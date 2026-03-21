import { z } from "zod";
import type { Tool, ToolRegistry } from "../../core/tools.js";

interface ToolCatalogResult {
  tools: Array<{
    id: string;
    description: string;
    exposure: "conversation" | "cli_only";
    targetScope: "self" | "household" | "owner_shared" | "system";
  }>;
}

const toolCatalogSchema = z.object({
  query: z.string().min(1).optional()
});

type ToolCatalogInput = z.infer<typeof toolCatalogSchema>;

const toolCatalogJsonSchema = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "Optional search phrase to narrow tools by name or description"
    }
  },
  additionalProperties: false
} satisfies Record<string, unknown>;

export function createToolCatalogTool(toolRegistry: ToolRegistry): Tool<ToolCatalogInput, ToolCatalogResult> {
  return {
    id: "tool.catalog",
    description: "Inspect the tools available in this runtime when you need to see what capabilities are currently available",
    inputSchema: toolCatalogSchema,
    inputJsonSchema: toolCatalogJsonSchema,
    requiredCapabilities: [],
    exposure: "conversation",
    approvalPolicy: "never",
    targetScope: "system",
    async execute(input): Promise<ToolCatalogResult> {
      const normalizedQuery = input.query?.trim().toLowerCase();
      const tools = toolRegistry
        .listConversationTools()
        .filter((tool) => {
          if (!normalizedQuery) {
            return true;
          }

          const haystack = `${tool.id} ${tool.description}`.toLowerCase();
          return haystack.includes(normalizedQuery);
        })
        .map((tool) => ({
          id: tool.id,
          description: tool.description,
          exposure: tool.exposure,
          targetScope: tool.targetScope
        }));

      return { tools };
    }
  };
}
