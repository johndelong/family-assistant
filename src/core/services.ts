import type { Logger } from "pino";
import type { AppConfig } from "../shared/config.js";
import type { ToolRegistry } from "./tools.js";

export interface AppServices {
  config: AppConfig;
  logger: Logger;
  toolRegistry: ToolRegistry;
}

