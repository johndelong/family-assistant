import { z } from "zod";
import type { Tool } from "../../core/tools.js";

export interface TimeNowResult {
  timezone: string;
  localDate: string;
  localTime: string;
  utcTimestamp: string;
}

export const timeNowTool: Tool<Record<string, never>, TimeNowResult> = {
  id: "time.now",
  description: "Return the current runtime date, time, timezone, and UTC timestamp",
  inputSchema: z.object({}),
  inputJsonSchema: {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false
  },
  requiredCapabilities: [],
  exposure: "conversation",
  approvalPolicy: "never",
  targetScope: "self",
  async execute(): Promise<TimeNowResult> {
    const now = new Date();
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

    return {
      timezone,
      localDate: new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric"
      }).format(now),
      localTime: new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
        hour12: true,
        timeZoneName: "short"
      }).format(now),
      utcTimestamp: now.toISOString()
    };
  }
};
