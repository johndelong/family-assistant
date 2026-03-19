import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { ServerContext } from "./context.js";

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

export function createApp({ context }: CreateAppOptions) {
  const app = Fastify({
    loggerInstance: context.logger
  });

  app.decorate("serverContext", context);
  app.decorate("appConfig", context.config);
  app.decorate("toolRegistry", context.toolRegistry);

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

    if (outcome.status === "completed") {
      return reply.code(202).send({
        status: "completed",
        requestId: outcome.requestId,
        route: outcome.route,
        person: {
          id: outcome.person.id,
          householdId: outcome.person.householdId,
          name: outcome.person.name,
          role: outcome.person.role
        },
        message: outcome.message
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

  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    serverContext: ServerContext;
    appConfig: ServerContext["config"];
    toolRegistry: ServerContext["toolRegistry"];
  }
}
