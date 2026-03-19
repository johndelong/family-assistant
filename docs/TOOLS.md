# Tool System Architecture

## Overview

The Family Assistant platform uses a **three-tier tool architecture** that balances flexibility with security. Tools are capabilities that the assistant can execute on behalf of users, ranging from simple read operations to complex integrations with external services.

**Core Philosophy:**
- **MCP-first approach**: Model Context Protocol (MCP) is the primary integration method for community-contributed tools
- **Universal capability discovery**: All tool sources expose capabilities via a unified ToolSource interface
- **Dynamic schema-driven permissions**: Permission checks based on discovered capabilities, not hard-coded rules
- **Simplified terminology**: Use "tools" consistently throughout the system (following OpenClaw's example)

---

## Three-Tier Tool Architecture

The platform supports three distinct tiers of tools, each serving different use cases:

### 1. Bundled Tools

**Purpose**: Core platform capabilities shipped with the system

**Characteristics:**
- Built directly into the platform codebase
- Tightly integrated with core services (Memory, Identity, etc.)
- Always available, no installation required
- Examples: memory search, session management, system health checks

**When to use:**
- Platform-essential functionality
- Features requiring deep integration with core services
- Operations that need guaranteed availability

**Implementation:**
```typescript
interface BundledToolSource extends ToolSource {
  type: 'bundled';
  tools: Tool[];
}

// Example bundled tool
const memorySearchTool: Tool = {
  name: 'memory.search',
  description: 'Search household and personal memories',
  inputSchema: z.object({
    query: z.string(),
    scope: z.enum(['private', 'shared']),
  }),
  capabilities: ['memory:read'],
  execute: async (input, context) => {
    // Direct access to Memory Service
    return context.deps.memoryService.search(
      context.person,
      input.query,
      input.scope
    );
  },
};
```

**Typical bundled tools (5-10 core tools):**
- `memory.search` - Search personal/shared memories
- `memory.store` - Store memories with scope
- `session.configure` - Configure current session
- `system.health` - Check system health
- `config.get` - Read configuration values

### 2. Adapter-Based Tools

**Purpose**: Special cases requiring bidirectional communication or complex state management

**Characteristics:**
- Custom code written for specific integrations
- Bidirectional communication (tool can push updates to assistant)
- Complex lifecycle management
- Direct access to credentials and state
- Examples: streaming sensors, real-time device control, complex OAuth flows

**When to use:**
- Integration requires bidirectional communication
- Tool needs to push updates/events to the assistant
- Complex state machines or lifecycle management
- MCP protocol cannot express the integration pattern

**Implementation:**
```typescript
interface AdapterToolSource extends ToolSource {
  type: 'adapter';
  adapterName: string;
  lifecycle: {
    start(): Promise<void>;
    stop(): Promise<void>;
    healthCheck(): Promise<HealthStatus>;
  };
}

// Example: Home Assistant adapter with bidirectional communication
class HomeAssistantAdapter implements AdapterToolSource {
  type = 'adapter' as const;
  adapterName = 'home-assistant';

  private eventStream?: WebSocket;

  async start() {
    // Connect to Home Assistant event stream
    this.eventStream = await this.connectEventStream();

    // Listen for device state changes
    this.eventStream.on('state_changed', (event) => {
      // Push update to assistant
      this.notifyStateChange(event);
    });
  }

  async discoverCapabilities(): Promise<ToolCapability[]> {
    // Dynamically discover capabilities from HA API
    const devices = await this.fetchDevices();

    return devices.map(device => ({
      name: `homeassistant.control.${device.entity_id}`,
      description: `Control ${device.friendly_name}`,
      inputSchema: device.schema,
      requiredPermissions: [`homeassistant:device:${device.entity_id}`],
    }));
  }
}
```

**Decision Matrix: Adapter vs MCP**

| Factor | Use Adapter | Use MCP |
|--------|-------------|---------|
| Communication pattern | Bidirectional | Request/response |
| State management | Complex lifecycle | Stateless |
| Event handling | Push events to assistant | Pull-based only |
| Development effort | High (custom code) | Low (standard protocol) |
| Use cases | Real-time sensors, WebSockets | APIs, CLIs, file access |

### 3. MCP-Based Tools (Default)

**Purpose**: Community integrations and standard tool patterns

**Characteristics:**
- **Primary integration method** for external tools
- Standard Model Context Protocol interface
- Process or container isolation
- Per-person credential management
- Examples: Google Calendar (via MCP), GitHub (via MCP), file system access

**When to use:**
- **Default choice for new integrations**
- Standard request/response pattern
- Integration available as MCP server
- No bidirectional communication required
- Community-maintained tools

**Why MCP as default:**
- Standard protocol across AI platforms
- Large ecosystem of existing servers
- Strong isolation model (security)
- Simple installation and configuration
- Community can contribute without platform knowledge

**Implementation:**
```typescript
interface MCPToolSource extends ToolSource {
  type: 'mcp';
  serverName: string;
  serverConfig: MCPServerConfig;
  isolation: 'process' | 'container';
}

// MCP tools discovered dynamically at runtime
interface MCPServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
  personId: string; // Each person has their own MCP server instance
}

// Example MCP tool (discovered from server)
const mcpCalendarTool: Tool = {
  name: 'mcp.google-calendar.list-events',
  description: 'List Google Calendar events',
  inputSchema: z.object({
    startDate: z.string(),
    endDate: z.string(),
  }),
  capabilities: ['google-calendar:read'],
  source: 'mcp:google-calendar',
  execute: async (input, context) => {
    // Route to person's MCP server instance
    return context.deps.mcpRunner.executeTools(
      context.person,
      'google-calendar',
      'list-events',
      input
    );
  },
};
```

---

## Capability Discovery Protocol

All tool sources (bundled, adapter, MCP) expose capabilities via the **ToolSource interface**. This enables dynamic permission management without hard-coded rules.

### ToolSource Interface

```typescript
interface ToolSource {
  type: 'bundled' | 'adapter' | 'mcp';
  name: string;

  // Capability discovery
  discoverCapabilities(): Promise<ToolCapability[]>;

  // Tool execution
  executeTool(
    toolName: string,
    input: any,
    context: RequestContext
  ): Promise<ToolResult>;

  // Health monitoring
  healthCheck(): Promise<HealthStatus>;
}

interface ToolCapability {
  name: string;                    // Unique capability identifier
  description: string;             // Human-readable description
  inputSchema: ZodSchema;          // Validation schema
  requiredPermissions: string[];   // Permission identifiers
  metadata?: {
    category?: string;             // Grouping (e.g., 'calendar', 'contacts')
    tags?: string[];               // Searchable tags
    isDestructive?: boolean;       // Requires extra confirmation
    estimatedDuration?: number;    // Expected execution time (ms)
  };
}
```

### Discovery Flow

```typescript
// 1. Platform discovers capabilities from all tool sources
async function discoverAllCapabilities(): Promise<ToolCapability[]> {
  const sources = [
    ...bundledToolSources,
    ...adapterToolSources,
    ...mcpToolSources,
  ];

  const capabilities = await Promise.all(
    sources.map(source => source.discoverCapabilities())
  );

  return capabilities.flat();
}

// 2. Capabilities stored in database
interface ToolCapabilityRecord {
  id: string;
  source_type: 'bundled' | 'adapter' | 'mcp';
  source_name: string;
  capability_name: string;
  description: string;
  input_schema: object;
  required_permissions: string[];
  metadata: object;
  discovered_at: Date;
  last_verified: Date;
}

// 3. Capabilities refreshed periodically
async function refreshCapabilities(): Promise<void> {
  const capabilities = await discoverAllCapabilities();

  await db.transaction(async (tx) => {
    // Mark all existing as stale
    await tx.update(toolCapabilities)
      .set({ stale: true });

    // Upsert discovered capabilities
    for (const cap of capabilities) {
      await tx.insert(toolCapabilities)
        .values({
          ...cap,
          stale: false,
          last_verified: new Date(),
        })
        .onConflictDoUpdate({
          target: [toolCapabilities.capability_name],
          set: {
            description: cap.description,
            input_schema: cap.inputSchema,
            required_permissions: cap.requiredPermissions,
            stale: false,
            last_verified: new Date(),
          },
        });
    }

    // Remove capabilities that are no longer discovered
    await tx.delete(toolCapabilities)
      .where(eq(toolCapabilities.stale, true));
  });
}
```

### Capability Metadata

Capabilities include rich metadata for dynamic UI generation and permission management:

```typescript
// Example: Calendar tool capability
{
  name: 'google-calendar.list-events',
  description: 'List events from Google Calendar',
  inputSchema: z.object({
    startDate: z.string().datetime(),
    endDate: z.string().datetime(),
    calendarId: z.string().optional(),
  }),
  requiredPermissions: ['google-calendar:read'],
  metadata: {
    category: 'calendar',
    tags: ['google', 'calendar', 'events', 'schedule'],
    estimatedDuration: 1000, // ~1 second
    isDestructive: false,
  }
}

// Example: Destructive tool capability
{
  name: 'google-calendar.delete-event',
  description: 'Delete a calendar event',
  inputSchema: z.object({
    eventId: z.string(),
  }),
  requiredPermissions: ['google-calendar:write'],
  metadata: {
    category: 'calendar',
    tags: ['google', 'calendar', 'delete'],
    isDestructive: true, // Requires extra confirmation
  }
}
```

---

## Dynamic Permission Model

Permissions are **based on discovered capabilities**, not hard-coded in the platform.

### Database Schema

```sql
-- Discovered capabilities from all tool sources
CREATE TABLE tool_capabilities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type VARCHAR(20) NOT NULL, -- 'bundled' | 'adapter' | 'mcp'
  source_name VARCHAR(100) NOT NULL,
  capability_name VARCHAR(200) NOT NULL UNIQUE,
  description TEXT NOT NULL,
  input_schema JSONB NOT NULL,
  required_permissions TEXT[] NOT NULL,
  metadata JSONB,
  discovered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_verified TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  stale BOOLEAN DEFAULT FALSE,

  INDEX idx_capabilities_source (source_type, source_name),
  INDEX idx_capabilities_perms (required_permissions)
);

-- Per-person capability grants
CREATE TABLE capability_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  capability_name VARCHAR(200) NOT NULL REFERENCES tool_capabilities(capability_name),
  granted_by UUID REFERENCES persons(id), -- Who granted this capability
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ, -- Optional expiration
  metadata JSONB, -- Grant-specific metadata (e.g., restrictions)

  UNIQUE(person_id, capability_name),
  INDEX idx_grants_person (person_id)
);

-- Shared capability grants (e.g., dad shares calendar access with kids)
CREATE TABLE shared_capability_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  grantee_id UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  capability_name VARCHAR(200) NOT NULL REFERENCES tool_capabilities(capability_name),
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,

  UNIQUE(owner_id, grantee_id, capability_name),
  INDEX idx_shared_grants_owner (owner_id),
  INDEX idx_shared_grants_grantee (grantee_id)
);
```

### Permission Checking

```typescript
async function checkCapabilityPermission(
  person: Person,
  capabilityName: string,
  ownerId?: string // For shared capabilities
): Promise<boolean> {
  // Admins have all capabilities
  if (person.role === 'admin') {
    return true;
  }

  // Check if person has direct capability grant
  const directGrant = await db.query.capability_grants.findFirst({
    where: and(
      eq(capability_grants.person_id, person.id),
      eq(capability_grants.capability_name, capabilityName),
      or(
        isNull(capability_grants.expires_at),
        gt(capability_grants.expires_at, new Date())
      )
    ),
  });

  if (directGrant) {
    return true;
  }

  // If accessing shared capability, check shared grant
  if (ownerId && ownerId !== person.id) {
    const sharedGrant = await db.query.shared_capability_grants.findFirst({
      where: and(
        eq(shared_capability_grants.owner_id, ownerId),
        eq(shared_capability_grants.grantee_id, person.id),
        eq(shared_capability_grants.capability_name, capabilityName),
        or(
          isNull(shared_capability_grants.expires_at),
          gt(shared_capability_grants.expires_at, new Date())
        )
      ),
    });

    if (sharedGrant) {
      return true;
    }
  }

  // Members have default household capabilities
  if (person.role === 'member') {
    // Check if this is a household-default capability
    const capability = await db.query.tool_capabilities.findFirst({
      where: eq(tool_capabilities.capability_name, capabilityName),
    });

    if (capability?.metadata?.householdDefault === true) {
      return true;
    }
  }

  return false;
}
```

### Example Permission Flows

**Scenario 1: Dad shares Google Calendar with kids**

```bash
# 1. MCP server discovers capabilities
$ family-assistant capabilities discover mcp:google-calendar

Discovered capabilities:
  - google-calendar:read (List and view events)
  - google-calendar:write (Create and modify events)
  - google-calendar:delete (Delete events)

# 2. Dad grants read access to son
$ family-assistant capabilities grant \
  --person son \
  --capability google-calendar:read \
  --owner dad

Granted 'google-calendar:read' from dad to son

# 3. Son asks assistant about dad's calendar
Son: "What's on dad's calendar tomorrow?"

System checks:
  - son wants to use 'google-calendar:read' capability
  - Capability owned by dad (his MCP server)
  - Check shared_capability_grants: son has grant from dad ✓
  - Execute via dad's MCP server instance
```

**Scenario 2: Admin installs new MCP server**

```bash
# 1. Install MCP server (adds to allowlist in v1)
$ family-assistant mcp add github-mcp \
  --command "npx" \
  --args "-y @modelcontextprotocol/server-github"

Added MCP server: github-mcp

# 2. Discover capabilities
$ family-assistant capabilities discover mcp:github-mcp

Discovered capabilities:
  - github:repos:list (List repositories)
  - github:issues:list (List issues)
  - github:issues:create (Create issues)
  - github:pull-requests:list (List pull requests)

# 3. Grant capabilities to household members
$ family-assistant capabilities grant \
  --person dad \
  --capability github:repos:list

$ family-assistant capabilities grant \
  --person mom \
  --capability github:issues:list
```

---

## MCP Integration

Model Context Protocol (MCP) is the **primary integration method** for the Family Assistant platform. MCP servers run per-person with isolated credentials and process/container isolation.

### Per-Person MCP Servers

Each person in the household gets their own instance of each MCP server:

```typescript
interface MCPServerInstance {
  serverId: string;
  personId: string;
  serverName: string;
  config: MCPServerConfig;
  process?: ChildProcess; // v1: process isolation
  container?: ContainerId; // v2: container isolation
  status: 'starting' | 'running' | 'stopped' | 'failed';
  lastHealthCheck: Date;
}

// Example: Dad and Mom each have their own Google Calendar MCP server
{
  serverId: 'mcp-google-cal-dad',
  personId: 'person-dad',
  serverName: 'google-calendar',
  config: {
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-google-calendar'],
    env: {
      GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
      // Dad's OAuth tokens (encrypted)
      GOOGLE_ACCESS_TOKEN: decryptCredential(dad.google_access_token),
      GOOGLE_REFRESH_TOKEN: decryptCredential(dad.google_refresh_token),
    }
  },
  process: ChildProcess { pid: 12345 },
  status: 'running'
}

{
  serverId: 'mcp-google-cal-mom',
  personId: 'person-mom',
  serverName: 'google-calendar',
  config: {
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-google-calendar'],
    env: {
      GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
      // Mom's OAuth tokens (encrypted)
      GOOGLE_ACCESS_TOKEN: decryptCredential(mom.google_access_token),
      GOOGLE_REFRESH_TOKEN: decryptCredential(mom.google_refresh_token),
    }
  },
  process: ChildProcess { pid: 12346 },
  status: 'running'
}
```

### Credential Isolation

**Per-person credentials ensure security and proper authorization:**

1. **OAuth Flow per Person**:
   ```typescript
   async function connectMCPIntegration(
     person: Person,
     serverName: string
   ): Promise<void> {
     // 1. Initiate OAuth flow for this specific person
     const authUrl = await generateOAuthUrl(serverName, person.id);

     // 2. User completes OAuth (gets access/refresh tokens)
     const tokens = await completeOAuthFlow(person.id);

     // 3. Encrypt and store tokens for this person
     await storeEncryptedCredentials(person.id, serverName, tokens);

     // 4. Spawn MCP server with person's credentials
     await mcpRunner.startServer(person.id, serverName);
   }
   ```

2. **Credential Encryption**:
   ```typescript
   interface EncryptedCredentials {
     ciphertext: string;
     iv: string;
     authTag: string;
     version: number;
   }

   // Stored per person
   CREATE TABLE mcp_credentials (
     id UUID PRIMARY KEY,
     person_id UUID NOT NULL REFERENCES persons(id),
     server_name VARCHAR(100) NOT NULL,
     credentials JSONB NOT NULL, -- EncryptedCredentials
     created_at TIMESTAMPTZ NOT NULL,
     updated_at TIMESTAMPTZ NOT NULL,

     UNIQUE(person_id, server_name)
   );
   ```

3. **Server Spawning**:
   ```typescript
   async function spawnMCPServer(
     person: Person,
     serverName: string
   ): Promise<ChildProcess> {
     // 1. Load person's encrypted credentials
     const encryptedCreds = await loadCredentials(person.id, serverName);

     // 2. Decrypt credentials (in-memory only)
     const creds = await decryptCredentials(encryptedCreds);

     // 3. Spawn process with credentials in environment
     const process = spawn(config.command, config.args, {
       env: {
         ...config.baseEnv,
         ...creds, // Person-specific credentials
       },
       stdio: ['pipe', 'pipe', 'pipe'],
     });

     // 4. Establish MCP protocol connection
     const client = new MCPClient(process.stdin, process.stdout);
     await client.initialize();

     return process;
   }
   ```

### Isolation Models

**v1: Process Isolation + Verified Allowlist**

```typescript
interface MCPServerAllowlistEntry {
  serverName: string;
  packageName: string; // NPM package or Docker image
  verified: boolean; // Manually reviewed by platform maintainers
  securityNotes?: string;
  addedAt: Date;
}

// v1 allowlist (manually curated)
const VERIFIED_MCP_SERVERS: MCPServerAllowlistEntry[] = [
  {
    serverName: 'google-calendar',
    packageName: '@modelcontextprotocol/server-google-calendar',
    verified: true,
    addedAt: new Date('2026-03-01'),
  },
  {
    serverName: 'github',
    packageName: '@modelcontextprotocol/server-github',
    verified: true,
    addedAt: new Date('2026-03-01'),
  },
  {
    serverName: 'filesystem',
    packageName: '@modelcontextprotocol/server-filesystem',
    verified: true,
    securityNotes: 'Restricted to ~/Documents by default',
    addedAt: new Date('2026-03-01'),
  },
];

// Only allowlisted servers can be installed
async function installMCPServer(serverName: string): Promise<void> {
  const allowlisted = VERIFIED_MCP_SERVERS.find(
    s => s.serverName === serverName
  );

  if (!allowlisted || !allowlisted.verified) {
    throw new Error(
      `MCP server '${serverName}' is not on the verified allowlist. ` +
      `See docs for security review process.`
    );
  }

  // Install from verified package
  await npmInstall(allowlisted.packageName);
}
```

**Why allowlist in v1:**
- MCP servers have full access to person's credentials
- Malicious MCP server could exfiltrate data
- Allowlist provides security until sandboxing is implemented
- Platform maintainers manually review each server

**v2: Container Isolation (Future)**

```typescript
interface MCPServerContainerConfig {
  image: string;
  cpuLimit: number;
  memoryLimit: string;
  networkPolicy: 'none' | 'restricted' | 'full';
  volumeMounts: VolumeMount[];
  securityContext: {
    readOnlyRootFilesystem: boolean;
    runAsNonRoot: boolean;
    capabilities: string[];
  };
}

// Future: Docker/Podman containers per person
async function spawnMCPServerContainer(
  person: Person,
  serverName: string
): Promise<Container> {
  const config = await loadMCPServerConfig(serverName);
  const creds = await decryptCredentials(person.id, serverName);

  const container = await docker.run({
    image: config.image,
    env: {
      ...config.baseEnv,
      ...creds,
    },
    resources: {
      cpuLimit: config.cpuLimit,
      memoryLimit: config.memoryLimit,
    },
    network: config.networkPolicy,
    security: {
      readOnlyRootFilesystem: true,
      runAsNonRoot: true,
      capabilities: ['NET_BIND_SERVICE'], // Minimal capabilities
    },
  });

  return container;
}
```

**Container benefits (v2):**
- Stronger isolation between MCP servers
- Resource limits prevent resource exhaustion
- Network policies prevent unauthorized egress
- Can run untrusted MCP servers safely
- Remove need for manual allowlist

### MCPServerRunner Interface

```typescript
interface MCPServerRunner {
  // Server lifecycle
  startServer(personId: string, serverName: string): Promise<void>;
  stopServer(personId: string, serverName: string): Promise<void>;
  restartServer(personId: string, serverName: string): Promise<void>;

  // Tool execution
  executeTools(
    person: Person,
    serverName: string,
    toolName: string,
    input: any
  ): Promise<ToolResult>;

  // Capability discovery
  discoverCapabilities(
    serverName: string
  ): Promise<ToolCapability[]>;

  // Health monitoring
  healthCheck(
    personId: string,
    serverName: string
  ): Promise<HealthStatus>;

  // Credential management
  setCredentials(
    personId: string,
    serverName: string,
    credentials: any
  ): Promise<void>;
}

// Implementation
class ProcessMCPServerRunner implements MCPServerRunner {
  private instances = new Map<string, MCPServerInstance>();

  async startServer(personId: string, serverName: string): Promise<void> {
    const key = `${personId}:${serverName}`;

    // Check if already running
    if (this.instances.has(key)) {
      return;
    }

    // Load person's credentials
    const creds = await this.loadCredentials(personId, serverName);

    // Spawn process
    const process = await this.spawnProcess(serverName, creds);

    // Store instance
    this.instances.set(key, {
      serverId: key,
      personId,
      serverName,
      process,
      status: 'running',
      lastHealthCheck: new Date(),
    });
  }

  async executeTool(
    person: Person,
    serverName: string,
    toolName: string,
    input: any
  ): Promise<ToolResult> {
    const key = `${person.id}:${serverName}`;
    const instance = this.instances.get(key);

    if (!instance || instance.status !== 'running') {
      // Auto-start server if not running
      await this.startServer(person.id, serverName);
    }

    // Execute via MCP protocol
    const client = await this.getClient(person.id, serverName);
    const result = await client.callTool(toolName, input);

    return {
      status: 'completed',
      data: result,
    };
  }
}
```

---

## CLI Commands

### Capability Management

```bash
# Discover capabilities from all tool sources
family-assistant capabilities discover

# Discover capabilities from specific source
family-assistant capabilities discover mcp:google-calendar
family-assistant capabilities discover adapter:home-assistant

# List all discovered capabilities
family-assistant capabilities list

# List capabilities by category
family-assistant capabilities list --category calendar

# Show detailed capability information
family-assistant capabilities show google-calendar:read

# Grant capability to person
family-assistant capabilities grant \
  --person john \
  --capability google-calendar:read

# Grant shared capability (owner's tool to grantee)
family-assistant capabilities grant \
  --person son \
  --capability google-calendar:read \
  --owner dad

# Revoke capability
family-assistant capabilities revoke \
  --person john \
  --capability google-calendar:read

# List person's capabilities
family-assistant capabilities list --person john

# Refresh capabilities (re-discover from all sources)
family-assistant capabilities refresh
```

### MCP Server Management

```bash
# Add MCP server to platform
family-assistant mcp add google-calendar \
  --command "npx" \
  --args "-y @modelcontextprotocol/server-google-calendar"

# List installed MCP servers
family-assistant mcp list

# Show MCP server details
family-assistant mcp show google-calendar

# Remove MCP server
family-assistant mcp remove google-calendar

# Start MCP server for person
family-assistant mcp start --person john --server google-calendar

# Stop MCP server for person
family-assistant mcp stop --person john --server google-calendar

# Restart MCP server
family-assistant mcp restart --person john --server google-calendar

# Check MCP server health
family-assistant mcp health --person john --server google-calendar

# List all running MCP server instances
family-assistant mcp ps

# View MCP server logs
family-assistant mcp logs --person john --server google-calendar
```

### MCP Credential Management

```bash
# Connect MCP integration (initiates OAuth flow)
family-assistant mcp connect google-calendar

# Disconnect MCP integration
family-assistant mcp disconnect google-calendar

# List connected MCP integrations for person
family-assistant mcp connections --person john

# Test MCP integration credentials
family-assistant mcp test google-calendar
```

---

## Examples

### Example 1: Bundled Tool

```typescript
// tools/bundled/memory-search.ts

import { z } from 'zod';
import type { Tool, RequestContext, ToolResult } from '@/types';

export const memorySearchTool: Tool = {
  name: 'memory.search',
  description: 'Search personal and shared household memories',

  inputSchema: z.object({
    query: z.string().min(1).describe('Search query'),
    scope: z.enum(['private', 'shared', 'all']).default('all'),
    limit: z.number().int().min(1).max(100).default(20),
  }),

  capabilities: ['memory:read'],

  async execute(input, context: RequestContext): Promise<ToolResult> {
    const { query, scope, limit } = input;

    // Check permissions
    if (scope === 'shared' || scope === 'all') {
      const hasPermission = await context.deps.authService.checkPermission(
        context.person,
        'memory.read.shared'
      );

      if (!hasPermission) {
        throw new Error('You do not have permission to search shared memories');
      }
    }

    // Search memories (scoped to person/household)
    const results = await context.deps.memoryService.search({
      householdId: context.person.householdId,
      personId: scope === 'private' ? context.person.id : undefined,
      query,
      limit,
    });

    return {
      status: 'completed',
      data: {
        results: results.map(r => ({
          id: r.id,
          content: r.content,
          scope: r.personId ? 'private' : 'shared',
          createdAt: r.createdAt,
        })),
      },
    };
  },
};
```

### Example 2: Adapter-Based Tool

```typescript
// adapters/home-assistant/adapter.ts

import WebSocket from 'ws';
import type { AdapterToolSource, ToolCapability } from '@/types';

export class HomeAssistantAdapter implements AdapterToolSource {
  type = 'adapter' as const;
  name = 'home-assistant';

  private eventStream?: WebSocket;
  private devices: Device[] = [];

  async start(): Promise<void> {
    // Connect to Home Assistant WebSocket API
    this.eventStream = new WebSocket(this.config.websocketUrl);

    // Authenticate
    await this.authenticate();

    // Subscribe to state changes
    await this.subscribeToEvents();

    // Discover devices
    this.devices = await this.discoverDevices();
  }

  async stop(): Promise<void> {
    this.eventStream?.close();
  }

  async discoverCapabilities(): Promise<ToolCapability[]> {
    // Dynamically generate capabilities from discovered devices
    return this.devices.map(device => ({
      name: `homeassistant.control.${device.entity_id}`,
      description: `Control ${device.friendly_name}`,
      inputSchema: z.object({
        action: z.enum(['turn_on', 'turn_off', 'toggle']),
        attributes: z.record(z.any()).optional(),
      }),
      requiredPermissions: [`homeassistant:device:${device.entity_id}`],
      metadata: {
        category: 'home-automation',
        tags: ['homeassistant', device.device_class],
      },
    }));
  }

  async executeTool(
    toolName: string,
    input: any,
    context: RequestContext
  ): Promise<ToolResult> {
    // Extract entity_id from tool name
    const entityId = toolName.replace('homeassistant.control.', '');

    // Get person's Home Assistant credentials
    const account = await context.deps.integrationService.getAccount(
      context.person.id,
      'home-assistant'
    );

    if (!account) {
      throw new Error('Connect your Home Assistant account first');
    }

    // Call Home Assistant service
    const result = await this.callService(
      account.credentials.accessToken,
      entityId,
      input.action,
      input.attributes
    );

    return {
      status: 'completed',
      data: result,
    };
  }

  private async subscribeToEvents(): Promise<void> {
    // Listen for state changes and push to assistant
    this.eventStream?.on('message', (data) => {
      const event = JSON.parse(data.toString());

      if (event.type === 'event' && event.event.event_type === 'state_changed') {
        // Notify assistant of state change
        this.notifyStateChange(event.event.data);
      }
    });
  }
}
```

### Example 3: MCP Tool Discovery and Execution

```typescript
// services/mcp/mcp-runner.ts

import { spawn, ChildProcess } from 'child_process';
import { MCPClient } from '@modelcontextprotocol/client';

export class MCPServerRunner {
  private instances = new Map<string, MCPServerInstance>();

  async startServer(personId: string, serverName: string): Promise<void> {
    const key = `${personId}:${serverName}`;

    // Load server configuration
    const config = await this.loadServerConfig(serverName);

    // Load person's credentials (encrypted)
    const credentials = await this.loadCredentials(personId, serverName);

    // Decrypt credentials
    const decryptedCreds = await this.decryptCredentials(credentials);

    // Spawn MCP server process
    const process = spawn(config.command, config.args, {
      env: {
        ...process.env,
        ...decryptedCreds,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Create MCP client
    const client = new MCPClient(process.stdin, process.stdout);

    // Initialize MCP protocol
    await client.initialize({
      protocolVersion: '2024-11-05',
      capabilities: {
        tools: {},
      },
      clientInfo: {
        name: 'family-assistant',
        version: '1.0.0',
      },
    });

    // Store instance
    this.instances.set(key, {
      serverId: key,
      personId,
      serverName,
      process,
      client,
      status: 'running',
      lastHealthCheck: new Date(),
    });
  }

  async discoverCapabilities(serverName: string): Promise<ToolCapability[]> {
    // Start temporary instance for discovery
    const tempKey = `_discovery:${serverName}`;
    await this.startServer('_system', serverName);

    const instance = this.instances.get(tempKey);
    if (!instance) {
      throw new Error(`Failed to start MCP server: ${serverName}`);
    }

    // List tools via MCP protocol
    const response = await instance.client.listTools();

    // Convert MCP tools to ToolCapability
    const capabilities: ToolCapability[] = response.tools.map(tool => ({
      name: `${serverName}.${tool.name}`,
      description: tool.description,
      inputSchema: tool.inputSchema,
      requiredPermissions: [`${serverName}:*`],
      metadata: {
        category: serverName,
        tags: [serverName],
      },
    }));

    // Stop temporary instance
    await this.stopServer('_system', serverName);

    return capabilities;
  }

  async executeTool(
    person: Person,
    serverName: string,
    toolName: string,
    input: any
  ): Promise<ToolResult> {
    const key = `${person.id}:${serverName}`;

    // Ensure server is running
    if (!this.instances.has(key)) {
      await this.startServer(person.id, serverName);
    }

    const instance = this.instances.get(key)!;

    // Execute tool via MCP protocol
    const result = await instance.client.callTool({
      name: toolName,
      arguments: input,
    });

    return {
      status: 'completed',
      data: result.content,
    };
  }
}
```

---

## Migration Path: From Adapters to MCP

For integrations currently implemented as adapters, migration to MCP can happen incrementally:

**Phase 1: Dual Support**
- Keep adapter implementation
- Add MCP server support
- Feature flag to switch between adapter/MCP

**Phase 2: Preference MCP**
- New installations use MCP by default
- Existing adapter installations continue working
- Provide migration tool

**Phase 3: Deprecate Adapter**
- Mark adapter as deprecated
- Remove adapter after grace period
- MCP becomes sole implementation

**Example migration:**
```typescript
// Old: Adapter-based
class GoogleCalendarAdapter implements AdapterToolSource {
  // Complex bidirectional code
}

// New: MCP-based (much simpler)
{
  serverName: 'google-calendar',
  packageName: '@modelcontextprotocol/server-google-calendar',
  verified: true
}

// Platform handles:
// - Per-person server instances
// - Credential management
// - Capability discovery
// - Permission checking
```

---

## Summary

**Tool System Architecture:**
- **Three tiers**: Bundled (core), Adapter (bidirectional), MCP (default)
- **MCP-first**: Primary integration method for community tools
- **Universal discovery**: ToolSource interface unifies all tool types
- **Dynamic permissions**: Capability-based, not hard-coded

**Key Benefits:**
- **Security**: Per-person MCP servers with credential isolation
- **Flexibility**: Support bundled, adapter, and MCP tools
- **Community**: Leverage MCP ecosystem
- **Simplicity**: Standard protocol, easy to add new tools

**References:**
- Capability discovery: See database schema above
- Permission model: See SECURITY_MODEL.md
- MCP protocol: https://modelcontextprotocol.io
- CLI commands: See CLI_DESIGN.md
