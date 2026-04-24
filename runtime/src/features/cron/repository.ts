import { and, asc, desc, eq, lte } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { randomUUID } from "node:crypto";
import { cronJobs, cronRuns } from "../../db/schema.js";

export type CronJobStatus = "active" | "paused";
export type CronJobSessionTarget = "isolated" | "main";
export type CronRunStatus = "running" | "completed" | "failed";
export type CronRunTrigger = "scheduled" | "manual";

export type CronJobPayload =
  | {
      kind: "agent_turn";
      prompt: string;
    }
  | {
      kind: "workflow";
      skillName: string;
      messageText: string;
    };

export type CronJobDelivery =
  | {
      type: "none";
    }
  | {
      type: "telegram";
    };

export interface CronJob {
  id: string;
  personId: string;
  name: string;
  status: CronJobStatus;
  schedule: string;
  timezone: string;
  sessionTarget: CronJobSessionTarget;
  payload: CronJobPayload;
  delivery: CronJobDelivery;
  lastRunAt?: Date;
  nextRunAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface CronRun {
  id: string;
  jobId: string;
  requestId?: string;
  trigger: CronRunTrigger;
  status: CronRunStatus;
  scheduledFor: Date;
  startedAt: Date;
  completedAt?: Date;
  output?: string;
  error?: string;
}

function mapCronJob(row: typeof cronJobs.$inferSelect): CronJob {
  return {
    id: row.id,
    personId: row.personId,
    name: row.name,
    status: row.status as CronJobStatus,
    schedule: row.schedule,
    timezone: row.timezone,
    sessionTarget: row.mode as CronJobSessionTarget,
    payload: row.target as CronJobPayload,
    delivery: (row.delivery as CronJobDelivery | null) ?? { type: "none" },
    ...(row.lastRunAt ? { lastRunAt: row.lastRunAt } : {}),
    nextRunAt: row.nextRunAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function mapCronRun(row: typeof cronRuns.$inferSelect): CronRun {
  return {
    id: row.id,
    jobId: row.jobId,
    ...(row.requestId ? { requestId: row.requestId } : {}),
    trigger: row.trigger as CronRunTrigger,
    status: row.status as CronRunStatus,
    scheduledFor: row.scheduledFor,
    startedAt: row.startedAt,
    ...(row.completedAt ? { completedAt: row.completedAt } : {}),
    ...(row.output ? { output: row.output } : {}),
    ...(row.error ? { error: row.error } : {})
  };
}

export class CronRepository {
  constructor(private readonly db: NodePgDatabase) {}

  async createJob(input: {
    personId: string;
    name: string;
    schedule: string;
    timezone: string;
    sessionTarget: CronJobSessionTarget;
    payload: CronJobPayload;
    delivery: CronJobDelivery;
    nextRunAt: Date;
  }): Promise<CronJob> {
    const now = new Date();
    const id = randomUUID();
    await this.db.insert(cronJobs).values({
      id,
      personId: input.personId,
      name: input.name,
      status: "active",
      schedule: input.schedule,
      timezone: input.timezone,
      mode: input.sessionTarget,
      target: input.payload,
      delivery: input.delivery,
      nextRunAt: input.nextRunAt,
      createdAt: now,
      updatedAt: now
    });

    return {
      id,
      personId: input.personId,
      name: input.name,
      status: "active",
      schedule: input.schedule,
      timezone: input.timezone,
      sessionTarget: input.sessionTarget,
      payload: input.payload,
      delivery: input.delivery,
      nextRunAt: input.nextRunAt,
      createdAt: now,
      updatedAt: now
    };
  }

  async listJobs(): Promise<CronJob[]> {
    const rows = await this.db.select().from(cronJobs).orderBy(asc(cronJobs.createdAt));
    return rows.map(mapCronJob);
  }

  async findJobById(id: string): Promise<CronJob | undefined> {
    const [row] = await this.db.select().from(cronJobs).where(eq(cronJobs.id, id)).limit(1);
    return row ? mapCronJob(row) : undefined;
  }

  async findDueJobs(now: Date, limit = 10): Promise<CronJob[]> {
    const rows = await this.db
      .select()
      .from(cronJobs)
      .where(and(
        eq(cronJobs.status, "active"),
        lte(cronJobs.nextRunAt, now)
      ))
      .orderBy(asc(cronJobs.nextRunAt))
      .limit(limit);

    return rows.map(mapCronJob);
  }

  async updateJobSchedule(input: {
    id: string;
    nextRunAt: Date;
    lastRunAt?: Date;
  }): Promise<void> {
    await this.db
      .update(cronJobs)
      .set({
        nextRunAt: input.nextRunAt,
        ...(input.lastRunAt ? { lastRunAt: input.lastRunAt } : {}),
        updatedAt: new Date()
      })
      .where(eq(cronJobs.id, input.id));
  }

  async updateJobStatus(input: {
    id: string;
    status: CronJobStatus;
  }): Promise<void> {
    await this.db
      .update(cronJobs)
      .set({
        status: input.status,
        updatedAt: new Date()
      })
      .where(eq(cronJobs.id, input.id));
  }

  async createRun(input: {
    jobId: string;
    requestId?: string;
    trigger: CronRunTrigger;
    scheduledFor: Date;
  }): Promise<CronRun> {
    const now = new Date();
    const id = randomUUID();
    await this.db.insert(cronRuns).values({
      id,
      jobId: input.jobId,
      ...(input.requestId ? { requestId: input.requestId } : {}),
      trigger: input.trigger,
      status: "running",
      scheduledFor: input.scheduledFor,
      startedAt: now
    });

    return {
      id,
      jobId: input.jobId,
      ...(input.requestId ? { requestId: input.requestId } : {}),
      trigger: input.trigger,
      status: "running",
      scheduledFor: input.scheduledFor,
      startedAt: now
    };
  }

  async completeRun(input: {
    id: string;
    status: "completed" | "failed";
    output?: string;
    error?: string;
  }): Promise<void> {
    await this.db
      .update(cronRuns)
      .set({
        status: input.status,
        completedAt: new Date(),
        ...(input.output ? { output: input.output } : {}),
        ...(input.error ? { error: input.error } : {})
      })
      .where(eq(cronRuns.id, input.id));
  }

  async listRunsForJob(jobId: string, limit = 20): Promise<CronRun[]> {
    const rows = await this.db
      .select()
      .from(cronRuns)
      .where(eq(cronRuns.jobId, jobId))
      .orderBy(desc(cronRuns.startedAt))
      .limit(limit);

    return rows.map(mapCronRun);
  }

  async listRecentRuns(limit = 20): Promise<CronRun[]> {
    const rows = await this.db
      .select()
      .from(cronRuns)
      .orderBy(desc(cronRuns.startedAt))
      .limit(limit);

    return rows.map(mapCronRun);
  }

  async listRunsForPerson(personId: string, limit = 20): Promise<Array<CronRun & { jobName: string }>> {
    const rows = await this.db
      .select({
        run: cronRuns,
        jobName: cronJobs.name
      })
      .from(cronRuns)
      .innerJoin(cronJobs, eq(cronRuns.jobId, cronJobs.id))
      .where(eq(cronJobs.personId, personId))
      .orderBy(desc(cronRuns.startedAt))
      .limit(limit);

    return rows.map((row) => ({
      ...mapCronRun(row.run),
      jobName: row.jobName
    }));
  }

  async deleteJob(id: string): Promise<void> {
    await this.db.delete(cronRuns).where(eq(cronRuns.jobId, id));
    await this.db.delete(cronJobs).where(eq(cronJobs.id, id));
  }
}
