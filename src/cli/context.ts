import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { createDatabaseClient } from "../db/client.js";
import { ensureSchema } from "../db/bootstrap.js";
import { ToolRegistry } from "../core/tools.js";
import { HouseholdRepository } from "../features/households/repository.js";
import { IdentityRepository } from "../features/identity/repository.js";
import { OpenAiProvider } from "../features/llm/openai-provider.js";
import { LlmService } from "../features/llm/service.js";
import { MemoryRepository } from "../features/memory/repository.js";
import { PersonRepository } from "../features/persons/repository.js";
import { RequestIntakeService } from "../features/requests/service.js";
import { IdentityResolutionService } from "../features/identity/service.js";
import { OrchestrationService } from "../features/orchestration/service.js";
import { TraceWriter } from "../features/tracing/writer.js";
import { createMemorySearchTool } from "../features/tools/memory-search-tool.js";
import { createMemoryStoreTool } from "../features/tools/memory-store-tool.js";
import { systemHealthTool } from "../features/tools/system-health-tool.js";
import type { AppConfig } from "../shared/config.js";

export interface CliContext {
  db: NodePgDatabase;
  close(): Promise<void>;
  households: HouseholdRepository;
  persons: PersonRepository;
  identities: IdentityRepository;
  requestIntake: RequestIntakeService;
}

export async function createCliContext(config: AppConfig): Promise<CliContext> {
  if (!config.databaseUrl) {
    throw new Error("DATABASE_URL is required for this command");
  }

  const { db, pool } = createDatabaseClient(config.databaseUrl);
  await ensureSchema(db);

  const toolRegistry = new ToolRegistry();
  const memory = new MemoryRepository(db);
  toolRegistry.register(systemHealthTool);
  toolRegistry.register(createMemoryStoreTool(memory));
  toolRegistry.register(createMemorySearchTool(memory));

  const persons = new PersonRepository(db);
  const identities = new IdentityRepository(db);
  const identityResolution = new IdentityResolutionService(identities, persons);
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
    db,
    households: new HouseholdRepository(db),
    persons,
    identities,
    requestIntake,
    async close() {
      await pool.end();
    }
  };
}
