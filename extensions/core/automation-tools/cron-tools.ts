import { z } from "../../../runtime/src/core/zod.js";
import type { Tool } from "../../../runtime/src/core/tools.js";
import type { ExtensionRegistry } from "../../../runtime/src/features/extensions/registry.js";
import type { CronRepository } from "../../../runtime/src/features/cron/repository.js";
import type { CronService } from "../../../runtime/src/features/cron/service.js";

const cronCreateSchema = z.object({
  name: z.string().min(1),
  schedule: z.string().min(1),
  timezone: z.string().min(1).default(Intl.DateTimeFormat().resolvedOptions().timeZone),
  mode: z.enum(["isolated", "main"]).default("isolated"),
  targetType: z.enum(["prompt", "workflow"]).default("prompt"),
  prompt: z.string().optional(),
  workflowSkillName: z.string().optional(),
  workflowMessageText: z.string().optional()
});

const cronListSchema = z.object({});

const cronJobActionSchema = z.object({
  jobId: z.string().uuid()
});

export function createCronCreateTool(cron: CronService, extensions: ExtensionRegistry): Tool<z.infer<typeof cronCreateSchema>, {
  jobId: string;
  name: string;
  nextRunAt: string;
}> {
  return {
    id: "cron.create",
    description: "Create a recurring cron job for the current person. Use prompt targets for general recurring tasks or workflow targets for deterministic extension workflows.",
    inputSchema: cronCreateSchema,
    inputJsonSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        schedule: { type: "string" },
        timezone: { type: "string" },
        mode: { type: "string", enum: ["isolated", "main"] },
        targetType: { type: "string", enum: ["prompt", "workflow"] },
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

      const target = input.targetType === "workflow"
        ? buildWorkflowTarget(input, extensions)
        : buildPromptTarget(input);
      const created = await cron.createJob({
        personId: context.person.id,
        name: input.name,
        schedule: input.schedule,
        timezone: input.timezone,
        mode: input.mode,
        target
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
    mode: string;
    targetType: string;
    nextRunAt: string;
  }>;
}> {
  return {
    id: "cron.list",
    description: "List recurring cron jobs for the current person, including schedule and next run time.",
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
          mode: job.mode,
          targetType: job.target.type,
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

function buildPromptTarget(input: z.infer<typeof cronCreateSchema>) {
  if (!input.prompt || input.prompt.trim().length === 0) {
    throw new Error("A prompt is required when targetType is 'prompt'.");
  }

  return {
    type: "prompt" as const,
    prompt: input.prompt.trim()
  };
}

function buildWorkflowTarget(input: z.infer<typeof cronCreateSchema>, extensions: ExtensionRegistry) {
  if (!input.workflowSkillName || input.workflowSkillName.trim().length === 0) {
    throw new Error("workflowSkillName is required when targetType is 'workflow'.");
  }

  const extension = extensions.get(input.workflowSkillName.trim());
  if (!extension) {
    throw new Error(`Workflow extension not found: ${input.workflowSkillName}`);
  }

  if (extension.manifest.structuredExecution?.runtime !== "workflow") {
    throw new Error(`Extension is not a workflow target: ${input.workflowSkillName}`);
  }

  return {
    type: "workflow" as const,
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
