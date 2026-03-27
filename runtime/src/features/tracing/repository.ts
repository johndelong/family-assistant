import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { TraceEvent } from "./writer.js";

export interface TraceSummary {
  requestId: string;
  path: string;
  modifiedAt: string;
}

export class TraceRepository {
  constructor(private readonly dataDir: string) {}

  async list(): Promise<TraceSummary[]> {
    const tracesDir = join(this.dataDir, "traces");
    await mkdir(tracesDir, { recursive: true });

    const entries = await readdir(tracesDir, { withFileTypes: true });

    const traceEntries = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"));

    const summaries = await Promise.all(traceEntries.map(async (entry) => {
      const path = join(tracesDir, entry.name);
      const fileStats = await stat(path);

      return {
        requestId: entry.name.replace(/\.jsonl$/, ""),
        path,
        modifiedAt: fileStats.mtime.toISOString()
      };
    }));

    return summaries.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
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
