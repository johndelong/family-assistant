import { z } from "zod";
import type { Person } from "../../core/domain.js";
import type { Tool } from "../../core/tools.js";
import type { ToolRegistry } from "../../core/tools.js";
import type { DirectActionTrace } from "../direct-actions/executor.js";
import type { ExtensionManifest, ExtensionRegistry, StructuredWorkflowDefinition, StructuredWorkflowStep } from "../extensions/registry.js";
import type { SessionContext } from "../sessions/service.js";

export type StructuredExecutionPlan =
  | StructuredConstrainedToolsPlan
  | StructuredWorkflowPlan;

interface StructuredExecutionPlanBase {
  skillName: string;
  toolIds: string[];
  integrationPrompts: "matched_tools" | "none";
  progressMessage?: string;
  trace: DirectActionTrace;
}

interface StructuredConstrainedToolsPlan extends StructuredExecutionPlanBase {
  runtime: "constrained_tools";
}

interface StructuredWorkflowPlan extends StructuredExecutionPlanBase {
  runtime: "workflow";
  workflow: StructuredWorkflowDefinition;
}

export interface StructuredExecutionCompletedResult {
  status: "completed";
  content: string;
  trace: DirectActionTrace;
}

export interface StructuredExecutionAwaitingApprovalResult {
  status: "awaiting_approval";
  content: string;
  trace: DirectActionTrace;
  currentStepId: string;
  state: WorkflowState;
}

export interface StructuredExecutionFailedResult {
  status: "failed";
  content: string;
  trace: DirectActionTrace;
}

export type StructuredExecutionRunResult =
  | StructuredExecutionCompletedResult
  | StructuredExecutionAwaitingApprovalResult
  | StructuredExecutionFailedResult;

export class StructuredExecutionService {
  constructor(private readonly extensionRegistry: ExtensionRegistry) {}

  resolve(input: {
    messageText: string;
    sessionContext?: SessionContext | undefined;
    tools: Tool<unknown, unknown>[];
  }): StructuredExecutionPlan | null {
    for (const extension of this.extensionRegistry.list()) {
      const manifest = extension.manifest;
      const definition = manifest.structuredExecution;
      if (!definition) {
        continue;
      }

      if (!shouldActivate(input.messageText, input.sessionContext, manifest)) {
        continue;
      }

      const matchingTools = input.tools.filter((tool) => matchesToolManifest(tool.id, manifest));
      if (matchingTools.length === 0) {
        continue;
      }

      if (definition.runtime === "workflow" && (!definition.workflow || definition.workflow.steps.length === 0)) {
        continue;
      }

      const trace: DirectActionTrace = {
        executorId: manifest.name,
        steps: [
          {
            kind: "resolve",
            success: true,
            detail: `Structured execution (${definition.runtime}) narrowed toolset to ${matchingTools.length} tool(s).`
          }
        ]
      };

      if (definition.runtime === "workflow") {
        return {
          skillName: manifest.name,
          runtime: "workflow",
          toolIds: matchingTools.map((tool) => tool.id),
          integrationPrompts: definition.integrationPrompts ?? "matched_tools",
          ...(definition.progressMessage ? { progressMessage: definition.progressMessage } : {}),
          workflow: definition.workflow as StructuredWorkflowDefinition,
          trace
        };
      }

      return {
        skillName: manifest.name,
        runtime: "constrained_tools",
        toolIds: matchingTools.map((tool) => tool.id),
        integrationPrompts: definition.integrationPrompts ?? "matched_tools",
        ...(definition.progressMessage ? { progressMessage: definition.progressMessage } : {}),
        trace
      };
    }

    return null;
  }

  resolveBySkillName(input: {
    skillName: string;
    tools: Tool<unknown, unknown>[];
  }): StructuredExecutionPlan | null {
    const manifest = this.extensionRegistry.get(input.skillName)?.manifest;
    if (!manifest?.structuredExecution) {
      return null;
    }

    const matchingTools = input.tools.filter((tool) => matchesToolManifest(tool.id, manifest));
    if (matchingTools.length === 0) {
      return null;
    }

    const trace: DirectActionTrace = {
      executorId: manifest.name,
      steps: [
        {
          kind: "resolve",
          success: true,
          detail: `Structured execution (${manifest.structuredExecution.runtime}) resumed with ${matchingTools.length} tool(s).`
        }
      ]
    };

    if (manifest.structuredExecution.runtime === "workflow") {
      if (!manifest.structuredExecution.workflow || manifest.structuredExecution.workflow.steps.length === 0) {
        return null;
      }

      return {
        skillName: manifest.name,
        runtime: "workflow",
        toolIds: matchingTools.map((tool) => tool.id),
        integrationPrompts: manifest.structuredExecution.integrationPrompts ?? "matched_tools",
        ...(manifest.structuredExecution.progressMessage ? { progressMessage: manifest.structuredExecution.progressMessage } : {}),
        workflow: manifest.structuredExecution.workflow,
        trace
      };
    }

    return {
      skillName: manifest.name,
      runtime: "constrained_tools",
      toolIds: matchingTools.map((tool) => tool.id),
      integrationPrompts: manifest.structuredExecution.integrationPrompts ?? "matched_tools",
      ...(manifest.structuredExecution.progressMessage ? { progressMessage: manifest.structuredExecution.progressMessage } : {}),
      trace
    };
  }

  async execute(input: {
    plan: StructuredExecutionPlan;
    requestId: string;
    person: Person;
    messageText: string;
    toolRegistry: ToolRegistry;
    sessionContext?: SessionContext | undefined;
    resume?: {
      currentStepId: string;
      state: WorkflowState;
      trace?: DirectActionTrace;
      approvalDecision?: boolean;
    };
  }): Promise<StructuredExecutionRunResult | null> {
    if (input.plan.runtime !== "workflow") {
      return null;
    }

    const steps = input.plan.workflow.steps;
    if (steps.length === 0) {
      return null;
    }

    const trace: DirectActionTrace = input.resume?.trace
      ? cloneTrace(input.resume.trace)
      : {
          executorId: input.plan.trace.executorId,
          ...(input.plan.trace.intent ? { intent: input.plan.trace.intent } : {}),
          ...(input.plan.trace.target ? { target: input.plan.trace.target } : {}),
          steps: [...input.plan.trace.steps]
        };

    const state: WorkflowState = input.resume?.state
      ? cloneWorkflowState(input.resume.state)
      : {
          message: {
            text: input.messageText
          },
          vars: {},
          steps: {}
        };

    let currentStepId: string | undefined = input.resume?.currentStepId ?? input.plan.workflow.startAt ?? steps[0]?.id;
    let approvalDecision = input.resume?.approvalDecision;
    const visited = new Set<string>();

    while (currentStepId) {
      if (visited.has(currentStepId)) {
        trace.steps.push({
          kind: "branch",
          success: false,
          detail: `Workflow loop detected at step ${currentStepId}.`
        });
        return {
          status: "failed",
          content: "I couldn't complete that workflow because it looped unexpectedly.",
          trace
        };
      }

      visited.add(currentStepId);
      const step = steps.find((candidate) => candidate.id === currentStepId);
      if (!step) {
        trace.steps.push({
          kind: "branch",
          success: false,
          detail: `Workflow step not found: ${currentStepId}.`
        });
        return {
          status: "failed",
          content: "I couldn't complete that workflow because a step was missing.",
          trace
        };
      }

      if (step.type === "set") {
        const values = renderValue(step.values, state);
        const record = typeof values === "object" && values && !Array.isArray(values)
          ? values as Record<string, unknown>
          : {};
        Object.assign(state.vars, record);
        state.steps[step.id] = { output: record };
        trace.steps.push({
          kind: "set",
          success: true,
          outputPreview: summarizeUnknown(record),
          detail: `Set ${Object.keys(record).length} workflow value(s).`
        });
        currentStepId = step.next ?? getNextStepId(steps, step.id);
        continue;
      }

      if (step.type === "tool") {
        const toolId = resolveToolId(step, input.plan.toolIds, input.toolRegistry);
        if (!toolId) {
          trace.steps.push({
            kind: "tool_call",
            success: false,
            detail: `No tool matched workflow step ${step.id}.`
          });
          return {
            status: "failed",
            content: "I couldn't complete that workflow because a required tool was unavailable.",
            trace
          };
        }

        const toolInput = renderValue(step.input ?? {}, state);
        const toolArgs = typeof toolInput === "object" && toolInput && !Array.isArray(toolInput)
          ? toolInput as Record<string, unknown>
          : {};

        try {
          const result = await input.toolRegistry.execute(toolId, toolArgs, {
            requestId: input.requestId,
            invocationSource: "conversation",
            person: input.person
          });
          const saveKey = step.saveAs ?? step.id;
          state.steps[step.id] = { output: result };
          state.vars[saveKey] = result;
          trace.steps.push({
            kind: "tool_call",
            toolName: toolId,
            arguments: toolArgs,
            success: true,
            outputPreview: summarizeUnknown(result)
          });
          currentStepId = step.next ?? getNextStepId(steps, step.id);
          continue;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          state.steps[step.id] = { error: message };
          trace.steps.push({
            kind: "tool_call",
            toolName: toolId,
            arguments: toolArgs,
            success: false,
            outputPreview: summarizeUnknown({ error: message })
          });
          currentStepId = step.onError ?? undefined;
          if (!currentStepId) {
            return {
              status: "failed",
              content: "I couldn't complete that workflow because a required tool step failed.",
              trace
            };
          }
          continue;
        }
      }

      if (step.type === "branch") {
        const branchNext = resolveBranchNext(step, state);
        trace.steps.push({
          kind: "branch",
          success: Boolean(branchNext),
          detail: branchNext
            ? `Branch selected next step ${branchNext}.`
            : "No branch condition matched."
        });
        if (!branchNext) {
          return {
            status: "failed",
            content: "I couldn't complete that workflow because no branch condition matched.",
            trace
          };
        }
        currentStepId = branchNext;
        continue;
      }

      if (step.type === "approval") {
        if (typeof approvalDecision === "boolean") {
          const approved = approvalDecision;
          approvalDecision = undefined;
          trace.steps.push({
            kind: "approval",
            success: approved,
            detail: approved ? "Approval granted." : "Approval denied."
          });

          if (approved) {
            currentStepId = step.next ?? getNextStepId(steps, step.id);
            continue;
          }

          if (step.denyNext) {
            currentStepId = step.denyNext;
            continue;
          }

          return {
            status: "completed",
            content: renderTemplate(step.denyResponse ?? "Okay, I won't do that.", state),
            trace
          };
        }

        const content = renderTemplate(step.prompt, state);
        trace.steps.push({
          kind: "approval",
          detail: `Awaiting approval at step ${step.id}.`
        });
        return {
          status: "awaiting_approval",
          content,
          trace,
          currentStepId: step.id,
          state
        };
      }

      if (step.type === "respond") {
        const content = renderTemplate(step.template, state);
        trace.steps.push({
          kind: "respond",
          success: true,
          outputPreview: summarizeUnknown(content)
        });
        return {
          status: "completed",
          content,
          trace
        };
      }
    }

    return null;
  }
}

export interface WorkflowState {
  message: {
    text: string;
  };
  vars: Record<string, unknown>;
  steps: Record<string, {
    output?: unknown;
    error?: string | undefined;
  }>;
}

const workflowStateSchema: z.ZodType<WorkflowState> = z.object({
  message: z.object({
    text: z.string()
  }),
  vars: z.record(z.string(), z.unknown()),
  steps: z.record(z.string(), z.object({
    output: z.unknown().optional(),
    error: z.string().optional()
  }))
});

export function validateWorkflowState(value: unknown): WorkflowState {
  return workflowStateSchema.parse(value);
}

function shouldActivate(
  messageText: string,
  sessionContext: SessionContext | undefined,
  manifest: ExtensionManifest
): boolean {
  const activation = manifest.activation;
  if (!activation) {
    return true;
  }

  const combined = normalize([
    messageText,
    ...(sessionContext?.recentMessages.map((message) => message.content) ?? [])
  ].join("\n"));

  const messageAll = activation.messageAll ?? [];
  const messageAny = activation.messageAny ?? [];

  if (messageAll.some((pattern) => !new RegExp(pattern, "i").test(combined))) {
    return false;
  }

  if (messageAny.length > 0 && !messageAny.some((pattern) => new RegExp(pattern, "i").test(combined))) {
    return false;
  }

  return true;
}

function matchesToolManifest(toolId: string, manifest: ExtensionManifest): boolean {
  const suffixes = manifest.toolMatchers?.idSuffixes ?? [];
  const patterns = manifest.toolMatchers?.idPatterns ?? [];

  return (
    suffixes.some((suffix) => toolId.endsWith(suffix)) ||
    patterns.some((pattern) => new RegExp(pattern).test(toolId))
  );
}

function normalize(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function getNextStepId(steps: StructuredWorkflowStep[], currentStepId: string): string | undefined {
  const index = steps.findIndex((step) => step.id === currentStepId);
  if (index === -1) {
    return undefined;
  }

  return steps[index + 1]?.id;
}

function cloneTrace(trace: DirectActionTrace): DirectActionTrace {
  return {
    executorId: trace.executorId,
    ...(trace.intent ? { intent: trace.intent } : {}),
    ...(trace.target ? { target: trace.target } : {}),
    steps: trace.steps.map((step) => ({
      kind: step.kind,
      ...(step.toolName ? { toolName: step.toolName } : {}),
      ...(step.arguments ? { arguments: structuredCloneValue(step.arguments) as Record<string, unknown> } : {}),
      ...(typeof step.success === "boolean" ? { success: step.success } : {}),
      ...(step.outputPreview ? { outputPreview: step.outputPreview } : {}),
      ...(step.detail ? { detail: step.detail } : {})
    }))
  };
}

function cloneWorkflowState(state: WorkflowState): WorkflowState {
  return {
    message: {
      text: state.message.text
    },
    vars: structuredCloneValue(state.vars) as Record<string, unknown>,
    steps: structuredCloneValue(state.steps) as WorkflowState["steps"]
  };
}

function structuredCloneValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function resolveToolId(
  step: Extract<StructuredWorkflowStep, { type: "tool" }>,
  allowedToolIds: string[],
  toolRegistry: ToolRegistry
): string | null {
  if (step.toolId && allowedToolIds.includes(step.toolId) && toolRegistry.get(step.toolId)) {
    return step.toolId;
  }

  if (step.toolIdSuffix) {
    const suffix = step.toolIdSuffix;
    const matched = allowedToolIds.find((toolId) => toolId.endsWith(suffix));
    if (matched && toolRegistry.get(matched)) {
      return matched;
    }
  }

  return null;
}

function resolveBranchNext(
  step: Extract<StructuredWorkflowStep, { type: "branch" }>,
  state: WorkflowState
): string | undefined {
  for (const condition of step.conditions) {
    const value = getPathValue(state, condition.path);

    if (typeof condition.exists === "boolean") {
      const exists = value !== undefined && value !== null;
      if (exists === condition.exists) {
        return condition.next;
      }
      continue;
    }

    if (condition.equals !== undefined && value === condition.equals) {
      return condition.next;
    }

    if (condition.includes !== undefined) {
      const asString = typeof value === "string" ? value : JSON.stringify(value);
      if (typeof asString === "string" && asString.toLowerCase().includes(condition.includes.toLowerCase())) {
        return condition.next;
      }
    }
  }

  return step.defaultNext;
}

function renderValue(value: unknown, state: WorkflowState): unknown {
  if (typeof value === "string") {
    return renderTemplateValue(value, state);
  }

  if (Array.isArray(value)) {
    return value.map((item) => renderValue(item, state));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, renderValue(child, state)])
    );
  }

  return value;
}

function renderTemplate(template: string, state: WorkflowState): string {
  return template.replace(/\{\{\s*([^}]+)\s*\}\}/g, (_match, path) => {
    const value = getPathValue(state, String(path).trim());
    if (value === undefined || value === null) {
      return "";
    }

    return typeof value === "string" ? value : JSON.stringify(value);
  });
}

function renderTemplateValue(template: string, state: WorkflowState): unknown {
  const exact = template.match(/^\{\{\s*([^}]+)\s*\}\}$/);
  const path = exact?.[1];
  if (path) {
    return getPathValue(state, path.trim());
  }

  return renderTemplate(template, state);
}

function getPathValue(state: WorkflowState, path: string): unknown {
  const segments = path.split(".").filter(Boolean);
  let current: unknown = state;

  for (const segment of segments) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }

    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}

function summarizeUnknown(value: unknown): string {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  return serialized.length > 200 ? `${serialized.slice(0, 197)}...` : serialized;
}
