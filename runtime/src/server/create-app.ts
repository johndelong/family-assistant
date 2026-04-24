import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { ServerContext } from "./context.js";
import { registerDynamicMcpTool } from "../features/integrations/dynamic-mcp-tools.js";
import { normalizeMcpToolMetadata } from "../features/integrations/tool-metadata.js";

interface CreateAppOptions {
  context: ServerContext;
}

const identityResolutionBodySchema = z.object({
  channelType: z.enum(["websocket", "telegram"]),
  externalUserId: z.string().min(1),
  chatId: z.string().optional(),
  text: z.string().min(1).default(""),
  metadata: z.record(z.string(), z.unknown()).optional()
});

const messageIntakeBodySchema = z.object({
  channelType: z.enum(["websocket", "telegram"]),
  externalUserId: z.string().min(1),
  chatId: z.string().optional(),
  text: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).optional()
});

const dynamicToolCallBodySchema = z.object({
  input: z.record(z.string(), z.unknown()).default({})
});

const cronJobCreateBodySchema = z.object({
  personId: z.uuid(),
  name: z.string().min(1),
  schedule: z.string().min(1),
  timezone: z.string().min(1),
  sessionTarget: z.enum(["isolated", "main"]).default("isolated"),
  delivery: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("none")
    }),
    z.object({
      type: z.literal("telegram")
    })
  ]).default({ type: "none" }),
  payload: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("agent_turn"),
      prompt: z.string().min(1)
    }),
    z.object({
      kind: z.literal("workflow"),
      skillName: z.string().min(1),
      messageText: z.string().min(1)
    })
  ])
});

const assistantIdentityUpdateBodySchema = z.object({
  name: z.string().min(1),
  roleDescription: z.string().min(1),
  introductionPolicy: z.enum(["first_message_or_when_asked"]).default("first_message_or_when_asked"),
  signatureName: z.string().optional()
});

const assistantProfileUpdateBodySchema = z.object({
  instructions: z.string().min(1)
});

const householdProfileUpdateBodySchema = z.object({
  instructions: z.string().min(1)
});

const personPreferencesUpdateBodySchema = z.object({
  showProgress: z.boolean()
});

const extensionPackageScaffoldBodySchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  tags: z.array(z.string()).optional(),
  replace: z.boolean().optional()
});

export async function createApp({ context }: CreateAppOptions) {
  const app = Fastify({
    loggerInstance: context.logger
  });

  await app.register(cors, {
    origin: context.config.frontendOrigins.length > 0 ? context.config.frontendOrigins : false,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["authorization", "content-type"]
  });
  await app.register(websocket);

  app.decorate("serverContext", context);
  app.decorate("appConfig", context.config);
  app.decorate("toolRegistry", context.toolRegistry);

  app.addHook("preHandler", async (request, reply) => {
    const routeUrl = request.routeOptions.url;
    if (!routeUrl?.startsWith("/admin/")) {
      return;
    }

    const adminApiToken = app.serverContext.config.adminApiToken;
    if (!adminApiToken) {
      return reply.code(503).send({
        error: "ADMIN_API_TOKEN is required to use admin routes"
      });
    }

    let token: string | undefined;
    const authorization = request.headers.authorization;
    if (authorization?.startsWith("Bearer ")) {
      token = authorization.slice("Bearer ".length).trim();
    } else if (routeUrl === "/admin/monitor/ws") {
      const query = z.object({
        token: z.string().optional()
      }).safeParse(request.query);
      token = query.success ? query.data.token?.trim() : undefined;
    }

    if (!token) {
      return reply.code(401).send({
        error: "Missing bearer token for admin route"
      });
    }

    if (token !== adminApiToken) {
      return reply.code(403).send({
        error: "Invalid admin token"
      });
    }
  });

  app.get("/health", async () => ({
    status: "ok",
    service: "family-assistant",
    environment: context.config.environment,
    databaseConfigured: Boolean(context.config.databaseUrl)
  }));

  app.get("/", async () => ({
    name: "family-assistant",
    status: "bootstrapped"
  }));

  app.post("/identity/resolve", async (request, reply) => {
    if (!app.serverContext.identityResolution) {
      return reply.code(503).send({
        error: "DATABASE_URL is required to resolve identities"
      });
    }

    const body = identityResolutionBodySchema.parse(request.body);
    const resolution = await app.serverContext.identityResolution.resolveInboundMessage({
      channelType: body.channelType,
      externalUserId: body.externalUserId,
      ...(body.chatId ? { chatId: body.chatId } : {}),
      text: body.text,
      receivedAt: new Date(),
      ...(body.metadata ? { metadata: body.metadata } : {})
    });

    if (resolution.status === "resolved") {
      return {
        status: "resolved",
        person: {
          id: resolution.person.id,
          householdId: resolution.person.householdId,
          name: resolution.person.name,
          role: resolution.person.role
        },
        identity: {
          id: resolution.identity.id,
          channelType: resolution.identity.channelType,
          externalId: resolution.identity.externalId
        }
      };
    }

    return reply.code(202).send({
      status: "unpaired",
      pairing: {
        code: resolution.pairingRequest.code,
        expiresAt: resolution.pairingRequest.expiresAt.toISOString(),
        channelType: resolution.pairingRequest.channelType,
        externalId: resolution.pairingRequest.externalId
      }
    });
  });

  app.post("/messages", async (request, reply) => {
    if (!app.serverContext.requestIntake) {
      return reply.code(503).send({
        error: "DATABASE_URL is required to accept inbound messages"
      });
    }

    const body = messageIntakeBodySchema.parse(request.body);
    const requestId = randomUUID();

    app.log.info({
      requestId,
      channelType: body.channelType,
      externalUserId: body.externalUserId
    }, "received inbound message");

    const outcome = await app.serverContext.requestIntake.acceptInboundMessage({
      requestId,
      message: {
        channelType: body.channelType,
        externalUserId: body.externalUserId,
        ...(body.chatId ? { chatId: body.chatId } : {}),
        text: body.text,
        receivedAt: new Date(),
        ...(body.metadata ? { metadata: body.metadata } : {})
      }
    });

    if (outcome.status === "completed" || outcome.status === "awaiting_approval") {
      return reply.code(202).send({
        status: outcome.status,
        requestId: outcome.requestId,
        route: outcome.route,
        person: {
          id: outcome.person.id,
          householdId: outcome.person.householdId,
          name: outcome.person.name,
          role: outcome.person.role
        },
        message: outcome.message,
        ...(outcome.status === "awaiting_approval"
          ? {
              awaitingApproval: {
                runId: outcome.runId,
                resumeToken: outcome.resumeToken
              }
            }
          : {})
      });
    }

    return reply.code(202).send({
      status: "unpaired",
      requestId: outcome.requestId,
      pairing: {
        code: outcome.pairingCode,
        expiresAt: outcome.expiresAt
      },
      message: outcome.message
    });
  });

  app.post("/admin/integrations/:connectionId/tools/discover", async (request, reply) => {
    if (!app.serverContext.integrations || !app.serverContext.mcpRuntime) {
      return reply.code(503).send({
        error: "DATABASE_URL is required to manage MCP integrations"
      });
    }

    const params = z.object({
      connectionId: z.uuid()
    }).parse(request.params);

    const connection = await app.serverContext.integrations.findConnectionById(params.connectionId);
    if (!connection) {
      return reply.code(404).send({
        error: `Connection not found: ${params.connectionId}`
      });
    }

    const tools = await app.serverContext.mcpRuntime.listTools(connection);
    const imported = [];

    for (const tool of tools) {
      const normalized = normalizeMcpToolMetadata({
        toolName: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        ...(tool.inputSchema ? { inputJsonSchema: tool.inputSchema } : {})
      });
      const exposedTool = await app.serverContext.integrations.upsertExposedTool({
        connectionId: connection.id,
        toolName: tool.name,
        description: normalized.description,
        inputJsonSchema: normalized.inputJsonSchema
      });

      registerDynamicMcpTool({
        connection,
        exposedTool,
        integrations: app.serverContext.integrations,
        runtimeManager: app.serverContext.mcpRuntime,
        register: (dynamicTool) => app.serverContext.toolRegistry.register(dynamicTool)
      });

      imported.push({
        id: exposedTool.id,
        toolName: exposedTool.toolName,
        enabled: exposedTool.enabled
      });
    }

    return {
      connectionId: connection.id,
      imported
    };
  });

  app.get("/admin/integrations/:connectionId/tools", async (request, reply) => {
    if (!app.serverContext.integrations) {
      return reply.code(503).send({
        error: "DATABASE_URL is required to inspect MCP integrations"
      });
    }

    const params = z.object({
      connectionId: z.uuid()
    }).parse(request.params);

    const connection = await app.serverContext.integrations.findConnectionById(params.connectionId);
    if (!connection) {
      return reply.code(404).send({
        error: `Connection not found: ${params.connectionId}`
      });
    }

    const tools = await app.serverContext.integrations.listExposedTools(connection.id);
    return {
      connectionId: connection.id,
      tools
    };
  });

  app.post("/admin/integrations/:connectionId/tools/:toolName/call", async (request, reply) => {
    if (!app.serverContext.integrations || !app.serverContext.mcpRuntime) {
      return reply.code(503).send({
        error: "DATABASE_URL is required to call MCP tools"
      });
    }

    const params = z.object({
      connectionId: z.uuid(),
      toolName: z.string().min(1)
    }).parse(request.params);
    const body = dynamicToolCallBodySchema.parse(request.body);

    const connection = await app.serverContext.integrations.findConnectionById(params.connectionId);
    if (!connection) {
      return reply.code(404).send({
        error: `Connection not found: ${params.connectionId}`
      });
    }

    const result = await app.serverContext.mcpRuntime.callTool(connection, {
      name: params.toolName,
      arguments: body.input
    });

    return {
      connectionId: connection.id,
      toolName: params.toolName,
      result
    };
  });

  app.get("/admin/extensions", async () => {
    const registry = app.serverContext.extensionRegistry;
    return {
      extensions: registry?.inspectAll() ?? [],
      loadErrors: registry?.listErrors() ?? []
    };
  });

  app.get("/admin/session", async () => ({
    ok: true,
    environment: app.serverContext.config.environment
  }));

  app.get("/admin/traces", async (request, reply) => {
    if (!app.serverContext.traces) {
      return reply.code(503).send({
        error: "Trace repository is unavailable"
      });
    }

    const query = z.object({
      limit: z.coerce.number().int().positive().max(100).optional()
    }).parse(request.query);

    return {
      traces: (await app.serverContext.traces.list()).slice(0, query.limit ?? 25)
    };
  });

  app.get("/admin/traces/:requestId", async (request, reply) => {
    if (!app.serverContext.traces) {
      return reply.code(503).send({
        error: "Trace repository is unavailable"
      });
    }

    const params = z.object({
      requestId: z.string().min(1)
    }).parse(request.params);

    try {
      return {
        requestId: params.requestId,
        events: await app.serverContext.traces.get(params.requestId)
      };
    } catch {
      return reply.code(404).send({
        error: `Trace not found: ${params.requestId}`
      });
    }
  });

  app.route({
    method: "GET",
    url: "/admin/monitor/ws",
    handler: (_, reply) => {
      reply.code(404).send();
    },
    wsHandler: (socket, request) => {
      const wsSocket = getWebSocketLike(socket);
    const parsedQuery = z.object({
      token: z.string().optional()
    }).safeParse(request.query);
    const tokenFromQuery = parsedQuery.success ? parsedQuery.data.token?.trim() : undefined;
    const tokenFromUrl = request.raw.url
      ? new URL(request.raw.url, "http://localhost").searchParams.get("token")?.trim()
      : undefined;
    const token = tokenFromQuery ?? tokenFromUrl;
    const adminApiToken = app.serverContext.config.adminApiToken;

      if (!wsSocket) {
        app.log.error({
          route: "/admin/monitor/ws",
          socketType: typeof socket
        }, "websocket handler did not receive a ws-compatible socket");
        return;
      }

      if (!adminApiToken || token !== adminApiToken || !app.serverContext.monitor) {
        wsSocket.send(JSON.stringify({
        type: "error",
        error: !adminApiToken
          ? "ADMIN_API_TOKEN is required to use admin routes"
          : "Invalid admin token"
        }));
        wsSocket.close();
        return;
      }

      wsSocket.send(JSON.stringify({
      type: "connected",
      timestamp: new Date().toISOString()
      }));

      const unsubscribe = app.serverContext.monitor.subscribe((event) => {
        wsSocket.send(JSON.stringify(event));
      });

      wsSocket.on("close", () => {
        unsubscribe();
      });
    }
  });

  app.get("/admin/monitor/summary", async (request, reply) => {
    if (!app.serverContext.cronRepository || !app.serverContext.structuredExecutionRuns || !app.serverContext.traces) {
      return reply.code(503).send({
        error: "DATABASE_URL is required to inspect runtime activity"
      });
    }

    const query = z.object({
      limit: z.coerce.number().int().positive().max(100).optional()
    }).parse(request.query);
    const limit = query.limit ?? 15;

    return {
      traces: (await app.serverContext.traces.list()).slice(0, limit),
      cronRuns: await app.serverContext.cronRepository.listRecentRuns(limit),
      structuredExecutionRuns: await app.serverContext.structuredExecutionRuns.listRecent(limit)
    };
  });

  app.get("/admin/extensions/:name", async (request, reply) => {
    const params = z.object({
      name: z.string().min(1)
    }).parse(request.params);
    const inspection = app.serverContext.extensionRegistry?.inspect(params.name);

    if (!inspection) {
      return reply.code(404).send({
        error: `Extension not found: ${params.name}`
      });
    }

    return inspection;
  });

  app.post("/admin/extensions/:name/enable", async (request, reply) => {
    if (!app.serverContext.extensionRegistry || !app.serverContext.extensionStates) {
      return reply.code(503).send({
        error: "Extension state is unavailable"
      });
    }

    const params = z.object({
      name: z.string().min(1)
    }).parse(request.params);
    const extension = app.serverContext.extensionRegistry.getAny(params.name);
    if (!extension) {
      return reply.code(404).send({
        error: `Extension not found: ${params.name}`
      });
    }

    await app.serverContext.extensionStates.setEnabled(params.name, true);
    app.serverContext.extensionRegistry.setEnabled(params.name, true);

    return {
      extension: app.serverContext.extensionRegistry.inspect(params.name),
      restartRecommended: false
    };
  });

  app.post("/admin/extensions/:name/disable", async (request, reply) => {
    if (!app.serverContext.extensionRegistry || !app.serverContext.extensionStates) {
      return reply.code(503).send({
        error: "Extension state is unavailable"
      });
    }

    const params = z.object({
      name: z.string().min(1)
    }).parse(request.params);
    const extension = app.serverContext.extensionRegistry.getAny(params.name);
    if (!extension) {
      return reply.code(404).send({
        error: `Extension not found: ${params.name}`
      });
    }

    await app.serverContext.extensionStates.setEnabled(params.name, false);
    app.serverContext.extensionRegistry.setEnabled(params.name, false);

    return {
      extension: app.serverContext.extensionRegistry.inspect(params.name),
      restartRecommended: false
    };
  });

  app.get("/admin/households", async (request, reply) => {
    if (!app.serverContext.households || !app.serverContext.persons || !app.serverContext.runtimePreferences) {
      return reply.code(503).send({
        error: "DATABASE_URL is required to inspect households"
      });
    }

    const households = await app.serverContext.households.list();
    const persons = await app.serverContext.persons.list();

    return {
      households: households.map((household) => ({
        ...household,
        peopleCount: persons.filter((person) => person.householdId === household.id).length
      }))
    };
  });

  app.get("/admin/households/:householdId", async (request, reply) => {
    if (!app.serverContext.households || !app.serverContext.persons || !app.serverContext.runtimePreferences || !app.serverContext.profiles) {
      return reply.code(503).send({
        error: "DATABASE_URL is required to inspect households"
      });
    }

    const params = z.object({
      householdId: z.uuid()
    }).parse(request.params);

    const household = await app.serverContext.households.findById(params.householdId);
    if (!household) {
      return reply.code(404).send({
        error: `Household not found: ${params.householdId}`
      });
    }

    const people = await app.serverContext.persons.list(params.householdId);
    const householdProfile = await app.serverContext.profiles.getHouseholdProfile(params.householdId);

    const persons = await Promise.all(people.map(async (person) => ({
      ...person,
      preferences: await app.serverContext.runtimePreferences!.getPersonPreferences(person.id),
      profile: await app.serverContext.profiles!.getPersonProfile(person.id)
    })));

    return {
      household,
      householdProfile,
      persons
    };
  });

  app.post("/admin/households/:householdId/profile", async (request, reply) => {
    if (!app.serverContext.profiles || !app.serverContext.households) {
      return reply.code(503).send({
        error: "DATABASE_URL is required to update household profiles"
      });
    }

    const params = z.object({
      householdId: z.uuid()
    }).parse(request.params);
    const body = householdProfileUpdateBodySchema.parse(request.body);
    const household = await app.serverContext.households.findById(params.householdId);

    if (!household) {
      return reply.code(404).send({
        error: `Household not found: ${params.householdId}`
      });
    }

    return {
      householdId: params.householdId,
      profile: await app.serverContext.profiles.setHouseholdProfile(params.householdId, body.instructions.trim())
    };
  });

  app.get("/admin/settings", async (request, reply) => {
    if (!app.serverContext.profiles) {
      return reply.code(503).send({
        error: "DATABASE_URL is required to inspect settings"
      });
    }

    return {
      runtime: {
        environment: app.serverContext.config.environment,
        host: app.serverContext.config.host,
        port: app.serverContext.config.port,
        logLevel: app.serverContext.config.logLevel,
        cronEnabled: app.serverContext.config.cronEnabled,
        cronPollIntervalMs: app.serverContext.config.cronPollIntervalMs,
        frontendOrigins: app.serverContext.config.frontendOrigins,
        databaseConfigured: Boolean(app.serverContext.config.databaseUrl),
        openAiConfigured: Boolean(app.serverContext.config.openAiApiKey),
        braveSearchConfigured: Boolean(app.serverContext.config.braveApiKey),
        telegramConfigured: Boolean(app.serverContext.config.telegramBotToken),
        defaultModel: app.serverContext.config.openAiModel
      },
      assistantIdentity: await app.serverContext.profiles.getAssistantIdentity(),
      assistantProfile: await app.serverContext.profiles.getAssistantProfile()
    };
  });

  app.post("/admin/settings/assistant-identity", async (request, reply) => {
    if (!app.serverContext.profiles) {
      return reply.code(503).send({
        error: "DATABASE_URL is required to update settings"
      });
    }

    const body = assistantIdentityUpdateBodySchema.parse(request.body);
    return {
      assistantIdentity: await app.serverContext.profiles.setAssistantIdentity({
        name: body.name.trim(),
        roleDescription: body.roleDescription.trim(),
        introductionPolicy: body.introductionPolicy,
        ...(body.signatureName?.trim() ? { signatureName: body.signatureName.trim() } : {})
      })
    };
  });

  app.post("/admin/settings/assistant-profile", async (request, reply) => {
    if (!app.serverContext.profiles) {
      return reply.code(503).send({
        error: "DATABASE_URL is required to update settings"
      });
    }

    const body = assistantProfileUpdateBodySchema.parse(request.body);
    return {
      assistantProfile: await app.serverContext.profiles.setAssistantProfile(body.instructions.trim())
    };
  });

  app.post("/admin/persons/:personId/preferences", async (request, reply) => {
    if (!app.serverContext.runtimePreferences || !app.serverContext.persons) {
      return reply.code(503).send({
        error: "DATABASE_URL is required to update person preferences"
      });
    }

    const params = z.object({
      personId: z.uuid()
    }).parse(request.params);
    const body = personPreferencesUpdateBodySchema.parse(request.body);
    const person = await app.serverContext.persons.findById(params.personId);

    if (!person) {
      return reply.code(404).send({
        error: `Person not found: ${params.personId}`
      });
    }

    return {
      preferences: await app.serverContext.runtimePreferences.setShowProgress(params.personId, body.showProgress)
    };
  });

  app.post("/admin/extensions/install", async (request, reply) => {
    if (!app.serverContext.extensionManager) {
      return reply.code(503).send({
        error: "Extension manager is unavailable"
      });
    }

    const body = z.object({
      fromDirectory: z.string().min(1),
      replace: z.boolean().optional()
    }).parse(request.body);

    const result = await app.serverContext.extensionManager.installFromDirectory({
      sourceDirectory: body.fromDirectory,
      ...(typeof body.replace === "boolean" ? { replace: body.replace } : {})
    });

    return {
      installedDirectory: result.installedDirectory,
      replaced: result.replaced,
      extension: {
        name: result.manifest.name,
        version: result.manifest.package.version,
        apiVersion: result.manifest.package.apiVersion
      }
    };
  });

  app.post("/admin/extensions/package-scaffold", async (request, reply) => {
    if (!app.serverContext.extensionManager) {
      return reply.code(503).send({
        error: "Extension manager is unavailable"
      });
    }

    const body = extensionPackageScaffoldBodySchema.parse(request.body);
    const result = await app.serverContext.extensionManager.scaffoldPackage({
      name: body.name,
      description: body.description,
      ...(body.tags ? { tags: body.tags } : {}),
      ...(typeof body.replace === "boolean" ? { replace: body.replace } : {})
    });

    return {
      directory: result.directory,
      extension: {
        name: result.manifest.name,
        version: result.manifest.package.version,
        apiVersion: result.manifest.package.apiVersion
      }
    };
  });

  app.delete("/admin/extensions/:name", async (request, reply) => {
    if (!app.serverContext.extensionManager) {
      return reply.code(503).send({
        error: "Extension manager is unavailable"
      });
    }

    const params = z.object({
      name: z.string().min(1)
    }).parse(request.params);

    const removedDirectory = await app.serverContext.extensionManager.uninstall(params.name);

    return {
      name: params.name,
      removedDirectory
    };
  });

  app.get("/admin/cron/jobs", async (request, reply) => {
    if (!app.serverContext.cronRepository) {
      return reply.code(503).send({
        error: "DATABASE_URL is required to inspect cron jobs"
      });
    }

    return {
      jobs: await app.serverContext.cronRepository.listJobs()
    };
  });

  app.post("/admin/cron/jobs", async (request, reply) => {
    if (!app.serverContext.cron) {
      return reply.code(503).send({
        error: "DATABASE_URL is required to manage cron jobs"
      });
    }

    const body = cronJobCreateBodySchema.parse(request.body);
    const job = await app.serverContext.cron.createJob({
      personId: body.personId,
      name: body.name,
      schedule: body.schedule,
      timezone: body.timezone,
      sessionTarget: body.sessionTarget,
      delivery: body.delivery,
      payload: body.payload
    });

    return {
      job
    };
  });

  app.get("/admin/cron/jobs/:jobId", async (request, reply) => {
    if (!app.serverContext.cronRepository) {
      return reply.code(503).send({
        error: "DATABASE_URL is required to inspect cron jobs"
      });
    }

    const params = z.object({
      jobId: z.uuid()
    }).parse(request.params);
    const job = await app.serverContext.cronRepository.findJobById(params.jobId);
    if (!job) {
      return reply.code(404).send({
        error: `Cron job not found: ${params.jobId}`
      });
    }

    return {
      job,
      runs: await app.serverContext.cronRepository.listRunsForJob(params.jobId, 20)
    };
  });

  app.post("/admin/cron/jobs/:jobId/run", async (request, reply) => {
    if (!app.serverContext.cron) {
      return reply.code(503).send({
        error: "DATABASE_URL is required to run cron jobs"
      });
    }

    const params = z.object({
      jobId: z.uuid()
    }).parse(request.params);

    await app.serverContext.cron.runJobNow(params.jobId);

    return {
      jobId: params.jobId,
      status: "triggered"
    };
  });

  app.post("/admin/cron/jobs/:jobId/pause", async (request, reply) => {
    if (!app.serverContext.cronRepository) {
      return reply.code(503).send({
        error: "DATABASE_URL is required to manage cron jobs"
      });
    }

    const params = z.object({
      jobId: z.uuid()
    }).parse(request.params);

    await app.serverContext.cronRepository.updateJobStatus({
      id: params.jobId,
      status: "paused"
    });

    return {
      jobId: params.jobId,
      status: "paused"
    };
  });

  app.post("/admin/cron/jobs/:jobId/resume", async (request, reply) => {
    if (!app.serverContext.cronRepository) {
      return reply.code(503).send({
        error: "DATABASE_URL is required to manage cron jobs"
      });
    }

    const params = z.object({
      jobId: z.uuid()
    }).parse(request.params);

    await app.serverContext.cronRepository.updateJobStatus({
      id: params.jobId,
      status: "active"
    });

    return {
      jobId: params.jobId,
      status: "active"
    };
  });

  app.delete("/admin/cron/jobs/:jobId", async (request, reply) => {
    if (!app.serverContext.cronRepository) {
      return reply.code(503).send({
        error: "DATABASE_URL is required to manage cron jobs"
      });
    }

    const params = z.object({
      jobId: z.uuid()
    }).parse(request.params);

    await app.serverContext.cronRepository.deleteJob(params.jobId);

    return {
      jobId: params.jobId,
      deleted: true
    };
  });

  app.post("/admin/cron/tick", async (request, reply) => {
    if (!app.serverContext.cron) {
      return reply.code(503).send({
        error: "DATABASE_URL is required to run cron jobs"
      });
    }

    const processed = await app.serverContext.cron.runDueJobs();
    return { processed };
  });

  app.post("/admin/structured-execution/:resumeToken/respond", async (request, reply) => {
    if (!app.serverContext.orchestration) {
      return reply.code(503).send({
        error: "DATABASE_URL is required to resume structured execution runs"
      });
    }

    const params = z.object({
      resumeToken: z.uuid()
    }).parse(request.params);
    const body = z.object({
      approved: z.boolean()
    }).parse(request.body);

    const result = await app.serverContext.orchestration.resumeStructuredExecution({
      resumeToken: params.resumeToken,
      approved: body.approved
    });

    return result;
  });

  return app;
}

function getWebSocketLike(
  value: unknown
): { send: (data: string) => void; close: () => void; on: (event: "close", listener: () => void) => void } | null {
  if (isWebSocketLike(value)) {
    return value;
  }

  if (
    typeof value === "object" &&
    value !== null &&
    "socket" in value &&
    isWebSocketLike((value as { socket?: unknown }).socket)
  ) {
    return (value as {
      socket: { send: (data: string) => void; close: () => void; on: (event: "close", listener: () => void) => void };
    }).socket;
  }

  return null;
}

function isWebSocketLike(
  value: unknown
): value is { send: (data: string) => void; close: () => void; on: (event: "close", listener: () => void) => void } {
  return (
    typeof value === "object" &&
    value !== null &&
    "send" in value &&
    typeof (value as { send?: unknown }).send === "function" &&
    "close" in value &&
    typeof (value as { close?: unknown }).close === "function" &&
    "on" in value &&
    typeof (value as { on?: unknown }).on === "function"
  );
}

declare module "fastify" {
  interface FastifyInstance {
    serverContext: ServerContext;
    appConfig: ServerContext["config"];
    toolRegistry: ServerContext["toolRegistry"];
  }
}
