import type { LlmProvider } from "../llm/provider.js";
import type { SessionMessageRole } from "./repository.js";

export interface SessionSummarizer {
  summarize(input: {
    existingSummary?: string;
    messages: Array<{
      role: SessionMessageRole;
      content: string;
    }>;
  }): Promise<string>;
}

export class LlmSessionSummarizer implements SessionSummarizer {
  constructor(private readonly provider: LlmProvider) {}

  async summarize(input: {
    existingSummary?: string;
    messages: Array<{
      role: SessionMessageRole;
      content: string;
    }>;
  }): Promise<string> {
    const transcript = input.messages
      .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
      .join("\n");

    const result = await this.provider.generate({
      requestId: `session-summary-${Date.now()}`,
      messages: [
        {
          role: "system",
          content: [
            "Summarize an active household assistant conversation for future turns.",
            "Capture durable context, active goals, stated preferences, and unresolved follow-ups.",
            "Be concise and factual.",
            "Do not include greetings or filler."
          ].join(" ")
        },
        {
          role: "user",
          content: [
            input.existingSummary ? `Existing summary:\n${input.existingSummary}` : "Existing summary:\n(none)",
            "Newer conversation turns:",
            transcript,
            "Return an updated rolling summary for the session."
          ].join("\n\n")
        }
      ]
    });

    return result.outputText.trim();
  }
}
