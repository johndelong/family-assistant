import { z } from "zod";
import type { Tool } from "../../core/tools.js";
import { MemoryRepository } from "../memory/repository.js";

export interface MemorySearchResult {
  memories: Array<{
    id: string;
    scope: string;
    content: string;
    createdAt: string;
  }>;
}

type MemorySearchInput = {
  query?: string | undefined;
  limit?: number | undefined;
};

export function createMemorySearchTool(memoryRepository: MemoryRepository): Tool<MemorySearchInput, MemorySearchResult> {
  return {
    id: "memory.search",
    description: "Search personal and shared household memory available to the current user",
    inputSchema: z.object({
      query: z.string().optional(),
      limit: z.number().int().positive().max(20).optional()
    }),
    inputJsonSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false
    },
    requiredCapabilities: [],
    exposure: "conversation",
    approvalPolicy: "never",
    targetScope: "self",
    async execute(input, context): Promise<MemorySearchResult> {
      if (!context.person) {
        throw new Error("A resolved person is required to search memory");
      }

      const rows = await memoryRepository.searchForPerson({
        householdId: context.person.householdId,
        personId: context.person.id,
        ...(input.query ? { query: input.query } : {}),
        ...(input.limit ? { limit: input.limit } : {})
      });

      return {
        memories: rows.map((row) => ({
          id: row.id,
          scope: row.scope,
          content: row.content,
          createdAt: row.createdAt.toISOString()
        }))
      };
    }
  };
}
