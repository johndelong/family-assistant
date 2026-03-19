import type { Logger } from "pino";
import type { AppConfig } from "../shared/config.js";
import { createDatabaseClient } from "../db/client.js";
import { ensureSchema } from "../db/bootstrap.js";
import { ToolRegistry } from "../core/tools.js";
import { HouseholdRepository } from "../features/households/repository.js";
import { IdentityRepository } from "../features/identity/repository.js";
import { IdentityResolutionService } from "../features/identity/service.js";
import { OpenAiProvider } from "../features/llm/openai-provider.js";
import { LlmService } from "../features/llm/service.js";
import { NotesRepository } from "../features/notes/repository.js";
import { OrchestrationService } from "../features/orchestration/service.js";
import { PersonRepository } from "../features/persons/repository.js";
import { RequestIntakeService } from "../features/requests/service.js";
import { TraceWriter } from "../features/tracing/writer.js";
import { createNoteListTool } from "../features/tools/note-list-tool.js";
import { createNoteStoreTool } from "../features/tools/note-store-tool.js";
import { systemHealthTool } from "../features/tools/system-health-tool.js";

export interface ServerContext {
  config: AppConfig;
  logger: Logger;
  toolRegistry: ToolRegistry;
  households?: HouseholdRepository;
  persons?: PersonRepository;
  identities?: IdentityRepository;
  identityResolution?: IdentityResolutionService;
  orchestration?: OrchestrationService;
  requestIntake?: RequestIntakeService;
  close(): Promise<void>;
}

export async function createServerContext(config: AppConfig, logger: Logger): Promise<ServerContext> {
  const toolRegistry = new ToolRegistry();
  toolRegistry.register(systemHealthTool);

  if (!config.databaseUrl) {
    return {
      config,
      logger,
      toolRegistry,
      async close() {
        return Promise.resolve();
      }
    };
  }

  const { db, pool } = createDatabaseClient(config.databaseUrl);
  await ensureSchema(db);

  const households = new HouseholdRepository(db);
  const persons = new PersonRepository(db);
  const identities = new IdentityRepository(db);
  const notes = new NotesRepository(db);
  const identityResolution = new IdentityResolutionService(identities, persons);
  toolRegistry.register(createNoteStoreTool(notes));
  toolRegistry.register(createNoteListTool(notes));
  const llmService = config.openAiApiKey
    ? new LlmService(new OpenAiProvider({
        apiKey: config.openAiApiKey,
        model: config.openAiModel
      }))
    : undefined;
  const orchestration = new OrchestrationService(toolRegistry, llmService);
  const traceWriter = new TraceWriter(config.dataDir);
  const requestIntake = new RequestIntakeService(identityResolution, orchestration, traceWriter);

  return {
    config,
    logger,
    toolRegistry,
    households,
    persons,
    identities,
    identityResolution,
    orchestration,
    requestIntake,
    async close() {
      await pool.end();
    }
  };
}
