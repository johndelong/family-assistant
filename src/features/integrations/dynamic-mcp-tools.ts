import { z } from "zod";
import type { Tool } from "../../core/tools.js";
import type { IntegrationConnection, IntegrationExposedTool } from "../../core/domain.js";
import { IntegrationRepository } from "./repository.js";
import { McpStdioClient } from "./mcp-stdio-client.js";

export async function registerDynamicMcpTools(input: {
  integrations: IntegrationRepository;
  mcpClient: McpStdioClient;
  register(tool: Tool<Record<string, unknown>, unknown>): void;
}): Promise<void> {
  const discovered = await input.integrations.listEnabledExposedTools();

  for (const item of discovered) {
    input.register(createDynamicMcpTool({
      connection: item.connection,
      exposedTool: item.tool,
      integrations: input.integrations,
      mcpClient: input.mcpClient
    }));
  }
}

function createDynamicMcpTool(input: {
  connection: IntegrationConnection;
  exposedTool: IntegrationExposedTool;
  integrations: IntegrationRepository;
  mcpClient: McpStdioClient;
}): Tool<Record<string, unknown>, unknown> {
  return {
    id: buildDynamicToolId(input.connection.id, input.exposedTool.toolName),
    description: input.exposedTool.description,
    inputSchema: z.object({}).passthrough(),
    inputJsonSchema: input.exposedTool.inputJsonSchema,
    requiredCapabilities: [],
    exposure: "conversation",
    approvalPolicy: "never",
    targetScope: "owner_shared",
    async execute(toolInput, context): Promise<unknown> {
      if (!context.person) {
        throw new Error("A resolved person is required to call dynamic MCP tools");
      }

      const canAccess = await input.integrations.canAccessTool({
        connectionId: input.connection.id,
        toolId: input.exposedTool.id,
        personId: context.person.id
      });

      if (!canAccess) {
        throw new Error("You do not have access to this tool on the connected account");
      }

      const transport = parseMcpTransport(input.connection);
      return input.mcpClient.callTool(transport, {
        name: input.exposedTool.toolName,
        arguments: toolInput
      });
    }
  };
}

export function buildDynamicToolId(connectionId: string, toolName: string): string {
  return `mcp.${connectionId}.${toolName}`;
}

function parseMcpTransport(connection: IntegrationConnection): {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
} {
  const metadata = connection.metadata ?? {};
  const command = metadata.command;
  const args = metadata.args;
  const cwd = metadata.cwd;
  const env = metadata.env;

  if (typeof command !== "string" || command.trim().length === 0) {
    throw new Error(`MCP connection ${connection.id} is missing metadata.command`);
  }

  if (args !== undefined && (!Array.isArray(args) || args.some((value) => typeof value !== "string"))) {
    throw new Error(`MCP connection ${connection.id} has invalid metadata.args`);
  }

  if (cwd !== undefined && typeof cwd !== "string") {
    throw new Error(`MCP connection ${connection.id} has invalid metadata.cwd`);
  }

  if (
    env !== undefined &&
    (
      typeof env !== "object" ||
      env === null ||
      Array.isArray(env) ||
      Object.values(env).some((value) => typeof value !== "string")
    )
  ) {
    throw new Error(`MCP connection ${connection.id} has invalid metadata.env`);
  }

  return {
    command,
    ...(Array.isArray(args) ? { args: args as string[] } : {}),
    ...(typeof cwd === "string" ? { cwd } : {}),
    ...(env ? { env: env as Record<string, string> } : {})
  };
}
