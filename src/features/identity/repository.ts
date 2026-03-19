import { and, asc, eq, gt } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { randomInt, randomUUID } from "node:crypto";
import type { ChannelIdentity, ChannelType, PairingRequest, PairingStatus } from "../../core/domain.js";
import { channelIdentities, pairingRequests } from "../../db/schema.js";

const pairingCodeLength = 6;

function generatePairingCode(): string {
  return String(randomInt(0, 10 ** pairingCodeLength)).padStart(pairingCodeLength, "0");
}

function mapPairingRequest(row: typeof pairingRequests.$inferSelect): PairingRequest {
  return {
    id: row.id,
    channelType: row.channelType as ChannelType,
    externalId: row.externalId,
    ...(row.displayLabel ? { displayLabel: row.displayLabel } : {}),
    code: row.code,
    status: row.status as PairingStatus,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    ...(row.pairedAt ? { pairedAt: row.pairedAt } : {}),
    ...(row.pairedPersonId ? { pairedPersonId: row.pairedPersonId } : {})
  };
}

function mapChannelIdentity(row: typeof channelIdentities.$inferSelect): ChannelIdentity {
  return {
    id: row.id,
    personId: row.personId,
    channelType: row.channelType as ChannelType,
    externalId: row.externalId,
    ...(row.displayLabel ? { displayLabel: row.displayLabel } : {}),
    createdAt: row.createdAt
  };
}

export class IdentityRepository {
  constructor(private readonly db: NodePgDatabase) {}

  async createPairingRequest(input: {
    channelType: ChannelType;
    externalId: string;
    displayLabel?: string;
    ttlMinutes?: number;
  }): Promise<PairingRequest> {
    const request: PairingRequest = {
      id: randomUUID(),
      channelType: input.channelType,
      externalId: input.externalId,
      ...(input.displayLabel ? { displayLabel: input.displayLabel } : {}),
      code: generatePairingCode(),
      status: "pending",
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + (input.ttlMinutes ?? 15) * 60_000)
    };

    await this.db.insert(pairingRequests).values(request);
    return request;
  }

  async findLinkedIdentity(input: {
    channelType: ChannelType;
    externalId: string;
  }): Promise<ChannelIdentity | undefined> {
    const [identity] = await this.db
      .select()
      .from(channelIdentities)
      .where(and(eq(channelIdentities.channelType, input.channelType), eq(channelIdentities.externalId, input.externalId)))
      .limit(1);

    return identity ? mapChannelIdentity(identity) : undefined;
  }

  async findActivePairingRequest(input: {
    channelType: ChannelType;
    externalId: string;
  }): Promise<PairingRequest | undefined> {
    const [request] = await this.db
      .select()
      .from(pairingRequests)
      .where(and(
        eq(pairingRequests.channelType, input.channelType),
        eq(pairingRequests.externalId, input.externalId),
        eq(pairingRequests.status, "pending"),
        gt(pairingRequests.expiresAt, new Date())
      ))
      .orderBy(asc(pairingRequests.createdAt))
      .limit(1);

    return request ? mapPairingRequest(request) : undefined;
  }

  async findOrCreateActivePairingRequest(input: {
    channelType: ChannelType;
    externalId: string;
    displayLabel?: string;
    ttlMinutes?: number;
  }): Promise<PairingRequest> {
    const existing = await this.findActivePairingRequest({
      channelType: input.channelType,
      externalId: input.externalId
    });

    if (existing) {
      return existing;
    }

    return this.createPairingRequest(input);
  }

  async listPending(): Promise<PairingRequest[]> {
    const rows = await this.db
      .select()
      .from(pairingRequests)
      .where(and(eq(pairingRequests.status, "pending"), gt(pairingRequests.expiresAt, new Date())))
      .orderBy(asc(pairingRequests.createdAt));

    return rows.map(mapPairingRequest);
  }

  async findPendingByCode(code: string): Promise<PairingRequest | undefined> {
    const [request] = await this.db
      .select()
      .from(pairingRequests)
      .where(and(eq(pairingRequests.code, code), eq(pairingRequests.status, "pending")))
      .limit(1);

    if (!request) {
      return undefined;
    }

    if (request.expiresAt <= new Date()) {
      await this.db
        .update(pairingRequests)
        .set({ status: "expired" })
        .where(eq(pairingRequests.id, request.id));
      return undefined;
    }

    return mapPairingRequest(request);
  }

  async completePairing(requestId: string, personId: string): Promise<ChannelIdentity> {
    const now = new Date();

    const [request] = await this.db
      .select()
      .from(pairingRequests)
      .where(eq(pairingRequests.id, requestId))
      .limit(1);

    if (!request) {
      throw new Error("Pairing request not found");
    }

    await this.db
      .update(pairingRequests)
      .set({
        status: "paired",
        pairedAt: now,
        pairedPersonId: personId
      })
      .where(eq(pairingRequests.id, requestId));

    const identity: ChannelIdentity = {
      id: randomUUID(),
      personId,
      channelType: request.channelType as ChannelType,
      externalId: request.externalId,
      ...(request.displayLabel ? { displayLabel: request.displayLabel } : {}),
      createdAt: now
    };

    await this.db.insert(channelIdentities).values(identity);
    return identity;
  }

  async linkIdentity(input: {
    personId: string;
    channelType: ChannelType;
    externalId: string;
    displayLabel?: string;
  }): Promise<ChannelIdentity> {
    const identity: ChannelIdentity = {
      id: randomUUID(),
      personId: input.personId,
      channelType: input.channelType,
      externalId: input.externalId,
      ...(input.displayLabel ? { displayLabel: input.displayLabel } : {}),
      createdAt: new Date()
    };

    await this.db.insert(channelIdentities).values(identity);
    return identity;
  }

  async listIdentities(): Promise<ChannelIdentity[]> {
    const rows = await this.db.select().from(channelIdentities).orderBy(asc(channelIdentities.createdAt));
    return rows.map(mapChannelIdentity);
  }
}
