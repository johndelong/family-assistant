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

export function readSkillBody(name: string): string {
  const cacheKey = `skill:${name}`;
  const cached = promptCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const fullPath = resolve(process.cwd(), "skills", name, "SKILL.md");
  const raw = readFileSync(fullPath, "utf8").trim();
  const content = raw.replace(/^---\n[\s\S]*?\n---\n?/u, "").trim();
  promptCache.set(cacheKey, content);
  return content;
}

export function readSkillManifest(name: string): string {
  const cacheKey = `skill-manifest:${name}`;
  const cached = promptCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const fullPath = resolve(process.cwd(), "skills", name, "skill.json");
  const content = readFileSync(fullPath, "utf8").trim();
  promptCache.set(cacheKey, content);
  return content;
}
