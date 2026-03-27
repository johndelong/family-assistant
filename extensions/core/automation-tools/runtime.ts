import type { ExtensionToolRuntimeContext } from "../../../runtime/src/features/extensions/tool-runtime.js";
import {
  createCronCreateTool,
  createCronListTool,
  createCronPauseTool,
  createCronResumeTool,
  createCronRunNowTool
} from "./cron-tools.js";

export function registerTools(input: ExtensionToolRuntimeContext): void {
  if (!input.cron || !input.cronRepository) {
    return;
  }

  input.toolRegistry.register(createCronCreateTool(input.cron, input.extensionRegistry));
  input.toolRegistry.register(createCronListTool(input.cronRepository));
  input.toolRegistry.register(createCronPauseTool(input.cronRepository));
  input.toolRegistry.register(createCronResumeTool(input.cronRepository));
  input.toolRegistry.register(createCronRunNowTool(input.cron, input.cronRepository));
}
