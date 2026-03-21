import type { Person } from "../../core/domain.js";
import type { InboundMessage } from "../../core/channels.js";
import type { LlmProvider, LlmToolSelectionTrace, LlmToolTrace } from "./provider.js";
import type { ToolRegistry } from "../../core/tools.js";
import type { RetrievedMemory } from "../memory/retrieval-service.js";
import type { PromptProfileContext } from "../profiles/prompt-profile-service.js";
import type { SessionContext } from "../sessions/service.js";
import type { McpPromptService } from "../integrations/mcp-prompt-service.js";
import type { DirectActionTrace } from "../direct-actions/executor.js";
import { readPromptFragment } from "./prompt-fragments.js";
import { selectRelevantTools } from "./tool-selection.js";
import { applySkillExecutionGuards, applyToolSkills } from "./tool-skills.js";

export class LlmService {
  constructor(
    private readonly provider: LlmProvider,
    private readonly mcpPromptService?: McpPromptService
  ) {}

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
      text: coerceAssistantText(result.outputText, "I processed that, but I do not have a response ready yet.")
    };
  }

  async respondWithTools(input: {
    requestId: string;
    person: Person;
    message: InboundMessage;
    toolRegistry: ToolRegistry;
    allowedToolIds?: string[] | undefined;
    integrationPromptSections?: string[] | undefined;
    requestMode?: "default" | "direct_action";
    relevantMemories?: RetrievedMemory[] | undefined;
    profileContext?: PromptProfileContext | undefined;
    sessionContext?: SessionContext | undefined;
    onProgress?: ((message: string) => Promise<void>) | undefined;
  }): Promise<{
    model: string;
    text: string;
    usedTools: string[];
    toolTrace: LlmToolTrace[];
    toolSelectionTrace: LlmToolSelectionTrace[];
    directActionTrace?: DirectActionTrace;
    integrationPrompts?: Array<{
      connectionId: string;
      integrationKey: string;
      promptName: string;
    }>;
    timing: {
      llmStartedAt: string;
      llmCompletedAt: string;
      firstToolCallAt?: string;
      firstToolCallMs?: number;
      totalLlmMs: number;
      toolCalls: Array<{
        toolName: string;
        startedAt: string;
        completedAt: string;
        durationMs: number;
        success: boolean;
      }>;
    };
  }> {
    const llmStartedAt = new Date();
    const conversationTools = input.allowedToolIds
      ? input.toolRegistry
          .listConversationTools()
          .filter((tool) => input.allowedToolIds?.includes(tool.id))
      : input.toolRegistry.listConversationTools();

    const selection = selectRelevantTools({
      messageText: input.message.text,
      person: input.person,
      tools: conversationTools,
      sessionContext: input.sessionContext,
      ...(input.requestMode === "direct_action" ? { maxTools: 12 } : {})
    });

    const skillContext = applyToolSkills({
      messageText: input.message.text,
      ...(input.requestMode ? { requestMode: input.requestMode } : {}),
      sessionContext: input.sessionContext,
      allTools: conversationTools,
      selectedTools: selection.selectedTools,
      trace: selection.trace
    });
    const integrationPrompts = input.integrationPromptSections
      ? input.integrationPromptSections.map((content) => ({
          connectionId: "external",
          integrationKey: "external",
          promptName: "external",
          content
        }))
      : (
      skillContext.directActionShortcut && this.mcpPromptService
        ? await this.mcpPromptService.buildPromptSections({
            toolIds: skillContext.directActionShortcut.toolIds,
            maxPromptsPerConnection: 2
          })
        : []
    );

    const tools = skillContext.selectedTools
      .filter((tool) => tool.inputJsonSchema)
      .map((tool) => ({
        internalName: tool.id,
        name: toOpenAiToolName(tool.id),
        description: tool.description,
        parameters: normalizeForOpenAi(tool.inputJsonSchema ?? {}),
        rawSchema: tool.inputJsonSchema ?? {}
      }));

    let response = await this.provider.generateWithTools({
      requestId: input.requestId,
      ...(input.requestMode ? { modelHint: input.requestMode } : {}),
      messages: [
        {
          role: "system",
          content: buildBaseSystemPrompt(input.profileContext, true)
        },
        ...(integrationPrompts.map((prompt) => ({
          role: "system" as const,
          content: prompt.content
        }))),
        ...skillContext.systemPromptSections.map((content) => ({
          role: "system" as const,
          content
        })),
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
    const toolTrace: LlmToolTrace[] = [];
    const toolTimings: Array<{
      toolName: string;
      startedAt: string;
      completedAt: string;
      durationMs: number;
      success: boolean;
    }> = [];
    let firstToolCallAt: Date | undefined;

    for (let i = 0; i < 5 && response.toolCalls.length > 0; i += 1) {
      const toolOutputs: Array<{ toolCallId: string; output: string }> = [];

      for (const toolCall of response.toolCalls) {
        const parsedArgs = JSON.parse(toolCall.arguments || "{}") as unknown;
        const tool = tools.find((candidate) => candidate.name === toolCall.name);
        if (!tool) {
          throw new Error(`Unknown tool call from model: ${toolCall.name}`);
        }
        const sanitizedArgs = sanitizeToolInput(parsedArgs, tool.rawSchema, true);
        const executedArgs = applySkillExecutionGuards({
          toolId: tool.internalName,
          toolInput: sanitizedArgs,
          userMessage: input.message.text,
          guards: skillContext.executionGuards
        });

        await input.onProgress?.(describeToolWork(tool.internalName, tool.description));
        const toolStartedAt = new Date();
        firstToolCallAt ??= toolStartedAt;

        try {
          const result = await input.toolRegistry.execute(tool.internalName, executedArgs ?? {}, {
            requestId: input.requestId,
            invocationSource: "conversation",
            person: input.person
          });

          usedTools.push(tool.internalName);
          const serializedOutput = JSON.stringify(result);
          const toolCompletedAt = new Date();
          toolTrace.push({
            toolName: tool.internalName,
            arguments: JSON.stringify(executedArgs ?? {}),
            output: serializedOutput
          });
          toolTimings.push({
            toolName: tool.internalName,
            startedAt: toolStartedAt.toISOString(),
            completedAt: toolCompletedAt.toISOString(),
            durationMs: toolCompletedAt.getTime() - toolStartedAt.getTime(),
            success: true
          });
          toolOutputs.push({
            toolCallId: toolCall.id,
            output: serializedOutput
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const toolCompletedAt = new Date();
          toolTrace.push({
            toolName: tool.internalName,
            arguments: JSON.stringify(executedArgs ?? {}),
            error: message
          });
          toolTimings.push({
            toolName: tool.internalName,
            startedAt: toolStartedAt.toISOString(),
            completedAt: toolCompletedAt.toISOString(),
            durationMs: toolCompletedAt.getTime() - toolStartedAt.getTime(),
            success: false
          });
          toolOutputs.push({
            toolCallId: toolCall.id,
            output: JSON.stringify({
              error: message
            })
          });
        }
      }

      const followUpInput: Parameters<LlmProvider["generateWithTools"]>[0] = {
        requestId: input.requestId,
        ...(input.requestMode ? { modelHint: input.requestMode } : {}),
        messages: [],
        tools,
        toolOutputs
      };

      if (response.responseId) {
        followUpInput.previousResponseId = response.responseId;
      }

      response = await this.provider.generateWithTools(followUpInput);
    }

    const llmCompletedAt = new Date();

    return {
      model: response.model,
      text: coerceAssistantText(
        response.outputText,
        usedTools.length > 0
          ? "I checked that, but I could not summarize the result clearly yet."
          : "I processed that, but I do not have a response ready yet."
      ),
      usedTools,
      toolTrace,
      toolSelectionTrace: skillContext.trace,
      ...(integrationPrompts.length > 0
        ? {
            integrationPrompts: integrationPrompts.map((prompt) => ({
              connectionId: prompt.connectionId,
              integrationKey: prompt.integrationKey,
              promptName: prompt.promptName
            }))
          }
        : {}),
      ...(skillContext.directActionShortcut
        ? {
            directActionTrace: buildDirectActionShortcutTrace(skillContext.directActionShortcut)
          }
        : {}),
      timing: {
        llmStartedAt: llmStartedAt.toISOString(),
        llmCompletedAt: llmCompletedAt.toISOString(),
        ...(firstToolCallAt
          ? {
              firstToolCallAt: firstToolCallAt.toISOString(),
              firstToolCallMs: firstToolCallAt.getTime() - llmStartedAt.getTime()
            }
          : {}),
        totalLlmMs: llmCompletedAt.getTime() - llmStartedAt.getTime(),
        toolCalls: toolTimings
      }
    };
  }
}

function buildDirectActionShortcutTrace(input: {
  skillName: string;
  toolIds: string[];
}): DirectActionTrace {
  return {
    executorId: input.skillName,
    steps: [
      {
        kind: "resolve",
        success: true,
        detail: `Narrowed direct-action toolset to ${input.toolIds.length} tool(s).`
      }
    ]
  };
}

function describeToolWork(toolId: string, description: string): string {
  const summary = description.split(/(?<=[.!?])\s+/)[0]?.trim();
  if (summary && summary.length <= 140) {
    return summary;
  }

  return `Using ${toolId}...`;
}

function toOpenAiToolName(toolId: string): string {
  return toolId.replace(/[^\w-]/g, "_");
}

function normalizeForOpenAi(schema: Record<string, unknown>): Record<string, unknown> {
  return normalizeSchemaNode(schema);
}

function normalizeSchemaNode(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false
    };
  }

  const schema = unwrapComposedSchema(value as Record<string, unknown>);
  const type = schema.type;

  if (type === "object" || schema.properties) {
    const rawProperties = (
      schema.properties &&
      typeof schema.properties === "object" &&
      !Array.isArray(schema.properties)
    )
      ? schema.properties as Record<string, unknown>
      : {};

    const properties = Object.fromEntries(
      Object.entries(rawProperties).map(([key, propertyValue]) => [key, normalizePropertyNode(propertyValue)])
    );
    const propertyNames = Object.keys(properties);

    return {
      ...schema,
      type: "object",
      properties,
      required: propertyNames,
      additionalProperties: false
    };
  }

  if (type === "array") {
    return {
      ...schema,
      type: "array",
      ...(schema.items ? { items: normalizePropertyNode(schema.items) } : {})
    };
  }

  return schema;
}

function normalizePropertyNode(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { type: "string" };
  }

  const schema = unwrapComposedSchema(value as Record<string, unknown>);

  if (schema.type === "object" || schema.properties) {
    return normalizeSchemaNode(schema);
  }

  if (schema.type === "array") {
    return {
      ...schema,
      type: "array",
      ...(schema.items ? { items: normalizePropertyNode(schema.items) } : {})
    };
  }

  const existingType = schema.type;
  if (typeof existingType === "string") {
    return schema;
  }

  if (Array.isArray(existingType)) {
    return schema;
  }

  return {
    ...schema,
    type: "string"
  };
}

function sanitizeToolInput(
  value: unknown,
  schema: unknown,
  required: boolean
): unknown {
  if (value == null) {
    return required ? value : undefined;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!required && trimmed.length === 0) {
      return undefined;
    }

    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizeToolInput(item, getSchemaItems(schema), false))
      .filter((item) => item !== undefined);
  }

  if (typeof value !== "object") {
    return value;
  }

  const normalizedSchema = (
    schema &&
    typeof schema === "object" &&
    !Array.isArray(schema)
  )
    ? unwrapComposedSchema(schema as Record<string, unknown>)
    : {};

  const rawProperties = (
    normalizedSchema.properties &&
    typeof normalizedSchema.properties === "object" &&
    !Array.isArray(normalizedSchema.properties)
  )
    ? normalizedSchema.properties as Record<string, unknown>
    : {};
  const requiredKeys = new Set(
    Array.isArray(normalizedSchema.required)
      ? normalizedSchema.required.filter((key): key is string => typeof key === "string")
      : []
  );

  const result: Record<string, unknown> = {};

  for (const [key, childValue] of Object.entries(value as Record<string, unknown>)) {
    const sanitizedChild = sanitizeToolInput(childValue, rawProperties[key], requiredKeys.has(key));
    if (sanitizedChild === undefined) {
      continue;
    }

    result[key] = sanitizedChild;
  }

  return result;
}

function getSchemaItems(schema: unknown): unknown {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return undefined;
  }

  const normalizedSchema = unwrapComposedSchema(schema as Record<string, unknown>);
  return normalizedSchema.items;
}

function unwrapComposedSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const composed = schema.oneOf ?? schema.anyOf ?? schema.allOf;
  if (!Array.isArray(composed) || composed.length === 0) {
    const { oneOf: _oneOf, anyOf: _anyOf, allOf: _allOf, ...rest } = schema;
    return rest;
  }

  const [firstBranch] = composed;
  const branch = (
    firstBranch &&
    typeof firstBranch === "object" &&
    !Array.isArray(firstBranch)
  )
    ? unwrapComposedSchema(firstBranch as Record<string, unknown>)
    : {};

  const { oneOf: _oneOf, anyOf: _anyOf, allOf: _allOf, ...rest } = schema;
  return {
    ...rest,
    ...branch
  };
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
    readPromptFragment("base"),
    buildStableTimeContext(),
    profileContext ? buildProfileContext(profileContext) : undefined,
    readPromptFragment("identity"),
    readPromptFragment("profiles"),
    enableTools
      ? readPromptFragment("tools")
      : "Do not claim to have used tools unless tool results were provided."
  ];

  return sections.filter(Boolean).join("\n\n");
}

function buildProfileContext(profileContext: PromptProfileContext): string {
  return [
    "Current persisted profile context:",
    `Assistant Identity:\nName: ${profileContext.assistantIdentity.name}\nRole: ${profileContext.assistantIdentity.roleDescription}\nIntroduction policy: Do not announce your name in every reply and do not sign routine chat responses. Use your name naturally only when first introducing yourself, when asked who you are, or when signing outbound messages such as email.${profileContext.assistantIdentity.signatureName ? `\nSignature name: ${profileContext.assistantIdentity.signatureName}` : ""}`,
    `Assistant Style:\n${profileContext.assistantStyle}`,
    profileContext.householdPreferences
      ? `Household Preferences:\n${profileContext.householdPreferences}`
      : "Household Preferences:\n(not set)",
    profileContext.personPreferences
      ? `Person Preferences (current person only):\n${profileContext.personPreferences}`
      : "Person Preferences (current person only):\n(not set)"
  ].join("\n\n");
}

function coerceAssistantText(value: string, fallback: string): string {
  const text = value.trim();
  return text.length > 0 ? text : fallback;
}

function buildStableTimeContext(): string {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

  return [
    "Time interpretation context:",
    `Timezone: ${timezone}`,
    "Interpret relative time references like today, tomorrow, this week, morning, and evening in this timezone.",
    "Use the time.now tool when you need the exact current date or current time."
  ].join("\n");
}
