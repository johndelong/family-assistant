import { and, desc, eq, ilike, or } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { randomUUID } from "node:crypto";
import { memoryEntries } from "../../db/schema.js";

export type MemoryScope = "private" | "shared";

export interface MemoryEntryRecord {
  id: string;
  householdId: string;
  personId: string | null;
  scope: MemoryScope;
  content: string;
  createdAt: Date;
}

function mapMemoryEntry(row: typeof memoryEntries.$inferSelect): MemoryEntryRecord {
  return {
    ...row,
    scope: row.scope as MemoryScope
  };
}

export class MemoryRepository {
  constructor(private readonly db: NodePgDatabase) {}

  async create(input: {
    householdId: string;
    personId?: string;
    scope: MemoryScope;
    content: string;
  }): Promise<MemoryEntryRecord> {
    const record: MemoryEntryRecord = {
      id: randomUUID(),
      householdId: input.householdId,
      personId: input.scope === "private" ? input.personId ?? null : null,
      scope: input.scope,
      content: input.content,
      createdAt: new Date()
    };

    await this.db.insert(memoryEntries).values(record);
    return record;
  }

  async searchForPerson(input: {
    householdId: string;
    personId: string;
    query?: string;
    limit?: number;
  }): Promise<MemoryEntryRecord[]> {
    const constraints = [
      eq(memoryEntries.householdId, input.householdId),
      or(
        and(eq(memoryEntries.scope, "private"), eq(memoryEntries.personId, input.personId)),
        eq(memoryEntries.scope, "shared")
      )
    ];

    if (input.query && input.query.trim().length > 0) {
      constraints.push(ilike(memoryEntries.content, `%${input.query.trim()}%`));
    }

    return this.db
      .select()
      .from(memoryEntries)
      .where(and(...constraints))
      .orderBy(desc(memoryEntries.createdAt))
      .limit(input.limit ?? 5)
      .then((rows) => rows.map(mapMemoryEntry));
  }
}
