import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

export const SUPPORTED_EXTENSION_API_VERSION = "1";

const requestModeSchema = z.enum(["default", "direct_action"]);
const primitiveSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const toolMatchersSchema = z.object({
  idSuffixes: z.array(z.string()).optional(),
  idPatterns: z.array(z.string()).optional()
}).optional();

const activationSchema = z.object({
  messageAll: z.array(z.string()).optional(),
  messageAny: z.array(z.string()).optional()
}).optional();

const executionGuardSchema = z.object({
  toolIdSuffix: z.string().optional(),
  toolIdPattern: z.string().optional(),
  dropFields: z.array(z.object({
    field: z.string(),
    whenValueEquals: z.union([z.string(), z.number(), z.boolean()]).optional(),
    unlessMessageMatches: z.string().optional()
  })).optional()
});

const workflowStepSchema: z.ZodType<StructuredWorkflowStep> = z.discriminatedUnion("type", [
  z.object({
    id: z.string(),
    type: z.literal("set"),
    values: z.record(z.string(), z.unknown()),
    next: z.string().optional()
  }),
  z.object({
    id: z.string(),
    type: z.literal("tool"),
    toolId: z.string().optional(),
    toolIdSuffix: z.string().optional(),
    input: z.record(z.string(), z.unknown()).optional(),
    saveAs: z.string().optional(),
    next: z.string().optional(),
    onError: z.string().optional()
  }),
  z.object({
    id: z.string(),
    type: z.literal("branch"),
    conditions: z.array(z.object({
      path: z.string(),
      equals: primitiveSchema.optional(),
      includes: z.string().optional(),
      exists: z.boolean().optional(),
      next: z.string()
    })),
    defaultNext: z.string().optional()
  }),
  z.object({
    id: z.string(),
    type: z.literal("approval"),
    prompt: z.string(),
    next: z.string().optional(),
    denyNext: z.string().optional(),
    denyResponse: z.string().optional()
  }),
  z.object({
    id: z.string(),
    type: z.literal("respond"),
    template: z.string()
  })
]);

const workflowDefinitionSchema = z.object({
  startAt: z.string().optional(),
  steps: z.array(workflowStepSchema)
});

const structuredExecutionSchema = z.object({
  runtime: z.enum(["constrained_tools", "workflow"]),
  requestModes: z.array(requestModeSchema).optional(),
  integrationPrompts: z.enum(["matched_tools", "none"]).optional(),
  progressMessage: z.string().optional(),
  workflow: workflowDefinitionSchema.optional()
}).optional();

const extensionPackageSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/, "Expected semver-like version (for example 1.0.0)"),
  apiVersion: z.string().default("1"),
  author: z.string().optional(),
  homepage: z.string().url().optional(),
  tags: z.array(z.string()).optional()
});

const extensionManifestSchema = z.object({
  name: z.string().min(1),
  package: extensionPackageSchema,
  toolMatchers: toolMatchersSchema,
  activation: activationSchema,
  forceIncludeMatchingTools: z.boolean().optional(),
  structuredExecution: structuredExecutionSchema,
  executionGuards: z.array(executionGuardSchema).optional()
});

export type RequestMode = z.infer<typeof requestModeSchema>;
export type SkillExecutionGuard = z.infer<typeof executionGuardSchema>;
export type StructuredWorkflowStep = (
  | {
      id: string;
      type: "set";
      values: Record<string, unknown>;
      next?: string | undefined;
    }
  | {
      id: string;
      type: "tool";
      toolId?: string | undefined;
      toolIdSuffix?: string | undefined;
      input?: Record<string, unknown> | undefined;
      saveAs?: string | undefined;
      next?: string | undefined;
      onError?: string | undefined;
    }
  | {
      id: string;
      type: "branch";
      conditions: Array<{
        path: string;
        equals?: string | number | boolean | null | undefined;
        includes?: string | undefined;
        exists?: boolean | undefined;
        next: string;
      }>;
      defaultNext?: string | undefined;
    }
  | {
      id: string;
      type: "approval";
      prompt: string;
      next?: string | undefined;
      denyNext?: string | undefined;
      denyResponse?: string | undefined;
    }
  | {
      id: string;
      type: "respond";
      template: string;
    }
);
export type StructuredWorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;
export type ExtensionManifest = z.infer<typeof extensionManifestSchema>;

type ExtensionSource = "workspace" | "managed" | "extra";

export interface RegisteredExtension {
  name: string;
  directory: string;
  source: ExtensionSource;
  description?: string;
  hasSkillBody: boolean;
  manifest: ExtensionManifest;
}

export interface ExtensionLoadError {
  directory: string;
  source: ExtensionSource;
  error: string;
}

export interface ExtensionInspection {
  name: string;
  source: ExtensionSource;
  directory: string;
  description?: string;
  package: {
    version: string;
    apiVersion: string;
    author?: string;
    homepage?: string;
    tags: string[];
  };
  hasSkillBody: boolean;
  toolMatchers: {
    idSuffixes: string[];
    idPatterns: string[];
  };
  activation: {
    messageAll: string[];
    messageAny: string[];
  };
  forceIncludeMatchingTools: boolean;
  executionGuardCount: number;
  structuredExecution?: {
    runtime: "constrained_tools" | "workflow";
    requestModes: RequestMode[];
    integrationPrompts: "matched_tools" | "none";
    progressMessage?: string;
    workflow?: {
      startAt?: string;
      stepCount: number;
      steps: Array<{
        id: string;
        type: StructuredWorkflowStep["type"];
        detail: string;
      }>;
    };
  };
}

export class ExtensionRegistry {
  readonly #entries: RegisteredExtension[];
  readonly #errors: ExtensionLoadError[];
  readonly #skillBodies = new Map<string, string>();

  constructor(input?: {
    workspaceDir?: string;
    managedDir?: string;
    extraDirs?: string[];
  }) {
    const roots = [
      { directory: resolve(input?.workspaceDir ?? resolve(process.cwd(), "skills")), source: "workspace" as const },
      { directory: resolve(input?.managedDir ?? resolve(process.cwd(), ".family-assistant", "skills")), source: "managed" as const },
      ...((input?.extraDirs ?? []).map((directory) => ({
        directory: resolve(directory),
        source: "extra" as const
      })))
    ];

    const entries = new Map<string, RegisteredExtension>();
    const errors: ExtensionLoadError[] = [];

    for (const root of roots) {
      if (!existsSync(root.directory)) {
        continue;
      }

      const dirs = readdirSync(root.directory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();

      for (const dirName of dirs) {
        const directory = resolve(root.directory, dirName);
        const manifestPath = resolve(directory, "skill.json");

        if (!existsSync(manifestPath)) {
          continue;
        }

        try {
          const manifest = extensionManifestSchema.parse(
            JSON.parse(readFileSync(manifestPath, "utf8"))
          );
          if (manifest.package.apiVersion !== SUPPORTED_EXTENSION_API_VERSION) {
            errors.push({
              directory,
              source: root.source,
              error: `Unsupported apiVersion ${manifest.package.apiVersion}. Supported apiVersion is ${SUPPORTED_EXTENSION_API_VERSION}.`
            });
            continue;
          }
          if (entries.has(manifest.name)) {
            continue;
          }

          const skillBodyPath = resolve(directory, "SKILL.md");
          const skillBody = existsSync(skillBodyPath)
            ? parseSkillBody(readFileSync(skillBodyPath, "utf8"))
            : undefined;
          if (skillBody) {
            this.#skillBodies.set(manifest.name, skillBody.body);
          }

          entries.set(manifest.name, {
            name: manifest.name,
            directory,
            source: root.source,
            ...(skillBody?.description ? { description: skillBody.description } : {}),
            hasSkillBody: Boolean(skillBody),
            manifest
          });
        } catch (error) {
          errors.push({
            directory,
            source: root.source,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }

    this.#entries = Array.from(entries.values()).sort((a, b) => a.name.localeCompare(b.name));
    this.#errors = errors;
  }

  list(): RegisteredExtension[] {
    return [...this.#entries];
  }

  listErrors(): ExtensionLoadError[] {
    return [...this.#errors];
  }

  get(name: string): RegisteredExtension | undefined {
    return this.#entries.find((entry) => entry.name === name);
  }

  getSkillBody(name: string): string | undefined {
    return this.#skillBodies.get(name);
  }

  inspect(name: string): ExtensionInspection | undefined {
    const entry = this.get(name);
    return entry ? inspectExtension(entry) : undefined;
  }

  inspectAll(): ExtensionInspection[] {
    return this.#entries.map((entry) => inspectExtension(entry));
  }
}

export function parseExtensionManifest(raw: string): ExtensionManifest {
  return extensionManifestSchema.parse(JSON.parse(raw));
}

function parseSkillBody(raw: string): { description?: string; body: string } {
  const frontmatterMatch = raw.match(/^---\n([\s\S]*?)\n---\n?/u);
  const frontmatter = frontmatterMatch?.[1] ?? "";
  const body = raw.replace(/^---\n[\s\S]*?\n---\n?/u, "").trim();
  const descriptionMatch = frontmatter.match(/^description:\s*(.+)$/m);

  return {
    ...(descriptionMatch?.[1] ? { description: descriptionMatch[1].trim() } : {}),
    body
  };
}

function inspectExtension(entry: RegisteredExtension): ExtensionInspection {
  const manifest = entry.manifest;
  const workflow = manifest.structuredExecution?.workflow;

  return {
    name: entry.name,
    source: entry.source,
    directory: entry.directory,
    ...(entry.description ? { description: entry.description } : {}),
    package: {
      version: manifest.package.version,
      apiVersion: manifest.package.apiVersion,
      ...(manifest.package.author ? { author: manifest.package.author } : {}),
      ...(manifest.package.homepage ? { homepage: manifest.package.homepage } : {}),
      tags: manifest.package.tags ?? []
    },
    hasSkillBody: entry.hasSkillBody,
    toolMatchers: {
      idSuffixes: manifest.toolMatchers?.idSuffixes ?? [],
      idPatterns: manifest.toolMatchers?.idPatterns ?? []
    },
    activation: {
      messageAll: manifest.activation?.messageAll ?? [],
      messageAny: manifest.activation?.messageAny ?? []
    },
    forceIncludeMatchingTools: manifest.forceIncludeMatchingTools ?? false,
    executionGuardCount: manifest.executionGuards?.length ?? 0,
    ...(manifest.structuredExecution
      ? {
          structuredExecution: {
            runtime: manifest.structuredExecution.runtime,
            requestModes: manifest.structuredExecution.requestModes ?? [],
            integrationPrompts: manifest.structuredExecution.integrationPrompts ?? "matched_tools",
            ...(manifest.structuredExecution.progressMessage
              ? { progressMessage: manifest.structuredExecution.progressMessage }
              : {}),
            ...(workflow
              ? {
                  workflow: {
                    ...(workflow.startAt ? { startAt: workflow.startAt } : {}),
                    stepCount: workflow.steps.length,
                    steps: workflow.steps.map((step) => ({
                      id: step.id,
                      type: step.type,
                      detail: summarizeWorkflowStep(step)
                    }))
                  }
                }
              : {})
          }
        }
      : {})
  };
}

function summarizeWorkflowStep(step: StructuredWorkflowStep): string {
  if (step.type === "set") {
    return `set ${Object.keys(step.values).length} value(s)`;
  }

  if (step.type === "tool") {
    return step.toolId
      ? `tool ${step.toolId}`
      : step.toolIdSuffix
        ? `tool matching ${step.toolIdSuffix}`
        : "tool step";
  }

  if (step.type === "branch") {
    return `branch with ${step.conditions.length} condition(s)`;
  }

  if (step.type === "approval") {
    return "approval checkpoint";
  }

  return "respond with template";
}
