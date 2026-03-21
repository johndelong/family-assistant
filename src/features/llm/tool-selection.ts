import type { Tool } from "../../core/tools.js";
import type { Person } from "../../core/domain.js";
import type { SessionContext } from "../sessions/service.js";

export interface ToolSelectionTraceEntry {
  toolId: string;
  score: number;
  selected: boolean;
}

const CORE_TOOL_IDS = new Set([
  "time.now",
  "web.search",
  "account.status",
  "memory.search",
  "memory.store"
]);

export function selectRelevantTools(input: {
  messageText: string;
  person: Person;
  tools: Tool<unknown, unknown>[];
  sessionContext?: SessionContext | undefined;
  maxTools?: number;
}): {
  selectedTools: Tool<unknown, unknown>[];
  trace: ToolSelectionTraceEntry[];
} {
  const maxTools = input.maxTools ?? 18;
  const stickyToolIds = collectStickyToolIds(input.sessionContext, input.tools);
  const stickyFamilies = collectStickyIntegrationFamilies(input.sessionContext, input.tools);
  const scored = input.tools.map((tool) => ({
    tool,
    score: scoreTool(tool, input.messageText, stickyToolIds, stickyFamilies)
  }));

  const selected = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, maxTools)
    .map(({ tool }) => tool);

  const selectedTools = dedupeById(selected);
  const selectedIds = new Set(selectedTools.map((tool) => tool.id));
  const trace = scored
    .map(({ tool, score }) => ({
      toolId: tool.id,
      score,
      selected: selectedIds.has(tool.id)
    }))
    .sort((a, b) => {
      if (a.selected !== b.selected) {
        return a.selected ? -1 : 1;
      }

      return b.score - a.score;
    });

  return {
    selectedTools,
    trace
  };
}

function scoreTool(
  tool: Tool<unknown, unknown>,
  messageText: string,
  stickyToolIds: Set<string>,
  stickyFamilies: Set<string>
): number {
  let score = 0;

  if (CORE_TOOL_IDS.has(tool.id)) {
    score += 100;
  }

  if (stickyToolIds.has(tool.id)) {
    score += 80;
  }

  if (belongsToStickyFamily(tool.id, stickyFamilies)) {
    score += 40;
  }

  score += lexicalScore(tool, messageText);

  return score;
}

function lexicalScore(tool: Tool<unknown, unknown>, messageText: string): number {
  const haystack = normalize(`${tool.id} ${tool.description}`);
  const tokens = tokenize(messageText);
  let score = 0;

  for (const token of tokens) {
    if (haystack.includes(token)) {
      score += 2;
    }
  }

  return score;
}

function collectStickyToolIds(
  sessionContext: SessionContext | undefined,
  tools: Tool<unknown, unknown>[]
): Set<string> {
  if (!sessionContext) {
    return new Set<string>();
  }

  const combined = normalize(sessionContext.recentMessages.map((message) => message.content).join("\n"));

  return new Set(
    tools
      .map((tool) => tool.id)
      .filter((toolId) => combined.includes(normalize(toolId)))
  );
}

function collectStickyIntegrationFamilies(
  sessionContext: SessionContext | undefined,
  tools: Tool<unknown, unknown>[]
): Set<string> {
  if (!sessionContext) {
    return new Set<string>();
  }

  const combined = normalize(sessionContext.recentMessages.map((message) => message.content).join("\n"));
  const families = new Set<string>();

  for (const tool of tools) {
    const family = extractIntegrationFamily(tool.id);
    if (!family) {
      continue;
    }

    const toolWords = tokenize(tool.id);
    if (toolWords.some((word) => combined.includes(word))) {
      families.add(family);
    }
  }

  return families;
}

function extractIntegrationFamily(toolId: string): string | undefined {
  const match = /^mcp\.([^.]+)/.exec(toolId);
  return match?.[1];
}

function belongsToStickyFamily(toolId: string, stickyFamilies: Set<string>): boolean {
  const family = extractIntegrationFamily(toolId);
  return family ? stickyFamilies.has(family) : false;
}

function tokenize(value: string): string[] {
  return normalize(value)
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
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
