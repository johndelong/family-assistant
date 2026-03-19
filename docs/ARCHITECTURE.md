# Architecture

## System Overview

The Family Assistant Platform is a modular TypeScript-based household assistant that supports multiple people within the same household. The system identifies who is interacting with it, determines what information and tools they are authorized to access, and responds using connected services.

**Core Philosophy:**
- **Lean Core + Rich Extensions**: Keep the core orchestrator lightweight; capabilities ship as plugins
- **Local-First**: Configuration via CLI and files, with optional UI later
- **Explicit over Hidden**: Favor deterministic, traceable code over framework magic
- **Terminal-First by Design**: CLI and file-based config ensure understanding and git-trackability

**System Components:**

The platform follows a **lean core architecture** by splitting responsibilities into focused, single-purpose services:

### 1. Gateway Service
The WebSocket entry point that:
- Handles incoming messages via WebSocket (Socket.io)
- Manages channel adapters (WebSocket, future: Telegram, WhatsApp)
- Routes messages to appropriate services
- Streams responses back to clients
- Manages session lifecycle and WebSocket connections

**Why separate?** Isolates transport layer from business logic, allows independent scaling of connection handling.

### 2. Identity & Authorization Service
The security boundary that:
- Resolves channel identities (phone, email, Telegram) to Person records
- Enforces pairing flow for unknown identities
- Validates permissions before operations (role + granular checks)
- Manages sharing grants (integration delegation)
- Tracks pairing requests and identity links

**Why separate?** Security should be isolated, auditable, and independently testable. Changes to auth logic don't affect orchestration.

### 3. Orchestrator Service
The lightweight coordination layer that:
- Assembles request context (dependencies, person, session)
- Coordinates tool execution with cancellation support
- Invokes LLM providers with fallback chains
- Broadcasts lifecycle events to hooks
- Enforces resource limits (concurrency, timeouts, rate limiting)

**Why separate?** Core business logic isolated from transport, auth, and storage concerns. Keeps orchestration lean and focused.

### 4. Memory Service
The dual-storage persistence layer that:
- Manages PostgreSQL for durable, scoped memory (private/shared/household)
- Handles JSONL session files for ephemeral execution traces
- Enforces memory scope boundaries
- Manages file rotation and retention policies
- Provides query interfaces with full-text search

**Why separate?** Storage strategy can evolve independently. Clear boundary between in-memory, database, and file-based storage.

### 5. CLI + File-Based Configuration
The v1 primary interface featuring:
- `family-assistant` CLI for all configuration
- Git-trackable YAML/JSON configuration files
- Export/import configuration for version control
- Interactive setup wizard for first-time users
- Health checks and diagnostics

### 6. Admin UI (Optional, Future Phase)
A web interface for management:
- Built only after v1 proves core concepts
- Consumes same APIs as CLI
- Nice-to-have, not required for v1

**Deployment Model (v1):**
All four services run as **separate modules within a single Node.js process**. This provides clean architectural boundaries without operational complexity. Future versions can deploy services independently if needed.

This is not a single-user chatbot. The platform is designed around a household with multiple users, each having their own identity, linked accounts, permissions, and private data, while also supporting shared family context.

## Component Interactions

**Request Flow Across Services:**

```
Incoming Message (WebSocket)
    ↓
[GATEWAY SERVICE]
    ├─→ Channel Adapter extracts identity
    └─→ Routes to Identity Service
    ↓
[IDENTITY & AUTH SERVICE]
    ├─→ Resolve channel identity → Person
    ├─→ Validate pairing (if new identity)
    └─→ Check permissions for operation
    ↓
[ORCHESTRATOR SERVICE]
    ├─→ Assemble request context (person, session, deps)
    ├─→ Broadcast lifecycle events (identity.resolved, request.start)
    ├─→ Execute tools (with authorization checks)
    │   └─→ Integration Adapters (Google, HA, etc.)
    ├─→ Invoke LLM (with fallback chain)
    │   └─→ LLM Providers (Anthropic/OpenAI/Ollama)
    └─→ Enforce resource limits (concurrency, timeout)
    ↓
[MEMORY SERVICE]
    ├─→ Store execution trace (JSONL)
    ├─→ Update durable memory (PostgreSQL, if requested)
    └─→ Manage session state
    ↓
[GATEWAY SERVICE]
    └─→ Stream response events back to client
```

**Key Flow Characteristics:**
- **Service boundaries are clear**: Gateway handles transport, Auth handles security, Orchestrator coordinates, Memory persists
- **Identity resolution happens BEFORE LLM invocation**: Auth service completes before orchestration begins
- **Authorization enforced in code, not by LLM**: Explicit permission checks, no delegation to AI
- **All dependencies explicit**: No hidden globals, dependency injection throughout
- **Tools execute in their natural context**: Integration adapters manage their own credentials
- **Real-time streaming**: Gateway maintains WebSocket connection, Orchestrator streams events
- **Comprehensive tracing**: Memory service appends all execution steps to JSONL files

## Service Interfaces

### Gateway Service API

```typescript
interface GatewayService {
  // WebSocket connection management
  handleConnection(socket: Socket): void;
  disconnect(sessionId: string): void;

  // Message routing
  routeMessage(channelId: string, message: InboundMessage): Promise<void>;

  // Response streaming
  streamEvent(sessionId: string, event: ResponseEvent): void;
}
```

### Identity & Auth Service API

```typescript
interface IdentityAuthService {
  // Identity resolution
  resolveIdentity(channelId: string): Promise<Person | null>;
  createPairingRequest(channelId: string): Promise<PairingRequest>;
  completePairing(code: string, personId: string): Promise<void>;

  // Authorization
  checkPermission(person: Person, permission: Permission): Promise<boolean>;
  checkPermissionWithGrant(person: Person, permission: Permission, grantedBy: Person): Promise<boolean>;

  // Sharing grants
  grantPermission(fromPerson: Person, toPerson: Person, permission: Permission): Promise<void>;
  revokePermission(fromPerson: Person, toPerson: Person, permission: Permission): Promise<void>;
}
```

### Orchestrator Service API

```typescript
interface OrchestratorService {
  // Request processing
  processRequest(person: Person, message: string, sessionId: string): Promise<void>;
  cancelRequest(requestId: string): void;

  // Tool execution
  executeTool(tool: Tool, input: any, context: RequestContext, signal: AbortSignal): Promise<ToolResult>;

  // LLM invocation
  invokeLLM(messages: Message[], options: LLMOptions): AsyncIterable<LLMChunk>;

  // Resource management
  checkResourceLimits(person: Person): Promise<boolean>;
  incrementRequestCount(person: Person): void;
}
```

### Memory Service API

```typescript
interface MemoryService {
  // Durable memory (PostgreSQL)
  storeMemory(scope: MemoryScope, content: string, metadata?: any): Promise<void>;
  retrieveMemory(scope: MemoryScope, query?: string): Promise<Memory[]>;

  // Session state (JSONL)
  createSession(sessionId: string, person: Person): Promise<void>;
  appendToSession(sessionId: string, entry: ExecutionLogEntry): Promise<void>;
  getSession(sessionId: string): Promise<Session>;
  closeSession(sessionId: string): Promise<void>;

  // Retention management
  cleanupOldSessions(retentionDays: number): Promise<void>;
}

interface MCPServerRunner {
  // MCP server lifecycle
  startServer(personId: string, serverName: string): Promise<void>;
  stopServer(personId: string, serverName: string): Promise<void>;
  restartServer(personId: string, serverName: string): Promise<void>;

  // Tool execution via MCP
  executeTool(
    person: Person,
    serverName: string,
    toolName: string,
    input: any
  ): Promise<ToolResult>;

  // Capability discovery
  discoverCapabilities(serverName: string): Promise<ToolCapability[]>;

  // Health monitoring
  healthCheck(personId: string, serverName: string): Promise<HealthStatus>;

  // Credential management
  setCredentials(personId: string, serverName: string, credentials: any): Promise<void>;
}
```

**Service Communication:**
- Services communicate via **direct function calls** (same process in v1)
- Each service exposes a typed interface
- Dependencies are injected, not imported globally
- Services can be mocked for testing
- Future: Services can be split into separate processes/containers if needed

## Core Components

### Identity Resolution & Authorization

Identity resolution maps incoming channel identities (phone number, email, Telegram account, etc.) to a specific Person through deterministic application logic. This happens before any LLM invocation or tool execution.

**Person Model with Role-Based Permissions:**

```typescript
interface Person {
  id: string;
  householdId: string;
  name: string;
  email?: string;
  role: 'admin' | 'member' | 'limited';
  permissions: Permission[];  // Granular permissions
  createdAt: Date;
}
```

**Security Model:**
- Unknown identities are blocked by default
- Pairing flow required for new identities (6-digit code, 15-min expiry)
- Authorization enforced before tool execution
- LLM never decides access permissions

For detailed security architecture, see [SECURITY_MODEL.md](./SECURITY_MODEL.md).

### Memory System

The platform uses a **hybrid memory storage strategy** combining the strengths of PostgreSQL and JSONL files.

**PostgreSQL for Durable Memory:**
- Long-term memories that need querying and relationships
- Scoped with foreign key constraints (household_id, person_id)
- Full-text search capabilities (`to_tsvector`)
- Retention policies enforced via database

**JSONL for Ephemeral State:**
- Session working memory (auto-cleanup on session end)
- Execution traces (append-only audit logs)
- Debug traces (developer convenience)
- Tool invocation logs (performance analysis)

**Memory Scopes:**
- Private per-person memory (PostgreSQL with scope enforcement)
- Shared household memory (PostgreSQL with scope enforcement)
- Short-lived session/task memory (ephemeral JSONL files)

These scopes remain clearly separated and never accidentally mixed.

**Illustrative Memory Table Structure:**

```sql
-- Simplified example (not full schema)
CREATE TABLE memory_entries (
  id UUID PRIMARY KEY,
  household_id UUID NOT NULL REFERENCES households(id),
  person_id UUID REFERENCES persons(id),  -- NULL for shared household memory
  scope TEXT NOT NULL,  -- 'private' | 'shared'
  content TEXT NOT NULL,
  embedding VECTOR(1536),  -- For future vector search
  created_at TIMESTAMP NOT NULL,
  metadata JSONB
);

-- Scope enforcement via CHECK constraint
ALTER TABLE memory_entries ADD CONSTRAINT scope_enforcement
  CHECK (
    (scope = 'private' AND person_id IS NOT NULL) OR
    (scope = 'shared' AND person_id IS NULL)
  );
```

### Tool System Architecture

The platform uses a **three-tier tool architecture** that balances security, flexibility, and extensibility. See [TOOLS.md](./TOOLS.md) for complete details.

**Three-Tier Model:**

1. **Bundled Tools** (5-10 core capabilities)
   - Built into platform codebase
   - Direct access to core services (Memory, Identity, etc.)
   - Examples: memory search, session management, system health

2. **Adapter-Based Tools** (special cases)
   - Custom code for bidirectional communication
   - Complex lifecycle management
   - Examples: streaming sensors, real-time device control
   - Use when: MCP cannot express the integration pattern

3. **MCP-Based Tools** (primary integration method)
   - **Default choice for new integrations**
   - Standard Model Context Protocol interface
   - Per-person server instances with credential isolation
   - Process isolation (v1) or container isolation (v2)
   - Examples: Google Calendar, GitHub, file system access
   - Large ecosystem of community-maintained servers

**Universal Capability Discovery:**

All tool sources expose capabilities via the `ToolSource` interface:

```typescript
interface ToolSource {
  type: 'bundled' | 'adapter' | 'mcp';
  name: string;

  // Dynamic capability discovery
  discoverCapabilities(): Promise<ToolCapability[]>;

  // Tool execution
  executeTool(name: string, input: any, context: RequestContext): Promise<ToolResult>;

  // Health monitoring
  healthCheck(): Promise<HealthStatus>;
}

interface ToolCapability {
  name: string;
  description: string;
  inputSchema: ZodSchema;
  requiredPermissions: string[];
  metadata?: {
    category?: string;
    tags?: string[];
    isDestructive?: boolean;
  };
}
```

**Dynamic Permission Model:**

Permissions are based on discovered capabilities, not hard-coded:

```sql
-- Capabilities discovered from all tool sources
CREATE TABLE tool_capabilities (
  capability_name VARCHAR(200) UNIQUE,
  source_type VARCHAR(20), -- 'bundled' | 'adapter' | 'mcp'
  source_name VARCHAR(100),
  required_permissions TEXT[],
  ...
);

-- Per-person capability grants
CREATE TABLE capability_grants (
  person_id UUID,
  capability_name VARCHAR(200),
  granted_by UUID,
  ...
);

-- Shared capabilities (e.g., dad shares calendar with kids)
CREATE TABLE shared_capability_grants (
  owner_id UUID,      -- Who owns the capability
  grantee_id UUID,    -- Who is granted access
  capability_name VARCHAR(200),
  ...
);
```

**Execution Principles:**
- Tools execute in their natural context (per-person credentials)
- Authorization checked before execution via capability-based permissions
- Support for streaming and long-running operations
- Clean cancellation support via AbortSignal
- MCP servers run per-person with isolated credentials

### MCP Integration Layer

**Model Context Protocol (MCP)** is the primary integration method, enabling community-contributed tools while maintaining security and isolation.

**Per-Person MCP Servers:**

Each person gets their own instance of each MCP server:

```typescript
interface MCPServerInstance {
  serverId: string;
  personId: string;           // Who owns this instance
  serverName: string;         // e.g., 'google-calendar', 'github'
  process?: ChildProcess;     // v1: process isolation
  container?: ContainerId;    // v2: container isolation
  status: 'running' | 'stopped' | 'failed';
}

// Example: Dad and Mom each have their own Google Calendar MCP server
{
  serverId: 'mcp-google-cal-dad',
  personId: 'person-dad',
  serverName: 'google-calendar',
  process: ChildProcess { pid: 12345 },
  env: {
    GOOGLE_ACCESS_TOKEN: dad.encrypted_token,  // Dad's OAuth token
  }
}

{
  serverId: 'mcp-google-cal-mom',
  personId: 'person-mom',
  serverName: 'google-calendar',
  process: ChildProcess { pid: 12346 },
  env: {
    GOOGLE_ACCESS_TOKEN: mom.encrypted_token,  // Mom's OAuth token
  }
}
```

**Credential Isolation:**

```typescript
// Per-person MCP credentials
CREATE TABLE mcp_credentials (
  person_id UUID REFERENCES persons(id),
  server_name VARCHAR(100),
  credentials JSONB,  -- EncryptedCredentials object
  UNIQUE(person_id, server_name)
);

// OAuth flow per person
async function connectMCPIntegration(person: Person, serverName: string) {
  // 1. OAuth flow for this specific person
  const tokens = await completeOAuthFlow(person.id);

  // 2. Encrypt and store tokens
  await storeEncryptedCredentials(person.id, serverName, tokens);

  // 3. Spawn MCP server with person's credentials
  await mcpRunner.startServer(person.id, serverName);
}
```

**Security Models:**

- **v1: Process Isolation + Verified Allowlist**
  - MCP servers run as child processes
  - Only verified servers can be installed (manual review)
  - Each person's server isolated by process boundary
  - Credentials passed via environment variables

- **v2: Container Isolation (Future)**
  - MCP servers run in Docker/Podman containers
  - Resource limits (CPU, memory, network)
  - Stronger isolation, can run untrusted servers
  - Remove need for manual allowlist

**MCP vs Adapter Decision:**

| Use MCP When | Use Adapter When |
|--------------|------------------|
| Request/response pattern | Bidirectional communication needed |
| Standard tool interface | Complex state machines |
| No push events needed | Server pushes events to assistant |
| Community integration | Platform-specific logic |

**Benefits:**
- **Standard Protocol**: Leverage large MCP ecosystem
- **Security**: Per-person isolation of credentials and processes
- **Delegation**: External systems manage their own permissions
- **Community**: Easy to add new integrations without platform changes

### LLM Provider System

The platform supports multiple LLM providers through a swappable interface with fallback chains.

**Supported Providers (v1):**
- **Anthropic (Claude)**: API-based, high quality
- **OpenAI (GPT)**: API-based, widely available
- **Ollama**: Local LLM runtime (privacy, offline, cost-free)

**Provider Hierarchy:**

LLM selection follows cascading preferences:
1. Person preference
2. Household default
3. System default

Each level can specify multiple providers in fallback order. The system tries each provider until one succeeds or all fail.

**Ollama Integration Benefits:**
- **Privacy**: Data never leaves your device
- **Cost**: No API fees, unlimited usage
- **Offline**: Works without internet
- **Control**: Choose specific models (Llama 3, Mistral, Gemma, Phi-3, etc.)
- **Performance**: Fast on local hardware with GPU support
- **No Rate Limits**: Limited only by local hardware

**LLMProvider Interface:**

```typescript
interface LLMProvider {
  name: string;
  type: 'api' | 'local';

  // Health check
  healthCheck(): Promise<ProviderHealth>;

  // Model invocation
  invoke(prompt: string, options: LLMOptions): Promise<LLMResponse>;
  stream(prompt: string, options: LLMOptions): AsyncIterable<LLMChunk>;

  // Capabilities
  supportedModels(): Promise<string[]>;
  maxContextSize(model: string): number;
}
```

**Example Fallback Strategy:**
```yaml
# Person preference: Claude (high quality, costs money)
# Household default: GPT-4 (good quality, some cost)
# System fallback: Ollama Llama3 (free, private, always available)

# Behavior:
# 1. Try Claude (person preference)
# 2. If unavailable, try GPT-4 (household default)
# 3. If unavailable, use Llama3 (system fallback)
# 4. System always has a working LLM (Ollama)
```

### Channel System

The platform supports multiple messaging channels through a unified abstraction layer.

**ChannelAdapter Interface:**

```typescript
interface ChannelAdapter {
  name: string;
  type: ChannelType; // 'websocket' | 'telegram' | 'whatsapp' | 'sms'

  // Lifecycle
  start(): Promise<void>;
  stop(): Promise<void>;

  // Messaging
  sendMessage(recipient: ChannelRecipient, message: Message): Promise<void>;

  // Events
  on(event: 'message', handler: (msg: InboundMessage) => void);
  on(event: 'error', handler: (error: Error) => void);

  // Health
  healthCheck(): Promise<ChannelHealth>;
}
```

**v1 Channels:**
- WebSocket (primary interface for v1)

**Future Channels:**
- Telegram Bot
- WhatsApp (via Baileys or official API)
- SMS
- Discord
- Slack

**Channel Configuration:**
Channels are configured per household and can be enabled/disabled independently. This abstraction ensures adding new channels doesn't require core orchestrator changes.

### Observability & Logging

Logging and traceability are foundational requirements for debugging and observability.

**Logging Strategy:**
- **Structured logging** via pino for application events
- **Append-only JSONL** for execution traces
- **Session files** for debugging and replay

**What Gets Logged:**
- Inbound request received
- Identity resolution result
- Authorization decisions
- Memory access events
- Tool selection and execution
- LLM invocation (provider, tokens, duration)
- Outbound response
- Errors and failures

**Session File Structure:**

```
data/
  sessions/
    <session-id>/
      execution.jsonl     # Append-only execution trace
      context.json        # Session working memory
      tools.jsonl         # Tool invocation history
  audit/
    2026-03-18/
      requests.jsonl      # Daily audit logs (auto-rotated)
```

**Retention Policies:**
- Session files: Auto-cleanup on session end or after N days
- Audit logs: Daily rotation with configurable retention (default: 90 days)
- Execution traces: Configurable retention (default: 30 days)
- PostgreSQL memory: Indefinite with manual cleanup

**Developer Experience:**
```bash
# Live debugging
tail -f data/sessions/<session-id>/execution.jsonl

# Session replay (future capability)
family-assistant sessions show <session-id>
family-assistant sessions replay <session-id>
```

## Technology Stack

**Runtime and Framework:**
- **Node.js**: Runtime environment
- **Fastify**: Lightweight, performant API framework
- **TypeScript**: Strong typing throughout
- **Zod**: Runtime validation

**Database and Persistence:**
- **PostgreSQL**: Durable memory, households, persons, identities
- **JSONL files**: Sessions, execution traces, audit logs
- **Prisma or Drizzle**: ORM/query builder with type safety

**Testing:**
- **Vitest or Jest**: Unit and integration testing
- Session replay tests (load JSONL, replay execution)

**Real-time Communication:**
- **Socket.io**: WebSocket-based communication
- Event-driven architecture for request lifecycle updates
- Real-time streaming of LLM responses
- Status updates for long-running operations
- Support for user interruption and cancellation

**Dependency Injection (Explicit Pattern):**

```typescript
// Explicit dependencies - testable, traceable, clear
interface RequestDeps {
  authService: AuthService;
  memoryProvider: MemoryProvider;
  toolRegistry: ToolRegistry;
  logger: Logger;
  requestId: string;
}

class Orchestrator {
  constructor(private deps: RequestDeps) {}

  async handleRequest(request: Request) {
    this.deps.logger.info({ requestId: this.deps.requestId }, 'handling request');
    // All dependencies explicit and traceable
  }
}
```

**Configuration Strategy (Layered):**

```
Tier 1: System Configuration (.env, config files)
  - Database credentials
  - LLM provider API keys
  - System-level defaults
  - Can be version-controlled (git)

Tier 2: Household Configuration (database + files)
  - Household settings
  - Person configurations
  - Tool availability
  - Export to YAML/JSON for git tracking

Tier 3: Session Configuration (runtime)
  - Model selection
  - Thinking level
  - Verbose mode
  - Applied via WebSocket without persistence
```

## Data Model

**High-Level Entity Relationships:**

```
Household
  ├─ Persons (1:many)
  │   ├─ ChannelIdentities (1:many)
  │   ├─ ConnectedAccounts (1:many)
  │   ├─ Permissions (1:many)
  │   └─ Memory Entries (1:many, private scope)
  └─ Memory Entries (1:many, shared scope)

Person
  ├─ Role: 'admin' | 'member' | 'limited'
  ├─ Permissions: Granular permission extensions
  └─ Integrations via ConnectedAccounts

ChannelIdentity
  ├─ Maps channel-specific identifier to Person
  ├─ Type: 'phone' | 'email' | 'telegram' | etc.
  └─ Verified: Boolean (via pairing flow)

ConnectedAccount
  ├─ Links Person to external service
  ├─ Stores OAuth tokens or API keys
  └─ Enables per-person integration credentials

Memory
  ├─ Scope: 'private' (person_id) | 'shared' (household)
  ├─ Storage: PostgreSQL (durable) | JSONL (ephemeral)
  └─ Retention: Configurable policies
```

## Request Lifecycle

**Step-by-Step Flow with Event Hooks:**

1. Receive inbound message via WebSocket
2. Create request/correlation ID and start execution trace
3. **Emit lifecycle event**: `identity.resolving`
4. Emit WebSocket event: `assistant:status` - "resolving_identity"
5. Resolve channel identity to person
6. **Emit lifecycle event**: `identity.resolved` (person: Person)
7. Load household and person context
8. Determine permissions and accessible integrations
9. Build request context with explicit dependencies (RequestDeps)
10. **Emit lifecycle event**: `context.assembled`
11. Emit WebSocket event: `assistant:status` - "thinking"
12. Select response path: direct response, tool usage, or skill execution
13. If tool execution needed:
    - **Emit lifecycle event**: `tool.before` (tool: Tool)
    - Emit WebSocket event: `assistant:tool` - tool name and parameters
    - Validate tool access before execution
    - Execute tool (in its natural context)
    - **Emit lifecycle event**: `tool.after` (result: ToolResult)
    - Emit WebSocket event: `assistant:tool` - tool result
14. Assemble relevant memory/context from PostgreSQL
15. Emit WebSocket event: `assistant:status` - "generating_response"
16. Invoke LLM if needed
17. **Emit lifecycle event**: `llm.invoked` (metadata: LLMMetadata)
18. Stream response chunks via WebSocket event: `assistant:chunk`
19. Emit WebSocket event: `assistant:complete` with full response
20. **Append to execution JSONL** (`data/sessions/<session-id>/execution.jsonl`)
21. **Emit lifecycle event**: `request.completed`
22. Make execution data available via CLI (`family-assistant sessions show <id>`)

**Event-Driven Architecture:**
- Lifecycle hooks enable plugins without core modifications
- Clear separation between internal events and WebSocket events
- All events logged for observability

## Key Architectural Decisions

### Lean Core + Plugin Extensions

**Rationale:**
- Core orchestrator remains lightweight and maintainable
- Capabilities ship as plugins (bundled, managed, workspace)
- Easy to add new features without modifying core
- Faster iteration and testing
- Clear separation of concerns

**Implementation:**
- Manifest-based tool registry
- Lifecycle event hooks for plugin integration
- Granular module exports enable selective imports
- No heavy dynamic plugin system in v1 (keep it simple)

### Hybrid Memory Storage

**Why PostgreSQL + JSONL:**

**PostgreSQL Benefits:**
- Proper querying and relationships
- Foreign key constraints enforce scope separation
- Full-text search capabilities
- ACID guarantees for durable data
- Retention policies via database jobs

**JSONL Benefits:**
- Fast append-only writes
- No schema migrations needed
- Easy debugging (`tail -f`)
- Flexible structure for execution traces
- Simple file-based cleanup

**Best of Both Worlds:**
- Use the right tool for each job
- Durable memory in PostgreSQL, ephemeral state in JSONL
- Single database + simple files (no complex infrastructure)
- Avoid vector database complexity until needed

### Integration Delegation Pattern

**Why External Systems Manage Permissions:**

Traditional approach (replicate permissions):
- Copy Google Calendar permissions into our system
- Sync changes, handle conflicts
- Duplicate complex permission models
- High maintenance burden

**Delegation approach (our choice):**
- Each person connects their own Google account
- Assistant uses person's credentials for requests
- Google enforces Google's permissions
- Shared access via Google's sharing (e.g., calendar sharing)
- Zero permission replication

**Benefits:**
- Simpler system design
- Always accurate permissions
- Leverage existing permission UIs
- No sync issues
- Clear security boundaries

### CLI-First, UI-Later

**Rationale for v1:**

**CLI-First Benefits:**
- Faster to ship (no UI development)
- Git-trackable configuration
- Scriptable and automatable
- Forces clean API design
- Understanding through terminal commands
- No UI framework dependencies

**UI-Later Benefits:**
- Build UI when usage patterns are clear
- UI consumes same APIs as CLI
- Not a v1 blocker
- Can iterate on UX separately
- Optional enhancement, not requirement

**Layered Configuration:**
- System: Environment variables, config files
- Household: Database + exportable YAML/JSON
- Session: Runtime, ephemeral
- Export/import for version control

## Architectural Boundaries

**Critical Separations (Must Stay Separate):**

- Identity resolution must be isolated from LLM logic
- Authorization must be enforced before tool execution
- Integrations must be behind replaceable adapters
- LLM provider must be swappable
- Memory retrieval must be scope-aware
- Shared and private memory must never be mixed accidentally
- Logging/tracing must wrap the full request lifecycle
- Transport/channel concerns must be separate from tools and business logic
- Core orchestrator must remain lean (tools are plugins)
- Dependencies must be explicit (no hidden globals)

**Why These Boundaries Matter:**
- Security: Authorization can't be bypassed
- Modularity: Components can be replaced independently
- Testability: Clear interfaces enable isolated testing
- Maintainability: Changes don't cascade unexpectedly
- Debuggability: Clear execution flow

## Extensibility Points

**Plugin Opportunities:**

1. **Lifecycle Hooks**: Event-driven plugin system
   - `identity.resolved`
   - `tool.before` / `tool.after`
   - `llm.invoked`
   - `request.completed`

2. **Tool Registry**: Manifest-based plugins
   - Bundled tools (built-in)
   - Managed tools (installed via CLI)
   - Workspace tools (user-defined)

3. **Adapter Interfaces**: Swappable implementations
   - MemoryProvider (PostgreSQL → Vector DB)
   - LLMProvider (Anthropic → OpenAI → Ollama)
   - ChannelAdapter (WebSocket → Telegram → WhatsApp)
   - StorageProvider (FileSystem → S3)

4. **Future Capabilities** (Not v1):
   - MCP integration support
   - Autonomous multi-step workflows
   - Sub-agents for complex tasks
   - Custom skill compositions

**Design Philosophy:**
- Start simple, upgrade later
- Granular module exports enable tree-shaking
- Clear interfaces over heavy frameworks
- Explicit over hidden

## Graceful Degradation

**Health Tracking:**

```typescript
interface IntegrationHealth {
  name: string;
  status: 'healthy' | 'degraded' | 'unavailable';
  lastCheck: Date;
  lastError?: Error;
  consecutiveFailures: number;
}
```

**Fallback Strategies:**

- **Google Calendar unavailable**: Skip calendar tools, continue with other capabilities
- **LLM provider fails**: Try fallback provider, then degrade to "service temporarily unavailable"
- **Memory service fails**: Use session memory only, warn user, continue operation
- **Integration fails**: Mark as unhealthy, retry with exponential backoff, notify user

**Error Handling:**
- Tool execution failures caught and logged with detailed context
- Retry strategies for transient failures (configurable retry count and backoff)
- Clear error messages to users without exposing internals
- Circuit breaker pattern consideration for future phases

**Health Monitoring:**

```bash
family-assistant health             # Show all integration health status
family-assistant health --provider anthropic
family-assistant health --integration google-calendar
```

**Resilience Principles:**
- Fail gracefully, not catastrophically
- Always provide feedback to user
- Log failures comprehensively
- Recover automatically where possible
- Degrade functionality before complete failure
