import { z } from "zod";
import type { Tool } from "../../core/tools.js";

export interface SystemHealthResult {
  status: "ok";
  service: "family-assistant";
  timestamp: string;
}

export const systemHealthTool: Tool<Record<string, never>, SystemHealthResult> = {
  id: "system.health",
  description: "Return basic system health for the assistant service",
  inputSchema: z.object({}),
  requiredCapabilities: [],
  exposure: "conversation",
  approvalPolicy: "never",
  targetScope: "self",
  async execute(): Promise<SystemHealthResult> {
    return {
      status: "ok",
      service: "family-assistant",
      timestamp: new Date().toISOString()
    };
  }
};
