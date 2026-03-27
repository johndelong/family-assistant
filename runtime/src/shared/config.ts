import { config as loadDotEnv } from "dotenv";
import { resolve } from "node:path";
import { z } from "zod";
import { repositoryRootDir } from "./paths.js";

loadDotEnv({ path: resolve(repositoryRootDir, ".env") });

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
  OPENAI_DIRECT_ACTION_MODEL: z.string().min(1).optional(),
  FRONTEND_ORIGINS: z.string().optional(),
  CRON_ENABLED: z.coerce.boolean().default(true),
  CRON_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(30000),
  BRAVE_API_KEY: z.string().min(1).optional(),
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
  openAiDirectActionModel?: string;
  frontendOrigins: string[];
  cronEnabled: boolean;
  cronPollIntervalMs: number;
  braveApiKey?: string;
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
    dataDir: resolve(repositoryRootDir, parsed.DATA_DIR),
    openAiModel: parsed.OPENAI_MODEL,
    frontendOrigins: parsed.FRONTEND_ORIGINS
      ? parsed.FRONTEND_ORIGINS.split(",").map((value) => value.trim()).filter(Boolean)
      : [],
    cronEnabled: parsed.CRON_ENABLED,
    cronPollIntervalMs: parsed.CRON_POLL_INTERVAL_MS,
    telegramLongPollTimeoutSec: parsed.TELEGRAM_LONG_POLL_TIMEOUT_SEC,
    ...(parsed.DATABASE_URL ? { databaseUrl: parsed.DATABASE_URL } : {}),
    ...(parsed.ENCRYPTION_MASTER_KEY ? { encryptionMasterKey: parsed.ENCRYPTION_MASTER_KEY } : {}),
    ...(parsed.OPENAI_API_KEY ? { openAiApiKey: parsed.OPENAI_API_KEY } : {}),
    ...(parsed.OPENAI_DIRECT_ACTION_MODEL ? { openAiDirectActionModel: parsed.OPENAI_DIRECT_ACTION_MODEL } : {}),
    ...(parsed.BRAVE_API_KEY ? { braveApiKey: parsed.BRAVE_API_KEY } : {}),
    ...(parsed.ADMIN_API_TOKEN ? { adminApiToken: parsed.ADMIN_API_TOKEN } : {}),
    ...(parsed.TELEGRAM_BOT_TOKEN ? { telegramBotToken: parsed.TELEGRAM_BOT_TOKEN } : {})
  };
}
