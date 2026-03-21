import { z } from "zod";
import type { Tool } from "../../core/tools.js";
import type { IntegrationConnection, IntegrationExposedTool } from "../../core/domain.js";
import { IntegrationRepository } from "./repository.js";
import { McpRuntimeManager } from "../mcp/runtime-manager.js";

export async function registerDynamicMcpTools(input: {
  integrations: IntegrationRepository;
  runtimeManager: McpRuntimeManager;
  register(tool: Tool<Record<string, unknown>, unknown>): void;
}): Promise<void> {
  const discovered = await input.integrations.listEnabledExposedTools();

  for (const item of discovered) {
    input.register(createDynamicMcpTool({
      connection: item.connection,
      exposedTool: item.tool,
      integrations: input.integrations,
      runtimeManager: input.runtimeManager
    }));
  }
}

export function registerDynamicMcpTool(input: {
  connection: IntegrationConnection;
  exposedTool: IntegrationExposedTool;
  integrations: IntegrationRepository;
  runtimeManager: McpRuntimeManager;
  register(tool: Tool<Record<string, unknown>, unknown>): void;
}): void {
  input.register(createDynamicMcpTool({
    connection: input.connection,
    exposedTool: input.exposedTool,
    integrations: input.integrations,
    runtimeManager: input.runtimeManager
  }));
}

function createDynamicMcpTool(input: {
  connection: IntegrationConnection;
  exposedTool: IntegrationExposedTool;
  integrations: IntegrationRepository;
  runtimeManager: McpRuntimeManager;
}): Tool<Record<string, unknown>, unknown> {
  const policy = inferMcpToolPolicy(input.exposedTool.toolName, input.exposedTool.description);

  return {
    id: buildDynamicToolId(input.connection.id, input.exposedTool.toolName),
    description: input.exposedTool.description,
    inputSchema: z.object({}).passthrough(),
    inputJsonSchema: input.exposedTool.inputJsonSchema,
    requiredCapabilities: [],
    exposure: policy.exposure,
    approvalPolicy: policy.approvalPolicy,
    targetScope: policy.targetScope,
    async execute(toolInput, context): Promise<unknown> {
      if (!context.person) {
        throw new Error("A resolved person is required to call dynamic MCP tools");
      }

      if (policy.targetScope === "self" && context.person.id !== input.connection.personId) {
        throw new Error("This tool can only be used by the owner of the connected account");
      }

      const canAccess = await input.integrations.canAccessTool({
        connectionId: input.connection.id,
        toolId: input.exposedTool.id,
        personId: context.person.id
      });

      if (!canAccess) {
        throw new Error("You do not have access to this tool on the connected account");
      }
      return input.runtimeManager.callTool(input.connection, {
        name: input.exposedTool.toolName,
        arguments: toolInput
      });
    }
  };
}

export function buildDynamicToolId(connectionId: string, toolName: string): string {
  return `mcp.${connectionId}.${toolName}`;
}

function inferMcpToolPolicy(
  toolName: string,
  description: string
): {
  kind: "auth" | "account" | "read" | "write" | "destructive" | "unknown";
  exposure: "conversation" | "cli_only";
  approvalPolicy: "never" | "confirm" | "admin_only";
  targetScope: "self" | "household" | "owner_shared" | "system";
} {
  const haystack = `${toolName} ${description}`.toLowerCase();

  if (matchesAny(haystack, ["authenticate", "oauth", "login", "sign in", "connect account", "complete auth", "reauth"])) {
    return {
      kind: "auth",
      exposure: "conversation",
      approvalPolicy: "never",
      targetScope: "self"
    };
  }

  if (matchesAny(haystack, ["list accounts", "workspace account", "account status", "connected account"])) {
    return {
      kind: "account",
      exposure: "conversation",
      approvalPolicy: "never",
      targetScope: "self"
    };
  }

  if (matchesAny(haystack, ["delete", "remove", "disconnect", "revoke", "purge", "destroy"])) {
    return {
      kind: "destructive",
      exposure: "conversation",
      approvalPolicy: "confirm",
      targetScope: "self"
    };
  }

  if (matchesAny(haystack, ["create", "update", "manage", "send", "upload", "assign", "write", "modify"])) {
    return {
      kind: "write",
      exposure: "conversation",
      approvalPolicy: "confirm",
      targetScope: "self"
    };
  }

  if (matchesAny(haystack, ["list", "get", "search", "read", "download", "fetch"])) {
    return {
      kind: "read",
      exposure: "conversation",
      approvalPolicy: "never",
      targetScope: "owner_shared"
    };
  }

  return {
    kind: "unknown",
    exposure: "cli_only",
    approvalPolicy: "admin_only",
    targetScope: "self"
  };
}

function matchesAny(haystack: string, needles: string[]): boolean {
  return needles.some((needle) => haystack.includes(needle));
}
