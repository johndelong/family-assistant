import { z } from "../../../runtime/src/core/zod.js";
import type { Tool } from "../../../runtime/src/core/tools.js";
import type { ExtensionRegistry } from "../../../runtime/src/features/extensions/registry.js";
import type { CronRepository } from "../../../runtime/src/features/cron/repository.js";
import type { CronService } from "../../../runtime/src/features/cron/service.js";

const cronCreateSchema = z.object({
  name: z.string().min(1),
  schedule: z.string().min(1),
  timezone: z.string().min(1).default(Intl.DateTimeFormat().resolvedOptions().timeZone),
  sessionTarget: z.enum(["isolated", "main"]).default("isolated"),
  deliveryType: z.enum(["none", "telegram"]).default("none"),
  payloadKind: z.enum(["agent_turn", "workflow"]).default("agent_turn"),
  prompt: z.string().optional(),
  workflowSkillName: z.string().optional(),
  workflowMessageText: z.string().optional()
});

const cronListSchema = z.object({});

const cronJobActionSchema = z.object({
  jobId: z.string().uuid()
});

const cronRunsSchema = z.object({
  jobId: z.string().uuid().optional(),
  limit: z.number().int().positive().max(50).default(10)
});

export function createCronCreateTool(cron: CronService, extensions: ExtensionRegistry): Tool<z.infer<typeof cronCreateSchema>, {
  jobId: string;
  name: string;
  nextRunAt: string;
}> {
  return {
    id: "cron.create",
    description: "Create a recurring cron job for the current person. Choose a sessionTarget of isolated or main, a payloadKind of agent_turn or workflow, and a delivery type. If deliveryType is telegram, the job will send results to the current person's linked Telegram identity automatically.",
    inputSchema: cronCreateSchema,
    inputJsonSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        schedule: { type: "string" },
        timezone: { type: "string" },
        sessionTarget: { type: "string", enum: ["isolated", "main"] },
        deliveryType: { type: "string", enum: ["none", "telegram"] },
        payloadKind: { type: "string", enum: ["agent_turn", "workflow"] },
        prompt: { type: "string" },
        workflowSkillName: { type: "string" },
        workflowMessageText: { type: "string" }
      },
      required: ["name", "schedule"],
      additionalProperties: false
    },
    exposure: "conversation",
    approvalPolicy: "confirm",
    targetScope: "self",
    async execute(input, context) {
      if (!context.person) {
        throw new Error("A resolved person is required to create a cron job.");
      }

      const payload = input.payloadKind === "workflow"
        ? buildWorkflowPayload(input, extensions)
        : buildAgentTurnPayload(input);
      const created = await cron.createJob({
        personId: context.person.id,
        name: input.name,
        schedule: input.schedule,
        timezone: input.timezone,
        sessionTarget: input.sessionTarget,
        delivery: input.deliveryType === "telegram" ? { type: "telegram" } : { type: "none" },
        payload
      });

      return {
        jobId: created.id,
        name: created.name,
        nextRunAt: created.nextRunAt.toISOString()
      };
    }
  };
}

export function createCronListTool(repository: CronRepository): Tool<z.infer<typeof cronListSchema>, {
  jobs: Array<{
    jobId: string;
    name: string;
    status: string;
    schedule: string;
    timezone: string;
    sessionTarget: string;
    payloadKind: string;
    deliveryType: string;
    nextRunAt: string;
  }>;
}> {
  return {
    id: "cron.list",
    description: "List recurring cron jobs for the current person, including schedule, delivery type, and next run time.",
    inputSchema: cronListSchema,
    inputJsonSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    },
    exposure: "conversation",
    approvalPolicy: "never",
    targetScope: "self",
    async execute(_input, context) {
      if (!context.person) {
        throw new Error("A resolved person is required to list cron jobs.");
      }

      const jobs = (await repository.listJobs())
        .filter((job) => job.personId === context.person?.id)
        .map((job) => ({
          jobId: job.id,
          name: job.name,
          status: job.status,
          schedule: job.schedule,
          timezone: job.timezone,
          sessionTarget: job.sessionTarget,
          payloadKind: job.payload.kind,
          deliveryType: job.delivery.type,
          nextRunAt: job.nextRunAt.toISOString()
        }));

      return { jobs };
    }
  };
}

export function createCronPauseTool(repository: CronRepository): Tool<z.infer<typeof cronJobActionSchema>, { jobId: string; status: string }> {
  return createCronStatusTool("cron.pause", "Pause a recurring cron job for the current person.", "paused", repository);
}

export function createCronResumeTool(repository: CronRepository): Tool<z.infer<typeof cronJobActionSchema>, { jobId: string; status: string }> {
  return createCronStatusTool("cron.resume", "Resume a paused recurring cron job for the current person.", "active", repository);
}

export function createCronRunNowTool(cron: CronService, repository: CronRepository): Tool<z.infer<typeof cronJobActionSchema>, { jobId: string; status: string }> {
  return {
    id: "cron.run_now",
    description: "Run a recurring cron job immediately for the current person.",
    inputSchema: cronJobActionSchema,
    inputJsonSchema: {
      type: "object",
      properties: {
        jobId: { type: "string", format: "uuid" }
      },
      required: ["jobId"],
      additionalProperties: false
    },
    exposure: "conversation",
    approvalPolicy: "confirm",
    targetScope: "self",
    async execute(input, context) {
      const job = await ensureOwnedJob(input.jobId, repository, context.person?.id);
      await cron.runJobNow(job.id);
      return {
        jobId: job.id,
        status: "triggered"
      };
    }
  };
}

export function createCronRunsTool(repository: CronRepository): Tool<z.infer<typeof cronRunsSchema>, {
  runs: Array<{
    runId: string;
    jobId: string;
    jobName: string;
    trigger: string;
    status: string;
    startedAt: string;
    completedAt?: string;
    output?: string;
    error?: string;
  }>;
}> {
  return {
    id: "cron.runs",
    description: "Inspect recent cron run results for the current person, either across all of their jobs or for one specific job, including output or delivery errors.",
    inputSchema: cronRunsSchema,
    inputJsonSchema: {
      type: "object",
      properties: {
        jobId: { type: "string", format: "uuid" },
        limit: { type: "integer", minimum: 1, maximum: 50 }
      },
      additionalProperties: false
    },
    exposure: "conversation",
    approvalPolicy: "never",
    targetScope: "self",
    async execute(input, context) {
      if (!context.person) {
        throw new Error("A resolved person is required to inspect cron runs.");
      }

      if (input.jobId) {
        const job = await ensureOwnedJob(input.jobId, repository, context.person.id);
        const runs = await repository.listRunsForJob(job.id, input.limit);
        return {
          runs: runs.map((run) => ({
            runId: run.id,
            jobId: run.jobId,
            jobName: job.name,
            trigger: run.trigger,
            status: run.status,
            startedAt: run.startedAt.toISOString(),
            ...(run.completedAt ? { completedAt: run.completedAt.toISOString() } : {}),
            ...(run.output ? { output: run.output } : {}),
            ...(run.error ? { error: run.error } : {})
          }))
        };
      }

      const runs = await repository.listRunsForPerson(context.person.id, input.limit);
      return {
        runs: runs.map((run) => ({
          runId: run.id,
          jobId: run.jobId,
          jobName: run.jobName,
          trigger: run.trigger,
          status: run.status,
          startedAt: run.startedAt.toISOString(),
          ...(run.completedAt ? { completedAt: run.completedAt.toISOString() } : {}),
          ...(run.output ? { output: run.output } : {}),
          ...(run.error ? { error: run.error } : {})
        }))
      };
    }
  };
}

function createCronStatusTool(
  id: string,
  description: string,
  status: "active" | "paused",
  repository: CronRepository
): Tool<z.infer<typeof cronJobActionSchema>, { jobId: string; status: string }> {
  return {
    id,
    description,
    inputSchema: cronJobActionSchema,
    inputJsonSchema: {
      type: "object",
      properties: {
        jobId: { type: "string", format: "uuid" }
      },
      required: ["jobId"],
      additionalProperties: false
    },
    exposure: "conversation",
    approvalPolicy: "confirm",
    targetScope: "self",
    async execute(input, context) {
      const job = await ensureOwnedJob(input.jobId, repository, context.person?.id);
      await repository.updateJobStatus({
        id: job.id,
        status
      });

      return {
        jobId: job.id,
        status
      };
    }
  };
}

function buildAgentTurnPayload(input: z.infer<typeof cronCreateSchema>) {
  if (!input.prompt || input.prompt.trim().length === 0) {
    throw new Error("A prompt is required when payloadKind is 'agent_turn'.");
  }

  return {
    kind: "agent_turn" as const,
    prompt: input.prompt.trim()
  };
}

function buildWorkflowPayload(input: z.infer<typeof cronCreateSchema>, extensions: ExtensionRegistry) {
  if (!input.workflowSkillName || input.workflowSkillName.trim().length === 0) {
    throw new Error("workflowSkillName is required when payloadKind is 'workflow'.");
  }

  const extension = extensions.get(input.workflowSkillName.trim());
  if (!extension) {
    throw new Error(`Workflow extension not found: ${input.workflowSkillName}`);
  }

  if (extension.manifest.structuredExecution?.runtime !== "workflow") {
    throw new Error(`Extension is not a workflow target: ${input.workflowSkillName}`);
  }

  return {
    kind: "workflow" as const,
    skillName: input.workflowSkillName.trim(),
    messageText: (input.workflowMessageText?.trim() || "Run the configured workflow now.")
  };
}

async function ensureOwnedJob(jobId: string, repository: CronRepository, personId: string | undefined) {
  if (!personId) {
    throw new Error("A resolved person is required to manage cron jobs.");
  }

  const job = await repository.findJobById(jobId);
  if (!job || job.personId !== personId) {
    throw new Error(`Cron job not found: ${jobId}`);
  }

  return job;
}
