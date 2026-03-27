import type { ExtensionToolRuntimeContext } from "../../../runtime/src/features/extensions/tool-runtime.js";
import { systemHealthTool } from "./system-health-tool.js";
import { timeNowTool } from "./time-now-tool.js";
import { createWebSearchTool } from "./web-search-tool.js";

export function registerTools(input: ExtensionToolRuntimeContext): void {
  input.toolRegistry.register(systemHealthTool);
  input.toolRegistry.register(timeNowTool);
  if (input.config.braveApiKey) {
    input.toolRegistry.register(createWebSearchTool(input.config.braveApiKey));
  }
}
