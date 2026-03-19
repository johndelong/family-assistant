# Architecture

## System Overview

The Family Assistant Platform is a modular TypeScript household assistant for multiple people sharing one environment. The system identifies who is interacting, enforces authorization in application code, coordinates tools and integrations, and responds using one or more LLM providers.

**Core Philosophy:**
- **Lean Core + Clear Boundaries**: A small orchestrator with explicit module seams
- **CLI-First**: The CLI is the primary control surface in v1
- **Database as Source of Truth**: PostgreSQL stores authoritative configuration and state
- **Explicit over Hidden**: Deterministic policy and tool execution over framework magic
- **Local-First**: File exports and JSONL traces support debugging and portability without becoming a second config authority

**Deployment Model (v1):** One Node.js process with modular internal services. We keep deployment simple while preserving interfaces that can be extracted later if needed.

## System Components

### 1. Gateway
Transport entry point:
- Receives inbound messages over WebSocket
- Receives inbound messages over supported chat channels such as Telegram
- Streams partial responses and status events
- Creates request lifecycle envelopes
- Manages session identifiers and cancellation wiring

**v1 Channel Guidance:**
- **Primary**: WebSocket
- **Acceptable v1 addition**: Telegram bot
- **Future**: Additional messaging channels once the identity and auth path is proven

### 2. Identity and Authorization
Security boundary:
- Resolves channel identities to `Person`
- Blocks unknown identities by default
- Enforces fixed core policies before privileged actions
- Enforces share grants and self-scope boundaries
- Owns approval workflows for sensitive operations

### 3. Orchestrator
Coordination layer:
- Assembles request context
- Chooses execution path (direct reply, tool, tool + LLM)
- Executes tools with cancellation and limits
- Invokes LLM providers with fallback
- Emits lifecycle events and writes traces

### 4. Memory
Hybrid persistence:
- PostgreSQL for durable memory and relational state
- JSONL for append-only execution traces and replay/debug data
- Scope-aware retrieval for private and shared memory

### 5. Integration Layer
External system access:
- Manages per-person integration connections
- Normalizes external providers behind one interface
- Exposes integration-backed tools through the shared tool registry
- Defers transport details such as native SDK, REST, or future MCP drivers

### 6. CLI and Admin Surface
Primary v1 interface:
- Creates households and people
- Manages identities, grants, providers, and integrations
- Exports/imports database-backed configuration snapshots
- Runs diagnostics and health checks

## Request Flow

```text
Inbound Message (WebSocket)
    ↓
[GATEWAY] create request + session context
    ↓
[IDENTITY/AUTH] resolve speaker + enforce policy
    ↓
[ORCHESTRATOR] assemble context + choose path
    ↓
[TOOLS / INTEGRATIONS / LLM] execute as needed
    ↓
[MEMORY] persist trace + update durable state
    ↓
[GATEWAY] stream response and completion
```

**Key Characteristics:**
- Identity resolution happens before any LLM call
- Authorization is enforced in code, not delegated to the model
- Tools are transport-agnostic
- Durable state lives in PostgreSQL
- JSONL is for traces, replay, and debugging only

## Channel Architecture

Channels are transports, not trust models.

```typescript
interface ChannelAdapter {
  type: 'websocket' | 'telegram';
  start(): Promise<void>;
  stop(): Promise<void>;
  sendMessage(recipient: ChannelRecipient, message: OutboundMessage): Promise<void>;
  normalizeInboundMessage(raw: unknown): Promise<InboundMessage>;
}
```

### Telegram in v1

Telegram is a good fit for v1 because it makes the assistant practically useful outside the home without changing the core architecture.

The Telegram adapter should provide:
- inbound/outbound message transport
- Telegram sender metadata such as numeric user ID and chat ID
- optional allowlist or pairing gates at the channel boundary

The Telegram adapter should **not** decide:
- which household member a sender ultimately maps to
- what tools they can use
- which integration account should be used

That logic belongs in the Identity and Authorization layer.

### OpenClaw as a Reference

OpenClaw treats Telegram as a channel with direct-message policies, allowlists, and pairing flows. Its docs describe `channels.telegram.dmPolicy`, `channels.telegram.allowFrom`, and pairing-based access approval as transport-level controls. That is a useful reference pattern for safely exposing a remote chat interface.

For this project, we should take the good part of that idea:
- Telegram can help establish a trusted inbound identity
- pairing or allowlisting can reduce exposure

But we should stop short of making Telegram config the real permissions model. A Telegram identity should resolve to a household `Person`, and all downstream authorization should use the platform's core policy and capability checks.

## Data Model

```text
Household
  ├─ Persons
  │   ├─ ChannelIdentities
  │   ├─ CorePolicyGrants
  │   ├─ CapabilityGrants
  │   ├─ IntegrationConnections
  │   └─ MemoryEntries (private)
  └─ MemoryEntries (shared)

RequestSession
  ├─ Request traces (JSONL)
  └─ Ephemeral runtime state
```

### Primary Entities

```typescript
interface Person {
  id: string;
  householdId: string;
  name: string;
  role: 'admin' | 'member' | 'limited';
  createdAt: Date;
}

interface IntegrationConnection {
  id: string;
  personId: string;
  integrationKey: string;
  driverType: 'native' | 'rest' | 'mcp';
  status: 'connected' | 'degraded' | 'disconnected';
  encryptedCredentials: EncryptedSecret;
  metadata?: Record<string, unknown>;
}
```

## Authorization Model

The platform uses a **two-layer authorization model**.

### Layer 1: Core Policies

Fixed, code-defined permissions for platform actions:
- `system.configure`
- `household.manage`
- `person.manage`
- `identity.manage`
- `config.self`
- `approval.respond`

These permissions govern administrative and platform behavior. They are intentionally stable and are not discovered dynamically.

### Layer 2: Tool Capabilities

Dynamic capabilities for executable tools and integration-backed actions:
- `memory.search`
- `calendar.read`
- `calendar.write`
- `homeassistant.control`

These capabilities are attached to tools and can be granted directly or shared from an owner to another household member.

### Why Split the Model

- Core platform actions stay explicit and auditable
- New tools do not require expanding a giant hard-coded permission enum
- Sharing access to integrations becomes straightforward
- Future integration drivers fit the same runtime contract

## Tool Architecture

v1 has **one runtime concept**: `Tool`.

```typescript
interface Tool<TInput, TOutput> {
  id: string;
  description: string;
  inputSchema: ZodSchema<TInput>;
  requiredCapabilities?: string[];
  approvalPolicy: 'never' | 'confirm' | 'admin_only';
  exposure: 'conversation' | 'cli_only';
  targetScope: 'self' | 'household' | 'owner_shared' | 'system';
  execute(input: TInput, context: RequestContext): Promise<TOutput>;
}
```

**Tool Sources in v1:**
- **Core tools**: In-process trusted tools for memory, session, health, config read
- **Integration-backed tools**: Tools implemented against the integration layer

This avoids separate runtime categories for plugins, manifests, and skills during v1.

## Integration Architecture

External systems are modeled as **integration drivers** behind a shared connection model.

```typescript
interface IntegrationDriver {
  key: string;
  driverType: 'native' | 'rest' | 'mcp';
  connect(personId: string, input: unknown): Promise<IntegrationConnection>;
  disconnect(connectionId: string): Promise<void>;
  listTools(connection: IntegrationConnection): Promise<Tool[]>;
  healthCheck(connection: IntegrationConnection): Promise<HealthStatus>;
}
```

**v1 Guidance:**
- Prefer native SDK or REST-backed drivers first
- Start with one or two integrations that prove the pattern
- Support `mcp` later as another driver type, not as the central architecture

## LLM Provider System

Supports multiple providers with fallback chains:
- Anthropic
- OpenAI
- Ollama

**Preference order:**
1. Person preference
2. Household default
3. System fallback

LLM providers are configuration-backed services, not tools.

## Storage Strategy

### PostgreSQL
Authoritative store for:
- Households
- Persons
- Identities
- Core grants
- Capability grants
- Integration connections
- Durable memory
- Provider configuration

### JSONL
Operational traces for:
- Request execution logs
- Tool invocation traces
- Session replay/debugging

JSONL is not treated as a second configuration authority.

## Observability and Logging

**Structured Logs:**
- Application events, errors, health checks

**JSONL Traces:**
- Request lifecycle
- Tool execution
- Approval events
- LLM invocation metadata

**Security Constraints:**
- Secrets are redacted before serialization
- Raw credentials never enter LLM context
- Secret submission should bypass normal conversational transcript logging

## Extensibility

The system is designed to expand by adding:
- New core tools
- New integration drivers
- New LLM providers
- New channels such as Telegram, then others
- Saved skill definitions

Not by introducing multiple overlapping runtime models.

## Deferred from v1

These are valid future directions, but not required for the first solid version:
- Long-lived per-person MCP server lifecycle management
- Installable plugin marketplaces
- Multiple writable configuration backends
- Autonomous workflow engines
- REST APIs for a UI

## Architectural Boundaries

**Hard Rules:**
- Identity before LLM
- Policy before execution
- One source of truth for configuration
- One runtime tool model
- Integration credentials stay person-scoped
- Shared access uses explicit grants
- Secrets never appear in model context

These boundaries are what keep the platform expandable without forcing a major refactor later.
