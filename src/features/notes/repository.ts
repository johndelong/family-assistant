import { desc, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { randomUUID } from "node:crypto";
import { notes } from "../../db/schema.js";

export interface NoteRecord {
  id: string;
  personId: string;
  content: string;
  createdAt: Date;
}

export class NotesRepository {
  constructor(private readonly db: NodePgDatabase) {}

  async create(input: { personId: string; content: string }): Promise<NoteRecord> {
    const note: NoteRecord = {
      id: randomUUID(),
      personId: input.personId,
      content: input.content,
      createdAt: new Date()
    };

    await this.db.insert(notes).values(note);
    return note;
  }

  async listByPerson(personId: string, limit = 5): Promise<NoteRecord[]> {
    return this.db
      .select()
      .from(notes)
      .where(eq(notes.personId, personId))
      .orderBy(desc(notes.createdAt))
      .limit(limit);
  }
}
