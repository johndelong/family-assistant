import type { Tool } from "../../core/tools.js";
import type { Person } from "../../core/domain.js";

export interface ToolSelectionTraceEntry {
  toolId: string;
  score: number;
  selected: boolean;
}

export function selectRelevantTools(input: {
  messageText: string;
  person: Person;
  tools: Tool<unknown, unknown>[];
  maxTools?: number;
}): {
  selectedTools: Tool<unknown, unknown>[];
  trace: ToolSelectionTraceEntry[];
} {
  const maxTools = input.maxTools ?? 12;
  const scored = input.tools.map((tool) => ({
    tool,
    score: scoreTool(tool, input.messageText)
  }));

  const alwaysInclude = new Set([
    "time.now",
    "web.search",
    "tool.catalog",
    "account.status",
    "memory.search",
    "memory.store"
  ]);

  const selected = [
    ...scored
      .filter(({ tool }) => alwaysInclude.has(tool.id))
      .sort((a, b) => b.score - a.score)
      .map(({ tool }) => tool),
    ...scored
      .filter(({ tool }) => !alwaysInclude.has(tool.id))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(0, maxTools - alwaysInclude.size))
      .map(({ tool }) => tool)
  ];

  const selectedTools = dedupeById(selected).slice(0, maxTools);
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

function scoreTool(tool: Tool<unknown, unknown>, messageText: string): number {
  const haystack = `${tool.id} ${tool.description}`.toLowerCase();
  const tokens = tokenize(messageText);
  let score = 0;

  for (const token of tokens) {
    if (haystack.includes(token)) {
      score += 3;
    }
  }

  if (tool.id.startsWith("mcp.")) {
    score += 1;
  }

  if (matchesAny(tokens, ["email", "mail", "inbox", "reply", "send"])) {
    if (haystack.includes("email") || haystack.includes("gmail") || haystack.includes("contacts")) {
      score += 8;
    }
  }

  if (matchesAny(tokens, ["calendar", "meeting", "schedule", "agenda", "event", "availability"])) {
    if (haystack.includes("calendar") || haystack.includes("agenda") || haystack.includes("event")) {
      score += 8;
    }
  }

  if (matchesAny(tokens, ["contact", "address", "email address", "phone", "wife", "husband", "person"])) {
    if (haystack.includes("contact") || haystack.includes("recipient") || haystack.includes("email address")) {
      score += 7;
    }
  }

  if (matchesAny(tokens, ["time", "date", "today", "tomorrow", "week", "month", "day"])) {
    if (tool.id === "time.now" || haystack.includes("time")) {
      score += 6;
    }
  }

  if (matchesAny(tokens, ["remember", "memory", "preference", "preferences", "profile"])) {
    if (haystack.includes("memory") || haystack.includes("profile")) {
      score += 6;
    }
  }

  if (matchesAny(tokens, ["progress", "verbose", "working", "doing", "show", "hide", "status updates"])) {
    if (haystack.includes("progress") || haystack.includes("runtime preferences") || haystack.includes("visible progress")) {
      score += 8;
    }
  }

  if (matchesAny(tokens, ["what can you do", "available", "accounts", "connected", "tools"])) {
    if (tool.id === "tool.catalog" || tool.id === "account.status") {
      score += 10;
    }
  }

  if (matchesAny(tokens, ["web", "internet", "search", "latest", "news", "recent", "current", "look up", "status", "update", "happening", "local"])) {
    if (tool.id === "web.search" || haystack.includes("public web") || haystack.includes("current information")) {
      score += 9;
    }
  }

  return score;
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9@._-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function matchesAny(tokens: string[], candidates: string[]): boolean {
  const joined = ` ${tokens.join(" ")} `;
  return candidates.some((candidate) => joined.includes(` ${candidate.toLowerCase()} `) || tokens.includes(candidate.toLowerCase()));
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
