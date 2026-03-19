import { z } from "zod";
import type { Tool } from "../../core/tools.js";
import { NotesRepository } from "../notes/repository.js";

export interface NoteStoreResult {
  noteId: string;
  content: string;
  createdAt: string;
}

export function createNoteStoreTool(notesRepository: NotesRepository): Tool<{ content: string }, NoteStoreResult> {
  return {
    id: "note.store",
    description: "Store a private note for the current user",
    inputSchema: z.object({
      content: z.string().min(1)
    }),
    requiredCapabilities: [],
    exposure: "conversation",
    approvalPolicy: "never",
    targetScope: "self",
    async execute(input, context): Promise<NoteStoreResult> {
      if (!context.person) {
        throw new Error("A resolved person is required to store notes");
      }

      const note = await notesRepository.create({
        personId: context.person.id,
        content: input.content
      });

      return {
        noteId: note.id,
        content: note.content,
        createdAt: note.createdAt.toISOString()
      };
    }
  };
}
