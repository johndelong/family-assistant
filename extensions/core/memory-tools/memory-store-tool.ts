import { z } from "../../../runtime/src/core/zod.js";
import type { Tool } from "../../../runtime/src/core/tools.js";
import { type MemoryScope, type MemoryRepository } from "../../../runtime/src/features/memory/repository.js";

export interface MemoryStoreResult {
  memoryId: string;
  scope: MemoryScope;
  content: string;
  createdAt: string;
}

type MemoryStoreInput = {
  content: string;
  scope?: MemoryScope | undefined;
};

export function createMemoryStoreTool(memoryRepository: MemoryRepository): Tool<MemoryStoreInput, MemoryStoreResult> {
  return {
    id: "memory.store",
    description: "Store durable assistant memory. Use private for person-specific context and shared for household-wide context.",
    inputSchema: z.object({
      content: z.string().min(1),
      scope: z.enum(["private", "shared"]).optional()
    }),
    inputJsonSchema: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "The memory content to store"
        },
        scope: {
          type: "string",
          enum: ["private", "shared"],
          description: "Use 'private' for one person's preferences or facts, and 'shared' for household routines, schedules, or family-wide context"
        }
      },
      required: ["content", "scope"],
      additionalProperties: false
    },
    requiredCapabilities: [],
    exposure: "conversation",
    approvalPolicy: "never",
    targetScope: "self",
    async execute(input, context): Promise<MemoryStoreResult> {
      if (!context.person) {
        throw new Error("A resolved person is required to store memory");
      }

      const scope = input.scope ?? "private";
      const record = await memoryRepository.create({
        householdId: context.person.householdId,
        ...(scope === "private" ? { personId: context.person.id } : {}),
        scope,
        content: input.content
      });

      return {
        memoryId: record.id,
        scope: record.scope,
        content: record.content,
        createdAt: record.createdAt.toISOString()
      };
    }
  };
}
