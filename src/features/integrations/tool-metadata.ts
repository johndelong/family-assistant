export interface NormalizedMcpToolMetadata {
  description: string;
  inputJsonSchema: Record<string, unknown>;
}

export function normalizeMcpToolMetadata(input: {
  toolName: string;
  description?: string;
  inputJsonSchema?: Record<string, unknown>;
}): NormalizedMcpToolMetadata {
  const description = buildPlannerFriendlyDescription(input.toolName, input.description);

  return {
    description,
    inputJsonSchema: input.inputJsonSchema ?? {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: true
    }
  };
}

function buildPlannerFriendlyDescription(toolName: string, rawDescription: string | undefined): string {
  const trimmed = (rawDescription ?? "").trim();
  const firstParagraph = trimmed.split(/\n\s*\n/)[0]?.trim() ?? "";
  const firstSentence = firstParagraph.split(/(?<=[.!?])\s+/)[0]?.trim() ?? "";
  const summary = firstSentence.length > 0
    ? firstSentence
    : `Use ${toolName} to interact with the connected integration.`;

  const hints = inferHints(toolName, rawDescription ?? "");
  return [summary, ...hints].join(" ");
}

function inferHints(toolName: string, description: string): string[] {
  const haystack = `${toolName} ${description}`.toLowerCase();
  const hints: string[] = [];

  if (matchesAny(haystack, ["contacts", "recipient", "email address"])) {
    hints.push("Useful for resolving people, email addresses, and contact details before asking the user again.");
  }

  if (matchesAny(haystack, ["calendar", "event", "agenda", "freebusy"])) {
    hints.push("Useful for answering schedule and availability questions with real account data.");
  }

  if (matchesAny(haystack, ["email", "gmail", "inbox", "thread", "message"])) {
    hints.push("Useful for searching, reading, drafting, replying, and sending email with real mailbox data.");
  }

  if (matchesAny(haystack, ["account", "authenticate", "status", "capabilities"])) {
    hints.push("Useful for checking whether an account is connected and what capabilities are available.");
  }

  if (matchesAny(haystack, ["drive", "docs", "sheets", "tasks", "workspace"])) {
    hints.push("Useful for looking up files, documents, tasks, or workspace content in the connected account.");
  }

  if (hints.length === 0) {
    hints.push("Use this when the task clearly matches the tool's name and returned data can help complete the user's request.");
  }

  return hints;
}

function matchesAny(haystack: string, needles: string[]): boolean {
  return needles.some((needle) => haystack.includes(needle));
}
