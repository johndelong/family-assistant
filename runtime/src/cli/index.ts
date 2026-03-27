#!/usr/bin/env node

import { Command, InvalidArgumentError } from "commander";
import { resolve } from "node:path";
import { TraceRepository } from "../features/tracing/repository.js";
import { ExtensionManager } from "../features/extensions/manager.js";
import { formatAcceptedRequestForUser } from "../features/requests/formatter.js";
import type { ChannelType, PersonRole } from "../core/domain.js";
import { createCliContext } from "./context.js";
import { loadAppConfig } from "../shared/config.js";

const validRoles: PersonRole[] = ["admin", "member", "limited"];
const validChannels: ChannelType[] = ["websocket", "telegram"];

function parseRole(value: string): PersonRole {
  if (validRoles.includes(value as PersonRole)) {
    return value as PersonRole;
  }

  throw new InvalidArgumentError(`Role must be one of: ${validRoles.join(", ")}`);
}

function parseChannel(value: string): ChannelType {
  if (validChannels.includes(value as ChannelType)) {
    return value as ChannelType;
  }

  throw new InvalidArgumentError(`Channel must be one of: ${validChannels.join(", ")}`);
}

function parseBooleanFlag(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (["true", "yes", "on", "1"].includes(normalized)) {
    return true;
  }

  if (["false", "no", "off", "0"].includes(normalized)) {
    return false;
  }

  throw new InvalidArgumentError("Expected a boolean value like true/false, yes/no, on/off, or 1/0");
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Expected a JSON object");
    }

    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new InvalidArgumentError(`Expected valid JSON object: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseJsonStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
      throw new Error("Expected a JSON array of strings");
    }

    return parsed;
  } catch (error) {
    throw new InvalidArgumentError(`Expected valid JSON string array: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseJsonStringRecord(value: string): Record<string, string> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      Object.values(parsed).some((item) => typeof item !== "string")
    ) {
      throw new Error("Expected a JSON object with string values");
    }

    return parsed as Record<string, string>;
  } catch (error) {
    throw new InvalidArgumentError(`Expected valid JSON string object: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function withContext<T>(action: (ctx: Awaited<ReturnType<typeof createCliContext>>) => Promise<T>): Promise<T> {
  const config = loadAppConfig();
  const context = await createCliContext(config);

  try {
    return await action(context);
  } finally {
    await context.close();
  }
}

function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function findPersonByRef(
  ctx: Awaited<ReturnType<typeof createCliContext>>,
  personRef: string
) {
  if (isUuidLike(personRef)) {
    return ctx.persons.findById(personRef);
  }

  return ctx.persons.findByName(personRef);
}

function buildProgram(): Command {
  const program = new Command();
  const config = loadAppConfig();

  program
    .name("family-assistant")
    .description("CLI for the Family Assistant platform")
    .version("0.1.0");

  program
    .command("init")
    .description("Initialize local configuration expectations for the project")
    .action(() => {
      console.log("Family Assistant bootstrap is ready.");
      console.log(`Environment: ${config.environment}`);
      console.log("Next step: configure DATABASE_URL and run `family-assistant doctor`.");
    });

  program
    .command("doctor")
    .description("Run a lightweight environment sanity check")
    .action(async () => {
      console.log("Doctor summary:");
      console.log(`- NODE_ENV: ${config.environment}`);
      console.log(`- HOST: ${config.host}`);
      console.log(`- PORT: ${config.port}`);
      console.log(`- DATA_DIR: ${config.dataDir}`);
      console.log(`- DATABASE_URL configured: ${config.databaseUrl ? "yes" : "no"}`);
      console.log(`- ENCRYPTION_MASTER_KEY configured: ${config.encryptionMasterKey ? "yes" : "no"}`);
      console.log(`- OPENAI_API_KEY configured: ${config.openAiApiKey ? "yes" : "no"}`);
      console.log(`- OPENAI_MODEL: ${config.openAiModel}`);
      console.log(`- BRAVE_API_KEY configured: ${config.braveApiKey ? "yes" : "no"}`);
      console.log(`- ADMIN_API_TOKEN configured: ${config.adminApiToken ? "yes" : "no"}`);
      console.log(`- TELEGRAM_BOT_TOKEN configured: ${config.telegramBotToken ? "yes" : "no"}`);
      console.log(`- TELEGRAM_LONG_POLL_TIMEOUT_SEC: ${config.telegramLongPollTimeoutSec}`);

      if (config.databaseUrl) {
        try {
          await withContext(async () => undefined);
          console.log("- Database connectivity: ok");
        } catch (error) {
          console.log(`- Database connectivity: failed (${error instanceof Error ? error.message : String(error)})`);
        }
      }
    });

  program
    .command("db:setup")
    .description("Create the initial database schema if it does not exist")
    .action(async () => {
      await withContext(async () => undefined);
      console.log("Database schema is ready.");
    });

  const household = program.command("household").description("Manage households");

  household
    .command("create")
    .argument("<name>", "Household name")
    .description("Create a household")
    .action(async (name: string) => {
      const created = await withContext((ctx) => ctx.households.create(name));
      console.log(`Created household ${created.name} (${created.id})`);
    });

  household
    .command("list")
    .description("List households")
    .action(async () => {
      const households = await withContext((ctx) => ctx.households.list());

      if (households.length === 0) {
        console.log("No households found.");
        return;
      }

      for (const item of households) {
        console.log(`${item.id}  ${item.name}`);
      }
    });

  const person = program.command("person").description("Manage household members");

  person
    .command("add")
    .requiredOption("--household <householdId>", "Household ID")
    .requiredOption("--name <name>", "Person name")
    .requiredOption("--role <role>", "Role", parseRole)
    .description("Add a person to a household")
    .action(async (options: { household: string; name: string; role: PersonRole }) => {
      const created = await withContext(async (ctx) => {
        const householdRecord = await ctx.households.findById(options.household);
        if (!householdRecord) {
          throw new Error(`Household not found: ${options.household}`);
        }

        return ctx.persons.create({
          householdId: householdRecord.id,
          name: options.name,
          role: options.role
        });
      });

      console.log(`Created person ${created.name} (${created.id}) with role ${created.role}`);
    });

  person
    .command("list")
    .option("--household <householdId>", "Filter by household ID")
    .description("List persons")
    .action(async (options: { household?: string }) => {
      const people = await withContext((ctx) => ctx.persons.list(options.household));

      if (people.length === 0) {
        console.log("No persons found.");
        return;
      }

      for (const item of people) {
        console.log(`${item.id}  ${item.name}  role=${item.role}  household=${item.householdId}`);
      }
    });

  const identity = program.command("identity").description("Manage channel identities and pairing");

  identity
    .command("request")
    .requiredOption("--channel <channel>", "Channel type", parseChannel)
    .requiredOption("--external-id <externalId>", "External channel identity")
    .option("--display-label <label>", "Optional display label")
    .option("--ttl <minutes>", "Pairing request TTL in minutes", "15")
    .description("Create a pairing request for an inbound channel identity")
    .action(async (options: { channel: ChannelType; externalId: string; displayLabel?: string; ttl: string }) => {
      const request = await withContext((ctx) => ctx.identities.createPairingRequest({
        channelType: options.channel,
        externalId: options.externalId,
        ...(options.displayLabel ? { displayLabel: options.displayLabel } : {}),
        ttlMinutes: Number(options.ttl)
      }));

      console.log(`Created pairing request ${request.code} for ${request.channelType}:${request.externalId}`);
    });

  identity
    .command("pending")
    .description("List active pairing requests")
    .action(async () => {
      const requests = await withContext((ctx) => ctx.identities.listPending());

      if (requests.length === 0) {
        console.log("No active pairing requests.");
        return;
      }

      for (const request of requests) {
        console.log(`${request.code}  ${request.channelType}:${request.externalId}  expires=${request.expiresAt.toISOString()}`);
      }
    });

  identity
    .command("pair")
    .requiredOption("--code <code>", "Pairing code")
    .requiredOption("--person <personRef>", "Person ID or exact name")
    .description("Complete a pending pairing request")
    .action(async (options: { code: string; person: string }) => {
      const identityRecord = await withContext(async (ctx) => {
        const request = await ctx.identities.findPendingByCode(options.code);
        if (!request) {
          throw new Error(`Pending pairing request not found for code ${options.code}`);
        }

        const personRecord = await findPersonByRef(ctx, options.person);
        if (!personRecord) {
          throw new Error(`Person not found: ${options.person}`);
        }

        return ctx.identities.completePairing(request.id, personRecord.id);
      });

      console.log(`Paired ${identityRecord.channelType}:${identityRecord.externalId} to person ${identityRecord.personId}`);
    });

  identity
    .command("link")
    .requiredOption("--person <personId>", "Person ID")
    .requiredOption("--channel <channel>", "Channel type", parseChannel)
    .requiredOption("--external-id <externalId>", "External channel identity")
    .option("--display-label <label>", "Optional display label")
    .description("Directly link a known channel identity to a person")
    .action(async (options: { person: string; channel: ChannelType; externalId: string; displayLabel?: string }) => {
      const linked = await withContext(async (ctx) => {
        const personRecord = await ctx.persons.findById(options.person);
        if (!personRecord) {
          throw new Error(`Person not found: ${options.person}`);
        }

        return ctx.identities.linkIdentity({
          personId: personRecord.id,
          channelType: options.channel,
          externalId: options.externalId,
          ...(options.displayLabel ? { displayLabel: options.displayLabel } : {})
        });
      });

      console.log(`Linked ${linked.channelType}:${linked.externalId} to person ${linked.personId}`);
    });

  identity
    .command("list")
    .description("List linked channel identities")
    .action(async () => {
      const identities = await withContext((ctx) => ctx.identities.listIdentities());

      if (identities.length === 0) {
        console.log("No linked identities found.");
        return;
      }

      for (const item of identities) {
        console.log(`${item.id}  ${item.channelType}:${item.externalId}  person=${item.personId}`);
      }
    });

  const profile = program.command("profile").description("Manage prompt profiles for the assistant, household, and people");

  profile
    .command("assistant-show")
    .description("Show the current assistant profile")
    .action(async () => {
      const record = await withContext((ctx) => ctx.profiles.getAssistantProfile());
      console.log(record.instructions);
    });

  profile
    .command("assistant-identity-show")
    .description("Show the current assistant identity")
    .action(async () => {
      const record = await withContext((ctx) => ctx.profiles.getAssistantIdentity());
      console.log(JSON.stringify(record, null, 2));
    });

  profile
    .command("assistant-set")
    .argument("<instructions>", "Assistant profile instructions")
    .description("Set the global assistant profile")
    .action(async (instructions: string) => {
      const record = await withContext((ctx) => ctx.profiles.setAssistantProfile(instructions.trim()));
      console.log(`Updated assistant profile at ${record.updatedAt.toISOString()}`);
    });

  profile
    .command("assistant-identity-set")
    .requiredOption("--name <name>", "Assistant name")
    .requiredOption("--role <roleDescription>", "Assistant role description")
    .option("--signature <signatureName>", "Optional signature name")
    .description("Set the assistant identity")
    .action(async (options: { name: string; role: string; signature?: string }) => {
      const record = await withContext((ctx) => ctx.profiles.setAssistantIdentity({
        name: options.name,
        roleDescription: options.role,
        ...(options.signature ? { signatureName: options.signature } : {})
      }));
      console.log(`Updated assistant identity at ${record.updatedAt.toISOString()}`);
    });

  profile
    .command("household-show")
    .requiredOption("--household <householdId>", "Household ID")
    .description("Show the household profile")
    .action(async (options: { household: string }) => {
      const record = await withContext((ctx) => ctx.profiles.getHouseholdProfile(options.household));

      if (!record) {
        console.log("No household profile set.");
        return;
      }

      console.log(record.instructions);
    });

  profile
    .command("household-set")
    .requiredOption("--household <householdId>", "Household ID")
    .argument("<instructions>", "Household profile instructions")
    .description("Set the household profile")
    .action(async (instructions: string, options: { household: string }) => {
      const record = await withContext(async (ctx) => {
        const householdRecord = await ctx.households.findById(options.household);
        if (!householdRecord) {
          throw new Error(`Household not found: ${options.household}`);
        }

        return ctx.profiles.setHouseholdProfile(options.household, instructions.trim());
      });

      console.log(`Updated household profile for ${record.householdId} at ${record.updatedAt.toISOString()}`);
    });

  profile
    .command("person-show")
    .requiredOption("--person <personRef>", "Person ID or exact name")
    .description("Show the person profile")
    .action(async (options: { person: string }) => {
      const record = await withContext(async (ctx) => {
        const personRecord = await findPersonByRef(ctx, options.person);
        if (!personRecord) {
          throw new Error(`Person not found: ${options.person}`);
        }

        return ctx.profiles.getPersonProfile(personRecord.id);
      });

      if (!record) {
        console.log("No person profile set.");
        return;
      }

      console.log(record.instructions);
    });

  profile
    .command("person-set")
    .requiredOption("--person <personRef>", "Person ID or exact name")
    .argument("<instructions>", "Person profile instructions")
    .description("Set the person profile")
    .action(async (instructions: string, options: { person: string }) => {
      const record = await withContext(async (ctx) => {
        const personRecord = await findPersonByRef(ctx, options.person);
        if (!personRecord) {
          throw new Error(`Person not found: ${options.person}`);
        }

        return ctx.profiles.setPersonProfile(personRecord.id, instructions.trim());
      });

      console.log(`Updated person profile for ${record.personId} at ${record.updatedAt.toISOString()}`);
    });

  const preference = program.command("preference").description("Manage per-person runtime preferences");

  preference
    .command("show")
    .requiredOption("--person <personRef>", "Person ID or exact name")
    .description("Show runtime preferences for a person")
    .action(async (options: { person: string }) => {
      const record = await withContext(async (ctx) => {
        const personRecord = await findPersonByRef(ctx, options.person);
        if (!personRecord) {
          throw new Error(`Person not found: ${options.person}`);
        }

        return ctx.runtimePreferences.getPersonPreferences(personRecord.id);
      });

      console.log(`showProgress=${record.showProgress} updatedAt=${record.updatedAt.toISOString()}`);
    });

  preference
    .command("set-progress")
    .requiredOption("--person <personRef>", "Person ID or exact name")
    .requiredOption("--enabled <boolean>", "Whether progress updates should be shown", parseBooleanFlag)
    .description("Enable or disable visible progress updates for a person")
    .action(async (options: { person: string; enabled: boolean }) => {
      const record = await withContext(async (ctx) => {
        const personRecord = await findPersonByRef(ctx, options.person);
        if (!personRecord) {
          throw new Error(`Person not found: ${options.person}`);
        }

        return ctx.runtimePreferences.setShowProgress(personRecord.id, options.enabled);
      });

      console.log(`Updated showProgress=${record.showProgress} for ${record.personId} at ${record.updatedAt.toISOString()}`);
    });

  const integration = program.command("integration").description("Manage integration connections, exposed tools, and grants");

  integration
    .command("connect-mcp")
    .requiredOption("--person <personRef>", "Person ID or exact name")
    .requiredOption("--key <integrationKey>", "Integration key, for example google_workspace")
    .option("--account-label <label>", "Human-friendly account label")
    .option("--server-ref <serverRef>", "MCP server reference or identifier")
    .requiredOption("--command <command>", "Command used to launch the MCP server")
    .option("--args <json>", "JSON array of command args", "[]")
    .option("--cwd <path>", "Optional working directory for the MCP server")
    .option("--env <json>", "JSON object of environment variables", "{}")
    .description("Create a person-owned MCP integration connection placeholder")
    .action(async (options: {
      person: string;
      key: string;
      accountLabel?: string;
      serverRef?: string;
      command: string;
      args: string;
      cwd?: string;
      env: string;
    }) => {
      const args = parseJsonStringArray(options.args);
      const env = parseJsonStringRecord(options.env);
      const connection = await withContext(async (ctx) => {
        const personRecord = await findPersonByRef(ctx, options.person);
        if (!personRecord) {
          throw new Error(`Person not found: ${options.person}`);
        }

        return ctx.integrations.createMcpConnection({
          personId: personRecord.id,
          integrationKey: options.key,
          metadata: {
            command: options.command,
            args,
            ...(options.cwd ? { cwd: options.cwd } : {}),
            ...(Object.keys(env).length > 0 ? { env } : {}),
            ...(options.accountLabel ? { accountLabel: options.accountLabel } : {}),
            ...(options.serverRef ? { serverRef: options.serverRef } : {})
          }
        });
      });

      console.log(`Created MCP connection ${connection.id} for person ${connection.personId} (${connection.integrationKey})`);
    });

  integration
    .command("list")
    .description("List integration connections")
    .action(async () => {
      const connections = await withContext((ctx) => ctx.integrations.listConnections());

      if (connections.length === 0) {
        console.log("No integration connections found.");
        return;
      }

      for (const connection of connections) {
        console.log(`${connection.id}  owner=${connection.personId}  key=${connection.integrationKey}  driver=${connection.driverType}  status=${connection.status}`);
      }
    });

  const integrationTool = integration.command("tool").description("Manage dynamically exposed integration tools");

  integrationTool
    .command("register")
    .requiredOption("--connection <connectionId>", "Connection ID")
    .requiredOption("--name <toolName>", "External MCP tool name")
    .requiredOption("--description <description>", "Tool description")
    .option("--schema <json>", "JSON schema object for tool input", "{}")
    .description("Register or update an exposed tool for a connection")
    .action(async (options: {
      connection: string;
      name: string;
      description: string;
      schema: string;
    }) => {
      const schema = parseJsonObject(options.schema);
      const tool = await withContext(async (ctx) => {
        const connection = await ctx.integrations.findConnectionById(options.connection);
        if (!connection) {
          throw new Error(`Connection not found: ${options.connection}`);
        }

        return ctx.integrations.upsertExposedTool({
          connectionId: connection.id,
          toolName: options.name,
          description: options.description,
          inputJsonSchema: schema
        });
      });

      console.log(`Registered tool ${tool.toolName} on connection ${tool.connectionId}`);
    });

  integrationTool
    .command("list")
    .requiredOption("--connection <connectionId>", "Connection ID")
    .description("List exposed tools for a connection")
    .action(async (options: { connection: string }) => {
      const tools = await withContext((ctx) => ctx.integrations.listExposedTools(options.connection));

      if (tools.length === 0) {
        console.log("No exposed tools found.");
        return;
      }

      for (const tool of tools) {
        console.log(`${tool.id}  ${tool.toolName}  enabled=${tool.enabled}`);
      }
    });


  integration
    .command("grant")
    .requiredOption("--connection <connectionId>", "Connection ID")
    .requiredOption("--tool <toolName>", "Tool name on that connection")
    .requiredOption("--to <personRef>", "Grantee person ID or exact name")
    .option("--granted-by <personRef>", "Granting person ID or exact name")
    .description("Grant a single exposed connection tool to another household member")
    .action(async (options: { connection: string; tool: string; to: string; grantedBy?: string }) => {
      const grant = await withContext(async (ctx) => {
        const connection = await ctx.integrations.findConnectionById(options.connection);
        if (!connection) {
          throw new Error(`Connection not found: ${options.connection}`);
        }

        const tool = await ctx.integrations.findExposedTool(connection.id, options.tool);
        if (!tool) {
          throw new Error(`Tool not found on connection: ${options.tool}`);
        }

        const grantee = await findPersonByRef(ctx, options.to);
        if (!grantee) {
          throw new Error(`Person not found: ${options.to}`);
        }

        let grantedBy: string | undefined;
        if (options.grantedBy) {
          const granter = await findPersonByRef(ctx, options.grantedBy);
          if (!granter) {
            throw new Error(`Granting person not found: ${options.grantedBy}`);
          }

          grantedBy = granter.id;
        }

        return ctx.integrations.grantToolAccess({
          connectionId: connection.id,
          toolId: tool.id,
          ownerId: connection.personId,
          granteeId: grantee.id,
          ...(grantedBy ? { grantedBy } : {})
        });
      });

      console.log(`Granted tool access on connection ${grant.connectionId} to ${grant.granteeId}`);
    });

  integration
    .command("grants")
    .requiredOption("--connection <connectionId>", "Connection ID")
    .description("List tool grants for a connection")
    .action(async (options: { connection: string }) => {
      const grants = await withContext((ctx) => ctx.integrations.listToolGrants(options.connection));

      if (grants.length === 0) {
        console.log("No grants found.");
        return;
      }

      for (const grant of grants) {
        console.log(`${grant.toolId}  owner=${grant.ownerId}  grantee=${grant.granteeId}`);
      }
    });

  const extension = program.command("extension").description("Inspect loaded extensions");

  extension
    .command("list")
    .description("List validated extensions and their runtime capabilities")
    .action(async () => {
      const result = await withContext(async (ctx) => ({
        extensions: ctx.extensionRegistry.inspectAll(),
        errors: ctx.extensionRegistry.listErrors()
      }));

      if (result.extensions.length === 0) {
        console.log("No extensions loaded.");
      } else {
        for (const item of result.extensions) {
          const runtime = item.structuredExecution?.runtime ?? "none";
          console.log(`${item.name}@${item.package.version}  source=${item.source}  runtime=${runtime}  path=${item.directory}`);
          if (item.description) {
            console.log(`  ${item.description}`);
          }
        }
      }

      if (result.errors.length > 0) {
        console.log("\nLoad errors:");
        for (const error of result.errors) {
          console.log(`- ${error.source} ${error.directory}: ${error.error}`);
        }
      }
    });

  extension
    .command("show")
    .argument("<name>", "Extension name")
    .description("Show detailed metadata for a single extension")
    .action(async (name: string) => {
      const inspection = await withContext(async (ctx) => ctx.extensionRegistry.inspect(name));

      if (!inspection) {
        throw new Error(`Extension not found: ${name}`);
      }

      console.log(JSON.stringify(inspection, null, 2));
    });

  extension
    .command("package-create")
    .requiredOption("--name <name>", "Package name")
    .requiredOption("--description <description>", "Package description")
    .option("--tag <tag...>", "Package tags")
    .option("--replace", "Replace an existing package workspace scaffold", false)
    .description("Create a package extension scaffold in the local package workspace")
    .action(async (options: { name: string; description: string; tag?: string[]; replace?: boolean }) => {
      const manager = new ExtensionManager({
        installedExtensionsDir: resolve(config.dataDir, "extensions"),
        packageWorkspaceDir: resolve(config.dataDir, "packages")
      });
      const result = await manager.scaffoldPackage({
        name: options.name,
        description: options.description,
        ...(options.tag ? { tags: options.tag } : {}),
        ...(typeof options.replace === "boolean" ? { replace: options.replace } : {})
      });

      console.log(`Created package scaffold ${result.manifest.name}@${result.manifest.package.version} at ${result.directory}`);
    });

  extension
    .command("validate")
    .requiredOption("--from <directory>", "Extension directory to validate")
    .description("Validate an extension directory against the extension contract")
    .action(async (options: { from: string }) => {
      const manager = new ExtensionManager({
        installedExtensionsDir: resolve(config.dataDir, "extensions"),
        packageWorkspaceDir: resolve(config.dataDir, "packages")
      });
      const result = await manager.validateDirectory(options.from);

      console.log(`Extension ${result.manifest.name}@${result.manifest.package.version} is valid.`);
      console.log(`- apiVersion: ${result.manifest.package.apiVersion}`);
      console.log(`- source: ${result.directory}`);
      console.log(`- has SKILL.md: ${result.hasSkillBody ? "yes" : "no"}`);
    });

  extension
    .command("install")
    .requiredOption("--from <directory>", "Extension directory to install")
    .description("Install an extension into the installed extension directory")
    .action(async (options: { from: string }) => {
      const manager = new ExtensionManager({
        installedExtensionsDir: resolve(config.dataDir, "extensions"),
        packageWorkspaceDir: resolve(config.dataDir, "packages")
      });
      const result = await manager.installFromDirectory({
        sourceDirectory: options.from
      });

      console.log(`Installed ${result.manifest.name}@${result.manifest.package.version} to ${result.installedDirectory}`);
    });

  extension
    .command("update")
    .requiredOption("--from <directory>", "Extension directory to update from")
    .description("Replace an existing installed extension with a new directory")
    .action(async (options: { from: string }) => {
      const manager = new ExtensionManager({
        installedExtensionsDir: resolve(config.dataDir, "extensions"),
        packageWorkspaceDir: resolve(config.dataDir, "packages")
      });
      const result = await manager.installFromDirectory({
        sourceDirectory: options.from,
        replace: true
      });

      console.log(`Updated ${result.manifest.name}@${result.manifest.package.version} at ${result.installedDirectory}`);
    });

  extension
    .command("remove")
    .argument("<name>", "Extension name")
    .description("Remove an installed extension")
    .action(async (name: string) => {
      const manager = new ExtensionManager({
        installedExtensionsDir: resolve(config.dataDir, "extensions"),
        packageWorkspaceDir: resolve(config.dataDir, "packages")
      });
      const removed = await manager.uninstall(name);
      console.log(`Removed ${name} from ${removed}`);
    });

  const cron = program.command("cron").description("Manage scheduled cron jobs");

  cron
    .command("create")
    .requiredOption("--person <person>", "Person ID or name")
    .requiredOption("--name <name>", "Job name")
    .requiredOption("--schedule <expr>", "Cron expression")
    .requiredOption("--prompt <prompt>", "Prompt to run for the job")
    .option("--timezone <timezone>", "IANA timezone", Intl.DateTimeFormat().resolvedOptions().timeZone)
    .option("--mode <mode>", "Run mode (isolated or main)", "isolated")
    .description("Create a cron job")
    .action(async (options: {
      person: string;
      name: string;
      schedule: string;
      prompt: string;
      timezone: string;
      mode: "isolated" | "main";
    }) => {
      const created = await withContext(async (ctx) => {
        const person = await findPersonByRef(ctx, options.person);
        if (!person) {
          throw new Error(`Person not found: ${options.person}`);
        }

        return ctx.cron.createJob({
          personId: person.id,
          name: options.name,
          schedule: options.schedule,
          timezone: options.timezone,
          mode: options.mode,
          target: {
            type: "prompt",
            prompt: options.prompt
          }
        });
      });

      console.log(`Created cron job ${created.name} (${created.id}) next run ${created.nextRunAt.toISOString()}`);
    });

  cron
    .command("list")
    .description("List cron jobs")
    .action(async () => {
      const jobs = await withContext((ctx) => ctx.cronRepository.listJobs());
      if (jobs.length === 0) {
        console.log("No cron jobs found.");
        return;
      }

      for (const job of jobs) {
        console.log(`${job.id}  ${job.name}  status=${job.status}  next=${job.nextRunAt.toISOString()}  schedule="${job.schedule}"`);
      }
    });

  cron
    .command("show")
    .argument("<jobId>", "Cron job ID")
    .description("Show a cron job and recent runs")
    .action(async (jobId: string) => {
      const result = await withContext(async (ctx) => {
        const job = await ctx.cronRepository.findJobById(jobId);
        const runs = job ? await ctx.cronRepository.listRunsForJob(jobId, 10) : [];
        return { job, runs };
      });

      if (!result.job) {
        throw new Error(`Cron job not found: ${jobId}`);
      }

      console.log(JSON.stringify(result.job, null, 2));
      if (result.runs.length > 0) {
        console.log("\nRecent runs:");
        for (const run of result.runs) {
          console.log(`${run.id}  ${run.status}  trigger=${run.trigger}  started=${run.startedAt.toISOString()}`);
        }
      }
    });

  cron
    .command("run")
    .argument("<jobId>", "Cron job ID")
    .description("Run a cron job immediately")
    .action(async (jobId: string) => {
      await withContext((ctx) => ctx.cron.runJobNow(jobId));
      console.log(`Triggered cron job ${jobId}`);
    });

  cron
    .command("tick")
    .description("Run due cron jobs once")
    .action(async () => {
      const count = await withContext((ctx) => ctx.cron.runDueJobs());
      console.log(`Processed ${count} due cron job(s).`);
    });

  cron
    .command("pause")
    .argument("<jobId>", "Cron job ID")
    .description("Pause a cron job")
    .action(async (jobId: string) => {
      await withContext((ctx) => ctx.cronRepository.updateJobStatus({ id: jobId, status: "paused" }));
      console.log(`Paused cron job ${jobId}`);
    });

  cron
    .command("resume")
    .argument("<jobId>", "Cron job ID")
    .description("Resume a cron job")
    .action(async (jobId: string) => {
      await withContext((ctx) => ctx.cronRepository.updateJobStatus({ id: jobId, status: "active" }));
      console.log(`Resumed cron job ${jobId}`);
    });

  const structuredExecution = program.command("structured-execution").description("Manage structured execution runs");

  structuredExecution
    .command("respond")
    .requiredOption("--token <resumeToken>", "Resume token")
    .option("--approve", "Approve and resume the workflow")
    .option("--deny", "Deny and resume the workflow")
    .description("Respond to a workflow approval checkpoint")
    .action(async (options: { token: string; approve?: boolean; deny?: boolean }) => {
      if (Boolean(options.approve) === Boolean(options.deny)) {
        throw new InvalidArgumentError("Choose exactly one of --approve or --deny");
      }

      const result = await withContext(async (ctx) => {
        return ctx.orchestration.resumeStructuredExecution({
          resumeToken: options.token,
          approved: Boolean(options.approve)
        });
      });

      console.log(result.content);
      if (result.status === "awaiting_approval" && result.resumeToken) {
        console.log(`New approval token: ${result.resumeToken}`);
      }
    });

  const trace = program.command("trace").description("Inspect request traces");

  trace
    .command("list")
    .description("List available request trace files")
    .action(async () => {
      const repository = new TraceRepository(config.dataDir);
      const traces = await repository.list();

      if (traces.length === 0) {
        console.log("No trace files found.");
        return;
      }

      for (const item of traces) {
        console.log(`${item.requestId}  ${item.path}`);
      }
    });

  trace
    .command("show")
    .argument("<requestId>", "Request ID")
    .description("Show the events for a specific request trace")
    .action(async (requestId: string) => {
      const repository = new TraceRepository(config.dataDir);
      const events = await repository.get(requestId);

      if (events.length === 0) {
        console.log("Trace file is empty.");
        return;
      }

      for (const event of events) {
        console.log(`${event.timestamp}  ${event.stage}`);
        console.log(JSON.stringify(event.payload, null, 2));
      }
    });

  program
    .command("message")
    .requiredOption("--channel <channel>", "Channel type", parseChannel)
    .requiredOption("--external-id <externalId>", "External channel identity")
    .option("--chat-id <chatId>", "Optional chat ID override")
    .argument("<text...>", "Message content")
    .description("Send a message through the same request intake path used by runtime channels")
    .action(async (textParts: string[], options: { channel: ChannelType; externalId: string; chatId?: string }) => {
      const text = textParts.join(" ").trim();

      const result = await withContext(async (ctx) => {
        if (!ctx.requestIntake) {
          throw new Error("Request intake service is unavailable");
        }

        const outcome = await ctx.requestIntake.acceptInboundMessage({
          requestId: crypto.randomUUID(),
          message: {
            channelType: options.channel,
            externalUserId: options.externalId,
            ...(options.chatId ? { chatId: options.chatId } : {}),
            text,
            receivedAt: new Date()
          }
        });

        return outcome;
      });

      console.log(formatAcceptedRequestForUser(result));
    });

  return program;
}

void buildProgram().parseAsync(process.argv);
