import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import type { AppConfig } from "../../shared/config.js";
import type { ToolRegistry } from "../../core/tools.js";
import type { Logger } from "pino";
import type { ExtensionRegistry, RegisteredExtension } from "./registry.js";
import type { MemoryRepository } from "../memory/repository.js";
import type { IntegrationRepository } from "../integrations/repository.js";
import type { PersonPreferenceRepository } from "../preferences/repository.js";
import type { ProfileRepository } from "../profiles/repository.js";
import type { CronService } from "../cron/service.js";
import type { CronRepository } from "../cron/repository.js";
import type { ExtensionManager } from "./manager.js";

export interface ExtensionToolRuntimeContext {
  config: AppConfig;
  logger: Logger;
  toolRegistry: ToolRegistry;
  extensionRegistry: ExtensionRegistry;
  memory?: MemoryRepository;
  integrations?: IntegrationRepository;
  runtimePreferences?: PersonPreferenceRepository;
  profiles?: ProfileRepository;
  cron?: CronService;
  cronRepository?: CronRepository;
  extensionManager?: ExtensionManager;
}

interface ExtensionToolRuntimeModule {
  registerTools(input: ExtensionToolRuntimeContext): Promise<void> | void;
}

export async function registerExtensionTools(input: ExtensionToolRuntimeContext): Promise<void> {
  for (const extension of input.extensionRegistry.list()) {
    if (!extension.manifest.toolRuntime?.module) {
      continue;
    }

    await registerExtensionToolRuntime(extension, input);
  }
}

async function registerExtensionToolRuntime(
  extension: RegisteredExtension,
  context: ExtensionToolRuntimeContext
): Promise<void> {
  const runtime = extension.manifest.toolRuntime;
  if (!runtime) {
    return;
  }

  const modulePath = resolve(extension.directory, runtime.module);
  const imported = await import(pathToFileURL(modulePath).href) as Partial<ExtensionToolRuntimeModule> & {
    default?: Partial<ExtensionToolRuntimeModule> | ((input: ExtensionToolRuntimeContext) => Promise<void> | void);
  };
  const registerTools = imported.registerTools
    ?? (typeof imported.default === "function" ? imported.default : imported.default?.registerTools);

  if (typeof registerTools !== "function") {
    throw new Error(`Extension runtime module must export registerTools(): ${extension.name}`);
  }

  await registerTools(context);
}
