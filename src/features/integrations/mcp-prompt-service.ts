import type { IntegrationRepository } from "./repository.js";
import type { McpRuntimeManager } from "../mcp/runtime-manager.js";

export class McpPromptService {
  constructor(
    private readonly integrations: IntegrationRepository,
    private readonly runtimeManager: McpRuntimeManager
  ) {}

  async buildPromptSections(input: {
    toolIds: string[];
    maxPromptsPerConnection?: number;
  }): Promise<Array<{
    connectionId: string;
    integrationKey: string;
    promptName: string;
    content: string;
  }>> {
    const connectionIds = Array.from(new Set(
      input.toolIds
        .map(extractMcpConnectionId)
        .filter((value): value is string => Boolean(value))
    ));

    const sections: Array<{
      connectionId: string;
      integrationKey: string;
      promptName: string;
      content: string;
    }> = [];

    for (const connectionId of connectionIds) {
      const connection = await this.integrations.findConnectionById(connectionId);
      if (!connection) {
        continue;
      }

      let prompts;
      try {
        prompts = await this.runtimeManager.listPrompts(connection);
      } catch {
        continue;
      }

      let included = 0;

      for (const prompt of prompts) {
        if (included >= (input.maxPromptsPerConnection ?? 2)) {
          break;
        }

        const hasRequiredArguments = (prompt.arguments ?? []).some((argument) => argument.required);
        if (hasRequiredArguments) {
          continue;
        }

        try {
          const messages = await this.runtimeManager.getPrompt(connection, {
            name: prompt.name
          });
          const text = messages
            .map((message) => `[${message.role}] ${message.text}`)
            .join("\n")
            .trim();

          if (!text) {
            continue;
          }

          sections.push({
            connectionId,
            integrationKey: connection.integrationKey,
            promptName: prompt.name,
            content: `Integration prompt from ${connection.integrationKey} (${prompt.name}):\n${text}`
          });
          included += 1;
        } catch {
          continue;
        }
      }
    }

    return sections;
  }
}

function extractMcpConnectionId(toolId: string): string | undefined {
  const match = toolId.match(/^mcp\.([^.]+)\./);
  return match?.[1];
}
