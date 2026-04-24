import type { Logger } from "pino";
import { resolve } from "node:path";
import type { AppConfig } from "../shared/config.js";
import { coreExtensionsDir, packageExtensionsDir } from "../shared/paths.js";
import { ChannelRouter } from "../channels/router.js";
import { createDatabaseClient } from "../db/client.js";
import { ensureSchema } from "../db/bootstrap.js";
import { ToolRegistry } from "../core/tools.js";
import { HouseholdRepository } from "../features/households/repository.js";
import { IdentityRepository } from "../features/identity/repository.js";
import { IdentityResolutionService } from "../features/identity/service.js";
import { OpenAiProvider } from "../features/llm/openai-provider.js";
import { LlmService } from "../features/llm/service.js";
import { CronRepository } from "../features/cron/repository.js";
import { CronService } from "../features/cron/service.js";
import { registerDynamicMcpTools } from "../features/integrations/dynamic-mcp-tools.js";
import { McpPromptService } from "../features/integrations/mcp-prompt-service.js";
import { IntegrationRepository } from "../features/integrations/repository.js";
import { McpRuntimeManager } from "../features/mcp/runtime-manager.js";
import { ExtensionManager } from "../features/extensions/manager.js";
import { ExtensionRegistry } from "../features/extensions/registry.js";
import { ExtensionStateStore } from "../features/extensions/state-store.js";
import { registerExtensionTools } from "../features/extensions/tool-runtime.js";
import { MemoryRepository } from "../features/memory/repository.js";
import { MemoryRetrievalService } from "../features/memory/retrieval-service.js";
import { MonitorEventHub } from "../features/monitor/hub.js";
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
import { TraceRepository } from "../features/tracing/repository.js";
import { TraceWriter } from "../features/tracing/writer.js";

export interface ServerContext {
  config: AppConfig;
  logger: Logger;
  toolRegistry: ToolRegistry;
  channels: ChannelRouter;
  mcpRuntime?: McpRuntimeManager;
  households?: HouseholdRepository;
  persons?: PersonRepository;
  identities?: IdentityRepository;
  integrations?: IntegrationRepository;
  extensionRegistry?: ExtensionRegistry;
  extensionManager?: ExtensionManager;
  extensionStates?: ExtensionStateStore;
  cron?: CronService;
  cronRepository?: CronRepository;
  profiles?: ProfileRepository;
  runtimePreferences?: PersonPreferenceRepository;
  traces?: TraceRepository;
  structuredExecutionRuns?: StructuredExecutionRunRepository;
  monitor?: MonitorEventHub;
  identityResolution?: IdentityResolutionService;
  sessionService?: SessionService;
  orchestration?: OrchestrationService;
  requestIntake?: RequestIntakeService;
  close(): Promise<void>;
}

export async function createServerContext(config: AppConfig, logger: Logger): Promise<ServerContext> {
  const toolRegistry = new ToolRegistry();
  const channels = new ChannelRouter();
  const mcpRuntime = new McpRuntimeManager();
  const extensionStates = new ExtensionStateStore(resolve(config.dataDir, "extension-state.json"));
  await extensionStates.load();
  const extensionRegistry = new ExtensionRegistry({
    coreDir: coreExtensionsDir,
    packageDir: packageExtensionsDir,
    installedDir: resolve(config.dataDir, "extensions"),
    enabledState: extensionStates.snapshot()
  });
  toolRegistry.setAvailabilityResolver((toolId) => extensionRegistry.isToolEnabled(toolId));
  const extensionManager = new ExtensionManager({
    installedExtensionsDir: resolve(config.dataDir, "extensions"),
    packageWorkspaceDir: resolve(config.dataDir, "packages")
  });

  await registerExtensionTools({
    config,
    logger,
    toolRegistry,
    extensionRegistry,
    extensionManager
  });

  if (!config.databaseUrl) {
    return {
      config,
      logger,
      toolRegistry,
      channels,
      mcpRuntime,
      extensionRegistry,
      extensionManager,
      extensionStates,
      async close() {
        await mcpRuntime.stopAll();
        return Promise.resolve();
      }
    };
  }

  const { db, pool } = createDatabaseClient(config.databaseUrl);
  await ensureSchema(db);

  const households = new HouseholdRepository(db);
  const persons = new PersonRepository(db);
  const identities = new IdentityRepository(db);
  const integrations = new IntegrationRepository(db);
  const cronRepository = new CronRepository(db);
  const memory = new MemoryRepository(db);
  const memoryRetrieval = new MemoryRetrievalService(memory);
  const profiles = new ProfileRepository(db);
  const personPreferences = new PersonPreferenceRepository(db);
  const promptProfiles = new PromptProfileService(profiles);
  const sessions = new SessionRepository(db);
  const mcpPromptService = new McpPromptService(integrations, mcpRuntime);
  const structuredExecutionService = new StructuredExecutionService(extensionRegistry);
  const structuredExecutionRuns = new StructuredExecutionRunRepository(db);
  const monitor = new MonitorEventHub();
  const traceWriter = new TraceWriter(config.dataDir, monitor);
  const traces = new TraceRepository(config.dataDir);
  const identityResolution = new IdentityResolutionService(identities, persons);
  await registerDynamicMcpTools({
    integrations,
    runtimeManager: mcpRuntime,
    register: (tool) => toolRegistry.register(tool)
  });
  const provider = config.openAiApiKey
    ? new OpenAiProvider({
        apiKey: config.openAiApiKey,
        model: config.openAiModel
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
    traceWriter,
    monitor
  );
  const cron = new CronService(
    cronRepository,
    persons,
    identities,
    channels,
    orchestration,
    traceWriter,
    monitor,
    config.cronPollIntervalMs
  );
  if (config.cronEnabled) {
    cron.start();
  }
  await registerExtensionTools({
    config,
    logger,
    toolRegistry,
    extensionRegistry,
    memory,
    integrations,
    runtimePreferences: personPreferences,
    profiles,
    cron,
    cronRepository,
    extensionManager
  });
  const requestIntake = new RequestIntakeService(identityResolution, orchestration, traceWriter, personPreferences);

  return {
    config,
    logger,
    toolRegistry,
    channels,
    mcpRuntime,
    households,
    persons,
    identities,
    integrations,
    extensionRegistry,
    extensionManager,
    extensionStates,
    cron,
    cronRepository,
    profiles,
    runtimePreferences: personPreferences,
    traces,
    structuredExecutionRuns,
      monitor,
      identityResolution,
      sessionService,
      orchestration,
      requestIntake,
    async close() {
      await cron.stop();
      await mcpRuntime.stopAll();
      await pool.end();
    }
  };
}
