import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Tool } from "../../core/tools.js";
import type { SessionContext } from "../sessions/service.js";
import { readSkillBody, readSkillManifest } from "./prompt-fragments.js";
import type { ToolSelectionTraceEntry } from "./tool-selection.js";

interface SkillManifest {
  name: string;
  toolMatchers?: {
    idSuffixes?: string[];
    idPatterns?: string[];
  };
  activation?: {
    messageAll?: string[];
    messageAny?: string[];
  };
  forceIncludeMatchingTools?: boolean;
  directAction?: {
    runtime: string;
  };
  executionGuards?: SkillExecutionGuard[];
}

interface SkillExecutionGuard {
  toolIdSuffix?: string;
  toolIdPattern?: string;
  dropFields?: Array<{
    field: string;
    whenValueEquals?: string | number | boolean;
    unlessMessageMatches?: string;
  }>;
}

export function applyToolSkills(input: {
  messageText: string;
  requestMode?: "default" | "direct_action";
  sessionContext?: SessionContext | undefined;
  allTools: Tool<unknown, unknown>[];
  selectedTools: Tool<unknown, unknown>[];
  trace: ToolSelectionTraceEntry[];
}): {
  selectedTools: Tool<unknown, unknown>[];
  systemPromptSections: string[];
  trace: ToolSelectionTraceEntry[];
  executionGuards: SkillExecutionGuard[];
  directActionShortcut?: {
    skillName: string;
    toolIds: string[];
  };
} {
  let selectedTools = input.selectedTools;
  let trace = input.trace;
  const systemPromptSections: string[] = [];
  const executionGuards: SkillExecutionGuard[] = [];
  let directActionShortcut:
    | {
        skillName: string;
        toolIds: string[];
      }
    | undefined;

  for (const manifest of listSkillManifests()) {
    const matchingTools = input.allTools.filter((tool) => matchesToolManifest(tool.id, manifest));
    if (matchingTools.length === 0) {
      continue;
    }

    if (!shouldActivateSkill(input.messageText, input.sessionContext, manifest)) {
      continue;
    }

    if (manifest.forceIncludeMatchingTools) {
      selectedTools = dedupeById([...selectedTools, ...matchingTools]);
      trace = mergeTrace(trace, matchingTools.map((tool) => tool.id));
    }

    if (
      input.requestMode === "direct_action" &&
      !directActionShortcut &&
      manifest.directAction?.runtime === "llm_shortcut"
    ) {
      selectedTools = dedupeById(matchingTools);
      trace = mergeTrace(trace, matchingTools.map((tool) => tool.id));
      directActionShortcut = {
        skillName: manifest.name,
        toolIds: matchingTools.map((tool) => tool.id)
      };
    }

    systemPromptSections.push(readSkillBody(manifest.name));
    executionGuards.push(...(manifest.executionGuards ?? []));
  }

  return {
    selectedTools,
    systemPromptSections,
    trace,
    executionGuards,
    ...(directActionShortcut ? { directActionShortcut } : {})
  };
}

export function applySkillExecutionGuards(input: {
  toolId: string;
  toolInput: unknown;
  userMessage: string;
  guards: SkillExecutionGuard[];
}): unknown {
  if (!input.toolInput || typeof input.toolInput !== "object" || Array.isArray(input.toolInput)) {
    return input.toolInput;
  }

  let next = { ...(input.toolInput as Record<string, unknown>) };

  for (const guard of input.guards) {
    if (!matchesGuardTool(input.toolId, guard)) {
      continue;
    }

    for (const dropField of guard.dropFields ?? []) {
      if (!(dropField.field in next)) {
        continue;
      }

      if (
        dropField.whenValueEquals !== undefined &&
        next[dropField.field] !== dropField.whenValueEquals
      ) {
        continue;
      }

      if (
        dropField.unlessMessageMatches &&
        new RegExp(dropField.unlessMessageMatches, "i").test(input.userMessage)
      ) {
        continue;
      }

      delete next[dropField.field];
    }
  }

  return next;
}

function shouldActivateSkill(
  messageText: string,
  sessionContext: SessionContext | undefined,
  manifest: SkillManifest
): boolean {
  if (!manifest.activation) {
    return true;
  }

  const combined = normalize([
    messageText,
    ...(sessionContext?.recentMessages.map((message) => message.content) ?? [])
  ].join("\n"));

  const messageAll = manifest.activation.messageAll ?? [];
  const messageAny = manifest.activation.messageAny ?? [];

  if (messageAll.some((pattern) => !new RegExp(pattern, "i").test(combined))) {
    return false;
  }

  if (messageAny.length > 0 && !messageAny.some((pattern) => new RegExp(pattern, "i").test(combined))) {
    return false;
  }

  return true;
}

function listSkillManifests(): SkillManifest[] {
  const skillsDir = resolve(process.cwd(), "skills");
  const entries = readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const manifests: SkillManifest[] = [];

  for (const entry of entries) {
    try {
      const manifest = JSON.parse(readSkillManifest(entry)) as SkillManifest;
      if (manifest?.name) {
        manifests.push(manifest);
      }
    } catch {
      continue;
    }
  }

  return manifests;
}

function matchesToolManifest(toolId: string, manifest: SkillManifest): boolean {
  const suffixes = manifest.toolMatchers?.idSuffixes ?? [];
  const patterns = manifest.toolMatchers?.idPatterns ?? [];

  return (
    suffixes.some((suffix) => toolId.endsWith(suffix)) ||
    patterns.some((pattern) => new RegExp(pattern).test(toolId))
  );
}

function matchesGuardTool(toolId: string, guard: SkillExecutionGuard): boolean {
  if (guard.toolIdSuffix && toolId.endsWith(guard.toolIdSuffix)) {
    return true;
  }

  if (guard.toolIdPattern && new RegExp(guard.toolIdPattern).test(toolId)) {
    return true;
  }

  return false;
}

function mergeTrace(
  trace: ToolSelectionTraceEntry[],
  forcedToolIds: string[]
): ToolSelectionTraceEntry[] {
  const forcedIds = new Set(forcedToolIds);
  const updated = trace.map((entry) => (
    forcedIds.has(entry.toolId)
      ? {
          ...entry,
          score: Math.max(entry.score, 500),
          selected: true
        }
      : entry
  ));

  return updated.sort((a, b) => {
    if (a.selected !== b.selected) {
      return a.selected ? -1 : 1;
    }

    return b.score - a.score;
  });
}

function normalize(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function dedupeById(tools: Tool<unknown, unknown>[]): Tool<unknown, unknown>[] {
  const seen = new Set<string>();
  const result: Tool<unknown, unknown>[] = [];

  for (const tool of tools) {
    if (seen.has(tool.id)) {
      continue;
    }

    seen.add(tool.id);
    result.push(tool);
  }

  return result;
}
