import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname } from "node:path";

interface ExtensionStateFile {
  enabled: Record<string, boolean>;
}

export class ExtensionStateStore {
  readonly #enabled = new Map<string, boolean>();

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    this.#enabled.clear();

    if (!(await pathExists(this.filePath))) {
      return;
    }

    const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<ExtensionStateFile>;
    for (const [name, enabled] of Object.entries(parsed.enabled ?? {})) {
      if (typeof enabled === "boolean") {
        this.#enabled.set(name, enabled);
      }
    }
  }

  isEnabled(name: string): boolean {
    return this.#enabled.get(name) ?? true;
  }

  snapshot(): Record<string, boolean> {
    return Object.fromEntries(this.#enabled.entries());
  }

  async setEnabled(name: string, enabled: boolean): Promise<void> {
    this.#enabled.set(name, enabled);
    await this.#save();
  }

  async #save(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const payload: ExtensionStateFile = {
      enabled: this.snapshot()
    };
    await writeFile(this.filePath, JSON.stringify(payload, null, 2) + "\n", "utf8");
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}
