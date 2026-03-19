export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmGenerateParams {
  requestId: string;
  messages: LlmMessage[];
}

export interface LlmGenerateResult {
  model: string;
  outputText: string;
}

export interface LlmProvider {
  readonly name: string;
  generate(input: LlmGenerateParams): Promise<LlmGenerateResult>;
}
