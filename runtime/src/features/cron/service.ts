import { randomUUID } from "node:crypto";
import { CronExpressionParser } from "cron-parser";
import type { ChannelRouter } from "../../channels/router.js";
import type { InboundMessage } from "../../core/channels.js";
import type { Person } from "../../core/domain.js";
import type { IdentityRepository } from "../identity/repository.js";
import type { MonitorEventHub } from "../monitor/hub.js";
import type { OrchestrationService } from "../orchestration/service.js";
import type { PersonRepository } from "../persons/repository.js";
import type { TraceWriter } from "../tracing/writer.js";
import type { CronJob, CronJobDelivery, CronJobPayload, CronJobSessionTarget, CronRepository } from "./repository.js";

export class CronService {
  #timer: NodeJS.Timeout | undefined;
  #running = false;

  constructor(
    private readonly repository: CronRepository,
    private readonly persons: PersonRepository,
    private readonly identities: IdentityRepository,
    private readonly channels: ChannelRouter,
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
    sessionTarget: CronJobSessionTarget;
    payload: CronJobPayload;
    delivery: CronJobDelivery;
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
        text: describeCronPayload(job.payload)
      }
    }).catch(() => undefined);

    try {
      const result = job.payload.kind === "workflow"
        ? await this.orchestration.executeStructuredWorkflowTarget({
            requestId,
            person,
            skillName: job.payload.skillName,
            messageText: job.payload.messageText
          })
        : await this.orchestration.processResolvedMessage({
            requestId,
            person,
            message: {
              channelType: "websocket",
              externalUserId: job.sessionTarget === "isolated"
                ? `cron:${job.id}:run:${run.id}`
                : `cron:${job.id}`,
              text: renderCronPayload(job.payload),
              receivedAt: new Date(),
              metadata: {
                cronJobId: job.id,
                cronRunId: run.id,
                cronTrigger: trigger,
                cronSessionTarget: job.sessionTarget
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
      await this.#deliverOutput(person, job, normalizedResult.content);
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

  async #deliverOutput(person: Person, job: CronJob, output: string): Promise<void> {
    if (job.delivery.type === "none") {
      return;
    }

    if (job.delivery.type === "telegram") {
      const identities = await this.identities.listIdentitiesForPerson(person.id);
      const telegramIdentity = identities.find((identity) => identity.channelType === "telegram");
      if (!telegramIdentity) {
        throw new Error(`No linked Telegram identity found for ${person.name}`);
      }

      await this.channels.sendMessage({
        channelType: "telegram",
        externalId: telegramIdentity.externalId
      }, {
        text: output
      });
    }
  }
}

function renderCronPayload(payload: CronJobPayload): string {
  if (payload.kind === "agent_turn") {
    return payload.prompt;
  }

  if (payload.kind === "workflow") {
    return payload.messageText;
  }

  return "";
}

function describeCronPayload(payload: CronJobPayload): string {
  if (payload.kind === "agent_turn") {
    return payload.prompt;
  }

  if (payload.kind === "workflow") {
    return `${payload.skillName}: ${payload.messageText}`;
  }

  return "cron job";
}
