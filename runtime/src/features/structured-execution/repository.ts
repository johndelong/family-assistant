import { desc, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { randomUUID } from "node:crypto";
import { structuredExecutionRuns } from "../../db/schema.js";

export interface StructuredExecutionRun {
  id: string;
  requestId?: string;
  personId?: string;
  skillName: string;
  runtime: string;
  status: "running" | "awaiting_approval" | "completed" | "failed";
  messageText: string;
  currentStepId?: string;
  state?: Record<string, unknown>;
  resumeToken?: string;
  trace?: Record<string, unknown>;
  result?: string;
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
}

function mapRun(row: typeof structuredExecutionRuns.$inferSelect): StructuredExecutionRun {
  return {
    id: row.id,
    ...(row.requestId ? { requestId: row.requestId } : {}),
    ...(row.personId ? { personId: row.personId } : {}),
    skillName: row.skillName,
    runtime: row.runtime,
    status: row.status as StructuredExecutionRun["status"],
    messageText: row.messageText,
    ...(row.currentStepId ? { currentStepId: row.currentStepId } : {}),
    ...(row.state ? { state: row.state as Record<string, unknown> } : {}),
    ...(row.resumeToken ? { resumeToken: row.resumeToken } : {}),
    ...(row.trace ? { trace: row.trace as Record<string, unknown> } : {}),
    ...(row.result ? { result: row.result } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.completedAt ? { completedAt: row.completedAt } : {})
  };
}

export class StructuredExecutionRunRepository {
  constructor(private readonly db: NodePgDatabase) {}

  async createRun(input: {
    requestId?: string;
    personId?: string;
    skillName: string;
    runtime: string;
    messageText: string;
    trace?: Record<string, unknown>;
  }): Promise<StructuredExecutionRun> {
    const now = new Date();
    const id = randomUUID();

    await this.db.insert(structuredExecutionRuns).values({
      id,
      ...(input.requestId ? { requestId: input.requestId } : {}),
      ...(input.personId ? { personId: input.personId } : {}),
      skillName: input.skillName,
      runtime: input.runtime,
      status: "running",
      messageText: input.messageText,
      currentStepId: null,
      state: null,
      resumeToken: null,
      ...(input.trace ? { trace: input.trace } : {}),
      createdAt: now,
      updatedAt: now
    });

    return {
      id,
      ...(input.requestId ? { requestId: input.requestId } : {}),
      ...(input.personId ? { personId: input.personId } : {}),
      skillName: input.skillName,
      runtime: input.runtime,
      status: "running",
      messageText: input.messageText,
      ...(input.trace ? { trace: input.trace } : {}),
      createdAt: now,
      updatedAt: now
    };
  }

  async pauseRun(input: {
    id: string;
    currentStepId: string;
    state: Record<string, unknown>;
    trace?: Record<string, unknown>;
    result?: string;
  }): Promise<StructuredExecutionRun> {
    const now = new Date();
    const resumeToken = randomUUID();

    const [row] = await this.db
      .update(structuredExecutionRuns)
      .set({
        status: "awaiting_approval",
        currentStepId: input.currentStepId,
        state: input.state,
        resumeToken,
        ...(input.trace ? { trace: input.trace } : {}),
        ...(input.result ? { result: input.result } : {}),
        updatedAt: now,
        completedAt: null
      })
      .where(eq(structuredExecutionRuns.id, input.id))
      .returning();

    if (!row) {
      throw new Error(`Structured execution run not found: ${input.id}`);
    }

    return mapRun(row);
  }

  async markRunning(input: {
    id: string;
    trace?: Record<string, unknown>;
  }): Promise<StructuredExecutionRun> {
    const now = new Date();
    const [row] = await this.db
      .update(structuredExecutionRuns)
      .set({
        status: "running",
        ...(input.trace ? { trace: input.trace } : {}),
        updatedAt: now
      })
      .where(eq(structuredExecutionRuns.id, input.id))
      .returning();

    if (!row) {
      throw new Error(`Structured execution run not found: ${input.id}`);
    }

    return mapRun(row);
  }

  async completeRun(input: {
    id: string;
    status: "completed" | "failed";
    trace?: Record<string, unknown>;
    result?: string;
  }): Promise<void> {
    const now = new Date();
    await this.db
      .update(structuredExecutionRuns)
      .set({
        status: input.status,
        currentStepId: null,
        state: null,
        resumeToken: null,
        ...(input.trace ? { trace: input.trace } : {}),
        ...(input.result ? { result: input.result } : {}),
        updatedAt: now,
        completedAt: now
      })
      .where(eq(structuredExecutionRuns.id, input.id));
  }

  async findById(id: string): Promise<StructuredExecutionRun | undefined> {
    const [row] = await this.db
      .select()
      .from(structuredExecutionRuns)
      .where(eq(structuredExecutionRuns.id, id))
      .limit(1);

    return row ? mapRun(row) : undefined;
  }

  async findByRequestId(requestId: string): Promise<StructuredExecutionRun[]> {
    const rows = await this.db
      .select()
      .from(structuredExecutionRuns)
      .where(eq(structuredExecutionRuns.requestId, requestId));

    return rows.map(mapRun);
  }

  async findByResumeToken(resumeToken: string): Promise<StructuredExecutionRun | undefined> {
    const [row] = await this.db
      .select()
      .from(structuredExecutionRuns)
      .where(eq(structuredExecutionRuns.resumeToken, resumeToken))
      .limit(1);

    return row ? mapRun(row) : undefined;
  }

  async listRecent(limit = 20): Promise<StructuredExecutionRun[]> {
    const rows = await this.db
      .select()
      .from(structuredExecutionRuns)
      .orderBy(desc(structuredExecutionRuns.updatedAt))
      .limit(limit);

    return rows.map(mapRun);
  }
}
