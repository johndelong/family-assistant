import type { Person } from "../../core/domain.js";
import { MemoryRepository, type MemoryEntryRecord } from "./repository.js";

export interface RetrievedMemory {
  id: string;
  scope: "private" | "shared";
  content: string;
  createdAt: string;
}

export class MemoryRetrievalService {
  constructor(private readonly memoryRepository: MemoryRepository) {}

  async retrieveForMessage(input: {
    person: Person;
    messageText: string;
    limit?: number;
  }): Promise<RetrievedMemory[]> {
    const query = normalizeQuery(input.messageText);
    const lexicalMatches = await this.memoryRepository.searchForPerson({
      householdId: input.person.householdId,
      personId: input.person.id,
      ...(query ? { query } : {}),
      limit: input.limit ?? 5
    });

    if (lexicalMatches.length > 0 || query.length === 0) {
      return lexicalMatches.map(toRetrievedMemory);
    }

    const recentMatches = await this.memoryRepository.searchForPerson({
      householdId: input.person.householdId,
      personId: input.person.id,
      limit: Math.min(input.limit ?? 5, 3)
    });

    return recentMatches.map(toRetrievedMemory);
  }
}

function normalizeQuery(messageText: string): string {
  return messageText
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 200);
}

function toRetrievedMemory(record: MemoryEntryRecord): RetrievedMemory {
  return {
    id: record.id,
    scope: record.scope,
    content: record.content,
    createdAt: record.createdAt.toISOString()
  };
}
