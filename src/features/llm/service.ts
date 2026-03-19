import type { Person } from "../../core/domain.js";
import type { InboundMessage } from "../../core/channels.js";
import type { LlmProvider } from "./provider.js";
import type { ToolRegistry } from "../../core/tools.js";

export class LlmService {
  constructor(private readonly provider: LlmProvider) {}

  async respond(input: {
    requestId: string;
    person: Person;
    message: InboundMessage;
  }): Promise<{ model: string; text: string }> {
    const result = await this.provider.generate({
      requestId: input.requestId,
      messages: [
        {
          role: "system",
          content: [
            "You are a helpful household assistant.",
            "You already know the user's identity from application code.",
            "Be concise and practical.",
            "Do not claim to have used tools unless tool results were provided."
          ].join(" ")
        },
        {
          role: "user",
          content: `Resolved user: ${input.person.name} (role: ${input.person.role}). Message: ${input.message.text}`
        }
      ]
    });

    return {
      model: result.model,
      text: result.outputText.trim()
    };
  }

  async respondWithTools(input: {
    requestId: string;
    person: Person;
    message: InboundMessage;
    toolRegistry: ToolRegistry;
  }): Promise<{ model: string; text: string; usedTools: string[] }> {
    const tools = input.toolRegistry
      .listConversationTools()
      .filter((tool) => tool.inputJsonSchema)
      .map((tool) => ({
        internalName: tool.id,
        name: toOpenAiToolName(tool.id),
        description: tool.description,
        parameters: tool.inputJsonSchema ?? {}
      }));

    let response = await this.provider.generateWithTools({
      requestId: input.requestId,
      messages: [
        {
          role: "system",
          content: [
            "You are a helpful household assistant.",
            "You already know the user's identity from application code.",
            "Use tools when they help answer accurately.",
            "Be concise and practical.",
            "Only use the provided tools."
          ].join(" ")
        },
        {
          role: "user",
          content: `Resolved user: ${input.person.name} (role: ${input.person.role}). Message: ${input.message.text}`
        }
      ],
      tools
    });

    const usedTools: string[] = [];

    for (let i = 0; i < 5 && response.toolCalls.length > 0; i += 1) {
      const toolOutputs: Array<{ toolCallId: string; output: string }> = [];

      for (const toolCall of response.toolCalls) {
        const parsedArgs = JSON.parse(toolCall.arguments || "{}") as unknown;
        const tool = tools.find((candidate) => candidate.name === toolCall.name);
        if (!tool) {
          throw new Error(`Unknown tool call from model: ${toolCall.name}`);
        }

        const result = await input.toolRegistry.execute(tool.internalName, parsedArgs, {
          requestId: input.requestId,
          invocationSource: "conversation",
          person: input.person
        });

        usedTools.push(tool.internalName);
        toolOutputs.push({
          toolCallId: toolCall.id,
          output: JSON.stringify(result)
        });
      }

      const followUpInput: Parameters<LlmProvider["generateWithTools"]>[0] = {
        requestId: input.requestId,
        messages: [],
        tools,
        toolOutputs
      };

      if (response.responseId) {
        followUpInput.previousResponseId = response.responseId;
      }

      response = await this.provider.generateWithTools(followUpInput);
    }

    return {
      model: response.model,
      text: response.outputText.trim(),
      usedTools
    };
  }
}

function toOpenAiToolName(toolId: string): string {
  return toolId.replace(/[^\w-]/g, "_");
}
