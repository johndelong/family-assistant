# Tool System Architecture

## Overview

The Family Assistant platform uses a **single runtime tool model** in v1.

This is intentional. We want one execution path, one authorization story, and one registry. Complexity should come from adding tools, not from adding new categories of tool machinery.

## Core Principles

- One runtime concept: `Tool`
- One registry for all executable capabilities
- Core policy and dynamic capabilities are separate concerns
- Integration-backed tools use the same execution path as local tools
- Skills are higher-level orchestrations built on tools, not a separate tool type

## Tool Interface

```typescript
interface Tool<TInput, TOutput> {
  id: string;
  description: string;
  inputSchema: ZodSchema<TInput>;
  requiredCapabilities?: string[];
  exposure: 'conversation' | 'cli_only';
  approvalPolicy: 'never' | 'confirm' | 'admin_only';
  targetScope: 'self' | 'household' | 'owner_shared' | 'system';
  execute(input: TInput, context: RequestContext): Promise<TOutput>;
}
```

### Metadata Meaning

- `requiredCapabilities`: Dynamic grants required to execute the tool
- `exposure`: Whether the tool can be invoked through conversation
- `approvalPolicy`: Whether the tool requires confirmation or admin-only execution
- `targetScope`: Which subject the tool is allowed to act on

## Tool Categories

### 1. Core Tools

Trusted in-process tools with direct access to platform services.

Examples:
- `system.health`
- `config.get`
- `memory.search`
- `memory.store`
- `session.configure`

### 2. Integration-Backed Tools

Tools that delegate to an integration driver while preserving the same registry and execution flow.

Examples:
- `calendar.read`
- `calendar.write`
- `homeassistant.control`

These are still just tools. They do not get a different runtime contract.

## Tool Registry

```typescript
interface ToolRegistry {
  list(): ToolDefinition[];
  get(toolId: string): ToolDefinition | undefined;
  register(tool: ToolDefinition): void;
}
```

The registry should support loading:
- bundled core tools
- integration-backed tool definitions
- future packaged tools if needed

v1 does not need separate manifest, plugin, and workspace runtime semantics.

## Authorization Model

Tool execution checks two things:

### 1. Core Policy

Fixed platform permissions for platform actions.

Examples:
- `system.configure`
- `person.manage`
- `identity.manage`
- `config.self`

### 2. Dynamic Capabilities

Tool-specific execution grants.

Examples:
- `memory.search`
- `calendar.read`
- `calendar.write`

### Why Both Exist

- Core policy controls the platform
- Capabilities control executable actions
- New tools can be added without bloating the core permission enum

## Capability Storage

```sql
CREATE TABLE tool_capabilities (
  capability_name VARCHAR(200) PRIMARY KEY,
  tool_id VARCHAR(200) NOT NULL,
  description TEXT NOT NULL,
  target_scope VARCHAR(50) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE capability_grants (
  person_id UUID NOT NULL REFERENCES persons(id),
  capability_name VARCHAR(200) NOT NULL REFERENCES tool_capabilities(capability_name),
  granted_by UUID REFERENCES persons(id),
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  PRIMARY KEY (person_id, capability_name)
);

CREATE TABLE shared_capability_grants (
  owner_id UUID NOT NULL REFERENCES persons(id),
  grantee_id UUID NOT NULL REFERENCES persons(id),
  capability_name VARCHAR(200) NOT NULL REFERENCES tool_capabilities(capability_name),
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  PRIMARY KEY (owner_id, grantee_id, capability_name)
);
```

## Integration Drivers

Integrations are exposed through drivers, not by inventing a second tool architecture.

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

### Connection Storage

```sql
CREATE TABLE integration_connections (
  id UUID PRIMARY KEY,
  person_id UUID NOT NULL REFERENCES persons(id),
  integration_key VARCHAR(100) NOT NULL,
  driver_type VARCHAR(20) NOT NULL,
  encrypted_credentials JSONB NOT NULL,
  status VARCHAR(20) NOT NULL,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(person_id, integration_key)
);
```

## Execution Flow

```text
resolve tool
  -> validate input
  -> check exposure rules
  -> check core policy if applicable
  -> check dynamic capabilities
  -> validate target scope
  -> request approval if needed
  -> execute
  -> trace result
```

## Sharing Model

Sharing happens through owner-scoped grants.

Example:
1. Dad connects Google Calendar
2. System registers `calendar.read` and `calendar.write`
3. Dad grants `calendar.read` to son
4. Son invokes `calendar.read` with `ownerId=dad`
5. Runtime checks shared grant and executes using dad's connected account

The important detail is that sharing is explicit and tied to the owner of the underlying resource.

## MCP in the Roadmap

MCP can fit cleanly as a future `IntegrationDriver` implementation:
- `driverType: 'mcp'`
- person-scoped connections
- tools exposed through the same registry

That gives us room to adopt MCP later without making v1 depend on long-lived per-person server orchestration.

## v1 Boundaries

v1 includes:
- one tool runtime
- one registry
- core tools
- integration-backed tools

v1 defers:
- installable plugin marketplaces
- multiple tool packaging systems
- per-person persistent MCP fleets
- skills as executable runtime code
