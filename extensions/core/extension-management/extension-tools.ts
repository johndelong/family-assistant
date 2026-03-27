import { z } from "../../../runtime/src/core/zod.js";
import type { Tool } from "../../../runtime/src/core/tools.js";
import type { ExtensionManager } from "../../../runtime/src/features/extensions/manager.js";

function ensureAdmin(context: { person?: { role: string } }): void {
  if (!context.person) {
    throw new Error("A resolved person is required to manage extensions.");
  }

  if (context.person.role !== "admin") {
    throw new Error("Only an admin can manage extensions.");
  }
}

const packageCreateSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  tags: z.array(z.string()).optional(),
  replace: z.boolean().optional()
});

export function createExtensionPackageTool(manager: ExtensionManager): Tool<z.infer<typeof packageCreateSchema>, {
  packageName: string;
  directory: string;
  version: string;
}> {
  return {
    id: "extension.package_create",
    description: "Create a new package extension scaffold in the package workspace so it can be edited and later installed.",
    inputSchema: packageCreateSchema,
    inputJsonSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        description: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        replace: { type: "boolean" }
      },
      required: ["name", "description"],
      additionalProperties: false
    },
    exposure: "conversation",
    approvalPolicy: "confirm",
    targetScope: "system",
    async execute(input, context) {
      ensureAdmin(context);
      const result = await manager.scaffoldPackage({
        name: input.name,
        description: input.description,
        ...(input.tags ? { tags: input.tags } : {}),
        ...(typeof input.replace === "boolean" ? { replace: input.replace } : {})
      });

      return {
        packageName: result.manifest.name,
        directory: result.directory,
        version: result.manifest.package.version
      };
    }
  };
}

const extensionInstallSchema = z.object({
  fromDirectory: z.string().min(1),
  replace: z.boolean().optional()
});

export function createExtensionInstallTool(manager: ExtensionManager): Tool<z.infer<typeof extensionInstallSchema>, {
  extensionName: string;
  installedDirectory: string;
  replaced: boolean;
}> {
  return {
    id: "extension.install",
    description: "Install or update an extension from a source directory into the runtime's installed extensions directory.",
    inputSchema: extensionInstallSchema,
    inputJsonSchema: {
      type: "object",
      properties: {
        fromDirectory: { type: "string" },
        replace: { type: "boolean" }
      },
      required: ["fromDirectory"],
      additionalProperties: false
    },
    exposure: "conversation",
    approvalPolicy: "confirm",
    targetScope: "system",
    async execute(input, context) {
      ensureAdmin(context);
      const result = await manager.installFromDirectory({
        sourceDirectory: input.fromDirectory,
        ...(typeof input.replace === "boolean" ? { replace: input.replace } : {})
      });

      return {
        extensionName: result.manifest.name,
        installedDirectory: result.installedDirectory,
        replaced: result.replaced
      };
    }
  };
}

const extensionRemoveSchema = z.object({
  name: z.string().min(1)
});

export function createExtensionRemoveTool(manager: ExtensionManager): Tool<z.infer<typeof extensionRemoveSchema>, {
  extensionName: string;
  removedDirectory: string;
}> {
  return {
    id: "extension.remove",
    description: "Remove an installed extension by name.",
    inputSchema: extensionRemoveSchema,
    inputJsonSchema: {
      type: "object",
      properties: {
        name: { type: "string" }
      },
      required: ["name"],
      additionalProperties: false
    },
    exposure: "conversation",
    approvalPolicy: "confirm",
    targetScope: "system",
    async execute(input, context) {
      ensureAdmin(context);
      const removedDirectory = await manager.uninstall(input.name);
      return {
        extensionName: input.name,
        removedDirectory
      };
    }
  };
}
