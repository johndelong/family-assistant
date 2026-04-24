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

export const integrationExposedTools = pgTable("integration_exposed_tools", {
  id: uuid("id").primaryKey(),
  connectionId: uuid("connection_id").notNull().references(() => integrationConnections.id),
  toolName: varchar("tool_name", { length: 200 }).notNull(),
  description: text("description").notNull(),
  inputJsonSchema: jsonb("input_json_schema").notNull(),
  enabled: varchar("enabled", { length: 10 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
});

export const connectionToolGrants = pgTable("connection_tool_grants", {
  connectionId: uuid("connection_id").notNull().references(() => integrationConnections.id),
  toolId: uuid("tool_id").notNull().references(() => integrationExposedTools.id),
  ownerId: uuid("owner_id").notNull().references(() => persons.id),
  granteeId: uuid("grantee_id").notNull().references(() => persons.id),
  grantedBy: uuid("granted_by").references(() => persons.id),
  grantedAt: timestamp("granted_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true })
}, (table) => ({
  pk: primaryKey({ columns: [table.connectionId, table.toolId, table.ownerId, table.granteeId] })
}));

export const memoryEntries = pgTable("memory_entries", {
  id: uuid("id").primaryKey(),
  householdId: uuid("household_id").notNull().references(() => households.id),
  personId: uuid("person_id").references(() => persons.id),
  scope: varchar("scope", { length: 32 }).notNull(),
  content: text("content").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull()
});

export const assistantProfiles = pgTable("assistant_profiles", {
  key: varchar("key", { length: 64 }).primaryKey(),
  instructions: text("instructions").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
});

export const assistantIdentity = pgTable("assistant_identity", {
  key: varchar("key", { length: 64 }).primaryKey(),
  name: text("name").notNull(),
  roleDescription: text("role_description").notNull(),
  introductionPolicy: varchar("introduction_policy", { length: 64 }).notNull(),
  signatureName: text("signature_name"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
});

export const householdProfiles = pgTable("household_profiles", {
  householdId: uuid("household_id").primaryKey().references(() => households.id),
  instructions: text("instructions").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
});

export const personProfiles = pgTable("person_profiles", {
  personId: uuid("person_id").primaryKey().references(() => persons.id),
  instructions: text("instructions").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
});

export const personPreferences = pgTable("person_preferences", {
  personId: uuid("person_id").primaryKey().references(() => persons.id),
  showProgress: varchar("show_progress", { length: 10 }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
});

export const conversationSessions = pgTable("conversation_sessions", {
  id: uuid("id").primaryKey(),
  personId: uuid("person_id").notNull().references(() => persons.id),
  channelType: varchar("channel_type", { length: 32 }).notNull(),
  externalUserId: text("external_user_id").notNull(),
  chatId: text("chat_id"),
  summary: text("summary"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
});

export const sessionMessages = pgTable("session_messages", {
  id: uuid("id").primaryKey(),
  sessionId: uuid("session_id").notNull().references(() => conversationSessions.id),
  role: varchar("role", { length: 32 }).notNull(),
  content: text("content").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull()
});

export const cronJobs = pgTable("cron_jobs", {
  id: uuid("id").primaryKey(),
  personId: uuid("person_id").notNull().references(() => persons.id),
  name: varchar("name", { length: 200 }).notNull(),
  status: varchar("status", { length: 32 }).notNull(),
  schedule: varchar("schedule", { length: 120 }).notNull(),
  timezone: varchar("timezone", { length: 120 }).notNull(),
  mode: varchar("mode", { length: 32 }).notNull(),
  target: jsonb("target").notNull(),
  delivery: jsonb("delivery").notNull(),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
});

export const cronRuns = pgTable("cron_runs", {
  id: uuid("id").primaryKey(),
  jobId: uuid("job_id").notNull().references(() => cronJobs.id),
  requestId: uuid("request_id"),
  trigger: varchar("trigger", { length: 32 }).notNull(),
  status: varchar("status", { length: 32 }).notNull(),
  scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  output: text("output"),
  error: text("error")
});

export const structuredExecutionRuns = pgTable("structured_execution_runs", {
  id: uuid("id").primaryKey(),
  requestId: uuid("request_id"),
  personId: uuid("person_id").references(() => persons.id),
  skillName: varchar("skill_name", { length: 200 }).notNull(),
  runtime: varchar("runtime", { length: 64 }).notNull(),
  status: varchar("status", { length: 32 }).notNull(),
  messageText: text("message_text").notNull(),
  currentStepId: varchar("current_step_id", { length: 200 }),
  state: jsonb("state"),
  resumeToken: uuid("resume_token"),
  trace: jsonb("trace"),
  result: text("result"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true })
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
