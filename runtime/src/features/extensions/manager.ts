import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { basename, resolve } from "node:path";
import { parseExtensionManifest, SUPPORTED_EXTENSION_API_VERSION, type ExtensionManifest } from "./registry.js";

export interface ExtensionValidationResult {
  directory: string;
  manifest: ExtensionManifest;
  hasSkillBody: boolean;
}

export interface ExtensionPackageScaffoldResult {
  directory: string;
  manifest: ExtensionManifest;
}

export class ExtensionManager {
  constructor(
    private readonly paths: {
      installedExtensionsDir: string;
      packageWorkspaceDir: string;
    }
  ) {}

  async validateDirectory(directory: string): Promise<ExtensionValidationResult> {
    const resolvedDirectory = resolve(directory);
    const manifestPath = resolve(resolvedDirectory, "skill.json");
    const manifest = parseExtensionManifest(await readFile(manifestPath, "utf8"));
    if (manifest.package.apiVersion !== SUPPORTED_EXTENSION_API_VERSION) {
      throw new Error(
        `Unsupported apiVersion ${manifest.package.apiVersion}. Supported apiVersion is ${SUPPORTED_EXTENSION_API_VERSION}.`
      );
    }

    const skillBodyPath = resolve(resolvedDirectory, "SKILL.md");
    const hasSkillBody = await pathExists(skillBodyPath);

    return {
      directory: resolvedDirectory,
      manifest,
      hasSkillBody
    };
  }

  async installFromDirectory(input: {
    sourceDirectory: string;
    replace?: boolean;
  }): Promise<ExtensionValidationResult & {
    installedDirectory: string;
    replaced: boolean;
  }> {
    const validated = await this.validateDirectory(input.sourceDirectory);
    const installedDirectory = resolve(this.paths.installedExtensionsDir, validated.manifest.name);
    const alreadyExists = await pathExists(installedDirectory);

    if (alreadyExists && !input.replace) {
      throw new Error(`Installed extension already exists: ${validated.manifest.name}`);
    }

    await mkdir(this.paths.installedExtensionsDir, { recursive: true });
    if (alreadyExists) {
      await rm(installedDirectory, { recursive: true, force: true });
    }

    await cp(validated.directory, installedDirectory, { recursive: true });

    return {
      ...validated,
      installedDirectory,
      replaced: alreadyExists
    };
  }

  async uninstall(nameOrDirectory: string): Promise<string> {
    const targetName = basename(nameOrDirectory);
    const installedDirectory = resolve(this.paths.installedExtensionsDir, targetName);
    const exists = await pathExists(installedDirectory);
    if (!exists) {
      throw new Error(`Installed extension not found: ${targetName}`);
    }

    await rm(installedDirectory, { recursive: true, force: true });
    return installedDirectory;
  }

  async scaffoldPackage(input: {
    name: string;
    description: string;
    tags?: string[];
    replace?: boolean;
  }): Promise<ExtensionPackageScaffoldResult> {
    const slug = slugify(input.name);
    const directory = resolve(this.paths.packageWorkspaceDir, slug);
    const exists = await pathExists(directory);
    if (exists && !input.replace) {
      throw new Error(`Package workspace already exists: ${slug}`);
    }

    if (exists) {
      await rm(directory, { recursive: true, force: true });
    }

    await mkdir(directory, { recursive: true });

    const manifest: ExtensionManifest = {
      name: slug,
      package: {
        version: "1.0.0",
        apiVersion: SUPPORTED_EXTENSION_API_VERSION,
        tags: input.tags ?? ["package"]
      },
      toolRuntime: {
        module: "runtime.ts"
      }
    };

    await writeFile(resolve(directory, "skill.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
    await writeFile(
      resolve(directory, "SKILL.md"),
      `---\ndescription: ${input.description.trim()}\n---\n\n${input.description.trim()}\n`,
      "utf8"
    );
    await writeFile(resolve(directory, "runtime.ts"), defaultRuntimeModule(), "utf8");

    return {
      directory,
      manifest
    };
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

function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (!slug) {
    throw new Error("Package name must contain at least one alphanumeric character");
  }

  return slug;
}

function defaultRuntimeModule(): string {
  return [
    'import type { ExtensionToolRuntimeContext } from "../../runtime/src/features/extensions/tool-runtime.js";',
    "",
    "export function registerTools(_input: ExtensionToolRuntimeContext): void {",
    "  // Register extension tools here.",
    "}"
  ].join("\n") + "\n";
}
