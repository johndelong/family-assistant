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
  directActionModel?: string;
}

export class OpenAiProvider implements LlmProvider {
  readonly name = "openai";
  readonly #client: OpenAI;
  readonly #defaultModel: string;
  readonly #directActionModel: string | undefined;

  constructor(options: OpenAiProviderOptions) {
    this.#client = new OpenAI({
      apiKey: options.apiKey
    });
    this.#defaultModel = options.model;
    this.#directActionModel = options.directActionModel;
  }

  async generate(input: LlmGenerateParams): Promise<LlmGenerateResult> {
    const model = this.#resolveModel(input.modelHint);
    const response = await this.#client.responses.create({
      model,
      input: input.messages.map((message) => ({
        role: message.role,
        content: message.content
      }))
    });

    return {
      model,
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
    const model = this.#resolveModel(input.modelHint);
    const response = await this.#client.responses.create({
      model,
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
      model,
      outputText: response.output_text,
      toolCalls,
      responseId: response.id
    };
  }

  #resolveModel(modelHint: "default" | "direct_action" | undefined): string {
    if (modelHint === "direct_action" && this.#directActionModel) {
      return this.#directActionModel;
    }

    return this.#defaultModel;
  }
}
