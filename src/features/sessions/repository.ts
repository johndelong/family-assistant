import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { randomUUID } from "node:crypto";
import type { ChannelType } from "../../core/domain.js";
import { conversationSessions, sessionMessages } from "../../db/schema.js";

export type SessionMessageRole = "user" | "assistant";

export interface ConversationSessionRecord {
  id: string;
  personId: string;
  channelType: ChannelType;
  externalUserId: string;
  chatId: string | null;
  summary: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SessionMessageRecord {
  id: string;
  sessionId: string;
  role: SessionMessageRole;
  content: string;
  createdAt: Date;
}

function mapSession(row: typeof conversationSessions.$inferSelect): ConversationSessionRecord {
  return {
    id: row.id,
    personId: row.personId,
    channelType: row.channelType as ChannelType,
    externalUserId: row.externalUserId,
    chatId: row.chatId,
    summary: row.summary,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function mapSessionMessage(row: typeof sessionMessages.$inferSelect): SessionMessageRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    role: row.role as SessionMessageRole,
    content: row.content,
    createdAt: row.createdAt
  };
}

export class SessionRepository {
  constructor(private readonly db: NodePgDatabase) {}

  async getOrCreateSession(input: {
    personId: string;
    channelType: ChannelType;
    externalUserId: string;
    chatId?: string;
  }): Promise<ConversationSessionRecord> {
    const [existing] = await this.db
      .select()
      .from(conversationSessions)
      .where(and(
        eq(conversationSessions.personId, input.personId),
        eq(conversationSessions.channelType, input.channelType),
        eq(conversationSessions.externalUserId, input.externalUserId),
        input.chatId
          ? eq(conversationSessions.chatId, input.chatId)
          : sql`${conversationSessions.chatId} is null`
      ))
      .limit(1);

    if (existing) {
      const updatedAt = new Date();
      await this.db
        .update(conversationSessions)
        .set({ updatedAt })
        .where(eq(conversationSessions.id, existing.id));

      return {
        ...mapSession(existing),
        updatedAt
      };
    }

    const record: ConversationSessionRecord = {
      id: randomUUID(),
      personId: input.personId,
      channelType: input.channelType,
      externalUserId: input.externalUserId,
      chatId: input.chatId ?? null,
      summary: null,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    await this.db.insert(conversationSessions).values(record);
    return record;
  }

  async appendMessage(input: {
    sessionId: string;
    role: SessionMessageRole;
    content: string;
  }): Promise<SessionMessageRecord> {
    const record: SessionMessageRecord = {
      id: randomUUID(),
      sessionId: input.sessionId,
      role: input.role,
      content: input.content,
      createdAt: new Date()
    };

    await this.db.insert(sessionMessages).values(record);
    await this.db
      .update(conversationSessions)
      .set({ updatedAt: record.createdAt })
      .where(eq(conversationSessions.id, input.sessionId));

    return record;
  }

  async listRecentMessages(sessionId: string, limit = 8): Promise<SessionMessageRecord[]> {
    const rows = await this.db
      .select()
      .from(sessionMessages)
      .where(eq(sessionMessages.sessionId, sessionId))
      .orderBy(desc(sessionMessages.createdAt))
      .limit(limit);

    return rows.map(mapSessionMessage).reverse();
  }

  async getSessionById(sessionId: string): Promise<ConversationSessionRecord> {
    const [row] = await this.db
      .select()
      .from(conversationSessions)
      .where(eq(conversationSessions.id, sessionId))
      .limit(1);

    if (!row) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    return mapSession(row);
  }

  async listMessages(sessionId: string): Promise<SessionMessageRecord[]> {
    const rows = await this.db
      .select()
      .from(sessionMessages)
      .where(eq(sessionMessages.sessionId, sessionId))
      .orderBy(desc(sessionMessages.createdAt));

    return rows.map(mapSessionMessage).reverse();
  }

  async updateSummary(sessionId: string, summary: string): Promise<void> {
    await this.db
      .update(conversationSessions)
      .set({
        summary,
        updatedAt: new Date()
      })
      .where(eq(conversationSessions.id, sessionId));
  }

  async deleteMessages(messageIds: string[]): Promise<void> {
    if (messageIds.length === 0) {
      return;
    }

    await this.db.delete(sessionMessages).where(inArray(sessionMessages.id, messageIds));
  }
}
