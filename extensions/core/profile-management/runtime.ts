import type { ExtensionToolRuntimeContext } from "../../../runtime/src/features/extensions/tool-runtime.js";
import {
  createAssistantIdentitySetTool,
  createAssistantProfileSetTool,
  createHouseholdProfileSetTool,
  createPersonProfileSetTool
} from "./profile-tools.js";

export function registerTools(input: ExtensionToolRuntimeContext): void {
  if (!input.profiles) {
    return;
  }

  input.toolRegistry.register(createPersonProfileSetTool(input.profiles));
  input.toolRegistry.register(createHouseholdProfileSetTool(input.profiles));
  input.toolRegistry.register(createAssistantProfileSetTool(input.profiles));
  input.toolRegistry.register(createAssistantIdentitySetTool(input.profiles));
}
