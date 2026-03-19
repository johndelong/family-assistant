export type PersonRole = "admin" | "member" | "limited";
export type ChannelType = "websocket" | "telegram";
export type PairingStatus = "pending" | "paired" | "expired" | "revoked";
export type CorePermission =
  | "system.configure"
  | "household.manage"
  | "person.manage"
  | "identity.manage"
  | "config.self"
  | "approval.respond";

export interface Household {
  id: string;
  name: string;
  createdAt: Date;
}

export interface Person {
  id: string;
  householdId: string;
  name: string;
  role: PersonRole;
  createdAt: Date;
}

export interface ChannelIdentity {
  id: string;
  personId: string;
  channelType: ChannelType;
  externalId: string;
  displayLabel?: string;
  createdAt: Date;
}

export interface PairingRequest {
  id: string;
  channelType: ChannelType;
  externalId: string;
  displayLabel?: string;
  code: string;
  status: PairingStatus;
  expiresAt: Date;
  createdAt: Date;
  pairedAt?: Date;
  pairedPersonId?: string;
}

export interface CorePolicyGrant {
  personId: string;
  permission: CorePermission;
  grantedBy?: string;
  grantedAt: Date;
}

export interface IntegrationConnection {
  id: string;
  personId: string;
  integrationKey: string;
  driverType: "native" | "rest" | "mcp";
  status: "connected" | "degraded" | "disconnected";
  encryptedCredentials: EncryptedSecret;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface EncryptedSecret {
  ciphertext: string;
  iv: string;
  authTag: string;
  version: number;
}
