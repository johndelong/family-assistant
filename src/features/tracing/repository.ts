import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { TraceEvent } from "./writer.js";

export interface TraceSummary {
  requestId: string;
  path: string;
}

export class TraceRepository {
  constructor(private readonly dataDir: string) {}

  async list(): Promise<TraceSummary[]> {
    const tracesDir = join(this.dataDir, "traces");
    await mkdir(tracesDir, { recursive: true });

    const entries = await readdir(tracesDir, { withFileTypes: true });

    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => ({
        requestId: entry.name.replace(/\.jsonl$/, ""),
        path: join(tracesDir, entry.name)
      }))
      .sort((left, right) => left.requestId.localeCompare(right.requestId));
  }

  async get(requestId: string): Promise<TraceEvent[]> {
    const filePath = join(this.dataDir, "traces", `${requestId}.jsonl`);
    const contents = await readFile(filePath, "utf8");

    return contents
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as TraceEvent);
  }
}
