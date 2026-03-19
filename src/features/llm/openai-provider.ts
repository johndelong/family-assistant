import OpenAI from "openai";
import type { LlmGenerateParams, LlmGenerateResult, LlmProvider } from "./provider.js";

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
}
