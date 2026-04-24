import { randomUUID } from "node:crypto";
import { Bot } from "grammy";
import type { Context } from "grammy";
import type { Logger } from "pino";
import type { ChannelAdapter, ChannelRecipient, InboundMessage, OutboundMessage } from "../core/channels.js";
import type { IdentityResolutionService } from "../features/identity/service.js";
import type { RequestIntakeService } from "../features/requests/service.js";
import { formatAcceptedRequestForUser } from "../features/requests/formatter.js";
import type { SessionService } from "../features/sessions/service.js";

interface TelegramAdapterOptions {
  botToken: string;
  logger: Logger;
  requestIntake: RequestIntakeService;
  identityResolution: IdentityResolutionService;
  sessionService: SessionService | undefined;
}

export class TelegramAdapter implements ChannelAdapter {
  readonly type = "telegram" as const;
  readonly #bot: Bot;
  readonly #logger: Logger;
  readonly #requestIntake: RequestIntakeService;
  readonly #identityResolution: IdentityResolutionService;
  readonly #sessionService: SessionService | undefined;
  #running = false;

  constructor(options: TelegramAdapterOptions) {
    this.#bot = new Bot(options.botToken);
    this.#logger = options.logger;
    this.#requestIntake = options.requestIntake;
    this.#identityResolution = options.identityResolution;
    this.#sessionService = options.sessionService;

    this.#bot.catch((error) => {
      this.#logger.error({ err: error.error }, "telegram adapter error");
    });

    this.#bot.on("message:text", async (ctx) => {
      await this.#handleTextMessage(ctx);
    });
  }

  async start(): Promise<void> {
    if (this.#running) {
      return;
    }

    this.#running = true;
    await this.#bot.init();
    void this.#bot.start({
      allowed_updates: ["message"],
      onStart: () => {
        this.#logger.info("telegram adapter started with grammY long polling");
      }
    });
  }

  async stop(): Promise<void> {
    this.#running = false;
    this.#bot.stop();
  }

  async sendMessage(recipient: ChannelRecipient, message: OutboundMessage): Promise<void> {
    await this.#bot.api.sendMessage(recipient.externalId, message.text);
  }

  async normalizeInboundMessage(raw: unknown): Promise<InboundMessage> {
    const ctx = raw as Context;
    const text = ctx.message?.text?.trim();
    const from = ctx.from;
    const chatId = ctx.chat?.id;

    if (!text || !from || !chatId) {
      throw new Error("Unsupported Telegram update payload");
    }

    const displayName = [from.first_name, from.last_name].filter(Boolean).join(" ").trim();

    return {
      channelType: "telegram",
      externalUserId: String(from.id),
      chatId: String(chatId),
      text,
      receivedAt: new Date(),
      metadata: {
        username: from.username,
        displayName: displayName || undefined
      }
    };
  }

  async #handleTextMessage(ctx: Context): Promise<void> {
    if (!ctx.message?.text) {
      return;
    }

    const stopTyping = this.#startTypingLoop(ctx);

    const inbound = await this.normalizeInboundMessage(ctx);
    try {
      const commandReply = await this.#handleCommand(inbound);
      if (commandReply) {
        await ctx.reply(commandReply);
        return;
      }

      const requestId = randomUUID();
      const outcome = await this.#requestIntake.acceptInboundMessage({
        requestId,
        message: inbound,
        onProgress: async (message) => {
          await ctx.reply(formatProgressMessage(message));
        }
      });

      const replyText = formatAcceptedRequestForUser(outcome).trim() || "I processed that, but I do not have a message to send yet.";
      await ctx.reply(replyText);
    } finally {
      stopTyping();
    }
  }

  async #handleCommand(message: InboundMessage): Promise<string | null> {
    const text = message.text.trim();
    if (!text.startsWith("/")) {
      return null;
    }

    const command = text.split(/\s+/u, 1)[0]?.split("@")[0]?.toLowerCase();
    if (!command) {
      return null;
    }

    if (command === "/start") {
      return "You can chat with me naturally here. Try asking for help, creating automations, or managing your household tools.";
    }

    if (command === "/help") {
      return [
        "Available commands:",
        "/start - quick introduction",
        "/help - show this help",
        "/status - check whether this Telegram account is linked",
        "/new - clear the current conversation context"
      ].join("\n");
    }

    if (command === "/status") {
      const resolution = await this.#identityResolution.resolveInboundMessage(message);
      if (resolution.status === "resolved") {
        return `This Telegram account is linked to ${resolution.person.name} (${resolution.person.role}).`;
      }

      return `This Telegram account is not linked yet. Use the admin UI to pair it with code ${resolution.pairingRequest.code}.`;
    }

    if (command === "/new") {
      const resolution = await this.#identityResolution.resolveInboundMessage(message);
      if (resolution.status !== "resolved") {
        return `This Telegram account is not linked yet. Use the admin UI to pair it with code ${resolution.pairingRequest.code}.`;
      }

      if (!this.#sessionService) {
        return "Conversation reset is unavailable right now.";
      }

      const cleared = await this.#sessionService.resetContext({
        person: resolution.person,
        message
      });

      return cleared
        ? "Started a fresh conversation."
        : "There was no existing conversation context to clear.";
    }

    return null;
  }

  #startTypingLoop(ctx: Context): () => void {
    let active = true;

    const sendTyping = async (): Promise<void> => {
      try {
        await ctx.replyWithChatAction("typing");
      } catch (error) {
        this.#logger.warn({ err: error }, "failed to send telegram typing indicator");
      }
    };

    void sendTyping();

    const timer = setInterval(() => {
      if (!active) {
        return;
      }

      void sendTyping();
    }, 4_000);

    timer.unref();

    return () => {
      active = false;
      clearInterval(timer);
    };
  }
}

function formatProgressMessage(message: string): string {
  const normalized = message.trim();
  if (normalized.length === 0) {
    return "⏳ Working...";
  }

  return `⏳ Working: ${normalized}`;
}
