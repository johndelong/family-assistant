import OpenAI from "openai";
import type {
  LlmGenerateParams,
  LlmGenerateResult,
  LlmProvider,
  LlmToolCall,
  LlmToolResponse
} from "./provider.js";

interface OpenAiProviderOptions {
  apiKey: string;
  model: string;
}

export class OpenAiProvider implements LlmProvider {
  readonly name = "openai";
  readonly #client: OpenAI;
  readonly #model: string;

  constructor(options: OpenAiProviderOptions) {
    this.#client = new OpenAI({
      apiKey: options.apiKey
    });
    this.#model = options.model;
  }

  async generate(input: LlmGenerateParams): Promise<LlmGenerateResult> {
    const response = await this.#client.responses.create({
      model: this.#model,
      input: input.messages.map((message) => ({
        role: message.role,
        content: message.content
      }))
    });

    return {
      model: this.#model,
      outputText: response.output_text
    };
  }

  async generateWithTools(input: LlmGenerateParams & {
    tools: Array<{
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    }>;
    previousResponseId?: string;
    toolOutputs?: Array<{
      toolCallId: string;
      output: string;
    }>;
  }): Promise<LlmToolResponse> {
    const response = await this.#client.responses.create({
      model: this.#model,
      input: input.toolOutputs
        ? input.toolOutputs.map((item) => ({
            type: "function_call_output" as const,
            call_id: item.toolCallId,
            output: item.output
          }))
        : input.messages.map((message) => ({
            role: message.role,
            content: message.content
          })),
      ...(input.previousResponseId ? { previous_response_id: input.previousResponseId } : {}),
      tools: input.tools.map((tool) => ({
        type: "function" as const,
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        strict: true
      }))
    });

    const outputItems = ((response as unknown) as { output?: Array<Record<string, unknown>> }).output ?? [];
    const toolCalls: LlmToolCall[] = outputItems
      .filter((item) => item.type === "function_call")
      .map((item) => ({
        id: String(item.call_id),
        name: String(item.name),
        arguments: String(item.arguments ?? "{}")
      }));

    return {
      model: this.#model,
      outputText: response.output_text,
      toolCalls,
      responseId: response.id
    };
  }
}
