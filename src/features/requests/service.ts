import type { InboundMessage } from "../../core/channels.js";
import type { Person } from "../../core/domain.js";
import { IdentityResolutionService } from "../identity/service.js";
import { OrchestrationService } from "../orchestration/service.js";
import { TraceWriter } from "../tracing/writer.js";

export type AcceptedRequest =
  | {
      status: "completed";
      requestId: string;
      person: Person;
      route: "direct_response" | "tool_execution" | "llm_response";
      message: string;
      model?: string;
    }
  | {
      status: "unpaired";
      requestId: string;
      pairingCode: string;
      expiresAt: string;
      message: string;
    };

export class RequestIntakeService {
  constructor(
    private readonly identityResolution: IdentityResolutionService,
    private readonly orchestration: OrchestrationService,
    private readonly traceWriter: TraceWriter
  ) {}

  async acceptInboundMessage(input: { requestId: string; message: InboundMessage }): Promise<AcceptedRequest> {
    await this.traceWriter.write({
      timestamp: new Date().toISOString(),
      requestId: input.requestId,
      stage: "request.received",
      payload: {
        channelType: input.message.channelType,
        externalUserId: input.message.externalUserId,
        text: input.message.text
      }
    });

    const resolution = await this.identityResolution.resolveInboundMessage(input.message);

    if (resolution.status === "resolved") {
      await this.traceWriter.write({
        timestamp: new Date().toISOString(),
        requestId: input.requestId,
        stage: "identity.resolved",
        payload: {
          personId: resolution.person.id,
          personName: resolution.person.name,
          identityId: resolution.identity.id,
          channelType: resolution.identity.channelType
        }
      });

      const response = await this.orchestration.processResolvedMessage({
        requestId: input.requestId,
        person: resolution.person,
        message: input.message
      });

      await this.traceWriter.write({
        timestamp: new Date().toISOString(),
        requestId: input.requestId,
        stage: response.model ? "llm.invoked" : "request.completed",
        payload: response.model ? {
          model: response.model
        } : {
          outcome: "completed",
          route: response.route
        }
      });

      if (response.model) {
        await this.traceWriter.write({
          timestamp: new Date().toISOString(),
          requestId: input.requestId,
          stage: "request.completed",
          payload: {
            outcome: "completed",
            route: response.route,
            model: response.model
          }
        });
      } else {
        await this.traceWriter.write({
          timestamp: new Date().toISOString(),
          requestId: input.requestId,
          stage: "request.completed",
          payload: {
            outcome: "completed",
            route: response.route
          }
        });
      }

      return {
        status: "completed",
        requestId: input.requestId,
        person: resolution.person,
        route: response.route,
        message: response.content,
        ...(response.model ? { model: response.model } : {})
      };
    }

    await this.traceWriter.write({
      timestamp: new Date().toISOString(),
      requestId: input.requestId,
      stage: "identity.unpaired",
      payload: {
        pairingCode: resolution.pairingRequest.code,
        expiresAt: resolution.pairingRequest.expiresAt.toISOString(),
        channelType: resolution.pairingRequest.channelType
      }
    });

    await this.traceWriter.write({
      timestamp: new Date().toISOString(),
      requestId: input.requestId,
      stage: "request.completed",
      payload: {
        outcome: "unpaired"
      }
    });

    return {
      status: "unpaired",
      requestId: input.requestId,
      pairingCode: resolution.pairingRequest.code,
      expiresAt: resolution.pairingRequest.expiresAt.toISOString(),
      message: `Identity not linked. Pair this sender with: family-assistant identity pair --code ${resolution.pairingRequest.code} --person <person-id-or-name>`
    };
  }
}
