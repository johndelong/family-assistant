import type { InboundMessage } from "../../core/channels.js";
import type { Person } from "../../core/domain.js";
import type { ToolRegistry } from "../../core/tools.js";
import { LlmService } from "../llm/service.js";
import type { MemoryRetrievalService, RetrievedMemory } from "../memory/retrieval-service.js";
import type { PromptProfileContext, PromptProfileService } from "../profiles/prompt-profile-service.js";
import type { SessionContext, SessionService } from "../sessions/service.js";

export interface OrchestratedResponse {
  route: "direct_response" | "tool_execution" | "llm_response";
  content: string;
  model?: string;
  trace?: {
    usedTools?: string[];
    toolTrace?: Array<{
      toolName: string;
      arguments: string;
      output?: string;
      error?: string;
    }>;
    relevantMemories?: RetrievedMemory[];
    profileContext?: PromptProfileContext;
    sessionContext?: SessionContext;
  };
}

export class OrchestrationService {
  constructor(
    private readonly toolRegistry: ToolRegistry,
    private readonly llmService?: LlmService,
    private readonly memoryRetrievalService?: MemoryRetrievalService,
    private readonly promptProfileService?: PromptProfileService,
    private readonly sessionService?: SessionService
  ) {}

  async processResolvedMessage(input: {
    requestId: string;
    person: Person;
    message: InboundMessage;
  }): Promise<OrchestratedResponse> {
    const rawText = input.message.text.trim();
    const normalizedText = rawText.toLowerCase();

    if (
      normalizedText === "health" ||
      normalizedText === "status" ||
      normalizedText === "system health" ||
      normalizedText === "are you healthy?"
    ) {
      const result = await this.toolRegistry.execute("system.health", {}, {
        requestId: input.requestId,
        invocationSource: "conversation",
        person: input.person
      }) as { status: string; service: string; timestamp: string };

      return {
        route: "tool_execution",
        content: `System health is ${result.status} for ${result.service} as of ${result.timestamp}.`
      };
    }

    if (normalizedText.startsWith("remember ")) {
      const memoryDirective = parseRememberDirective(rawText);

      if (!memoryDirective || memoryDirective.content.length === 0) {
        return {
          route: "direct_response",
          content: "Tell me what you want me to remember after the word 'remember'."
        };
      }

      const result = await this.toolRegistry.execute("memory.store", {
        content: memoryDirective.content,
        scope: memoryDirective.scope
      }, {
        requestId: input.requestId,
        invocationSource: "conversation",
        person: input.person
      }) as { memoryId: string; createdAt: string; scope: "private" | "shared" };

      return {
        route: "tool_execution",
        content: result.scope === "shared"
          ? `I saved that to shared household memory with id ${result.memoryId} at ${result.createdAt}.`
          : `I saved that to your private memory with id ${result.memoryId} at ${result.createdAt}.`
      };
    }

    if (
      normalizedText === "search my memory" ||
      normalizedText === "show my memories" ||
      normalizedText === "what do you remember about me?"
    ) {
      const result = await this.toolRegistry.execute("memory.search", {}, {
        requestId: input.requestId,
        invocationSource: "conversation",
        person: input.person
      }) as { memories: Array<{ scope: string; content: string; createdAt: string }> };

      if (result.memories.length === 0) {
        return {
          route: "tool_execution",
          content: "I do not have any memory stored for you yet."
        };
      }

      const lines = result.memories.map((memory, index) => `${index + 1}. [${memory.scope}] ${memory.content} (${memory.createdAt})`);
      return {
        route: "tool_execution",
        content: `Here is the memory I found for you:\n${lines.join("\n")}`
      };
    }

    if (this.llmService) {
      const profileContext = this.promptProfileService
        ? await this.promptProfileService.buildContextForPerson(input.person)
        : undefined;
      const sessionContext = this.sessionService
        ? await this.sessionService.loadContext({
            person: input.person,
            message: input.message
          })
        : undefined;
      const relevantMemories = this.memoryRetrievalService
        ? await this.memoryRetrievalService.retrieveForMessage({
            person: input.person,
            messageText: input.message.text,
            limit: 5
          })
        : [];

      const response = await this.llmService.respondWithTools({
        requestId: input.requestId,
        person: input.person,
        message: input.message,
        toolRegistry: this.toolRegistry,
        relevantMemories,
        profileContext,
        sessionContext
      });

      if (sessionContext) {
        await this.sessionService?.recordTurn({
          sessionId: sessionContext.session.id,
          userMessage: input.message.text,
          assistantMessage: response.text
        });
      }

      return {
        route: "llm_response",
        content: response.text,
        model: response.model,
        trace: {
          usedTools: response.usedTools,
          toolTrace: response.toolTrace,
          relevantMemories,
          ...(sessionContext ? { sessionContext } : {}),
          ...(profileContext ? { profileContext } : {})
        }
      };
    }

    return {
      route: "direct_response",
      content: `I recognized you as ${input.person.name} and received your message: "${input.message.text}". Tool routing and LLM orchestration are the next layer to add.`
    };
  }
}

function parseRememberDirective(text: string): { content: string; scope: "private" | "shared" } | null {
  const trimmed = text.trim();
  const lowered = trimmed.toLowerCase();

  if (!lowered.startsWith("remember ")) {
    return null;
  }

  const patterns: Array<{ pattern: RegExp; scope: "private" | "shared" }> = [
    { pattern: /^remember\s+for\s+the\s+family\s+that\s+(.+)$/i, scope: "shared" },
    { pattern: /^remember\s+for\s+the\s+household\s+that\s+(.+)$/i, scope: "shared" },
    { pattern: /^remember\s+for\s+us\s+that\s+(.+)$/i, scope: "shared" },
    { pattern: /^remember\s+this\s+for\s+the\s+family:?\s+(.+)$/i, scope: "shared" },
    { pattern: /^remember\s+this\s+for\s+the\s+household:?\s+(.+)$/i, scope: "shared" },
    { pattern: /^remember\s+this\s+for\s+us:?\s+(.+)$/i, scope: "shared" }
  ];

  for (const candidate of patterns) {
    const match = trimmed.match(candidate.pattern);
    if (match?.[1]) {
      return {
        content: match[1].trim(),
        scope: candidate.scope
      };
    }
  }

  return {
    content: trimmed.slice("remember ".length).trim(),
    scope: "private"
  };
}
