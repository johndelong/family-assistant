import type { ExtensionToolRuntimeContext } from "../../../runtime/src/features/extensions/tool-runtime.js";
import { createAccountStatusTool } from "./account-status-tool.js";
import {
  createRuntimePreferenceStatusTool,
  createSetProgressVisibilityTool
} from "./runtime-preference-tools.js";

export function registerTools(input: ExtensionToolRuntimeContext): void {
  if (input.integrations) {
    input.toolRegistry.register(createAccountStatusTool(input.integrations));
  }

  if (input.runtimePreferences) {
    input.toolRegistry.register(createRuntimePreferenceStatusTool(input.runtimePreferences));
    input.toolRegistry.register(createSetProgressVisibilityTool(input.runtimePreferences));
  }
}
