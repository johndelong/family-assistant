export interface DirectActionTrace {
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
}
