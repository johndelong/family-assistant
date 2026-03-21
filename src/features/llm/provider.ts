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

export interface LlmToolDefinition {
  internalName: string;
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LlmToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface LlmToolResponse {
  model: string;
  outputText: string;
  toolCalls: LlmToolCall[];
  responseId?: string;
}

export interface LlmToolTrace {
  toolName: string;
  arguments: string;
  output?: string;
  error?: string;
}

export interface LlmToolSelectionTrace {
  toolId: string;
  score: number;
  selected: boolean;
}

export interface LlmProvider {
  readonly name: string;
  generate(input: LlmGenerateParams): Promise<LlmGenerateResult>;
  generateWithTools(input: LlmGenerateParams & {
    tools: LlmToolDefinition[];
    previousResponseId?: string;
    toolOutputs?: Array<{
      toolCallId: string;
      output: string;
    }>;
  }): Promise<LlmToolResponse>;
}
