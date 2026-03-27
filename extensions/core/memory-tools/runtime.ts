import type { ExtensionToolRuntimeContext } from "../../../runtime/src/features/extensions/tool-runtime.js";
import { createMemorySearchTool } from "./memory-search-tool.js";
import { createMemoryStoreTool } from "./memory-store-tool.js";

export function registerTools(input: ExtensionToolRuntimeContext): void {
  if (!input.memory) {
    return;
  }

  input.toolRegistry.register(createMemoryStoreTool(input.memory));
  input.toolRegistry.register(createMemorySearchTool(input.memory));
}
