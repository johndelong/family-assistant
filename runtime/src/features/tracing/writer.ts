import { mkdir, appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { MonitorEventHub } from "../monitor/hub.js";

export interface TraceEvent {
  timestamp: string;
  requestId: string;
  stage:
    | "request.received"
    | "identity.resolved"
    | "identity.unpaired"
    | "llm.invoked"
    | "request.completed"
    | "structured_execution.paused"
    | "structured_execution.resumed"
    | "structured_execution.completed";
  payload: Record<string, unknown>;
}

export class TraceWriter {
  constructor(
    private readonly dataDir: string,
    private readonly monitorHub?: MonitorEventHub
  ) {}

  async write(event: TraceEvent): Promise<void> {
    const tracesDir = join(this.dataDir, "traces");
    await mkdir(tracesDir, { recursive: true });
    const filePath = join(tracesDir, `${event.requestId}.jsonl`);
    await appendFile(filePath, `${JSON.stringify(event)}\n`, "utf8");
    this.monitorHub?.publish({
      type: "trace.event",
      event
    });
  }
}
