import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const promptCache = new Map<string, string>();

export function readPromptFragment(name: string): string {
  const cached = promptCache.get(name);
  if (cached) {
    return cached;
  }

  const fullPath = resolve(process.cwd(), "prompts", `${name}.md`);
  const content = readFileSync(fullPath, "utf8").trim();
  promptCache.set(name, content);
  return content;
}
