import pino, { type Logger } from "pino";

export function createLogger(level: Logger["level"]): Logger {
  return pino({
    level,
    base: null,
    redact: {
      paths: [
        "*.apiKey",
        "*.accessToken",
        "*.refreshToken",
        "*.password",
        "*.secret",
        "*.credentials",
        "*.encryptedCredentials"
      ],
      censor: "[REDACTED]"
    }
  });
}
