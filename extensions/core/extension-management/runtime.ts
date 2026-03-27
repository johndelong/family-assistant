import type { ExtensionToolRuntimeContext } from "../../../runtime/src/features/extensions/tool-runtime.js";
import {
  createExtensionInstallTool,
  createExtensionPackageTool,
  createExtensionRemoveTool
} from "./extension-tools.js";

export function registerTools(input: ExtensionToolRuntimeContext): void {
  if (!input.extensionManager) {
    return;
  }

  input.toolRegistry.register(createExtensionPackageTool(input.extensionManager));
  input.toolRegistry.register(createExtensionInstallTool(input.extensionManager));
  input.toolRegistry.register(createExtensionRemoveTool(input.extensionManager));
}
