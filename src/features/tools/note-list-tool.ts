import { z } from "zod";
import type { Tool } from "../../core/tools.js";
import { NotesRepository } from "../notes/repository.js";

export interface NoteListResult {
  notes: Array<{
    id: string;
    content: string;
    createdAt: string;
  }>;
}

export function createNoteListTool(notesRepository: NotesRepository): Tool<{ limit?: number | undefined }, NoteListResult> {
  return {
    id: "note.list",
    description: "List recent private notes for the current user",
    inputSchema: z.object({
      limit: z.number().int().positive().max(20).optional()
    }),
    requiredCapabilities: [],
    exposure: "conversation",
    approvalPolicy: "never",
    targetScope: "self",
    async execute(input, context): Promise<NoteListResult> {
      if (!context.person) {
        throw new Error("A resolved person is required to list notes");
      }

      const rows = await notesRepository.listByPerson(context.person.id, input.limit ?? 5);

      return {
        notes: rows.map((note) => ({
          id: note.id,
          content: note.content,
          createdAt: note.createdAt.toISOString()
        }))
      };
    }
  };
}
