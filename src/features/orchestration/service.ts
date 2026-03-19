import type { InboundMessage } from "../../core/channels.js";
import type { Person } from "../../core/domain.js";
import type { ToolRegistry } from "../../core/tools.js";
import { LlmService } from "../llm/service.js";

export interface OrchestratedResponse {
  route: "direct_response" | "tool_execution" | "llm_response";
  content: string;
  model?: string;
}

export class OrchestrationService {
  constructor(
    private readonly toolRegistry: ToolRegistry,
    private readonly llmService?: LlmService
  ) {}

  async processResolvedMessage(input: {
    requestId: string;
    person: Person;
    message: InboundMessage;
  }): Promise<OrchestratedResponse> {
    const normalizedText = input.message.text.trim().toLowerCase();

    if (normalizedText === "who am i" || normalizedText === "who am i?") {
      return {
        route: "direct_response",
        content: `You are ${input.person.name}, and I currently know you as a ${input.person.role} in this household.`
      };
    }

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
      const content = input.message.text.trim().slice("remember ".length).trim();

      if (content.length === 0) {
        return {
          route: "direct_response",
          content: "Tell me what you want me to remember after the word 'remember'."
        };
      }

      const result = await this.toolRegistry.execute("note.store", { content }, {
        requestId: input.requestId,
        invocationSource: "conversation",
        person: input.person
      }) as { noteId: string; createdAt: string };

      return {
        route: "tool_execution",
        content: `I saved that note for you with id ${result.noteId} at ${result.createdAt}.`
      };
    }

    if (
      normalizedText === "list my notes" ||
      normalizedText === "show my notes" ||
      normalizedText === "what do you remember about me?"
    ) {
      const result = await this.toolRegistry.execute("note.list", {}, {
        requestId: input.requestId,
        invocationSource: "conversation",
        person: input.person
      }) as { notes: Array<{ content: string; createdAt: string }> };

      if (result.notes.length === 0) {
        return {
          route: "tool_execution",
          content: "I do not have any notes stored for you yet."
        };
      }

      const lines = result.notes.map((note, index) => `${index + 1}. ${note.content} (${note.createdAt})`);
      return {
        route: "tool_execution",
        content: `Here are your recent notes:\n${lines.join("\n")}`
      };
    }

    if (normalizedText.includes("hello") || normalizedText.includes("hi")) {
      return {
        route: "direct_response",
        content: `Hi ${input.person.name}. I resolved your identity successfully and I'm ready for the next step.`
      };
    }

    if (this.llmService) {
      const response = await this.llmService.respond({
        requestId: input.requestId,
        person: input.person,
        message: input.message
      });

      return {
        route: "llm_response",
        content: response.text,
        model: response.model
      };
    }

    return {
      route: "direct_response",
      content: `I recognized you as ${input.person.name} and received your message: "${input.message.text}". Tool routing and LLM orchestration are the next layer to add.`
    };
  }
}
