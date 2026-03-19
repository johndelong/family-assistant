import { randomUUID } from "node:crypto";
import { Bot } from "grammy";
import type { Context } from "grammy";
import type { Logger } from "pino";
import type { ChannelAdapter, ChannelRecipient, InboundMessage, OutboundMessage } from "../core/channels.js";
import type { RequestIntakeService } from "../features/requests/service.js";
import { formatAcceptedRequestForUser } from "../features/requests/formatter.js";

interface TelegramAdapterOptions {
  botToken: string;
  logger: Logger;
  requestIntake: RequestIntakeService;
}

export class TelegramAdapter implements ChannelAdapter {
  readonly type = "telegram" as const;
  readonly #bot: Bot;
  readonly #logger: Logger;
  readonly #requestIntake: RequestIntakeService;
  #running = false;

  constructor(options: TelegramAdapterOptions) {
    this.#bot = new Bot(options.botToken);
    this.#logger = options.logger;
    this.#requestIntake = options.requestIntake;

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
      const requestId = randomUUID();
      const outcome = await this.#requestIntake.acceptInboundMessage({
        requestId,
        message: inbound
      });

      await ctx.reply(formatAcceptedRequestForUser(outcome));
    } finally {
      stopTyping();
    }
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
