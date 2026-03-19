import type { Person } from "../../core/domain.js";
import type { InboundMessage } from "../../core/channels.js";
import type { LlmProvider } from "./provider.js";

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
}
