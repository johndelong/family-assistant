import { pgTable, text, timestamp, uuid, varchar, jsonb, primaryKey } from "drizzle-orm/pg-core";

export const households = pgTable("households", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull()
});

export const persons = pgTable("persons", {
  id: uuid("id").primaryKey(),
  householdId: uuid("household_id").notNull().references(() => households.id),
  name: text("name").notNull(),
  role: varchar("role", { length: 32 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull()
});

export const channelIdentities = pgTable("channel_identities", {
  id: uuid("id").primaryKey(),
  personId: uuid("person_id").notNull().references(() => persons.id),
  channelType: varchar("channel_type", { length: 32 }).notNull(),
  externalId: text("external_id").notNull(),
  displayLabel: text("display_label"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull()
});

export const pairingRequests = pgTable("pairing_requests", {
  id: uuid("id").primaryKey(),
  channelType: varchar("channel_type", { length: 32 }).notNull(),
  externalId: text("external_id").notNull(),
  displayLabel: text("display_label"),
  code: varchar("code", { length: 6 }).notNull(),
  status: varchar("status", { length: 32 }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  pairedAt: timestamp("paired_at", { withTimezone: true }),
  pairedPersonId: uuid("paired_person_id").references(() => persons.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull()
});

export const corePolicyGrants = pgTable("core_policy_grants", {
  personId: uuid("person_id").notNull().references(() => persons.id),
  permission: varchar("permission", { length: 64 }).notNull(),
  grantedBy: uuid("granted_by").references(() => persons.id),
  grantedAt: timestamp("granted_at", { withTimezone: true }).notNull()
}, (table) => ({
  pk: primaryKey({ columns: [table.personId, table.permission] })
}));

export const integrationConnections = pgTable("integration_connections", {
  id: uuid("id").primaryKey(),
  personId: uuid("person_id").notNull().references(() => persons.id),
  integrationKey: varchar("integration_key", { length: 100 }).notNull(),
  driverType: varchar("driver_type", { length: 32 }).notNull(),
  status: varchar("status", { length: 32 }).notNull(),
  encryptedCredentials: jsonb("encrypted_credentials").notNull(),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
});

export const memoryEntries = pgTable("memory_entries", {
  id: uuid("id").primaryKey(),
  householdId: uuid("household_id").notNull().references(() => households.id),
  personId: uuid("person_id").references(() => persons.id),
  scope: varchar("scope", { length: 32 }).notNull(),
  content: text("content").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull()
});

export const toolCapabilities = pgTable("tool_capabilities", {
  capabilityName: varchar("capability_name", { length: 200 }).primaryKey(),
  toolId: varchar("tool_id", { length: 200 }).notNull(),
  description: text("description").notNull(),
  targetScope: varchar("target_scope", { length: 50 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull()
});

export const capabilityGrants = pgTable("capability_grants", {
  personId: uuid("person_id").notNull().references(() => persons.id),
  capabilityName: varchar("capability_name", { length: 200 }).notNull().references(() => toolCapabilities.capabilityName),
  grantedBy: uuid("granted_by").references(() => persons.id),
  grantedAt: timestamp("granted_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true })
}, (table) => ({
  pk: primaryKey({ columns: [table.personId, table.capabilityName] })
}));

export const sharedCapabilityGrants = pgTable("shared_capability_grants", {
  ownerId: uuid("owner_id").notNull().references(() => persons.id),
  granteeId: uuid("grantee_id").notNull().references(() => persons.id),
  capabilityName: varchar("capability_name", { length: 200 }).notNull().references(() => toolCapabilities.capabilityName),
  grantedAt: timestamp("granted_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true })
}, (table) => ({
  pk: primaryKey({ columns: [table.ownerId, table.granteeId, table.capabilityName] })
}));
