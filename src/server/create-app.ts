import Fastify, { type FastifyInstance } from "fastify";
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

export function createApp({ context }: CreateAppOptions) {
  const app = Fastify({
    loggerInstance: context.logger
  });

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

    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) {
      return reply.code(401).send({
        error: "Missing bearer token for admin route"
      });
    }

    const token = authorization.slice("Bearer ".length).trim();
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

declare module "fastify" {
  interface FastifyInstance {
    serverContext: ServerContext;
    appConfig: ServerContext["config"];
    toolRegistry: ServerContext["toolRegistry"];
  }
}
