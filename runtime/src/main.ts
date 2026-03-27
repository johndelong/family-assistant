import { createLogger } from "./shared/logger.js";
import { loadAppConfig } from "./shared/config.js";
import { createApp } from "./server/create-app.js";
import { createServerContext } from "./server/context.js";
import { TelegramAdapter } from "./channels/telegram-adapter.js";

async function main(): Promise<void> {
  const config = loadAppConfig();
  const logger = createLogger(config.logLevel);
  const context = await createServerContext(config, logger);
  const app = await createApp({ context });
  let telegramAdapter: TelegramAdapter | undefined;

  try {
    await app.listen({ host: config.host, port: config.port });
    logger.info({ host: config.host, port: config.port }, "family assistant server started");

    if (config.telegramBotToken && context.requestIntake) {
      telegramAdapter = new TelegramAdapter({
        botToken: config.telegramBotToken,
        logger,
        requestIntake: context.requestIntake
      });
      await telegramAdapter.start();
      logger.info("telegram adapter started");
    }
  } catch (error) {
    logger.error({ err: error }, "failed to start family assistant server");
    process.exitCode = 1;
  }

  const shutdown = async (): Promise<void> => {
    if (telegramAdapter) {
      await telegramAdapter.stop();
    }
    await app.close();
    await context.close();
  };

  process.on("SIGINT", () => {
    void shutdown();
  });

  process.on("SIGTERM", () => {
    void shutdown();
  });
}

void main();
