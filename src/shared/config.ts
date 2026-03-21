import { config as loadDotEnv } from "dotenv";
import { z } from "zod";

loadDotEnv();

const appConfigSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  DATA_DIR: z.string().default(".family-assistant"),
  DATABASE_URL: z.string().url().optional(),
  ENCRYPTION_MASTER_KEY: z.string().min(32).optional(),
  OPENAI_API_KEY: z.string().min(1).optional(),
  OPENAI_MODEL: z.string().default("gpt-5-mini"),
  ADMIN_API_TOKEN: z.string().min(1).optional(),
  TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
  TELEGRAM_LONG_POLL_TIMEOUT_SEC: z.coerce.number().int().positive().max(60).default(30)
});

export interface AppConfig {
  environment: "development" | "test" | "production";
  host: string;
  port: number;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  dataDir: string;
  databaseUrl?: string;
  encryptionMasterKey?: string;
  openAiApiKey?: string;
  openAiModel: string;
  adminApiToken?: string;
  telegramBotToken?: string;
  telegramLongPollTimeoutSec: number;
}

export function loadAppConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = appConfigSchema.parse(source);

  return {
    environment: parsed.NODE_ENV,
    host: parsed.HOST,
    port: parsed.PORT,
    logLevel: parsed.LOG_LEVEL,
    dataDir: parsed.DATA_DIR,
    openAiModel: parsed.OPENAI_MODEL,
    telegramLongPollTimeoutSec: parsed.TELEGRAM_LONG_POLL_TIMEOUT_SEC,
    ...(parsed.DATABASE_URL ? { databaseUrl: parsed.DATABASE_URL } : {}),
    ...(parsed.ENCRYPTION_MASTER_KEY ? { encryptionMasterKey: parsed.ENCRYPTION_MASTER_KEY } : {}),
    ...(parsed.OPENAI_API_KEY ? { openAiApiKey: parsed.OPENAI_API_KEY } : {}),
    ...(parsed.ADMIN_API_TOKEN ? { adminApiToken: parsed.ADMIN_API_TOKEN } : {}),
    ...(parsed.TELEGRAM_BOT_TOKEN ? { telegramBotToken: parsed.TELEGRAM_BOT_TOKEN } : {})
  };
}
