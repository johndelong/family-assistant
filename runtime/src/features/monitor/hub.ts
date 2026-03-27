import type { TraceEvent } from "../tracing/writer.js";

export interface MonitorTraceEvent {
  type: "trace.event";
  event: TraceEvent;
}

export interface MonitorCronRunEvent {
  type: "cron.run";
  event: {
    id: string;
    jobId: string;
    requestId?: string;
    trigger: "scheduled" | "manual";
    status: "running" | "completed" | "failed";
    startedAt: string;
    completedAt?: string;
    output?: string;
    error?: string;
  };
}

export interface MonitorStructuredExecutionEvent {
  type: "structured_execution.run";
  event: {
    id: string;
    requestId?: string;
    skillName: string;
    runtime: string;
    status: "running" | "awaiting_approval" | "completed" | "failed";
    messageText: string;
    updatedAt: string;
    completedAt?: string;
    result?: string;
  };
}

export type MonitorEvent =
  | MonitorTraceEvent
  | MonitorCronRunEvent
  | MonitorStructuredExecutionEvent;

type MonitorListener = (event: MonitorEvent) => void;

export class MonitorEventHub {
  readonly #listeners = new Set<MonitorListener>();

  subscribe(listener: MonitorListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  publish(event: MonitorEvent): void {
    for (const listener of this.#listeners) {
      listener(event);
    }
  }
}
