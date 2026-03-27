import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = dirname(fileURLToPath(import.meta.url));

export const runtimeRootDir = resolve(currentDir, "../..");
export const repositoryRootDir = resolve(runtimeRootDir, "..");
export const builtInPromptsDir = resolve(runtimeRootDir, "prompts");
export const extensionsRootDir = resolve(repositoryRootDir, "extensions");
export const coreExtensionsDir = resolve(extensionsRootDir, "core");
export const packageExtensionsDir = resolve(extensionsRootDir, "packages");
