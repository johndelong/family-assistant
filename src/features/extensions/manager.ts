import { access, cp, mkdir, readFile, rm } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { basename, resolve } from "node:path";
import { parseExtensionManifest, SUPPORTED_EXTENSION_API_VERSION, type ExtensionManifest } from "./registry.js";

export interface ExtensionValidationResult {
  directory: string;
  manifest: ExtensionManifest;
  hasSkillBody: boolean;
}

export class ExtensionManager {
  constructor(private readonly managedExtensionsDir: string) {}

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
    const installedDirectory = resolve(this.managedExtensionsDir, validated.manifest.name);
    const alreadyExists = await pathExists(installedDirectory);

    if (alreadyExists && !input.replace) {
      throw new Error(`Managed extension already exists: ${validated.manifest.name}`);
    }

    await mkdir(this.managedExtensionsDir, { recursive: true });
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
    const installedDirectory = resolve(this.managedExtensionsDir, targetName);
    const exists = await pathExists(installedDirectory);
    if (!exists) {
      throw new Error(`Managed extension not found: ${targetName}`);
    }

    await rm(installedDirectory, { recursive: true, force: true });
    return installedDirectory;
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
