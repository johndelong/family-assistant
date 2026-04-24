import type { InboundMessage } from "../../core/channels.js";
import type { Person } from "../../core/domain.js";
import { SessionRepository, type ConversationSessionRecord } from "./repository.js";

interface SessionCompactionPolicy {
  maxMessagesBeforeCompaction: number;
  retainRecentMessages: number;
}

export interface SessionSummarizer {
  summarize(input: {
    existingSummary?: string;
    messages: Array<{
      role: "user" | "assistant";
      content: string;
    }>;
  }): Promise<string>;
}

export interface SessionContext {
  session: ConversationSessionRecord;
  summary?: string;
  recentMessages: Array<{
    role: "user" | "assistant";
    content: string;
  }>;
}

export class SessionService {
  readonly #policy: SessionCompactionPolicy;

  constructor(
    private readonly sessions: SessionRepository,
    private readonly summarizer?: SessionSummarizer,
    policy?: Partial<SessionCompactionPolicy>
  ) {
    this.#policy = {
      maxMessagesBeforeCompaction: policy?.maxMessagesBeforeCompaction ?? 12,
      retainRecentMessages: policy?.retainRecentMessages ?? 6
    };
  }

  async loadContext(input: {
    person: Person;
    message: InboundMessage;
  }): Promise<SessionContext> {
    const session = await this.sessions.getOrCreateSession({
      personId: input.person.id,
      channelType: input.message.channelType,
      externalUserId: input.message.externalUserId,
      ...(input.message.chatId ? { chatId: input.message.chatId } : {})
    });

    const recentMessages = await this.sessions.listRecentMessages(session.id, 8);

    return {
      session,
      ...(session.summary ? { summary: session.summary } : {}),
      recentMessages: recentMessages.map((message) => ({
        role: message.role,
        content: message.content
      }))
    };
  }

  async recordTurn(input: {
    sessionId: string;
    userMessage: string;
    assistantMessage: string;
  }): Promise<void> {
    await this.sessions.appendMessage({
      sessionId: input.sessionId,
      role: "user",
      content: input.userMessage
    });

    await this.sessions.appendMessage({
      sessionId: input.sessionId,
      role: "assistant",
      content: input.assistantMessage
    });

    await this.#compactIfNeeded(input.sessionId);
  }

  async resetContext(input: {
    person: Person;
    message: InboundMessage;
  }): Promise<boolean> {
    const session = await this.sessions.findSessionByParticipant({
      personId: input.person.id,
      channelType: input.message.channelType,
      externalUserId: input.message.externalUserId,
      ...(input.message.chatId ? { chatId: input.message.chatId } : {})
    });

    if (!session) {
      return false;
    }

    await this.sessions.deleteSession(session.id);
    return true;
  }

  async #compactIfNeeded(sessionId: string): Promise<void> {
    if (!this.summarizer) {
      return;
    }

    const messages = await this.sessions.listMessages(sessionId);
    if (messages.length <= this.#policy.maxMessagesBeforeCompaction) {
      return;
    }

    const cutoff = Math.max(messages.length - this.#policy.retainRecentMessages, 0);
    const toCompact = messages.slice(0, cutoff);
    if (toCompact.length === 0) {
      return;
    }

    const currentContext = await this.loadContextFromSessionId(sessionId);
    const summary = await this.summarizer.summarize({
      ...(currentContext.summary ? { existingSummary: currentContext.summary } : {}),
      messages: toCompact.map((message) => ({
        role: message.role,
        content: message.content
      }))
    });

    if (!summary) {
      return;
    }

    await this.sessions.updateSummary(sessionId, summary);
    await this.sessions.deleteMessages(toCompact.map((message) => message.id));
  }

  async loadContextFromSessionId(sessionId: string): Promise<SessionContext> {
    const allMessages = await this.sessions.listMessages(sessionId);
    const recentMessages = allMessages.slice(-8).map((message) => ({
      role: message.role,
      content: message.content
    }));

    const [session] = await Promise.all([
      this.sessions.getSessionById(sessionId)
    ]);

    return {
      session,
      ...(session.summary ? { summary: session.summary } : {}),
      recentMessages
    };
  }
}
