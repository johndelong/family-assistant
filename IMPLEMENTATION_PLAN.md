# Project: Modular Household Assistant Platform (v2 - Lean Core Architecture)

## Overview

Build a modular TypeScript-based household assistant platform that supports multiple people within the same household. The system should identify who is interacting with it, determine what information and tools they are authorized to access, and respond using connected services such as Google accounts, calendars, contacts, and future integrations.

**Core Philosophy** (Inspired by OpenClaw):
- **Lean Core + Rich Extensions**: Keep the core orchestrator lightweight; capabilities ship as plugins
- **Local-First**: Configuration via CLI and files, with optional UI later
- **Explicit over Hidden**: Favor deterministic, traceable code over framework magic
- **Terminal-First by Design**: CLI and file-based config ensure understanding and git-trackability

**Architecture:**
This platform consists of a **single lean service** with optional UI:

1. **Assistant Service (Core)** - Lightweight orchestration engine
   - Handles incoming assistant messages via WebSocket
   - Performs identity resolution and authorization
   - Orchestrates tool execution (tools run where they live)
   - Manages LLM invocations and memory
   - Persists execution logs as append-only JSONL files
   - Exposes optional REST APIs for future UI

2. **CLI + File-Based Configuration** (v1 Primary Interface)
   - `family-assistant` CLI for all configuration
   - Git-trackable YAML/JSON configuration files
   - Export/import configuration for version control
   - Interactive setup wizard for first-time users

3. **Admin UI (Optional, Future Phase)** - Web interface for management
   - Built only after v1 proves core concepts
   - Consumes same APIs as CLI
   - Nice-to-have, not required for v1

This is not a single-user chatbot. The platform must be designed around a household with multiple users, each having their own identity, linked accounts, permissions, and private data, while also supporting shared family context.

## Primary Goals

- Support multiple people within a household
- Enforce identity and authorization in application code
- Support both private per-user context and shared household context
- **Provide execution tracking and visualization for debugging and observability**
- Keep the architecture modular so components can be replaced or improved over time
- Favor explicit, deterministic application logic over hidden agent abstractions
- **Lean core with plugin-based extensions**
- Make logging, traceability, and troubleshooting first-class concerns from the start
- Secure secrets and credentials management
- **CLI-first, UI-later approach for faster v1 delivery**

## Core Requirements

### 1. Household-Centric Domain Model

The platform should model:
- Household
- Person
- ChannelIdentity
- ConnectedAccount
- Permission / Authorization policy
- Memory scopes
- RequestContext
- Tool / Capability (plugin-based)
- Execution / Audit records (JSONL files)

### 2. Identity Resolution

Incoming requests must be mapped to a specific person through deterministic application logic.

Examples of channel identity include:
- phone number
- email address
- Telegram account
- WhatsApp account
- device identity

Identity resolution must happen before any LLM invocation or tool execution.

### 3. Authorization

Authorization must be enforced in application code.
The LLM must not decide what a user is allowed to access.

Tool execution must only occur after validating:
- who the speaker is
- what integrations are accessible
- what scopes are permitted

**Person Model & Role-Based Permissions:**

The system supports a three-tier role model with granular permission extension:

```typescript
interface Person {
  id: string;
  householdId: string;
  name: string;
  email?: string;
  role: 'admin' | 'member' | 'limited';
  permissions: Permission[];  // Granular permissions
  createdAt: Date;
  updatedAt: Date;
}

type Permission =
  // System permissions
  | 'system.configure'
  | 'llm.configure'
  | 'integration.connect'

  // Household permissions
  | 'household.manage'
  | 'person.manage'

  // Memory permissions
  | 'memory.read.shared'
  | 'memory.write.shared'
  | 'memory.read.private'   // Always granted to own private memory
  | 'memory.write.private'  // Always granted to own private memory

  // Integration sharing permissions
  // These control whether others can use YOUR connected integrations
  | 'integrations.share.calendar.read'    // Allow others to read your calendar
  | 'integrations.share.calendar.write'   // Allow others to write to your calendar
  | 'integrations.share.contacts.read'    // Allow others to read your contacts
  | 'integrations.share.homeassistant'    // Allow others to control devices via your HA account

  // Self-configuration
  | 'config.self';
```

**Role Definitions:**

- **admin**: Full household control
  - All permissions automatically granted
  - Can manage other users
  - Can configure system-level settings
  - Can grant/revoke permissions

- **member**: Standard family member
  - Read/write access to shared household memory
  - Full control over own private data and integrations
  - Can configure own settings
  - Can connect own integration accounts (calendar, contacts, etc.)
  - Can grant sharing access to their integrations to other household members
  - Cannot manage other users or system configuration
  - Device control delegated to connected integrations (e.g., Home Assistant)

- **limited**: Restricted access for extended family/friends
  - No default permissions
  - Permissions granted explicitly via CLI
  - Can connect own integration accounts
  - Must be granted sharing access to use other household members' integrations
  - Common use case: grandparents, close friends with specific privileges
  - Example: Grandma can read dad's calendar if he grants her 'integrations.share.calendar.read'
  - Device control delegated to connected integrations (e.g., Home Assistant)

**Permission Enforcement:**

Authorization checks happen before tool execution:

```typescript
async function checkPermission(
  person: Person,
  requiredPermission: Permission,
  grantedBy?: Person  // For sharing permissions, who granted access
): Promise<boolean> {
  // Admins have all permissions
  if (person.role === 'admin') {
    return true;
  }

  // For sharing permissions, check if grantedBy person has granted this permission
  if (requiredPermission.startsWith('integrations.share.') && grantedBy) {
    // Check if the owner (grantedBy) has explicitly granted this to the requesting person
    const sharingGrants = await getPermissionGrants(grantedBy.id, person.id);
    return sharingGrants.includes(requiredPermission);
  }

  // Members have standard permissions
  if (person.role === 'member') {
    const memberPermissions = [
      'memory.read.shared', 'memory.write.shared',
      'memory.read.private', 'memory.write.private',
      'integration.connect',
      'config.self'
    ];
    if (memberPermissions.includes(requiredPermission)) {
      return true;
    }
  }

  // Limited users: check explicit permissions
  if (person.role === 'limited') {
    // Everyone can configure themselves
    if (requiredPermission === 'config.self') {
      return true;
    }
    // Everyone can read their own private memory
    if (requiredPermission === 'memory.read.private' ||
        requiredPermission === 'memory.write.private') {
      return true;
    }
    // Check explicit grants
    return person.permissions.includes(requiredPermission);
  }

  return false;
}

// Helper: Get permissions that ownerId has granted to granteeId
async function getPermissionGrants(
  ownerId: string,
  granteeId: string
): Promise<Permission[]> {
  const grants = await db.query(
    `SELECT permission FROM sharing_grants
     WHERE owner_id = $1 AND grantee_id = $2`,
    [ownerId, granteeId]
  );
  return grants.rows.map(row => row.permission);
}
```

**How Sharing Permissions Work:**

Integration sharing permissions control whether others can use YOUR connected integrations. Here's how it works in practice:

1. **Connect Your Own Integration**: Each person connects their own integration accounts
   ```bash
   # Dad connects his Google Calendar
   family-assistant integrations connect google-calendar
   # OAuth flow happens, dad's credentials stored
   ```

2. **Grant Sharing Access**: The integration owner decides who can use their integration
   ```bash
   # Dad allows his kids to read his calendar
   family-assistant permissions grant --person son --permission integrations.share.calendar.read
   family-assistant permissions grant --person daughter --permission integrations.share.calendar.read
   ```

3. **Access Check During Tool Execution**: When someone requests calendar data:
   ```typescript
   async function getCalendarEvents(requestingPerson: Person, ownerId: string) {
     // Check if requesting person can access owner's calendar
     if (requestingPerson.id === ownerId) {
       // Own calendar - always allowed
       const account = await getConnectedAccount(ownerId, 'google-calendar');
       return fetchCalendarEvents(account.credentials);
     }

     // Requesting someone else's calendar - check if owner has granted sharing
     const owner = await getPerson(ownerId);
     const hasSharedAccess = await checkPermission(
       requestingPerson,
       'integrations.share.calendar.read',
       owner // Check against owner's granted permissions
     );

     if (!hasSharedAccess) {
       throw new Error(`${owner.name} has not shared their calendar with you`);
     }

     // Use owner's credentials to fetch data
     const account = await getConnectedAccount(ownerId, 'google-calendar');
     return fetchCalendarEvents(account.credentials);
   }
   ```

4. **Example Use Cases**:
   - **Kids viewing parent's calendar**: Dad grants `integrations.share.calendar.read` to kids so they can ask "What days do I have school this week?"
   - **Shared home control**: Dad grants `integrations.share.homeassistant` to wife so she can control lights using his Home Assistant account
   - **Limited calendar editing**: Dad grants `integrations.share.calendar.write` to wife so she can add family events

**Permission Management (CLI):**

```bash
# Create person with role
family-assistant person add --name "Grandma" --role limited

# Grant sharing access to YOUR calendar integration (run as the integration owner)
# This allows grandma to read events from YOUR connected Google Calendar
family-assistant permissions grant --person grandma --permission integrations.share.calendar.read

# Grant sharing access to specific integrations
# This allows son to control devices using YOUR Home Assistant account
family-assistant permissions grant --person son --permission integrations.share.homeassistant

# Revoke sharing access
family-assistant permissions revoke --person grandma --permission integrations.share.calendar.read

# List sharing grants you've made to others
family-assistant permissions list-sharing-grants

# List what integrations others have shared with you
family-assistant permissions list-shared-with-me

# List explicit permissions granted to a limited role user
family-assistant permissions list --person grandma

# Change role (admin-only operation, requires CLI access)
family-assistant permissions set-role --person john --role admin
```

**Database Schema:**

```sql
CREATE TABLE persons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id UUID NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255),
  role VARCHAR(20) NOT NULL CHECK (role IN ('admin', 'member', 'limited')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE person_permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  permission VARCHAR(100) NOT NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  granted_by UUID REFERENCES persons(id),
  UNIQUE(person_id, permission)
);

-- Sharing permissions: tracks who has granted access to their integrations to whom
CREATE TABLE sharing_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,  -- Who owns the integration
  grantee_id UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE, -- Who is being granted access
  permission VARCHAR(100) NOT NULL,  -- e.g., 'integrations.share.calendar.read'
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(owner_id, grantee_id, permission)
);

CREATE INDEX idx_person_household ON persons(household_id);
CREATE INDEX idx_person_permissions ON person_permissions(person_id);
CREATE INDEX idx_sharing_grants_owner ON sharing_grants(owner_id);
CREATE INDEX idx_sharing_grants_grantee ON sharing_grants(grantee_id);
```

### 4. Memory Boundaries

The system must support at least:
- private per-person memory (PostgreSQL with scope enforcement)
- shared household memory (PostgreSQL with scope enforcement)
- short-lived session/task memory (ephemeral JSONL files)

**Memory Storage Strategy (Hybrid Approach):**

**PostgreSQL for Durable Memory:**
- Long-term memories that need querying and relationships
- Scoped with foreign key constraints (household_id, person_id)
- Full-text search capabilities
- Retention policies enforced via database

**JSONL for Ephemeral Execution State:**
- Session working memory (auto-cleanup on session end)
- Execution traces (append-only audit logs)
- Debug traces (developer convenience)
- Tool invocation logs (performance analysis)

These scopes must remain clearly separated and never accidentally mixed.

### 5. Modular Integrations

External systems such as Google Calendar and Google Contacts should be represented as modular integrations behind clean interfaces.

**Integration Pattern:**
- Integrations are separate, swappable modules
- Tools execute in their integration context (e.g., Google Calendar tools run in Google integration service)
- Clean adapter interfaces for all external services
- Easy to add new integrations without core changes

The design should allow additional integrations in the future without large architectural changes.

**Per-Person Integration Credentials:**

Each person connects their own integration accounts. The family assistant proxies requests to the integration using the requesting person's credentials.

```typescript
interface ConnectedAccount {
  id: string;
  personId: string;           // Who owns this connection
  integration: string;        // 'google-calendar', 'home-assistant', etc.
  credentials: {
    accessToken: string;      // OAuth token or API key
    refreshToken?: string;
    expiresAt?: Date;
  };
  metadata?: Record<string, any>;
}

// When executing a tool that requires an integration:
async function executeIntegrationTool(
  person: Person,
  integration: string,
  action: string,
  params: any
) {
  // 1. Get person's connected account for this integration
  const account = await getConnectedAccount(person.id, integration);

  if (!account) {
    throw new Error(`You need to connect your ${integration} account first`);
  }

  // 2. Use THEIR credentials to make the request
  // The integration enforces its own permissions
  return await integrationClient.execute(
    account.credentials.accessToken,
    action,
    params
  );
}
```

**Home Automation Integration (Delegation Pattern):**

For home automation systems like Home Assistant, Family Assistant **delegates** device control entirely to the home automation platform. Family Assistant does NOT manage device permissions itself.

```typescript
// Example: Home Assistant Integration
interface HomeAssistantTool {
  name: 'homeassistant.control_device';
  requiredPermissions: []; // No Family Assistant permissions needed

  async execute(person: Person, deviceId: string, action: string) {
    // Get person's Home Assistant account
    const haAccount = await getConnectedAccount(person.id, 'home-assistant');

    if (!haAccount) {
      throw new Error('Connect your Home Assistant account to control devices');
    }

    // Make request to Home Assistant using person's token
    // Home Assistant decides if this person can control this device
    const response = await fetch(`${haAccount.baseUrl}/api/services/light/turn_on`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${haAccount.credentials.accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ entity_id: deviceId })
    });

    if (!response.ok) {
      // Home Assistant denied the request - respect their decision
      throw new Error('Home Assistant denied this request. Check your HA permissions.');
    }

    return response.json();
  }
}
```

**Why Delegation for Home Automation:**

1. **Separation of Concerns**: Home automation platforms (Home Assistant, SmartThings) already have sophisticated permission and device management systems
2. **Single Source of Truth**: The home automation platform's permissions are authoritative
3. **No Duplicate Permission Management**: Don't maintain device permissions in two places
4. **Respects Existing Setup**: Users' existing home automation permissions work as-is
5. **Security**: Each person authenticates with their own home automation account
6. **Flexibility**: Works with any home automation platform (Home Assistant, SmartThings, etc.)

**Use Case Examples:**

**Scenario 1: Kid with Limited Home Assistant Access**
- Kid has Home Assistant account that can only control bedroom lights
- Kid asks Family Assistant: "Turn on living room lights"
- Family Assistant proxies to Home Assistant with kid's HA token
- Home Assistant returns 403 Forbidden (kid doesn't have permission)
- Family Assistant: "Sorry, you don't have permission to control living room lights in Home Assistant"

**Scenario 2: Grandma as Guest (No HA Account)**
- Grandma doesn't have a Home Assistant account
- Grandma asks: "Turn on the lights"
- Family Assistant: "To control devices, you need to connect a Home Assistant account"
- Admin can optionally: Create a limited HA account for grandma with specific device permissions

**Scenario 3: Admin with Full Access**
- Admin has full Home Assistant access
- Admin can control all devices
- This permission comes from **Home Assistant**, not Family Assistant

### 6. Tooling Model (Plugin-Based)

Assistant capabilities should be exposed as typed tools or service operations.

**Tool Categories:**
- **Bundled Tools**: Core tools shipped with system (readonly, built-in)
- **Managed Tools**: Installed via CLI or future UI (system-wide plugins)
- **Workspace Tools**: User-defined custom tools (local extensions)

Examples:
- read calendar
- create calendar event
- search contacts
- create reminder
- save note

**Tool Structure:**
```typescript
interface Tool<TInput, TOutput> {
  name: string;
  description: string;
  inputSchema: ZodSchema<TInput>;
  requiredPermissions: Permission[];
  execute: (input: TInput, context: RequestContext) => Promise<ToolResult<TOutput>>;
}

interface ToolResult<T> {
  status: 'pending' | 'streaming' | 'completed' | 'failed';
  data?: T;
  stream?: AsyncIterable<Partial<T>>; // For long-running operations
}
```

Tool implementations should be independent of transport/channel logic.
Authorization should be checked before tool execution.

### 7. Skill Support

The architecture should support higher-level reusable capabilities built on top of tools.

Conceptually:
- Tool = atomic capability
- Skill = named higher-level behavior or composition of tools and application logic

Skills should be supported as abstractions, but v1 should remain simple and not introduce a heavy dynamic plugin system.

### 8. LLM Orchestration

LLM usage should happen only after:
- identity is resolved
- authorization context is established
- relevant memory and tool availability are assembled

LLM-related code should be isolated so the model provider can be swapped later.

### 9. Observability and Logging

Logging and traceability must be foundational requirements.
The system must produce structured, correlated execution records for each request.

**Logging Strategy:**
- **Structured logging** (pino) for application events
- **Append-only JSONL** for execution traces
- **Session files** for debugging and replay

At minimum, logs/events should capture:
- inbound request received
- identity resolution result
- authorization decisions
- memory access events
- tool selection and execution
- LLM invocation (provider, tokens, duration)
- outbound response
- errors and failures

**File Structure:**
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

Requirements:
- use structured logging
- assign a request or correlation ID to every inbound request
- make it possible to trace a request end-to-end
- separate or redact sensitive fields where appropriate (especially credentials and personal data)
- preserve enough context for troubleshooting and refinement
- support durable execution history for debugging and audit purposes
- support data retention policies (configurable retention period for execution logs)
- expose execution data via APIs for future UI visualization

### 10. CLI-First Configuration

**v1 Primary Interface:**
```bash
# Household management
family-assistant household create "Smith Family"
family-assistant household list

# Person management
family-assistant person add --name "John" --email "john@example.com"
family-assistant person list

# Identity linking
family-assistant identity link --person john --phone "+1234567890"
family-assistant identity link --person jane --telegram "@jane_smith"

# LLM provider setup
family-assistant llm add --provider anthropic --api-key "..."
family-assistant llm add --provider openai --api-key "..."
family-assistant llm test --provider anthropic

# Configuration export/import (git-trackable)
family-assistant config export > config.yaml
family-assistant config import config.yaml

# Session debugging
family-assistant sessions list
family-assistant sessions show <session-id>
family-assistant sessions replay <session-id>

# Tool management
family-assistant tools list
family-assistant tools install <tool-package>
```

**Configuration Files:**
```
~/.family-assistant/
  config.yaml              # System configuration
  households/
    <household-id>.yaml    # Household-specific config
  tools/
    manifest.yaml          # Installed tool registry
    bundled/               # Core tools
    managed/               # Installed tools
  data/
    sessions/              # Execution traces (JSONL)
    audit/                 # Audit logs (JSONL)
```

Benefits:
- Git-trackable configuration
- No UI dependency for v1
- Terminal-first ensures understanding
- Faster to implement than full UI
- Can add UI later when usage patterns are clear

## System Architecture

### Core Assistant Service

**Purpose**: Lean orchestration engine - identity, authorization, event coordination

**Technology Stack**:
- **Language**: TypeScript
- **Runtime**: Node.js
- **Framework**: Fastify (lightweight)
- **Database**: PostgreSQL (durable memory only)
- **File Storage**: JSONL (sessions, audit logs, execution traces)
- **Logging**: pino (structured logging)

**Key Principle**: "Gateway as Control Plane"
- Core service is lightweight orchestrator
- Tools execute in their natural contexts
- Plugins extend capabilities without bloating core

**Responsibilities**:
- Process incoming assistant messages via WebSocket
- Identity resolution and authorization
- **Tool orchestration** (not execution - tools run in their contexts)
- LLM provider selection and invocation
- Memory management (PostgreSQL for durable, JSONL for ephemeral)
- Event lifecycle broadcasting
- Execution logging (append-only JSONL)
- Optional REST APIs for future UI

**Does NOT include**:
- UI/frontend code (deferred to future phase)
- Heavy abstractions or frameworks
- Tool execution (tools are plugins)

**Deployment**:
- Standalone service
- Can run headless
- Designed to be callable from multiple channels (API, Telegram, WhatsApp, etc.)

---

## Technical Preferences

### Assistant Service

**Runtime and Framework**:
- Node.js runtime
- API framework: Fastify (lightweight, performant)
- Minimal dependencies, maximum clarity
- Avoid heavy frameworks unless clearly justified

**Typing and Validation**:
- Strong use of TypeScript types and interfaces throughout
- Runtime validation using Zod
- Clear separation between domain models and API schemas

**Database and Persistence**:
- **PostgreSQL**: Durable memory, households, persons, identities
- **JSONL files**: Sessions, execution traces, audit logs
- ORM or query builder: Prisma or Drizzle
- Favor clarity and type safety over abstraction complexity

**Dependency Injection Pattern** (Explicit over Hidden):
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

**Testing**:
- Vitest or Jest
- Unit tests for identity, authorization, tools, memory, logging
- Integration tests for request lifecycle
- Session replay tests (load JSONL, replay execution)

**Deployment**:
- Standalone Node.js service
- Environment-variable driven configuration
- File-based config for complex settings

### Real-time Communication

- WebSocket-based communication via Socket.io
- Event-driven architecture for request lifecycle updates
- Real-time streaming of LLM responses (token-by-token or chunk-by-chunk)
- Status updates for long-running operations (tool execution, thinking, etc.)
- Support for user interruption and cancellation
- Connection management with automatic reconnection
- Room-based isolation per session/household for multi-user support

**Event Types:**
- `assistant:status` - Lifecycle status changes (thinking, executing_tool, generating_response)
- `assistant:tool` - Tool execution start/completion with details
- `assistant:chunk` - Streaming response chunks from LLM
- `assistant:complete` - Request completed with full response and metadata
- `assistant:error` - Error occurred with details

**Lifecycle Hook System** (Event-Driven Extensibility):
```typescript
interface RequestLifecycle {
  on(event: 'identity.resolved', handler: (person: Person) => void);
  on(event: 'tool.before', handler: (tool: Tool) => void);
  on(event: 'tool.after', handler: (result: ToolResult) => void);
  on(event: 'llm.invoked', handler: (metadata: LLMMetadata) => void);
}

// Enables plugins to hook lifecycle without coupling:
// - Logging becomes a plugin
// - Metrics becomes a plugin
// - Future approval workflows = just another plugin
```

### LLM Integration

- Use official SDKs directly where possible
- Avoid unnecessary abstraction layers unless they provide clear value
- Keep the LLM provider behind a swappable interface
- Support multiple LLM providers (API-based and local via Ollama)
- Per-task LLM selection with fallback chain
- Provider selection hierarchy: person preference → household default → system default
- Stream LLM responses in real-time via WebSocket events

**Supported Providers (v1):**
- Anthropic (Claude) - API-based
- OpenAI (GPT) - API-based
- Ollama - Local LLM runtime (privacy, offline, cost-free)

**Provider Interface:**
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

**Logging and Observability**:
- Structured logging using pino
- Correlation/request IDs for all requests
- Append-only JSONL for execution traces
- Logs should be machine-readable and suitable for future analysis
- Session files enable debugging with `tail -f data/sessions/<id>/execution.jsonl`

**Configuration Strategy** (Layered):
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

**Async and Concurrency**:
- Use async/await consistently
- Design services to be non-blocking and composable
- Session-based isolation (no shared mutable state)

**Provider-Agnostic Abstractions**:
```typescript
// All external dependencies behind swappable interfaces

interface StorageProvider {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
}

interface MemoryProvider {
  retrieve(scope: MemoryScope, query: string): Promise<Memory[]>;
  store(scope: MemoryScope, memory: Memory): Promise<void>;
}

interface LLMProvider {
  invoke(prompt: string, options: LLMOptions): Promise<LLMResponse>;
  stream(prompt: string, options: LLMOptions): AsyncIterable<LLMChunk>;
}

// Implementations can be swapped:
// - PostgresMemoryProvider → VectorMemoryProvider
// - FileSystemStorage → S3Storage
// - Start simple, upgrade later
```

---

## Additional Requirements

### Channel Architecture

The platform supports multiple messaging channels through a unified abstraction layer.

**Channel Adapter Interface:**
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

---

### Security Model & Identity Pairing

**Default Security Posture:** Unknown identities are blocked until explicitly paired.

**Pairing Flow:**
1. Unknown identifier sends message to a channel
2. System generates 6-digit pairing code (expires in 15 minutes)
3. System responds via channel: "To link this identity, run: `family-assistant identity pair --code ABC123 --person <name>`"
4. User runs CLI command to approve pairing (requires physical CLI access)
5. Identity linked; future messages from this identity are processed normally

**Pairing CLI Commands:**
```bash
# Manual pairing request generation
family-assistant identity pair-request --channel telegram --identifier "@username"

# Approve pairing (links identity to person)
family-assistant identity pair --code ABC123 --person john

# List pending pairing requests
family-assistant identity pending

# Revoke identity
family-assistant identity revoke --identity-id <id>
```

**Security Considerations:**
- Pairing codes expire after 15 minutes
- Failed pairing attempts are logged and audited
- Pairing requires physical access to CLI (secure by design)
- Rate limiting prevents brute-force attacks on pairing codes
- Unknown identities cannot execute tools or access memory

---

### Resource Management

**Resource Limits Configuration:**
```typescript
interface ResourceLimits {
  // Request limits
  maxRequestSize: number;           // Default: 10MB
  maxConcurrentRequests: number;    // Per person, default: 3
  maxExecutionTime: number;         // Default: 300000ms (5 min)

  // Storage limits
  maxSessionFileSize: number;       // Default: 100MB (triggers rotation)
  maxMemoryEntriesPerPerson: number; // Default: 10000
  maxAuditLogDays: number;          // Default: 90

  // Rate limiting
  maxRequestsPerMinute: number;     // Per person, default: 30
  maxToolExecutionsPerRequest: number; // Default: 20
}
```

**Enforcement:**
- Oversized requests rejected with clear error message
- Concurrent request limit prevents resource exhaustion
- Execution timeout prevents runaway operations
- Session file rotation when size limit exceeded
- Rate limiting prevents abuse (accidental or malicious)
- Tool execution limits prevent infinite loops

**CLI Configuration:**
```bash
family-assistant config set limits.maxRequestSize 20971520  # 20MB
family-assistant config set limits.maxConcurrentRequests 5
family-assistant config get limits  # View all limits
```

**Why This Matters:**
- Household assistant runs on personal hardware with finite resources
- Prevents accidental resource exhaustion
- Security against malicious use
- Clear limits prevent surprising behavior

---

### Request Cancellation

**Cancellation Support:**
All long-running operations must support cancellation to enable user control and resource cleanup.

```typescript
interface CancellableRequest {
  requestId: string;
  cancel(): Promise<void>;
  onCancelled(handler: () => void): void;
}

// WebSocket event
// Client → Server: 'assistant:cancel' { requestId: '...' }
// Server → Client: 'assistant:cancelled' { requestId: '...' }
```

**Tool Execution with Cancellation:**
```typescript
async function executeTool(
  tool: Tool,
  input: any,
  signal: AbortSignal
): Promise<ToolResult> {
  signal.addEventListener('abort', () => {
    // Cleanup: cancel API calls, close connections, etc.
  });

  // Tool checks signal periodically
  if (signal.aborted) throw new Error('Cancelled');

  // Perform work...
}
```

**Use Cases:**
- User realizes they asked wrong question
- Tool is taking too long
- User wants to interrupt multi-step workflow
- System shutdown requires cleanup

---

### Development Experience

**Hot Reload & Watch Mode:**
- File watcher monitors source, config, and tool manifest changes
- Auto-restart server on changes
- Preserve active sessions across restarts when possible
- Fast iteration during development

**Developer Commands:**
```bash
family-assistant dev                # Start with hot reload
family-assistant dev --verbose      # Debug logging enabled
family-assistant dev --inspect      # Node debugger on port 9229
```

**Debug & Diagnostics:**
```bash
family-assistant doctor             # System health check
family-assistant doctor --fix       # Auto-fix common issues

# Health checks include:
# - Database connectivity
# - Required tables exist and have correct schema
# - LLM provider API keys valid (test connection)
# - Integration credentials valid
# - File permissions correct (~/.family-assistant/)
# - Port availability (WebSocket port)
# - Session file integrity
```

**Session Management:**
```bash
family-assistant sessions active    # Show active sessions
family-assistant sessions close <id> # Close session manually
family-assistant sessions cleanup   # Remove old sessions (respects retention)
family-assistant sessions cleanup --days 30
```

---

### Error Handling and Resilience

**Integration Health Tracking:**
```typescript
interface IntegrationHealth {
  name: string;
  status: 'healthy' | 'degraded' | 'unavailable';
  lastCheck: Date;
  lastError?: Error;
  consecutiveFailures: number;
}
```

**Graceful Degradation Strategy:**
- If Google Calendar unavailable: Skip calendar tools, continue with other capabilities
- If LLM provider fails: Try fallback provider, then degrade to "service temporarily unavailable"
- If memory service fails: Use session memory only, warn user, continue operation
- If integration fails: Mark as unhealthy, retry with exponential backoff, notify user

**Error Handling:**
- Tool execution failures should be caught and logged with detailed error context
- Retry strategies for transient failures (configurable retry count and backoff)
- Clear error messages returned to users without exposing internal implementation details
- Circuit breaker pattern consideration for future phases

**Health Monitoring:**
```bash
family-assistant health             # Show all integration health status
family-assistant health --provider anthropic
family-assistant health --integration google-calendar
```

### Data Retention

**PostgreSQL (Durable Memory):**
- Configurable retention policies for memory entries (default: indefinite with manual cleanup)
- Retention enforced via database cleanup jobs

**JSONL Files (Ephemeral State):**
- Session files: Auto-cleanup on session end or after N days
- Audit logs: Daily rotation with configurable retention (default: 90 days)
- Execution traces: Configurable retention (default: 30 days)
- Cleanup via simple file deletion (no database migrations)

## Design Principles

- **lean core, rich extensions**
- **modular**
- **testable**
- **readable**
- **explicit over hidden**
- **production-minded but pragmatic**
- **easy to extend**
- **easy to debug**
- **observable by default**
- **traceable and visualizable**
- **secure by default**
- **CLI-first, UI-later**

## Architectural Boundaries

- identity resolution must be isolated from LLM logic
- authorization must be enforced before tool execution
- integrations must be behind replaceable adapters
- LLM provider must be swappable
- memory retrieval must be scope-aware
- shared and private memory must never be mixed accidentally
- logging/tracing must wrap the full request lifecycle
- transport/channel concerns must be separate from tools and business logic
- **core orchestrator must remain lean** (tools are plugins)
- **dependencies must be explicit** (no hidden globals)

## Extensibility Expectations

- the platform should support pluggable capabilities through stable internal abstractions
- atomic capabilities should be represented as tools (plugin-based)
- higher-level reusable behaviors may be represented as skills
- the request lifecycle should be event-driven with clear hook points
- the architecture should remain compatible with future MCP integration, but MCP should not be treated as a foundational requirement for v1
- the architecture should support adding autonomous multi-step workflows (sub-agents) in future phases
- **lifecycle hooks enable plugins without core modifications**
- **granular module exports enable selective imports and tree-shaking**

## Minimum v1 Scope

Core platform:
- one household
- multiple persons
- **channel abstraction layer** (ChannelAdapter interface)
- **WebSocket channel implementation** (v1 primary channel)
- **identity pairing flow** (6-digit codes, 15-min expiry, security default)
- channel identity resolution
- request context assembly with explicit dependencies
- authorization checks
- **resource limits** (request size, concurrency, rate limiting, timeouts)
- **PostgreSQL for durable memory** (private/shared scopes)
- **JSONL for ephemeral session state** (execution traces, working memory)
- **session lifecycle management** (create, close, cleanup, file rotation)
- **manifest-based tool registry** (bundled tools only for v1)
- **tool execution with cancellation support** (AbortSignal)
- support for simple skills built from tools/application logic
- stubbed integrations for Google Calendar and Google Contacts
- **integration health tracking** (healthy/degraded/unavailable)
- **graceful degradation** (continue with available integrations)
- WebSocket-based real-time communication for assistant interactions
- real-time event streaming (status updates, tool execution, response streaming, cancellation)
- **request cancellation** (user can interrupt long operations)
- **lifecycle event system** with hook points
- structured logging and request correlation
- **append-only JSONL execution logs**
- **LLM providers**: Anthropic (Claude), OpenAI (GPT), **Ollama (local)**
- LLM provider fallback chain
- LLM usage tracking
- **self-configuration tools** (secure, four-tier permission model)
- **read-only tools** (system.health, config.get, etc.)
- **self-scoped tools** (person.configure.self, session.configure)
- **approval-required tools** (llm.add with confirmation)
- **credential redaction** (secrets never logged)
- **approval workflow** (60-second timeout, audited)
- tests for identity resolution, authorization, request routing, real-time events, and core logging behavior
- **CLI for all configuration** (household, person, identity, LLM provider management)
- **CLI for diagnostics** (`doctor`, `health`, `dev`)
- **CLI for pairing** (`identity pair`, `identity pending`)
- **CLI for sessions** (`sessions cleanup`, `sessions close`, `sessions active`)
- **config export/import** (git-trackable YAML/JSON)
- **hot reload dev mode**

**NOT in v1:**
- Admin UI (deferred to post-v1)
- Complex visualizations
- Analytics dashboards
- Managed/workspace tool installation (bundled tools only)
- Additional channels (Telegram, WhatsApp, SMS) - architecture ready, implementation later
- Tool development CLI helpers (`tool create`, `tool validate`) - can add later

## Request Lifecycle

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

## Recommended Abstractions

Core abstractions:
- identity resolver (deterministic, no LLM)
- authorization service (explicit permission checks)
- request context builder (explicit dependency injection)
- memory provider interface (swappable: Postgres, Vector, etc.)
- **tool registry** (manifest-based, plugin-aware)
- **tool manifest** (bundled/managed/workspace tools)
- skill abstraction (composition of tools)
- integration adapter interfaces (swappable external services)
- LLM provider interface (swappable: Anthropic, OpenAI, local)
- orchestration service (lean, event-driven)
- **lifecycle event emitter** (plugin hook system)
- real-time event emitter (WebSocket event broadcasting)
- structured logger / trace manager (pino + JSONL)
- **execution logger** (append-only JSONL writer)

## Minimal Database Schema for v1

Core tables:
- `households` - Household entities
- `persons` - People in households
- `channel_identities` - Identity mappings (phone, email, Telegram, etc.)
- `connected_accounts` - Linked external accounts (Google, etc.)
- `permissions` - Authorization policy mappings

**Memory table** (durable, queryable):
```sql
CREATE TABLE memory_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Scope
  household_id UUID NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  person_id UUID REFERENCES persons(id) ON DELETE CASCADE, -- null = shared

  -- Content
  type VARCHAR(50) NOT NULL, -- 'conversation', 'fact', 'preference', 'event'
  content TEXT NOT NULL,
  metadata JSONB,

  -- Search
  content_vector tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ, -- null = never expires

  -- Constraints
  CONSTRAINT person_or_shared CHECK (
    (person_id IS NULL AND type IN ('shared', 'household')) OR
    (person_id IS NOT NULL AND type IN ('conversation', 'fact', 'preference'))
  )
);

CREATE INDEX idx_memory_scope ON memory_entries(household_id, person_id);
CREATE INDEX idx_memory_search ON memory_entries USING gin(content_vector);
CREATE INDEX idx_memory_expires ON memory_entries(expires_at) WHERE expires_at IS NOT NULL;
```

Configuration tables:
- `configuration` - System-wide and household-level config

LLM tables:
- `llm_providers` - Available LLM providers and their configurations
- `llm_invocations` - Track all LLM calls for usage tracking and debugging

Security tables:
- `secrets` - Encrypted storage for API keys, OAuth tokens, and credentials

**NOT in database** (JSONL files instead):
- Session execution traces → `data/sessions/<session-id>/execution.jsonl`
- Tool invocation logs → `data/sessions/<session-id>/tools.jsonl`
- Audit trails → `data/audit/<date>/requests.jsonl`

## API Endpoints

### Core Assistant API (WebSocket)

```typescript
// Primary assistant interaction (WebSocket-based)
// Socket.io connection at: /assistant

// Events:
//   Client → Server:
//     'assistant:message' - Send message to assistant
//     'assistant:cancel'  - Cancel ongoing operation

//   Server → Client:
//     'assistant:status'   - Status updates (thinking, executing_tool, generating_response)
//     'assistant:tool'     - Tool execution details
//     'assistant:chunk'    - Streaming response chunks
//     'assistant:complete' - Request completed
//     'assistant:error'    - Error occurred
```

### Optional REST APIs (for future UI)

```typescript
// Household management
GET    /api/config/households
POST   /api/config/households
PUT    /api/config/households/:id

// Person management
GET    /api/config/persons
POST   /api/config/persons
PUT    /api/config/persons/:id
DELETE /api/config/persons/:id

// Channel identity management
POST   /api/config/persons/:personId/identities
DELETE /api/config/persons/:personId/identities/:identityId

// LLM provider management
GET    /api/config/llm-providers
POST   /api/config/llm-providers
PUT    /api/config/llm-providers/:id

// Session queries (reads from JSONL files)
GET    /api/sessions                    // List all sessions (paginated, filtered)
GET    /api/sessions/:id                // Get session details with execution trace
```

**Note**: REST APIs are optional for v1. CLI is primary interface. APIs enable future UI without architectural changes.

---

## Implementation Phases

### Phase 1: Architecture and Scaffolding

**Goals**: Repository structure, core models, database setup, CLI foundation, resource limits

**Tasks**:
- Define core domain models (Household, Person, Tool, ChannelIdentity, etc.)
- **Define Person model with role field** (admin, member, limited)
- **Define Permission type** (granular permission enumeration)
- Define interfaces and service boundaries
- **Define channel adapter interface** (WebSocket, future Telegram/WhatsApp)
- Scaffold Fastify API application with WebSocket support
- Setup PostgreSQL database with Drizzle or Prisma
- Create database migrations for core tables
- **Create persons table with role field**
- **Create person_permissions table** (granular permission grants)
- Setup `memory_entries` table with full-text search
- Establish structured logging (pino)
- Setup JSONL execution logger
- Create file structure for sessions and audit logs
- Setup secrets management (encrypted storage)
- **Configure resource limits** (request size, concurrency, timeouts)
- **Scaffold CLI** with Commander.js
- Implement basic CLI commands (household, person, config)
- **Add CLI commands for permission management** (grant, revoke, list, set-role)
- **Setup dev mode with hot reload** (nodemon or tsx watch)
- Setup granular module exports for tree-shaking

**Deliverables**:
- Repository with clean structure
- Database schema and migrations including permission tables
- Core TypeScript interfaces including ChannelAdapter, Person, Permission
- Person model with role-based and granular permissions
- Permission system schema and interfaces
- Resource limits configuration
- Basic CLI scaffolding with permission commands
- Dev mode with hot reload
- Logging and correlation model
- JSONL execution logger

---

### Phase 2: Core Request Pipeline & Event System

**Goals**: Identity, authorization, lifecycle events, WebSocket channel, pairing, cancellation

**Tasks**:
- Implement identity resolution (deterministic, no LLM)
- **Implement pairing service** for unknown identities (6-digit codes, 15-min expiry)
- Implement request context assembly with explicit dependency injection
- **Implement authorization service** (role-based + granular permission checks)
- **Implement checkPermission function** (role-aware, permission-aware)
- **Load person with role and permissions from database**
- Implement authorization checks before tool execution
- **Implement resource limit enforcement** (request size, concurrency, rate limiting)
- **Implement lifecycle event system** (hook-based)
- **Implement WebSocket channel adapter** (first concrete channel implementation)
- Setup Socket.io WebSocket server
- Implement event broadcasting (status, tool, chunk, complete, cancelled)
- Create WebSocket endpoint: `/assistant`
- **Implement request cancellation** (AbortSignal propagation)
- Implement basic orchestration with explicit dependency injection
- **Implement JSONL execution trace writer**
- Add CLI commands for session debugging (`sessions list`, `sessions show`)
- **Add CLI commands for pairing** (`identity pair`, `identity pending`)

**Deliverables**:
- Identity resolution with pairing flow
- Unknown identity blocking (security default)
- Authorization service with role-based and granular permissions
- Permission checking before all tool executions
- Resource limits enforced
- Lifecycle event emitter with hooks
- WebSocket channel adapter (implements ChannelAdapter interface)
- WebSocket server with event broadcasting
- Request cancellation support
- Basic orchestration entrypoint
- Append-only execution logging
- Pairing CLI commands

---

### Phase 3: Memory and Tool Registry

**Goals**: PostgreSQL memory, JSONL sessions, manifest-based tools, session lifecycle

**Tasks**:
- Implement PostgreSQL memory provider (scoped: household/person)
- Add full-text search for memory queries
- Implement session working memory (JSONL files)
- **Implement session lifecycle management** (create, get, close, cleanup)
- **Add session file rotation** (when maxSessionFileSize exceeded)
- **Create tool manifest system** (bundled/managed/workspace)
- Implement tool registry with manifest loading
- Create base Tool interface with async execution and cancellation support
- Add initial bundled tools with authorization
- Implement tool execution logging (JSONL)
- **Add tool execution with AbortSignal** (respects cancellation)
- Add CLI commands for tool management (`tools list`, `tools info`)
- **Add CLI commands for session management** (`sessions cleanup`, `sessions close`)

**File Structure**:
```
~/.family-assistant/
  tools/
    manifest.yaml          # Tool registry
    bundled/
      calendar-read.ts
      calendar-create.ts
    managed/               # Future: installed tools
    workspace/             # Future: custom tools
  data/
    sessions/
      <session-id>/
        execution.jsonl    # Execution trace (auto-rotates if > maxSize)
        context.json       # Session working memory
        tools.jsonl        # Tool invocation log
```

**Deliverables**:
- PostgreSQL memory working (private/shared scopes)
- Session JSONL files (ephemeral state)
- Session lifecycle management (create, close, cleanup)
- Session file rotation
- Tool manifest and registry
- Initial bundled tools with cancellation support
- Tool execution with authorization and cancellation
- Session management CLI commands

---

### Phase 3B: Self-Configuration Tools (Secure)

**Goals**: Enable safe conversational configuration with security boundaries

**Security Philosophy**: Balance convenience with security through a four-tier permission model that prevents privilege escalation, credential leaks, and unauthorized access while enabling helpful self-service configuration.

**Four-Tier Security Model**:

**Tier 1: Read-Only Tools** (Safe, always allowed)
- No modification of system state
- Cannot leak sensitive data
- Available to all authenticated users

**Tier 2: Self-Scoped Tools** (Person can configure themselves only)
- Modifications limited to requesting person
- Cannot affect other users or system
- Validated: `requestingPerson.id === targetPerson.id`

**Tier 3: Approval-Required Tools** (Explicit confirmation needed)
- Sensitive operations requiring user awareness
- 60-second approval timeout
- All approvals audited

**Tier 4: Admin-Only** (CLI-only, never exposed to LLM)
- Critical system operations
- Requires physical server access
- Not callable via conversation

**Tasks**:

**Security Infrastructure**:
- Define four-tier permission model with risk levels
- Implement tool exposure filtering (hide Tier 4 from LLM)
- Add self-scope validation (prevent cross-person configuration)
- Implement approval workflow with timeout
- Add credential redaction system (`@secret` annotation)
- Add approval audit logging
- Implement rate limiting for approval requests

**Tier 1 Tools (Read-Only)**:
```typescript
// Safe: Read system state
'system.health'      // Check system health status
'config.get'         // Read configuration values
'llm.list'          // List configured LLM providers
'llm.test'          // Test provider connectivity
'integration.list'  // List integrations
'integration.test'  // Test integration health
'tools.list'        // List available tools
'memory.search'     // Search memories (scope-aware)
'sessions.list'     // List sessions
```

**Tier 2 Tools (Self-Scoped)**:
```typescript
// Safe: Scoped to requesting person
'person.configure.self'  // Configure own settings
'session.configure'      // Configure current session

// Examples:
// - Set verbose mode
// - Change default LLM
// - Update preferences
// - Configure notification settings

// Validation: Enforces requestingPerson === targetPerson
```

**Tier 3 Tools (Approval-Required)**:
```typescript
// Sensitive: Requires explicit approval
'llm.add'              // Add LLM provider (stores credentials)
'integration.connect'  // Connect integration (OAuth flow)

// Approval flow:
// 1. LLM requests approval with clear explanation
// 2. User must type 'APPROVE' within 60 seconds
// 3. Operation executes if approved
// 4. Approval logged to audit trail
```

**Tier 4 Operations (Admin-Only, CLI-Only)**:
```typescript
// Never exposed as tools - CLI only
'system.configure'      // System-level configuration
'permissions.grant'     // Grant/revoke permissions
'secrets.rotate'        // Rotate encryption keys
'household.delete'     // Delete household
'database.migrate'     // Database operations
'person.delete'        // Delete users

// These require: family-assistant CLI access (physical security)
```

**Credential Security**:
- Annotate sensitive fields with `@secret`
- Redact credentials in logs (`apiKey: '[REDACTED]'`)
- Encrypt credentials at rest
- Never include credentials in JSONL execution traces
- Never pass credentials to LLM context

**Tool Execution Security**:
```typescript
// Security checks before execution
async function executeTool(
  toolName: string,
  input: any,
  context: RequestContext
): Promise<ToolResult> {
  const tool = toolRegistry.get(toolName);

  // 1. Check if tool is exposed to LLM
  if (!tool.exposedToLLM) {
    throw new Error('Tool not available via conversation');
  }

  // 2. Check permissions
  if (!await authService.checkPermission(context.person, tool.permissions)) {
    throw new Error('Insufficient permissions');
  }

  // 3. Validate self-scoped operations
  if (tool.tier === 'selfScoped') {
    if (input.personId && input.personId !== context.person.id) {
      throw new Error('Cannot configure other people');
    }
  }

  // 4. Require approval for sensitive operations
  if (tool.requiresApproval) {
    const approved = await requestApproval(context, tool, input);
    if (!approved) {
      throw new Error('Operation not approved or timed out');
    }
  }

  // 5. Redact sensitive data from logs
  const sanitizedInput = redactSecrets(input);
  logger.info({ tool: toolName, input: sanitizedInput }, 'executing tool');

  // 6. Execute with AbortSignal support
  return tool.execute(input, context);
}
```

**Approval Workflow**:
```typescript
async function requestApproval(
  context: RequestContext,
  tool: Tool,
  input: any
): Promise<boolean> {
  const approvalId = generateApprovalId();

  // Send approval request to user
  await context.channel.sendMessage(context.person, {
    type: 'approval_request',
    approvalId,
    tool: tool.name,
    description: tool.approvalPrompt,
    risks: tool.risks,
    timeout: 60, // seconds
  });

  // Wait for approval (or timeout)
  const result = await waitForApproval(approvalId, 60000); // 60 seconds

  // Audit log
  await auditLog.write({
    type: 'approval',
    approvalId,
    tool: tool.name,
    person: context.person.id,
    approved: result.approved,
    timestamp: new Date(),
  });

  return result.approved;
}
```

**Example Conversations**:

Safe (Tier 1 - Read-Only):
```
User: "What LLM am I using?"
Assistant: *calls config.get('person.john.llm')*
Assistant: "You're using Anthropic Claude Sonnet"

User: "Is the system healthy?"
Assistant: *calls system.health()*
Assistant: "System healthy. All integrations operational."
```

Safe (Tier 2 - Self-Scoped):
```
User: "Switch to verbose mode"
Assistant: *calls session.configure({ verbose: true })*
Assistant: "Verbose mode enabled for this session"

User: "Make Claude my default LLM"
Assistant: *calls person.configure.self({ llm: 'anthropic:claude' })*
Assistant: "Set Claude as your default LLM"
```

Approval Required (Tier 3):
```
User: "Add my OpenAI key: sk-..."
Assistant: "⚠️ SECURITY CHECK

I need to store your OpenAI API key securely.

This will:
- Encrypt and store the key
- Enable OpenAI LLM calls
- Track usage for billing

Type 'APPROVE' within 60 seconds to confirm"

User: "APPROVE"
Assistant: *calls llm.add({ provider: 'openai', apiKey: '...' })*
Assistant: "✓ OpenAI provider added securely"
```

Blocked (Tier 4 - Admin-Only):
```
User: "Make me a household admin"
Assistant: "I cannot change user roles. Role changes require CLI access:

  family-assistant permissions grant --person john --role admin

This ensures only someone with physical server access can change permissions."
```

Blocked (Cross-Person):
```
User: "Change Jane's default LLM to GPT"
Assistant: "I can only configure your own settings. To change Jane's settings, she needs to:

1. Log in and configure herself
2. Or ask an admin via CLI if needed

This prevents unauthorized access to other users' accounts."
```

**CLI Commands** (for admin operations):
```bash
# Admin-only operations (not available via conversation)
family-assistant permissions grant --person john --role admin
family-assistant person delete --person-id <id> --confirm
family-assistant system configure --key <key> --value <value>
family-assistant secrets rotate --type api-keys
```

**Deliverables**:
- Four-tier permission model implemented
- Tool exposure filtering (Tier 4 hidden from LLM)
- Self-scope validation (prevent cross-person config)
- Approval workflow with 60-second timeout
- Credential redaction system
- Approval audit logging
- Read-only tools (system.health, config.get, etc.)
- Self-scoped tools (person.configure.self, session.configure)
- Approval-required tools (llm.add, integration.connect)
- Tool execution security checks
- Rate limiting for approval requests
- Comprehensive tests for all security boundaries

**Security Tests**:
- ✓ Self-scoped tools cannot target other users
- ✓ Tier 4 tools not callable via conversation
- ✓ Credentials redacted in all logs
- ✓ Approval timeout enforced
- ✓ Failed approvals audited
- ✓ Cross-person configuration blocked
- ✓ Privilege escalation prevented

---

### Phase 4: Skills

**Goals**: Higher-level behaviors composed from tools

**Tasks**:
- Implement lightweight skill abstraction
- Support simple behaviors composed from tools
- Keep skill loading simple and explicit (no complex plugin system)
- Add example skills (e.g., "schedule meeting" = check calendar + create event)

**Deliverables**:
- Skill abstraction
- Example composite skills

---

### Phase 5: Integrations

**Goals**: Stubbed Google Calendar and Contacts, integration health tracking

**Tasks**:
- Create integration adapter interface
- Implement stubbed Google Calendar adapter
- Implement stubbed Google Contacts adapter
- Connect tools to adapters
- **Implement integration health tracking** (healthy/degraded/unavailable)
- **Add health check service** (periodic checks, exponential backoff on failures)
- **Implement graceful degradation** (skip unavailable integrations, warn user)
- Add CLI commands for health monitoring (`health`, `health --integration <name>`)

**Deliverables**:
- Integration adapter pattern
- Stubbed Google integrations
- Tools connected to adapters
- Integration health tracking
- Graceful degradation on integration failures
- Health monitoring CLI commands

---

### Phase 6: LLM Integration

**Goals**: Multi-provider LLM support with fallback, including Ollama for local models

**Tasks**:
- Create LLM provider interface (swappable, supports API and local)
- Implement Anthropic provider (Claude)
- Implement OpenAI provider (GPT)
- **Implement Ollama provider** (local LLM runtime)
- Implement LLM selector with fallback chain
- Add provider hierarchy (person → household → system)
- Integrate LLM invocation into orchestration
- Log LLM invocations to `llm_invocations` table
- Implement health checking for providers (including Ollama connectivity)
- Add CLI commands for LLM management (`llm add`, `llm test`, `llm list`)
- Stream responses via WebSocket chunks
- **Add Ollama-specific CLI commands** (`llm add --provider ollama --model llama3`)

**Ollama Integration:**
```bash
# Prerequisites: Ollama installed and running locally
# Install: https://ollama.ai

# Add Ollama provider
family-assistant llm add --provider ollama --endpoint http://localhost:11434

# Pull model via Ollama
ollama pull llama3

# Configure household to use Ollama
family-assistant config set llm.household.default ollama:llama3

# Test Ollama connectivity
family-assistant llm test --provider ollama
```

**Deliverables**:
- Multi-provider LLM support (API + local)
- Anthropic, OpenAI, and Ollama providers
- Fallback chain working
- LLM usage tracking
- Health checks for all providers
- CLI for LLM configuration with Ollama support

---

### Phase 7: CLI Enhancement & Config Export

**Goals**: Complete CLI, config export/import, diagnostics, pairing management

**Tasks**:
- Enhance CLI with all configuration commands
- Implement interactive setup wizard
- **Add config export** (`family-assistant config export > config.yaml`)
- **Add config import** (`family-assistant config import config.yaml`)
- Add session replay command (`family-assistant sessions replay <id>`)
- **Implement `doctor` command** (health checks, auto-fix)
- **Implement `dev` command** (already in Phase 1, enhance with better logging)
- **Add pairing management commands** (already in Phase 2, enhance UX)
- Improve CLI help and documentation
- Add CLI tests

**Complete CLI Commands:**
```bash
# Setup
family-assistant init                    # Interactive setup wizard

# Development
family-assistant dev                     # Start with hot reload
family-assistant dev --verbose           # Debug logging
family-assistant dev --inspect           # Node debugger

# Diagnostics
family-assistant doctor                  # System health check
family-assistant doctor --fix            # Auto-fix common issues
family-assistant health                  # Integration health status
family-assistant health --provider anthropic
family-assistant health --integration google-calendar

# Household management
family-assistant household create <name>
family-assistant household list

# Person management
family-assistant person add --name "John" --email "john@example.com" --role member
family-assistant person add --name "Grandma" --role limited
family-assistant person list
family-assistant person show <person-id>

# Permission management (sharing integrations)
family-assistant permissions grant --person grandma --permission integrations.share.calendar.read
family-assistant permissions revoke --person grandma --permission integrations.share.calendar.read
family-assistant permissions list --person grandma
family-assistant permissions set-role --person john --role admin

# Identity management
family-assistant identity link --person <id> --phone "+1234567890"
family-assistant identity link --person <id> --telegram "@username"
family-assistant identity pair --code ABC123 --person john
family-assistant identity pair-request --channel telegram --identifier "@username"
family-assistant identity pending        # List pending pairing requests
family-assistant identity revoke --identity-id <id>
family-assistant identity list

# LLM providers
family-assistant llm add --provider anthropic --api-key "..."
family-assistant llm add --provider ollama --endpoint http://localhost:11434
family-assistant llm list
family-assistant llm test --provider anthropic

# Tools
family-assistant tools list
family-assistant tools info <tool-name>

# Sessions & debugging
family-assistant sessions list
family-assistant sessions show <session-id>
family-assistant sessions replay <session-id>
family-assistant sessions active         # Show active sessions
family-assistant sessions close <id>     # Close session manually
family-assistant sessions cleanup        # Remove old sessions
family-assistant sessions cleanup --days 30

# Configuration
family-assistant config export > config.yaml
family-assistant config import config.yaml
family-assistant config validate
family-assistant config set <key> <value>
family-assistant config get <key>
```

**Doctor Command Checks:**
- Database connectivity
- Required tables exist with correct schema
- LLM provider API keys valid (test connection)
- Integration credentials valid
- File permissions correct (~/.family-assistant/)
- Port availability (WebSocket port)
- Session file integrity
- Disk space availability

**Deliverables**:
- Complete CLI interface
- Config export/import (git-trackable)
- Session replay capability
- Interactive setup wizard
- Doctor command with health checks
- Enhanced dev mode
- Comprehensive CLI tests

---

### Phase 8: Testing and Refinement

**Goals**: Comprehensive tests with multiple profiles, performance optimization, security audit

**Testing Strategy:**

**Unit Tests** (`test:unit`):
- Pure functions (identity resolution, authorization logic)
- Tool schema validation
- Memory scope enforcement
- Pairing code generation and validation
- Resource limit enforcement
- No I/O dependencies (mocked)

**Integration Tests** (`test:integration`):
- Database operations (PostgreSQL)
- File system operations (JSONL logs)
- Tool execution with mocked integrations
- WebSocket connection handling
- Channel adapter lifecycle
- Session lifecycle management
- Configuration import/export

**End-to-End Tests** (`test:e2e`):
- Full request lifecycle (message → tool → LLM → response)
- Multi-step tool workflows
- Request cancellation
- Session management
- CLI command validation
- Pairing flow
- Graceful degradation scenarios

**Live Tests** (`test:live`) - Optional:
- Real LLM provider calls (Anthropic, OpenAI, Ollama)
- Real Google API integration tests
- Network-dependent features
- Run manually before releases (expensive, slow)

**Test Infrastructure:**
```json
{
  "scripts": {
    "test": "vitest",
    "test:unit": "vitest run src/**/*.test.ts",
    "test:integration": "vitest run tests/integration",
    "test:e2e": "vitest run tests/e2e",
    "test:live": "vitest run tests/live --no-parallel",
    "test:watch": "vitest watch",
    "test:coverage": "vitest run --coverage"
  }
}
```

**Coverage Requirements:**
- Core security functions (pairing, authorization): 100%
- Identity resolution: 100%
- Resource limit enforcement: 100%
- Tool execution: >90%
- Integration adapters: >80%
- CLI commands: >80%
- Overall: >85%

**Tasks**:
- Add unit tests for core flows (identity, authorization, tools, memory, pairing)
- Add tests for logging/traceability and authorization boundaries
- Add integration tests for request lifecycle
- Add tests for LLM provider selection and fallback (including Ollama)
- Add session replay tests (load JSONL, verify execution)
- Add CLI tests (all commands)
- Add cancellation tests (abort workflows mid-execution)
- Add resource limit tests (exceed limits, verify rejection)
- Add channel adapter tests
- Refine interfaces and improve modularity
- Performance optimization
- Security audit (secrets, permissions, SQL injection, pairing flow)
- Documentation (architecture, CLI usage, tool development, deployment)

**Deliverables**:
- Comprehensive test suite with multiple profiles
- >85% test coverage
- Performance benchmarks
- Security audit completed
- Complete documentation

---

### Phase 9: Optional REST APIs (Future UI Preparation)

**Goals**: Enable future UI without architectural changes

**Tasks**:
- Implement REST endpoints for configuration
- Implement REST endpoints for session queries
- Add authentication middleware
- Add API documentation (OpenAPI/Swagger)
- API tests

**Note**: This phase is optional for v1. Can be deferred until UI is actually needed.

**Deliverables**:
- Optional REST APIs
- API documentation
- Future UI can be built without core changes

---

## Future Considerations (Not Required for v1)

- **Admin UI** (web-based configuration and monitoring)
- Sub-agent architecture for autonomous multi-step workflows
- Execution hierarchy tracking for sub-agent delegation trees
- MCP client support for external tools/resources
- MCP server support to expose assistant capabilities externally
- Richer lifecycle hooks and middleware
- Approval workflows for sensitive actions
- More integrations and transport channels (Telegram, WhatsApp, SMS)
- Shared types that could support a future mobile frontend
- Advanced timeline and hierarchy visualizations (swimlane, tree views)
- Analytics dashboards with aggregated metrics
- ML-based analytics and insights
- OAuth/JWT authentication for Admin UI
- Advanced retry and circuit breaker patterns
- Multi-tenant support (multiple households with isolation)
- Voice input/output integration (requires speaker identification/voice profiles for unknown speakers)
- **Managed/workspace tool installation** (plugin marketplace)
- **Horizontal scaling** (session-based distribution across instances)

## Initial Deliverable

Produce a v1 architecture implementation that includes:
- core domain model
- service boundaries
- request lifecycle
- core abstractions (with explicit dependencies)
- minimal database schema
- PostgreSQL memory storage (durable, scoped)
- JSONL execution logging (ephemeral, append-only)
- logging and traceability approach
- **CLI for all configuration**
- **config export/import capability**
- **manifest-based tool registry**
- lifecycle event system
- implementation order

Then scaffold the repository for that v1 in a clean and incremental way.

## Key Decisions for Memory Storage

**Hybrid Approach (PostgreSQL + JSONL):**

1. **PostgreSQL for Durable Memory**:
   - Long-term memories that need querying
   - Scoped with foreign key constraints (household_id, person_id)
   - Full-text search capabilities (`to_tsvector`)
   - Relationships and joins
   - Retention policies via database

2. **JSONL for Ephemeral State**:
   - Session working memory (auto-cleanup)
   - Execution traces (append-only audit)
   - Tool invocation logs
   - Debug traces
   - No schema changes needed
   - Fast append, easy debugging (`tail -f`)

Benefits:
- Durable memory has proper querying and constraints
- Execution logs remain flexible and append-only
- Best tool for each job
- Single database + simple files (no complex infrastructure)

## Key Decisions for LLM Selection

1. **Provider Hierarchy**: LLM providers are selected based on cascading preferences:
   - Person preference
   - Household default
   - System default

2. **Fallback Chain**: Each level can specify multiple providers in order of preference. The system tries each provider until one succeeds or all fail.

3. **Provider Types**:
   - **API Providers**: Anthropic (Claude), OpenAI (GPT)
   - **Local Providers**: Ollama (privacy, offline, cost-free)

4. **Usage Tracking**: All LLM invocations are logged with:
   - Provider used (including model name for Ollama)
   - Token counts (input/output)
   - Timestamp and duration
   - Success/failure status
   - Associated person

5. **Provider Health**: Basic health checking for configured providers with status tracking (available/unavailable).

6. **Ollama Integration Benefits**:
   - **Privacy**: Data never leaves your device
   - **Cost**: No API fees
   - **Offline**: Works without internet
   - **Control**: Choose specific models (Llama 3, Mistral, etc.)
   - **Performance**: Fast on local hardware with GPU support

## Ollama Integration Guide

**What is Ollama?**
Ollama is a local LLM runtime that enables running large language models on your own hardware. It provides a simple API compatible with OpenAI's format, making integration straightforward.

**Benefits for Family Assistant:**
- **Privacy**: All data stays on your device (critical for household data)
- **Cost**: No API fees (unlimited usage)
- **Offline**: Works without internet connectivity
- **Control**: Choose specific models and versions
- **Performance**: Fast inference with GPU acceleration
- **No Rate Limits**: Limited only by local hardware

**Supported Models (via Ollama):**
- Llama 3 / Llama 3.1 (8B, 70B variants)
- Mistral / Mixtral
- Gemma
- Phi-3
- And 100+ other models from Ollama library

**Prerequisites:**
```bash
# Install Ollama: https://ollama.ai
# macOS
brew install ollama

# Start Ollama service
ollama serve

# Pull a model
ollama pull llama3
ollama pull mistral
```

**Configuration in Family Assistant:**
```bash
# Add Ollama as a provider
family-assistant llm add --provider ollama \
  --endpoint http://localhost:11434 \
  --model llama3

# Set as household default (all family members use it)
family-assistant config set llm.household.default ollama:llama3

# Set as system fallback (used when primary fails)
family-assistant config set llm.system.fallback ollama:mistral

# Test connectivity
family-assistant llm test --provider ollama

# Check available models
family-assistant llm list --provider ollama
```

**Fallback Strategy Example:**
```yaml
# Person preference: Anthropic Claude (high quality, costs money)
# Household default: OpenAI GPT-4 (good quality, some cost)
# System fallback: Ollama Llama3 (free, private, always available)

# Behavior:
# 1. Try Claude (person preference)
# 2. If Claude unavailable, try GPT-4 (household default)
# 3. If GPT-4 unavailable, use Llama3 (system fallback)
# 4. System always has a working LLM (Ollama)
```

**Hardware Recommendations:**
- **Minimum**: 8GB RAM, 4-core CPU (small models like Phi-3)
- **Recommended**: 16GB RAM, 8-core CPU (Llama 3 8B)
- **Optimal**: 32GB+ RAM, GPU with 8GB+ VRAM (larger models, faster inference)

**Provider Implementation:**
```typescript
class OllamaProvider implements LLMProvider {
  name = 'ollama';
  type = 'local';

  constructor(
    private endpoint: string,  // http://localhost:11434
    private model: string       // llama3, mistral, etc.
  ) {}

  async healthCheck(): Promise<ProviderHealth> {
    // Check Ollama service is running
    // Check model is available
  }

  async invoke(prompt: string, options: LLMOptions): Promise<LLMResponse> {
    // POST to /api/generate
  }

  async *stream(prompt: string, options: LLMOptions): AsyncIterable<LLMChunk> {
    // POST to /api/generate with stream=true
    // Yield chunks as they arrive
  }
}
```

---

## Key Decisions for Tool Architecture

1. **Plugin-Based Model**:
   - **Bundled**: Core tools shipped with system
   - **Managed**: Installed via CLI (future)
   - **Workspace**: User-defined custom tools (future)

2. **Manifest-Based Registry**:
   ```yaml
   # tools/manifest.yaml
   bundled:
     - name: calendar.read
       path: ./bundled/calendar-read.ts
       permissions: []  # No permissions needed - uses requester's connected account
     - name: calendar.create
       path: ./bundled/calendar-create.ts
       permissions: []  # No permissions needed - uses requester's connected account
   ```

3. **Tools Execute in Context**:
   - Calendar tools use the requesting person's connected Google account (or shared access if granted)
   - Home Assistant tools use the requesting person's connected HA account (or shared access)
   - System tools run in system context with permission checks
   - Clear execution boundaries and permission enforcement

4. **Async Tool Results**:
   - Support streaming for long-running operations
   - Enable real-time progress updates
   - Clean cancellation support

## Key Decisions for Channel Architecture

1. **Channel Abstraction**:
   - All channels implement `ChannelAdapter` interface
   - Unified message handling regardless of transport
   - Easy to add new channels without core changes

2. **v1 Implementation**:
   - WebSocket channel (primary interface)
   - Architecture ready for Telegram, WhatsApp, SMS

3. **Channel Security**:
   - Unknown identities blocked by default
   - Pairing flow required for new identities
   - Each channel can have multiple identities

4. **Message Flow**:
   - Channel → Identity Resolution → Pairing Check → Authorization → Orchestration
   - Response routing via same channel

---

## Key Decisions for Security & Pairing

1. **Security Default**: Deny unknown identities
   - Prevents unauthorized access
   - Requires explicit pairing approval

2. **Pairing Mechanism**:
   - 6-digit codes (easy to type, sufficient entropy)
   - 15-minute expiry (security vs usability balance)
   - CLI-based approval (requires physical access)

3. **Pairing Flow**:
   - System generates code
   - User receives code via channel
   - User runs CLI command to approve
   - Identity linked permanently

4. **Revocation**:
   - Identities can be revoked at any time
   - Revoked identities return to unknown state

---

## Key Decisions for Resource Management

1. **Resource Limits**:
   - Request size: 10MB default (prevents memory exhaustion)
   - Concurrent requests: 3 per person (prevents overload)
   - Execution timeout: 5 minutes (prevents runaway operations)
   - Rate limiting: 30 requests/minute per person

2. **Enforcement Points**:
   - Request size: API gateway
   - Concurrency: Orchestrator
   - Timeout: Per-request timer
   - Rate limiting: Per-person counter

3. **User Communication**:
   - Clear error messages when limits exceeded
   - Suggestions for resolution (e.g., "Request too large, try smaller input")

---

## Key Decisions for Configuration

1. **CLI-First Approach**:
   - All configuration via CLI in v1
   - No UI dependency
   - Git-trackable via export
   - Faster to ship

2. **Layered Configuration**:
   - System (env vars, config files)
   - Household (database + exportable files)
   - Session (runtime, ephemeral)

3. **Export/Import**:
   - Version control configuration
   - Easy backup/restore
   - Reproducible deployments

4. **Optional UI Later**:
   - Can add UI without architectural changes
   - Build when usage patterns are clear
   - Not a v1 blocker

---

## Key Decisions for Development Experience

1. **Hot Reload**:
   - File watcher monitors source and config changes
   - Fast iteration during development
   - No manual restart needed

2. **Diagnostics**:
   - `doctor` command for health checks
   - Auto-fix for common issues
   - Clear error messages

3. **Debugging**:
   - Session files viewable with `tail -f`
   - Session replay for bug reproduction
   - Structured logs for tracing

4. **Testing**:
   - Multiple test profiles (unit, integration, e2e, live)
   - Fast feedback loop
   - Clear separation of test types

---

## Key Decisions for Self-Configuration Security

**Philosophy**: Enable helpful self-service while preventing privilege escalation, credential leaks, and unauthorized access.

1. **Four-Tier Security Model**:
   - **Tier 1 (Read-Only)**: Safe, always allowed, cannot modify state
   - **Tier 2 (Self-Scoped)**: Person can configure themselves only
   - **Tier 3 (Approval-Required)**: Sensitive operations need explicit confirmation
   - **Tier 4 (Admin-Only)**: Critical operations are CLI-only

2. **Security Boundaries**:
   - Self-scoped tools validate `requestingPerson === targetPerson`
   - Tier 4 tools never exposed to LLM
   - Credentials redacted in all logs and traces
   - Approval requests timeout after 60 seconds
   - Cross-person configuration blocked

3. **Approval Workflow**:
   - Clear explanation of operation and risks
   - User must type 'APPROVE' (exact match)
   - 60-second timeout for approval
   - All approvals and rejections audited
   - Rate limiting prevents approval spam

4. **Credential Handling**:
   - Annotate sensitive fields with `@secret`
   - Redact in logs: `apiKey: '[REDACTED]'`
   - Encrypt at rest
   - Never include in execution traces
   - Never pass to LLM context

5. **Tool Exposure**:
   - Tools marked `exposedToLLM: false` are hidden
   - Admin operations require CLI access
   - Prevents LLM from discovering admin tools

6. **Examples**:
   - ✅ **Allowed**: "Switch to verbose mode" (Tier 2, self-scoped)
   - ✅ **Allowed with Approval**: "Add my API key" (Tier 3, requires APPROVE)
   - ❌ **Blocked**: "Make me an admin" (Tier 4, CLI-only)
   - ❌ **Blocked**: "Change Jane's settings" (cross-person)

## Success Criteria

v1 is successful if:
- Multiple persons in a household can interact with the assistant
- Each person is connected to their own service instances (Google, etc.)
- **Three-tier role model works** (admin, member, limited)
- **Granular permissions can be granted and revoked** via CLI
- **Integration sharing permissions work** (e.g., dad can grant kids read access to his calendar integration)
- **Limited role members can be given specific permissions** (e.g., grandma can be granted access to dad's calendar but not household memory)
- **Admin role has all permissions automatically**
- **Member role has standard household permissions**
- **Unknown identities are blocked until paired** (security default)
- **Pairing flow works** (6-digit codes, CLI approval)
- Identity is correctly resolved and authorization is enforced
- **Permission checks happen before all tool executions**
- **Resource limits prevent abuse** (request size, concurrency, rate limiting)
- **Requests can be cancelled** (long operations interruptible)
- Tools execute only with proper permissions
- **Tools respect cancellation** (AbortSignal propagation)
- LLM provider selection works with proper fallback chain
- **Ollama integration works** (local LLM option available)
- LLM usage is tracked (provider, tokens, invocations) for all calls
- **Integration health tracking works** (detect failures, degrade gracefully)
- **System continues with available integrations** (graceful degradation)
- **Per-person integration credentials work** (each person connects their own accounts)
- **Device control delegated to home automation platforms** (Home Assistant permissions respected)
- **Self-configuration works safely via conversation** (four-tier security model)
- **Users can configure themselves via conversation** (self-scoped tools)
- **Sensitive operations require approval** (llm.add, integration.connect)
- **Cross-person configuration is blocked** (cannot configure others)
- **Credentials are never logged** (redacted to [REDACTED])
- **Approval workflow works** (60-second timeout, requires 'APPROVE')
- **Admin operations remain CLI-only** (physical security)
- **All configuration manageable via CLI**
- **Configuration can be exported/imported** (git-trackable)
- **Execution history viewable via CLI** (`family-assistant sessions show`)
- **Session cleanup works** (old sessions removed, disk managed)
- **Doctor command works** (health checks, diagnostics)
- **Dev mode works** (hot reload, fast iteration)
- Memory boundaries are never violated (PostgreSQL enforces scope)
- All requests are fully traceable through JSONL logs
- Secrets and credentials are stored securely
- Failed tool executions are handled gracefully with appropriate error messages
- The architecture is modular and can evolve (plugins, lifecycle hooks)
- **Channel abstraction supports future channels** (Telegram, WhatsApp ready)
- **Lifecycle events enable plugins without core modifications**
- Tests validate core security and traceability requirements
- System remains responsive under normal household usage patterns
- **No UI required for full functionality**
