import type { Person } from "../../core/domain.js";
import type { InboundMessage } from "../../core/channels.js";
import type { LlmProvider } from "./provider.js";
import type { ToolRegistry } from "../../core/tools.js";
import type { RetrievedMemory } from "../memory/retrieval-service.js";
import type { PromptProfileContext } from "../profiles/prompt-profile-service.js";
import type { SessionContext } from "../sessions/service.js";

export class LlmService {
  constructor(private readonly provider: LlmProvider) {}

  async respond(input: {
    requestId: string;
    person: Person;
    message: InboundMessage;
    relevantMemories?: RetrievedMemory[] | undefined;
    profileContext?: PromptProfileContext | undefined;
    sessionContext?: SessionContext | undefined;
  }): Promise<{ model: string; text: string }> {
    const result = await this.provider.generate({
      requestId: input.requestId,
      messages: [
        {
          role: "system",
          content: buildBaseSystemPrompt(input.profileContext, false)
        },
        ...(input.relevantMemories && input.relevantMemories.length > 0
          ? [{
              role: "system" as const,
              content: buildMemoryContext(input.relevantMemories)
            }]
          : []),
        ...buildSessionMessages(input.sessionContext),
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
    relevantMemories?: RetrievedMemory[] | undefined;
    profileContext?: PromptProfileContext | undefined;
    sessionContext?: SessionContext | undefined;
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
          content: buildBaseSystemPrompt(input.profileContext, true)
        },
        ...(input.relevantMemories && input.relevantMemories.length > 0
          ? [{
              role: "system" as const,
              content: buildMemoryContext(input.relevantMemories)
            }]
          : []),
        ...buildSessionMessages(input.sessionContext),
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

function buildMemoryContext(memories: RetrievedMemory[]): string {
  const lines = memories.map((memory, index) =>
    `${index + 1}. [${memory.scope}] ${memory.content} (stored ${memory.createdAt})`
  );

  return [
    "Relevant memory for this conversation:",
    ...lines,
    "Use this context when helpful, but do not mention memory unless it improves the response."
  ].join("\n");
}

function buildSessionMessages(sessionContext: SessionContext | undefined): Array<{
  role: "system" | "user" | "assistant";
  content: string;
}> {
  if (!sessionContext) {
    return [];
  }

  return [
    ...(sessionContext.summary
      ? [{
          role: "system" as const,
          content: `Current conversation summary:\n${sessionContext.summary}`
        }]
      : []),
    ...sessionContext.recentMessages.map((message) => ({
      role: message.role,
      content: message.content
    }))
  ];
}

function buildBaseSystemPrompt(
  profileContext: PromptProfileContext | undefined,
  enableTools: boolean
): string {
  const sections = [
    "You are a helpful household assistant.",
    "You already know the user's identity from application code.",
    profileContext ? buildProfileContext(profileContext) : undefined,
    enableTools
      ? [
          "Use tools when they help answer accurately.",
          "Use memory.store to save durable context only when the user is clearly asking you to remember something for later.",
          "Choose scope='private' for person-specific preferences or facts, and scope='shared' for household-wide routines, schedules, or family context.",
          "The profile sections in this prompt reflect the current persisted assistant style and user preferences.",
          "If the user asks what preferences, personality, or style are currently set, answer directly from those profile sections.",
          "If a profile section is marked as not set, say that clearly instead of inventing one.",
          "Assistant Style can be described to any household member.",
          "Household Preferences can be described as shared family context.",
          "Person Preferences apply only to the currently resolved person in this conversation.",
          "If asked about another person's private preferences, say you cannot report those from this conversation context.",
          "When a user wants help setting preferences, run a short interview over multiple turns rather than asking everything at once.",
          "After the user clearly states or confirms stable preferences, persist them with the appropriate profile tool.",
          "Use profile.set_person_preferences for one person's preferences, profile.set_household_preferences for family-wide norms, and profile.set_assistant_style only when an admin explicitly asks to change how the assistant behaves overall.",
          "Do not update a household or assistant-wide profile unless the user is explicit and the scope is clear.",
          "Only use the provided tools."
        ].join(" ")
      : [
          "The profile sections in this prompt reflect the current persisted assistant style and user preferences.",
          "If the user asks what preferences, personality, or style are currently set, answer directly from those profile sections.",
          "If a profile section is marked as not set, say that clearly instead of inventing one.",
          "Assistant Style can be described to any household member.",
          "Household Preferences can be described as shared family context.",
          "Person Preferences apply only to the currently resolved person in this conversation.",
          "If asked about another person's private preferences, say you cannot report those from this conversation context.",
          "Do not claim to have used tools unless tool results were provided."
        ].join(" "),
    "Be concise and practical."
  ];

  return sections.filter(Boolean).join("\n\n");
}

function buildProfileContext(profileContext: PromptProfileContext): string {
  return [
    "Current persisted profile context:",
    `Assistant Style:\n${profileContext.assistantStyle}`,
    profileContext.householdPreferences
      ? `Household Preferences:\n${profileContext.householdPreferences}`
      : "Household Preferences:\n(not set)",
    profileContext.personPreferences
      ? `Person Preferences (current person only):\n${profileContext.personPreferences}`
      : "Person Preferences (current person only):\n(not set)"
  ].join("\n\n");
}
