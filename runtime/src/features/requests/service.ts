import type { InboundMessage } from "../../core/channels.js";
import type { Person } from "../../core/domain.js";
import { IdentityResolutionService } from "../identity/service.js";
import { OrchestrationService } from "../orchestration/service.js";
import { PersonPreferenceRepository } from "../preferences/repository.js";
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
      status: "awaiting_approval";
      requestId: string;
      person: Person;
      route: "tool_execution";
      message: string;
      runId: string;
      resumeToken: string;
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
    private readonly traceWriter: TraceWriter,
    private readonly runtimePreferences?: PersonPreferenceRepository
  ) {}

  async acceptInboundMessage(input: {
    requestId: string;
    message: InboundMessage;
    onProgress?: ((message: string) => Promise<void>) | undefined;
  }): Promise<AcceptedRequest> {
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
      const runtimePreferences = this.runtimePreferences
        ? await this.runtimePreferences.getPersonPreferences(resolution.person.id)
        : undefined;
      const progressHandler = runtimePreferences?.showProgress ? input.onProgress : undefined;

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
        message: input.message,
        onProgress: progressHandler
      });

      await this.traceWriter.write({
        timestamp: new Date().toISOString(),
        requestId: input.requestId,
        stage: response.model ? "llm.invoked" : "request.completed",
        payload: response.model ? {
          model: response.model,
          usedTools: response.trace?.usedTools ?? [],
          timing: summarizeTiming(response.trace?.timing),
          integrationPrompts: response.trace?.integrationPrompts ?? [],
          toolSelection: summarizeToolSelectionTrace(response.trace?.toolSelectionTrace ?? []),
          toolTrace: summarizeToolTrace(response.trace?.toolTrace ?? []),
          relevantMemories: summarizeRelevantMemories(response.trace?.relevantMemories ?? []),
          profileContext: summarizeProfileContext(response.trace?.profileContext),
          sessionContext: summarizeSessionContext(response.trace?.sessionContext)
        } : {
          outcome: response.awaitingApproval ? "awaiting_approval" : "completed",
          route: response.route,
          ...(response.awaitingApproval ? { awaitingApproval: response.awaitingApproval } : {}),
          ...(response.trace?.directAction ? { directAction: summarizeDirectActionTrace(response.trace.directAction) } : {})
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
      }

      if (response.awaitingApproval) {
        return {
          status: "awaiting_approval",
          requestId: input.requestId,
          person: resolution.person,
          route: "tool_execution",
          message: response.content,
          runId: response.awaitingApproval.runId,
          resumeToken: response.awaitingApproval.resumeToken
        };
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

function summarizeRelevantMemories(memories: Array<{
  id: string;
  scope: "private" | "shared";
  content: string;
  createdAt: string;
}>): Array<{
  id: string;
  scope: "private" | "shared";
  createdAt: string;
  preview: string;
}> {
  return memories.map((memory) => ({
    id: memory.id,
    scope: memory.scope,
    createdAt: memory.createdAt,
    preview: memory.content.length > 120 ? `${memory.content.slice(0, 117)}...` : memory.content
  }));
}

function summarizeProfileContext(profileContext: {
  assistantStyle: string;
  householdPreferences?: string;
  personPreferences?: string;
} | undefined): {
  assistantStylePreview: string;
  householdPreferencesPreview?: string;
  personPreferencesPreview?: string;
} | undefined {
  if (!profileContext) {
    return undefined;
  }

  return {
    assistantStylePreview: summarizeText(profileContext.assistantStyle),
    ...(profileContext.householdPreferences
      ? { householdPreferencesPreview: summarizeText(profileContext.householdPreferences) }
      : {}),
    ...(profileContext.personPreferences
      ? { personPreferencesPreview: summarizeText(profileContext.personPreferences) }
      : {})
  };
}

function summarizeText(value: string): string {
  return value.length > 160 ? `${value.slice(0, 157)}...` : value;
}

function summarizeSessionContext(sessionContext: {
  summary?: string;
  recentMessages: Array<{ role: "user" | "assistant"; content: string }>;
} | undefined): {
  summaryPreview?: string;
  recentMessages: Array<{ role: "user" | "assistant"; preview: string }>;
} | undefined {
  if (!sessionContext) {
    return undefined;
  }

  return {
    ...(sessionContext.summary ? { summaryPreview: summarizeText(sessionContext.summary) } : {}),
    recentMessages: sessionContext.recentMessages.map((message) => ({
      role: message.role,
      preview: summarizeText(message.content)
    }))
  };
}

function summarizeToolTrace(toolTrace: Array<{
  toolName: string;
  arguments: string;
  output?: string;
  error?: string;
}>): Array<{
  toolName: string;
  argumentsPreview: string;
  outputPreview?: string;
  error?: string;
}> {
  return toolTrace.map((entry) => ({
    toolName: entry.toolName,
    argumentsPreview: summarizeText(entry.arguments),
    ...(entry.output ? { outputPreview: summarizeText(entry.output) } : {}),
    ...(entry.error ? { error: summarizeText(entry.error) } : {})
  }));
}

function summarizeToolSelectionTrace(toolSelectionTrace: Array<{
  toolId: string;
  score: number;
  selected: boolean;
}>): Array<{
  toolId: string;
  score: number;
  selected: boolean;
}> {
  return toolSelectionTrace
    .slice(0, 20)
    .map((entry) => ({
      toolId: entry.toolId,
      score: entry.score,
      selected: entry.selected
    }));
}

function summarizeTiming(timing: {
  llmStartedAt?: string;
  llmCompletedAt?: string;
  firstToolCallAt?: string;
  firstToolCallMs?: number;
  totalLlmMs?: number;
  toolCalls?: Array<{
    toolName: string;
    startedAt: string;
    completedAt: string;
    durationMs: number;
    success: boolean;
  }>;
} | undefined): {
  llmStartedAt?: string;
  llmCompletedAt?: string;
  firstToolCallAt?: string;
  firstToolCallMs?: number;
  totalLlmMs?: number;
  toolCalls?: Array<{
    toolName: string;
    startedAt: string;
    completedAt: string;
    durationMs: number;
    success: boolean;
  }>;
} | undefined {
  if (!timing) {
    return undefined;
  }

  return {
    ...(timing.llmStartedAt ? { llmStartedAt: timing.llmStartedAt } : {}),
    ...(timing.llmCompletedAt ? { llmCompletedAt: timing.llmCompletedAt } : {}),
    ...(timing.firstToolCallAt ? { firstToolCallAt: timing.firstToolCallAt } : {}),
    ...(typeof timing.firstToolCallMs === "number" ? { firstToolCallMs: timing.firstToolCallMs } : {}),
    ...(typeof timing.totalLlmMs === "number" ? { totalLlmMs: timing.totalLlmMs } : {}),
    ...(timing.toolCalls ? { toolCalls: timing.toolCalls } : {})
  };
}

function summarizeDirectActionTrace(trace: {
  executorId: string;
  intent?: string;
  target?: Record<string, unknown>;
  steps: Array<{
    kind: "resolve" | "tool_call" | "verify" | "set" | "branch" | "approval" | "respond";
    toolName?: string;
    arguments?: Record<string, unknown>;
    success?: boolean;
    outputPreview?: string;
    detail?: string;
  }>;
}): {
  executorId: string;
  intent?: string;
  target?: Record<string, unknown>;
  steps: Array<{
    kind: "resolve" | "tool_call" | "verify" | "set" | "branch" | "approval" | "respond";
    toolName?: string;
    arguments?: Record<string, unknown>;
    success?: boolean;
    outputPreview?: string;
    detail?: string;
  }>;
} {
  return {
    executorId: trace.executorId,
    ...(trace.intent ? { intent: trace.intent } : {}),
    ...(trace.target ? { target: trace.target } : {}),
    steps: trace.steps.map((step) => ({
      kind: step.kind,
      ...(step.toolName ? { toolName: step.toolName } : {}),
      ...(step.arguments ? { arguments: step.arguments } : {}),
      ...(typeof step.success === "boolean" ? { success: step.success } : {}),
      ...(step.outputPreview ? { outputPreview: summarizeText(step.outputPreview) } : {}),
      ...(step.detail ? { detail: summarizeText(step.detail) } : {})
    }))
  };
}
