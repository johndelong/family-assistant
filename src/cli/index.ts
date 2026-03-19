#!/usr/bin/env node

import { Command, InvalidArgumentError } from "commander";
import { TraceRepository } from "../features/tracing/repository.js";
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

async function withContext<T>(action: (ctx: Awaited<ReturnType<typeof createCliContext>>) => Promise<T>): Promise<T> {
  const config = loadAppConfig();
  const context = await createCliContext(config);

  try {
    return await action(context);
  } finally {
    await context.close();
  }
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

        const personRecord = (await ctx.persons.findById(options.person)) ?? (await ctx.persons.findByName(options.person));
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
