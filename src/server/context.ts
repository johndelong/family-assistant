import type { Logger } from "pino";
import { resolve } from "node:path";
import type { AppConfig } from "../shared/config.js";
import { createDatabaseClient } from "../db/client.js";
import { ensureSchema } from "../db/bootstrap.js";
import { ToolRegistry } from "../core/tools.js";
import { HouseholdRepository } from "../features/households/repository.js";
import { IdentityRepository } from "../features/identity/repository.js";
import { IdentityResolutionService } from "../features/identity/service.js";
import { OpenAiProvider } from "../features/llm/openai-provider.js";
import { LlmService } from "../features/llm/service.js";
import { registerDynamicMcpTools } from "../features/integrations/dynamic-mcp-tools.js";
import { McpPromptService } from "../features/integrations/mcp-prompt-service.js";
import { IntegrationRepository } from "../features/integrations/repository.js";
import { McpRuntimeManager } from "../features/mcp/runtime-manager.js";
import { ExtensionRegistry } from "../features/extensions/registry.js";
import { MemoryRepository } from "../features/memory/repository.js";
import { MemoryRetrievalService } from "../features/memory/retrieval-service.js";
import { OrchestrationService } from "../features/orchestration/service.js";
import { PersonRepository } from "../features/persons/repository.js";
import { PersonPreferenceRepository } from "../features/preferences/repository.js";
import { PromptProfileService } from "../features/profiles/prompt-profile-service.js";
import { ProfileRepository } from "../features/profiles/repository.js";
import { RequestIntakeService } from "../features/requests/service.js";
import { SessionRepository } from "../features/sessions/repository.js";
import { LlmSessionSummarizer } from "../features/sessions/llm-session-summarizer.js";
import { SessionService } from "../features/sessions/service.js";
import { StructuredExecutionRunRepository } from "../features/structured-execution/repository.js";
import { StructuredExecutionService } from "../features/structured-execution/service.js";
import { TraceWriter } from "../features/tracing/writer.js";
import { createAccountStatusTool } from "../features/tools/account-status-tool.js";
import { createMemorySearchTool } from "../features/tools/memory-search-tool.js";
import { createMemoryStoreTool } from "../features/tools/memory-store-tool.js";
import {
  createAssistantProfileSetTool,
  createAssistantIdentitySetTool,
  createHouseholdProfileSetTool,
  createPersonProfileSetTool
} from "../features/tools/profile-tools.js";
import {
  createRuntimePreferenceStatusTool,
  createSetProgressVisibilityTool
} from "../features/tools/runtime-preference-tools.js";
import { systemHealthTool } from "../features/tools/system-health-tool.js";
import { timeNowTool } from "../features/tools/time-now-tool.js";
import { createWebSearchTool } from "../features/tools/web-search-tool.js";

export interface ServerContext {
  config: AppConfig;
  logger: Logger;
  toolRegistry: ToolRegistry;
  mcpRuntime?: McpRuntimeManager;
  households?: HouseholdRepository;
  persons?: PersonRepository;
  identities?: IdentityRepository;
  integrations?: IntegrationRepository;
  extensionRegistry?: ExtensionRegistry;
  identityResolution?: IdentityResolutionService;
  orchestration?: OrchestrationService;
  requestIntake?: RequestIntakeService;
  close(): Promise<void>;
}

export async function createServerContext(config: AppConfig, logger: Logger): Promise<ServerContext> {
  const toolRegistry = new ToolRegistry();
  const mcpRuntime = new McpRuntimeManager();
  toolRegistry.register(systemHealthTool);
  toolRegistry.register(timeNowTool);
  if (config.braveApiKey) {
    toolRegistry.register(createWebSearchTool(config.braveApiKey));
  }

  if (!config.databaseUrl) {
    return {
      config,
      logger,
      toolRegistry,
      mcpRuntime,
      async close() {
        await mcpRuntime.stopAll();
        return Promise.resolve();
      }
    };
  }

  const { db, pool } = createDatabaseClient(config.databaseUrl);
  await ensureSchema(db);
  const extensionRegistry = new ExtensionRegistry({
    workspaceDir: resolve(process.cwd(), "skills"),
    managedDir: resolve(process.cwd(), config.dataDir, "skills"),
    extraDirs: config.extensionDirs
  });

  const households = new HouseholdRepository(db);
  const persons = new PersonRepository(db);
  const identities = new IdentityRepository(db);
  const integrations = new IntegrationRepository(db);
  const memory = new MemoryRepository(db);
  const memoryRetrieval = new MemoryRetrievalService(memory);
  const profiles = new ProfileRepository(db);
  const personPreferences = new PersonPreferenceRepository(db);
  const promptProfiles = new PromptProfileService(profiles);
  const sessions = new SessionRepository(db);
  const mcpPromptService = new McpPromptService(integrations, mcpRuntime);
  const structuredExecutionService = new StructuredExecutionService(extensionRegistry);
  const structuredExecutionRuns = new StructuredExecutionRunRepository(db);
  const traceWriter = new TraceWriter(config.dataDir);
  const identityResolution = new IdentityResolutionService(identities, persons);
  toolRegistry.register(createMemoryStoreTool(memory));
  toolRegistry.register(createMemorySearchTool(memory));
  toolRegistry.register(createAccountStatusTool(integrations));
  toolRegistry.register(createRuntimePreferenceStatusTool(personPreferences));
  toolRegistry.register(createSetProgressVisibilityTool(personPreferences));
  toolRegistry.register(createPersonProfileSetTool(profiles));
  toolRegistry.register(createHouseholdProfileSetTool(profiles));
  toolRegistry.register(createAssistantProfileSetTool(profiles));
  toolRegistry.register(createAssistantIdentitySetTool(profiles));
  await registerDynamicMcpTools({
    integrations,
    runtimeManager: mcpRuntime,
    register: (tool) => toolRegistry.register(tool)
  });
  const provider = config.openAiApiKey
    ? new OpenAiProvider({
        apiKey: config.openAiApiKey,
        model: config.openAiModel,
        ...(config.openAiDirectActionModel ? { directActionModel: config.openAiDirectActionModel } : {})
      })
    : undefined;
  const llmService = provider ? new LlmService(provider, extensionRegistry) : undefined;
  const sessionService = new SessionService(
    sessions,
    provider ? new LlmSessionSummarizer(provider) : undefined
  );
  const orchestration = new OrchestrationService(
    toolRegistry,
    llmService,
    memoryRetrieval,
    promptProfiles,
    sessionService,
    mcpPromptService,
    structuredExecutionService,
    structuredExecutionRuns,
    persons,
    traceWriter
  );
  const requestIntake = new RequestIntakeService(identityResolution, orchestration, traceWriter, personPreferences);

  return {
    config,
    logger,
    toolRegistry,
    mcpRuntime,
    households,
    persons,
    identities,
    integrations,
    extensionRegistry,
    identityResolution,
    orchestration,
    requestIntake,
    async close() {
      await mcpRuntime.stopAll();
      await pool.end();
    }
  };
}
