import { z } from "../../../runtime/src/core/zod.js";
import type { Tool } from "../../../runtime/src/core/tools.js";
import type { IntegrationRepository } from "../../../runtime/src/features/integrations/repository.js";

interface AccountStatusInput {}

interface AccountStatusResult {
  accounts: Array<{
    connectionId: string;
    integrationKey: string;
    driverType: "native" | "rest" | "mcp";
    status: "connected" | "degraded" | "disconnected";
    enabledToolCount: number;
    updatedAt: string;
  }>;
}

const accountStatusSchema = z.object({});

const accountStatusJsonSchema = {
  type: "object",
  properties: {},
  additionalProperties: false
} satisfies Record<string, unknown>;

export function createAccountStatusTool(integrations: IntegrationRepository): Tool<AccountStatusInput, AccountStatusResult> {
  return {
    id: "account.status",
    description: "Inspect the current person's connected accounts and integration health before using account-dependent tools",
    inputSchema: accountStatusSchema,
    inputJsonSchema: accountStatusJsonSchema,
    requiredCapabilities: [],
    exposure: "conversation",
    approvalPolicy: "never",
    targetScope: "self",
    async execute(_input, context): Promise<AccountStatusResult> {
      if (!context.person) {
        throw new Error("A resolved person is required to inspect account status");
      }

      const allConnections = await integrations.listConnections();
      const ownedConnections = allConnections.filter((connection) => connection.personId === context.person?.id);
      const accounts = await Promise.all(ownedConnections.map(async (connection) => {
        const enabledToolCount = (await integrations.listExposedTools(connection.id))
          .filter((tool) => tool.enabled)
          .length;

        return {
          connectionId: connection.id,
          integrationKey: connection.integrationKey,
          driverType: connection.driverType,
          status: connection.status,
          enabledToolCount,
          updatedAt: connection.updatedAt.toISOString()
        };
      }));

      return { accounts };
    }
  };
}
