import { and, asc, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { randomUUID } from "node:crypto";
import type {
  ConnectionToolGrant,
  IntegrationConnection,
  IntegrationExposedTool
} from "../../core/domain.js";
import {
  connectionToolGrants,
  integrationConnections,
  integrationExposedTools
} from "../../db/schema.js";

function mapConnection(row: typeof integrationConnections.$inferSelect): IntegrationConnection {
  return {
    id: row.id,
    personId: row.personId,
    integrationKey: row.integrationKey,
    driverType: row.driverType as "native" | "rest" | "mcp",
    status: row.status as "connected" | "degraded" | "disconnected",
    encryptedCredentials: row.encryptedCredentials as IntegrationConnection["encryptedCredentials"],
    ...(row.metadata ? { metadata: row.metadata as Record<string, unknown> } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function mapExposedTool(row: typeof integrationExposedTools.$inferSelect): IntegrationExposedTool {
  return {
    id: row.id,
    connectionId: row.connectionId,
    toolName: row.toolName,
    description: row.description,
    inputJsonSchema: row.inputJsonSchema as Record<string, unknown>,
    enabled: row.enabled === "true",
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function mapGrant(row: typeof connectionToolGrants.$inferSelect): ConnectionToolGrant {
  return {
    connectionId: row.connectionId,
    toolId: row.toolId,
    ownerId: row.ownerId,
    granteeId: row.granteeId,
    ...(row.grantedBy ? { grantedBy: row.grantedBy } : {}),
    grantedAt: row.grantedAt,
    ...(row.expiresAt ? { expiresAt: row.expiresAt } : {})
  };
}

export class IntegrationRepository {
  constructor(private readonly db: NodePgDatabase) {}

  async createMcpConnection(input: {
    personId: string;
    integrationKey: string;
    metadata?: Record<string, unknown>;
  }): Promise<IntegrationConnection> {
    const record: IntegrationConnection = {
      id: randomUUID(),
      personId: input.personId,
      integrationKey: input.integrationKey,
      driverType: "mcp",
      status: "connected",
      encryptedCredentials: {
        ciphertext: "managed-by-mcp",
        iv: "managed-by-mcp",
        authTag: "managed-by-mcp",
        version: 1
      },
      ...(input.metadata ? { metadata: input.metadata } : {}),
      createdAt: new Date(),
      updatedAt: new Date()
    };

    await this.db.insert(integrationConnections).values(record);
    return record;
  }

  async listConnections(): Promise<IntegrationConnection[]> {
    const rows = await this.db.select().from(integrationConnections).orderBy(asc(integrationConnections.createdAt));
    return rows.map(mapConnection);
  }

  async listMcpConnections(): Promise<IntegrationConnection[]> {
    const rows = await this.db
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.driverType, "mcp"))
      .orderBy(asc(integrationConnections.createdAt));

    return rows.map(mapConnection);
  }

  async findConnectionById(connectionId: string): Promise<IntegrationConnection | undefined> {
    const [row] = await this.db
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.id, connectionId))
      .limit(1);

    return row ? mapConnection(row) : undefined;
  }

  async upsertExposedTool(input: {
    connectionId: string;
    toolName: string;
    description: string;
    inputJsonSchema: Record<string, unknown>;
    enabled?: boolean;
  }): Promise<IntegrationExposedTool> {
    const existing = await this.findExposedTool(input.connectionId, input.toolName);
    const now = new Date();

    if (existing) {
      await this.db
        .update(integrationExposedTools)
        .set({
          description: input.description,
          inputJsonSchema: input.inputJsonSchema,
          enabled: String(input.enabled ?? true),
          updatedAt: now
        })
        .where(eq(integrationExposedTools.id, existing.id));

      return {
        ...existing,
        description: input.description,
        inputJsonSchema: input.inputJsonSchema,
        enabled: input.enabled ?? true,
        updatedAt: now
      };
    }

    const record: IntegrationExposedTool = {
      id: randomUUID(),
      connectionId: input.connectionId,
      toolName: input.toolName,
      description: input.description,
      inputJsonSchema: input.inputJsonSchema,
      enabled: input.enabled ?? true,
      createdAt: now,
      updatedAt: now
    };

    await this.db.insert(integrationExposedTools).values({
      ...record,
      enabled: String(record.enabled)
    });
    return record;
  }

  async findExposedTool(connectionId: string, toolName: string): Promise<IntegrationExposedTool | undefined> {
    const [row] = await this.db
      .select()
      .from(integrationExposedTools)
      .where(and(
        eq(integrationExposedTools.connectionId, connectionId),
        eq(integrationExposedTools.toolName, toolName)
      ))
      .limit(1);

    return row ? mapExposedTool(row) : undefined;
  }

  async listExposedTools(connectionId: string): Promise<IntegrationExposedTool[]> {
    const rows = await this.db
      .select()
      .from(integrationExposedTools)
      .where(eq(integrationExposedTools.connectionId, connectionId))
      .orderBy(asc(integrationExposedTools.createdAt));

    return rows.map(mapExposedTool);
  }

  async findExposedToolById(toolId: string): Promise<IntegrationExposedTool | undefined> {
    const [row] = await this.db
      .select()
      .from(integrationExposedTools)
      .where(eq(integrationExposedTools.id, toolId))
      .limit(1);

    return row ? mapExposedTool(row) : undefined;
  }

  async listEnabledExposedTools(): Promise<Array<{
    connection: IntegrationConnection;
    tool: IntegrationExposedTool;
  }>> {
    const connections = await this.listMcpConnections();
    const items: Array<{
      connection: IntegrationConnection;
      tool: IntegrationExposedTool;
    }> = [];

    for (const connection of connections) {
      const tools = await this.listExposedTools(connection.id);
      for (const tool of tools) {
        if (tool.enabled) {
          items.push({ connection, tool });
        }
      }
    }

    return items;
  }

  async grantToolAccess(input: {
    connectionId: string;
    toolId: string;
    ownerId: string;
    granteeId: string;
    grantedBy?: string;
  }): Promise<ConnectionToolGrant> {
    const record: ConnectionToolGrant = {
      connectionId: input.connectionId,
      toolId: input.toolId,
      ownerId: input.ownerId,
      granteeId: input.granteeId,
      ...(input.grantedBy ? { grantedBy: input.grantedBy } : {}),
      grantedAt: new Date()
    };

    await this.db
      .insert(connectionToolGrants)
      .values(record)
      .onConflictDoNothing();

    return record;
  }

  async listToolGrants(connectionId: string): Promise<ConnectionToolGrant[]> {
    const rows = await this.db
      .select()
      .from(connectionToolGrants)
      .where(eq(connectionToolGrants.connectionId, connectionId))
      .orderBy(asc(connectionToolGrants.grantedAt));

    return rows.map(mapGrant);
  }

  async canAccessTool(input: {
    connectionId: string;
    toolId: string;
    personId: string;
  }): Promise<boolean> {
    const connection = await this.findConnectionById(input.connectionId);
    if (!connection) {
      return false;
    }

    if (connection.personId === input.personId) {
      return true;
    }

    const [grant] = await this.db
      .select()
      .from(connectionToolGrants)
      .where(and(
        eq(connectionToolGrants.connectionId, input.connectionId),
        eq(connectionToolGrants.toolId, input.toolId),
        eq(connectionToolGrants.granteeId, input.personId)
      ))
      .limit(1);

    if (!grant) {
      return false;
    }

    if (grant.expiresAt && grant.expiresAt <= new Date()) {
      return false;
    }

    return true;
  }
}
