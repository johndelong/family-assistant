import { randomUUID } from "node:crypto";
import { CronExpressionParser } from "cron-parser";
import type { InboundMessage } from "../../core/channels.js";
import type { Person } from "../../core/domain.js";
import type { MonitorEventHub } from "../monitor/hub.js";
import type { OrchestrationService } from "../orchestration/service.js";
import type { PersonRepository } from "../persons/repository.js";
import type { TraceWriter } from "../tracing/writer.js";
import type { CronJob, CronJobMode, CronJobTarget, CronRepository } from "./repository.js";

export class CronService {
  #timer: NodeJS.Timeout | undefined;
  #running = false;

  constructor(
    private readonly repository: CronRepository,
    private readonly persons: PersonRepository,
    private readonly orchestration: OrchestrationService,
    private readonly traceWriter?: TraceWriter,
    private readonly monitorHub?: MonitorEventHub,
    private readonly pollIntervalMs = 30_000
  ) {}

  computeNextRun(input: {
    schedule: string;
    timezone: string;
    currentDate?: Date;
  }): Date {
    const interval = CronExpressionParser.parse(input.schedule, {
      currentDate: input.currentDate ?? new Date(),
      tz: input.timezone
    });

    return interval.next().toDate();
  }

  async createJob(input: {
    personId: string;
    name: string;
    schedule: string;
    timezone: string;
    mode: CronJobMode;
    target: CronJobTarget;
  }): Promise<CronJob> {
    const nextRunAt = this.computeNextRun({
      schedule: input.schedule,
      timezone: input.timezone
    });

    return this.repository.createJob({
      ...input,
      nextRunAt
    });
  }

  start(): void {
    if (this.#timer) {
      return;
    }

    this.#timer = setInterval(() => {
      void this.runDueJobs().catch(() => undefined);
    }, this.pollIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  async runDueJobs(now = new Date()): Promise<number> {
    if (this.#running) {
      return 0;
    }

    this.#running = true;
    try {
      const jobs = await this.repository.findDueJobs(now, 10);
      for (const job of jobs) {
        await this.runJob(job, "scheduled", job.nextRunAt);
        const nextRunAt = this.computeNextRun({
          schedule: job.schedule,
          timezone: job.timezone,
          currentDate: now
        });
        await this.repository.updateJobSchedule({
          id: job.id,
          nextRunAt,
          lastRunAt: now
        });
      }

      return jobs.length;
    } finally {
      this.#running = false;
    }
  }

  async runJobNow(jobId: string): Promise<void> {
    const job = await this.repository.findJobById(jobId);
    if (!job) {
      throw new Error(`Cron job not found: ${jobId}`);
    }

    await this.runJob(job, "manual", new Date());
  }

  private async runJob(job: CronJob, trigger: "scheduled" | "manual", scheduledFor: Date): Promise<void> {
    const person = await this.persons.findById(job.personId);
    if (!person) {
      throw new Error(`Cron job person not found: ${job.personId}`);
    }

    const requestId = randomUUID();
    const run = await this.repository.createRun({
      jobId: job.id,
      requestId,
      trigger,
      scheduledFor
    });
    this.monitorHub?.publish({
      type: "cron.run",
      event: {
        id: run.id,
        jobId: run.jobId,
        ...(run.requestId ? { requestId: run.requestId } : {}),
        trigger: run.trigger,
        status: run.status,
        startedAt: run.startedAt.toISOString()
      }
    });

    await this.traceWriter?.write({
      timestamp: new Date().toISOString(),
      requestId,
      stage: "request.received",
      payload: {
        channelType: "websocket",
        externalUserId: `cron:${job.id}:run:${run.id}`,
        text: describeCronTarget(job.target)
      }
    }).catch(() => undefined);

    try {
      const result = job.target.type === "workflow"
        ? await this.orchestration.executeStructuredWorkflowTarget({
            requestId,
            person,
            skillName: job.target.skillName,
            messageText: job.target.messageText
          })
        : await this.orchestration.processResolvedMessage({
            requestId,
            person,
            message: {
              channelType: "websocket",
              externalUserId: job.mode === "isolated"
                ? `cron:${job.id}:run:${run.id}`
                : `cron:${job.id}`,
              text: renderCronTarget(job.target),
              receivedAt: new Date(),
              metadata: {
                cronJobId: job.id,
                cronRunId: run.id,
                cronTrigger: trigger
              }
            } satisfies InboundMessage
          });

      const normalizedResult = "status" in result
        ? result
        : {
            status: "completed" as const,
            content: result.content
          };

      await this.repository.completeRun({
        id: run.id,
        status: normalizedResult.status === "failed" ? "failed" : "completed",
        output: normalizedResult.content
      });
      this.monitorHub?.publish({
        type: "cron.run",
        event: {
          id: run.id,
          jobId: run.jobId,
          ...(run.requestId ? { requestId: run.requestId } : {}),
          trigger: run.trigger,
          status: normalizedResult.status === "failed" ? "failed" : "completed",
          startedAt: run.startedAt.toISOString(),
          completedAt: new Date().toISOString(),
          output: normalizedResult.content
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.repository.completeRun({
        id: run.id,
        status: "failed",
        error: message
      });
      this.monitorHub?.publish({
        type: "cron.run",
        event: {
          id: run.id,
          jobId: run.jobId,
          ...(run.requestId ? { requestId: run.requestId } : {}),
          trigger: run.trigger,
          status: "failed",
          startedAt: run.startedAt.toISOString(),
          completedAt: new Date().toISOString(),
          error: message
        }
      });
      throw error;
    }
  }
}

function renderCronTarget(target: CronJobTarget): string {
  if (target.type === "prompt") {
    return target.prompt;
  }

  if (target.type === "workflow") {
    return target.messageText;
  }

  return "";
}

function describeCronTarget(target: CronJobTarget): string {
  if (target.type === "prompt") {
    return target.prompt;
  }

  if (target.type === "workflow") {
    return `${target.skillName}: ${target.messageText}`;
  }

  return "cron job";
}
