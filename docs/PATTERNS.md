# Patterns and Integration Guide

This guide provides concrete implementation patterns for developers building integrations and tools for the Family Assistant platform. Each pattern includes code examples showing HOW to implement these concepts.

---

## Tool Execution Pattern

### Tool Structure

Tools are the atomic building blocks of capabilities in the platform. Each tool is a typed, self-contained unit with explicit permissions and validation.

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

**Key Principles:**
- Tool implementations are independent of transport/channel logic
- Authorization is checked before tool execution
- Tools use Zod schemas for input validation
- Tools can stream results for long-running operations

### Tool Execution Flow

The complete flow from request to response includes authorization, execution, and cancellation support:

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
  const hasPermission = await checkPermission(
    context.person,
    tool.requiredPermissions
  );

  if (!hasPermission) {
    throw new Error(`Insufficient permissions for ${tool.name}`);
  }

  // 3. Validate input
  const validatedInput = tool.inputSchema.parse(input);

  // 4. Check if approval required
  if (tool.requiresApproval) {
    const approved = await requestApproval(context, tool, validatedInput);
    if (!approved) {
      throw new Error('User denied approval');
    }
  }

  // 5. Log execution (sanitized)
  const sanitizedInput = redactSecrets(input);
  logger.info({ tool: toolName, input: sanitizedInput }, 'executing tool');

  // 6. Execute with AbortSignal support
  return tool.execute(input, context);
}
```

### Example: Calendar Tool

Here's a concrete example showing how a calendar tool uses the requester's credentials:

```typescript
const getCalendarEventsTool: Tool<CalendarInput, CalendarEvent[]> = {
  name: 'calendar.get_events',
  description: 'Retrieve calendar events for a date range',

  inputSchema: z.object({
    startDate: z.string().datetime(),
    endDate: z.string().datetime(),
    ownerId: z.string().optional(), // Whose calendar to access
  }),

  requiredPermissions: ['integrations.share.calendar.read'],

  async execute(input, context) {
    const ownerId = input.ownerId || context.person.id;

    // Check if requesting person can access owner's calendar
    if (context.person.id !== ownerId) {
      const hasPermission = await checkPermission(
        context.person,
        'integrations.share.calendar.read',
        { ownerId } // grantedBy
      );

      if (!hasPermission) {
        throw new Error('You do not have permission to access this calendar');
      }
    }

    // Get the owner's connected Google Calendar account
    const account = await getConnectedAccount(ownerId, 'google-calendar');

    if (!account) {
      throw new Error(`${ownerId === context.person.id ? 'You need' : 'Owner needs'} to connect Google Calendar first`);
    }

    // Use THEIR credentials to fetch events
    const events = await googleCalendarClient.getEvents({
      accessToken: account.credentials.accessToken,
      startDate: input.startDate,
      endDate: input.endDate,
    });

    return {
      status: 'completed',
      data: events,
    };
  },
};
```

**Key Points:**
- Tool uses the owner's credentials, not system credentials
- Permission checks happen before integration access
- Clear error messages guide users to connect integrations
- Credentials are scoped per person

---

## Tool Source Pattern

### Implementing ToolSource Interface

All tool sources (bundled, adapter, MCP) implement a unified interface for capability discovery and execution. See [TOOLS.md](./TOOLS.md) for complete architecture.

**ToolSource Interface:**

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
```

### Example: Bundled Tool Source

```typescript
class BundledToolSource implements ToolSource {
  type = 'bundled' as const;
  name = 'core';

  private tools = new Map<string, Tool>();

  constructor() {
    // Register bundled tools
    this.tools.set('memory.search', memorySearchTool);
    this.tools.set('memory.store', memoryStoreTool);
    this.tools.set('session.configure', sessionConfigureTool);
  }

  async discoverCapabilities(): Promise<ToolCapability[]> {
    return Array.from(this.tools.values()).map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      requiredPermissions: tool.capabilities || [],
      metadata: {
        category: 'core',
        tags: ['bundled', 'platform'],
      },
    }));
  }

  async executeTool(
    toolName: string,
    input: any,
    context: RequestContext
  ): Promise<ToolResult> {
    const tool = this.tools.get(toolName);

    if (!tool) {
      throw new Error(`Unknown tool: ${toolName}`);
    }

    // Validate input
    const validatedInput = tool.inputSchema.parse(input);

    // Execute tool (has direct access to core services)
    return tool.execute(validatedInput, context);
  }

  async healthCheck(): Promise<HealthStatus> {
    return {
      status: 'healthy',
      lastCheck: new Date(),
    };
  }
}
```

### Example: Adapter Tool Source

```typescript
class HomeAssistantAdapter implements ToolSource {
  type = 'adapter' as const;
  name = 'home-assistant';

  private eventStream?: WebSocket;
  private devices: Device[] = [];

  async start(): Promise<void> {
    // Connect to Home Assistant WebSocket
    this.eventStream = new WebSocket(this.config.websocketUrl);

    // Subscribe to device state changes
    await this.subscribeToEvents();

    // Discover devices
    this.devices = await this.fetchDevices();
  }

  async discoverCapabilities(): Promise<ToolCapability[]> {
    // Dynamically generate capabilities from discovered devices
    return this.devices.map(device => ({
      name: `homeassistant.control.${device.entity_id}`,
      description: `Control ${device.friendly_name}`,
      inputSchema: z.object({
        action: z.enum(['turn_on', 'turn_off', 'toggle']),
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
    const account = await getConnectedAccount(
      context.person.id,
      'home-assistant'
    );

    if (!account) {
      throw new Error('Connect your Home Assistant account first');
    }

    // Call Home Assistant service (delegation)
    const result = await this.callService(
      account.credentials.accessToken,
      entityId,
      input.action
    );

    return {
      status: 'completed',
      data: result,
    };
  }

  private async subscribeToEvents(): Promise<void> {
    // Bidirectional communication: adapter pushes updates to assistant
    this.eventStream?.on('message', (data) => {
      const event = JSON.parse(data.toString());

      if (event.type === 'state_changed') {
        this.notifyStateChange(event.data);
      }
    });
  }
}
```

### Example: MCP Tool Source

```typescript
class MCPToolSource implements ToolSource {
  type = 'mcp' as const;
  name: string;

  constructor(
    private serverName: string,
    private mcpRunner: MCPServerRunner
  ) {
    this.name = `mcp:${serverName}`;
  }

  async discoverCapabilities(): Promise<ToolCapability[]> {
    // Discover capabilities from MCP server
    return this.mcpRunner.discoverCapabilities(this.serverName);
  }

  async executeTool(
    toolName: string,
    input: any,
    context: RequestContext
  ): Promise<ToolResult> {
    // Route execution to person's MCP server instance
    return this.mcpRunner.executeTool(
      context.person,
      this.serverName,
      toolName,
      input
    );
  }

  async healthCheck(): Promise<HealthStatus> {
    // Check health of person's MCP server instances
    // (Check at least one running instance, or system instance)
    return this.mcpRunner.healthCheck('_system', this.serverName);
  }
}
```

---

## Capability Discovery Pattern

### Dynamic Capability Discovery

Capabilities are discovered at runtime from all tool sources, enabling dynamic permission management.

**Discovery Flow:**

```typescript
// 1. Discover from all tool sources
async function discoverAllCapabilities(): Promise<ToolCapability[]> {
  const sources: ToolSource[] = [
    ...bundledToolSources,
    ...adapterToolSources,
    ...mcpToolSources,
  ];

  const capabilityArrays = await Promise.all(
    sources.map(source => source.discoverCapabilities())
  );

  return capabilityArrays.flat();
}

// 2. Store in database
async function refreshCapabilities(): Promise<void> {
  const capabilities = await discoverAllCapabilities();

  await db.transaction(async (tx) => {
    // Mark existing as stale
    await tx.update(tool_capabilities).set({ stale: true });

    // Upsert discovered capabilities
    for (const cap of capabilities) {
      await tx
        .insert(tool_capabilities)
        .values({
          source_type: cap.sourceType,
          source_name: cap.sourceName,
          capability_name: cap.name,
          description: cap.description,
          input_schema: cap.inputSchema,
          required_permissions: cap.requiredPermissions,
          metadata: cap.metadata,
          discovered_at: new Date(),
          last_verified: new Date(),
          stale: false,
        })
        .onConflictDoUpdate({
          target: [tool_capabilities.capability_name],
          set: {
            description: cap.description,
            input_schema: cap.inputSchema,
            last_verified: new Date(),
            stale: false,
          },
        });
    }

    // Remove stale capabilities
    await tx.delete(tool_capabilities).where(eq(tool_capabilities.stale, true));
  });
}
```

### Capability Metadata

Rich metadata enables dynamic UI generation and permission management:

```typescript
interface ToolCapability {
  name: string;
  description: string;
  inputSchema: ZodSchema;
  requiredPermissions: string[];
  metadata?: {
    category?: string;         // Group capabilities
    tags?: string[];           // Searchable tags
    isDestructive?: boolean;   // Requires confirmation
    estimatedDuration?: number; // Expected execution time
  };
}

// Example: Calendar capability
{
  name: 'google-calendar:read',
  description: 'List and view Google Calendar events',
  inputSchema: z.object({
    startDate: z.string().datetime(),
    endDate: z.string().datetime(),
  }),
  requiredPermissions: ['google-calendar:read'],
  metadata: {
    category: 'calendar',
    tags: ['google', 'calendar', 'events'],
    estimatedDuration: 1000, // ~1 second
  },
}
```

---

## MCP Tool Execution Pattern

### Per-Person MCP Server Execution

MCP tools execute via per-person server instances with isolated credentials.

**Execution Flow:**

```typescript
async function executeMCPTool(
  person: Person,
  serverName: string,
  toolName: string,
  input: any
): Promise<ToolResult> {
  // 1. Check capability permission
  const capability = `${serverName}:${toolName}`;
  const hasPermission = await checkCapabilityPermission(person, capability);

  if (!hasPermission) {
    throw new Error(`Missing capability: ${capability}`);
  }

  // 2. Ensure person's MCP server is running
  const instance = await mcpRunner.ensureServerRunning(person.id, serverName);

  if (!instance) {
    // Auto-start server if not running
    await mcpRunner.startServer(person.id, serverName);
  }

  // 3. Execute via MCP protocol (person's server, person's credentials)
  const client = await mcpRunner.getClient(person.id, serverName);

  const result = await client.callTool({
    name: toolName,
    arguments: input,
  });

  return {
    status: 'completed',
    data: result.content,
  };
}
```

### Shared Capability Execution

When one person uses another's capability (e.g., son reads dad's calendar):

```typescript
async function executeSharedMCPTool(
  requestingPerson: Person,
  ownerId: string,
  serverName: string,
  toolName: string,
  input: any
): Promise<ToolResult> {
  // 1. Check shared capability permission
  const capability = `${serverName}:${toolName}`;
  const hasSharedPermission = await checkSharedCapabilityPermission(
    requestingPerson,
    capability,
    ownerId
  );

  if (!hasSharedPermission) {
    throw new Error(
      `You do not have shared access to ${capability} from owner ${ownerId}`
    );
  }

  // 2. Execute via OWNER's MCP server (owner's credentials)
  const owner = await getPerson(ownerId);
  const instance = await mcpRunner.ensureServerRunning(owner.id, serverName);

  if (!instance) {
    throw new Error(`Owner's ${serverName} server is not running`);
  }

  // 3. Execute with owner's credentials
  const client = await mcpRunner.getClient(owner.id, serverName);

  const result = await client.callTool({
    name: toolName,
    arguments: input,
  });

  return {
    status: 'completed',
    data: result.content,
  };
}

// Example: Son reads dad's calendar
// - requestingPerson: son
// - ownerId: dad.id
// - serverName: 'google-calendar'
// - Executes via dad's MCP server (dad's Google OAuth tokens)
// - Dad has granted son 'google-calendar:read' capability
```

### Permission Check Pattern

```typescript
async function checkSharedCapabilityPermission(
  person: Person,
  capabilityName: string,
  ownerId: string
): Promise<boolean> {
  // Admins have all capabilities
  if (person.role === 'admin') {
    return true;
  }

  // Own capability - always allowed
  if (person.id === ownerId) {
    return true;
  }

  // Check shared capability grant
  const grant = await db.query.shared_capability_grants.findFirst({
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

  return !!grant;
}
```

---

## Permission Checking Pattern

### Role-Based + Granular Permissions

The platform uses a hybrid permission model combining role-based access with granular permission grants:

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

### Integration Sharing Pattern

How users share their connected integrations with other household members:

**1. Connect Your Own Integration**

Each person connects their own integration accounts:

```bash
# Dad connects his Google Calendar
family-assistant integrations connect google-calendar
# OAuth flow happens, dad's credentials stored
```

**2. Grant Sharing Access**

The integration owner decides who can use their integration:

```bash
# Dad allows his kids to read his calendar
family-assistant permissions grant --person son --permission integrations.share.calendar.read
family-assistant permissions grant --person daughter --permission integrations.share.calendar.read
```

**3. Access Check During Tool Execution**

When someone requests calendar data:

```typescript
async function getCalendarEvents(requestingPerson: Person, ownerId: string) {
  // Check if requesting person can access owner's calendar
  if (requestingPerson.id === ownerId) {
    // Own calendar - always allowed
    const account = await getConnectedAccount(ownerId, 'google-calendar');
    return fetchCalendarEvents(account.credentials);
  } else {
    // Someone else's calendar - check sharing permission
    const hasPermission = await checkPermission(
      requestingPerson,
      'integrations.share.calendar.read',
      { ownerId } // grantedBy parameter
    );

    if (!hasPermission) {
      throw new Error(`You don't have permission to access ${ownerId}'s calendar`);
    }

    const account = await getConnectedAccount(ownerId, 'google-calendar');
    return fetchCalendarEvents(account.credentials);
  }
}
```

**Example Flow: Dad Shares Calendar with Kids**

```
User (Son): "What's on Dad's calendar tomorrow?"

System:
1. Identify requester: son
2. Parse intent: access dad's calendar
3. Check permission: son has 'integrations.share.calendar.read' from dad
4. Retrieve dad's connected Google Calendar account
5. Use dad's credentials to fetch events
6. Return events to son

Response: "Dad has a dentist appointment at 2pm and soccer practice at 5pm."
```

---

## Memory Access Pattern

### Scope Enforcement

Memory is partitioned by scope to prevent accidental data leakage:

**Scope Types:**
- **Private**: Personal to one person (person_id NOT NULL)
- **Shared**: Accessible to all household members (person_id NULL)
- **Household**: Same as shared, semantic distinction
- **Session**: Ephemeral, lives in JSONL files

**Memory Table Schema:**

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

### PostgreSQL Scoped Queries

Always enforce scope in your queries to prevent data leakage:

```typescript
// Retrieve private memories for a person
async function getPrivateMemories(
  householdId: string,
  personId: string,
  query: string
): Promise<Memory[]> {
  const results = await db.query(
    `SELECT id, type, content, metadata, created_at
     FROM memory_entries
     WHERE household_id = $1
       AND person_id = $2
       AND content_vector @@ plainto_tsquery('english', $3)
     ORDER BY created_at DESC
     LIMIT 20`,
    [householdId, personId, query]
  );

  return results.rows;
}

// Retrieve shared memories (accessible to all household members)
async function getSharedMemories(
  householdId: string,
  query: string
): Promise<Memory[]> {
  const results = await db.query(
    `SELECT id, type, content, metadata, created_at
     FROM memory_entries
     WHERE household_id = $1
       AND person_id IS NULL
       AND content_vector @@ plainto_tsquery('english', $3)
     ORDER BY created_at DESC
     LIMIT 20`,
    [householdId, query]
  );

  return results.rows;
}

// Store a private memory
async function storePrivateMemory(
  householdId: string,
  personId: string,
  type: string,
  content: string,
  metadata?: object
): Promise<void> {
  await db.query(
    `INSERT INTO memory_entries (household_id, person_id, type, content, metadata)
     VALUES ($1, $2, $3, $4, $5)`,
    [householdId, personId, type, content, metadata || {}]
  );
}

// Store a shared memory
async function storeSharedMemory(
  householdId: string,
  type: string,
  content: string,
  metadata?: object
): Promise<void> {
  await db.query(
    `INSERT INTO memory_entries (household_id, person_id, type, content, metadata)
     VALUES ($1, NULL, $2, $3, $4)`,
    [householdId, type, content, metadata || {}]
  );
}
```

**Key Safety Rules:**
- ALWAYS include `household_id` in WHERE clause
- For private: ALWAYS include `person_id = $personId`
- For shared: ALWAYS include `person_id IS NULL`
- Use database constraints to enforce scope at schema level
- Never mix private and shared in same query without explicit intent

### JSONL Session Memory

Ephemeral session state lives in append-only JSONL files:

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

**Session Memory Pattern:**

```typescript
// Load session context
async function loadSessionContext(sessionId: string): Promise<SessionContext> {
  const contextPath = path.join(DATA_DIR, 'sessions', sessionId, 'context.json');

  if (!await fileExists(contextPath)) {
    // New session
    return {
      sessionId,
      workingMemory: {},
      conversationHistory: [],
    };
  }

  const content = await fs.readFile(contextPath, 'utf-8');
  return JSON.parse(content);
}

// Save session context
async function saveSessionContext(
  sessionId: string,
  context: SessionContext
): Promise<void> {
  const contextPath = path.join(DATA_DIR, 'sessions', sessionId, 'context.json');
  await fs.writeFile(contextPath, JSON.stringify(context, null, 2));
}

// Append execution log entry
async function appendExecutionLog(
  sessionId: string,
  entry: ExecutionLogEntry
): Promise<void> {
  const logPath = path.join(DATA_DIR, 'sessions', sessionId, 'execution.jsonl');
  const line = JSON.stringify(entry) + '\n';
  await fs.appendFile(logPath, line);
}
```

**What Gets Logged:**

```typescript
interface ExecutionLogEntry {
  timestamp: string;
  event: string; // 'request', 'identity_resolved', 'tool_executed', 'llm_invoked', 'response'
  requestId: string;
  personId?: string;
  toolName?: string;
  duration?: number;
  metadata?: Record<string, any>;
}

// Example entries
{
  "timestamp": "2026-03-18T10:30:00Z",
  "event": "request",
  "requestId": "req_123",
  "message": "What's on my calendar today?"
}

{
  "timestamp": "2026-03-18T10:30:00Z",
  "event": "identity_resolved",
  "requestId": "req_123",
  "personId": "person_john"
}

{
  "timestamp": "2026-03-18T10:30:01Z",
  "event": "tool_executed",
  "requestId": "req_123",
  "toolName": "calendar.get_events",
  "duration": 245,
  "metadata": { "eventCount": 3 }
}
```

---

## Lifecycle Hook Pattern

### Event-Driven Extensibility

The platform uses lifecycle hooks to enable plugins without tight coupling:

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

### Plugin Example

Here's how a plugin hooks into the lifecycle:

```typescript
class MetricsPlugin {
  constructor(private lifecycle: RequestLifecycle) {
    this.registerHooks();
  }

  private registerHooks() {
    // Track tool execution times
    const toolStartTimes = new Map<string, number>();

    this.lifecycle.on('tool.before', (tool) => {
      toolStartTimes.set(tool.name, Date.now());
    });

    this.lifecycle.on('tool.after', (result) => {
      const startTime = toolStartTimes.get(result.toolName);
      if (startTime) {
        const duration = Date.now() - startTime;
        this.recordMetric('tool.execution.duration', duration, {
          toolName: result.toolName,
          status: result.status,
        });
        toolStartTimes.delete(result.toolName);
      }
    });

    // Track LLM usage
    this.lifecycle.on('llm.invoked', (metadata) => {
      this.recordMetric('llm.tokens.used', metadata.tokensUsed, {
        provider: metadata.provider,
        model: metadata.model,
      });
    });
  }

  private recordMetric(name: string, value: number, tags: Record<string, string>) {
    // Send to metrics backend (Prometheus, DataDog, etc.)
    console.log(`[METRIC] ${name} = ${value}`, tags);
  }
}

// Usage
const lifecycle = new RequestLifecycle();
new MetricsPlugin(lifecycle);
new LoggingPlugin(lifecycle);
new ApprovalPlugin(lifecycle);
```

**Benefits:**
- Plugins don't modify core orchestrator code
- Easy to enable/disable features
- Testable in isolation
- Clear separation of concerns

---

## Cancellation Pattern

### AbortSignal Propagation

All long-running operations must support cancellation:

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

**Example: Cancellable API Call**

```typescript
async function fetchWithCancellation(
  url: string,
  signal: AbortSignal
): Promise<Response> {
  const controller = new AbortController();

  // Link external abort signal to fetch controller
  signal.addEventListener('abort', () => {
    controller.abort();
  });

  try {
    return await fetch(url, { signal: controller.signal });
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('Request cancelled by user');
    }
    throw error;
  }
}

// Usage in a tool
const calendarTool: Tool = {
  async execute(input, context) {
    const events = await fetchWithCancellation(
      'https://api.google.com/calendar/events',
      context.signal
    );

    return { status: 'completed', data: events };
  }
};
```

---

## Approval Workflow Pattern

### Security Boundary Pattern

High-risk operations require user approval before execution:

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

**Example: High-Risk Tool**

```typescript
const deleteCalendarTool: Tool = {
  name: 'calendar.delete_event',
  requiresApproval: true,
  approvalPrompt: 'Delete calendar event?',
  risks: ['This action cannot be undone'],

  async execute(input, context) {
    // Approval already checked by executeTool wrapper
    // Proceed with deletion
    await googleCalendar.deleteEvent(input.eventId);
    return { status: 'completed' };
  }
};
```

**Tool Safety Tiers:**

```typescript
// Tier 1: Read-Only (No Approval)
'config.get'           // Read configuration
'system.health'        // Check system health
'memory.search'        // Search memories (scope-aware)

// Tier 2: Self-Scoped (No Approval)
'config.set.self'      // Modify own settings
'memory.store.private' // Store private memory

// Tier 3: Shared/Household (Approval Required)
'memory.delete.shared' // Delete shared memories
'config.set.household' // Modify household settings

// Tier 4: Destructive (Approval + Admin Only)
'household.delete'     // Delete household
'person.delete'        // Delete users
```

---

## Channel Adapter Pattern

### Unified Message Handling

The platform supports multiple messaging channels through a unified abstraction:

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

### Implementing a New Channel

Step-by-step guide to adding a new messaging channel:

**1. Implement the ChannelAdapter Interface**

```typescript
class TelegramChannelAdapter implements ChannelAdapter {
  name = 'telegram';
  type: ChannelType = 'telegram';

  private bot: TelegramBot;
  private messageHandlers: Array<(msg: InboundMessage) => void> = [];

  constructor(private config: TelegramConfig) {
    this.bot = new TelegramBot(config.botToken);
  }

  async start(): Promise<void> {
    this.bot.on('message', (msg) => {
      // Convert Telegram message to internal format
      const inboundMessage: InboundMessage = {
        channel: 'telegram',
        channelUserId: msg.from.id.toString(),
        text: msg.text,
        timestamp: new Date(msg.date * 1000),
      };

      // Notify all registered handlers
      this.messageHandlers.forEach(handler => handler(inboundMessage));
    });

    await this.bot.startPolling();
  }

  async stop(): Promise<void> {
    await this.bot.stopPolling();
  }

  async sendMessage(recipient: ChannelRecipient, message: Message): Promise<void> {
    await this.bot.sendMessage(recipient.channelUserId, message.text);
  }

  on(event: 'message', handler: (msg: InboundMessage) => void) {
    if (event === 'message') {
      this.messageHandlers.push(handler);
    }
  }

  async healthCheck(): Promise<ChannelHealth> {
    try {
      await this.bot.getMe();
      return { status: 'healthy', lastCheck: new Date() };
    } catch (error) {
      return {
        status: 'unavailable',
        lastCheck: new Date(),
        error: error.message
      };
    }
  }
}
```

**2. Register the Channel**

```typescript
// In your service initialization
const channelRegistry = new ChannelRegistry();

const telegramAdapter = new TelegramChannelAdapter({
  botToken: process.env.TELEGRAM_BOT_TOKEN,
});

channelRegistry.register(telegramAdapter);
await telegramAdapter.start();
```

**3. Handle Identity Resolution**

```typescript
// Map channel-specific identifiers to internal persons
async function resolveIdentity(message: InboundMessage): Promise<Person | null> {
  // Look up person by channel + channel user ID
  const identity = await db.query(
    `SELECT person_id FROM identities
     WHERE channel = $1 AND channel_user_id = $2`,
    [message.channel, message.channelUserId]
  );

  if (!identity.rows.length) {
    return null; // Unknown user - trigger pairing flow
  }

  return await getPerson(identity.rows[0].person_id);
}
```

**Benefits:**
- Adding new channels doesn't require core orchestrator changes
- Channels can be enabled/disabled per household
- All channels get same functionality (memory, tools, LLM)
- Easy to test channels in isolation

---

## Dependency Injection Pattern

### Explicit Dependencies

The platform favors explicit dependencies over hidden globals or framework magic:

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

### Why Explicit Over Hidden

**Benefits of Explicit Dependencies:**

1. **Testability**: Easy to inject mocks for testing
2. **Traceability**: Clear what each component needs
3. **No Hidden State**: No global singletons causing spooky action
4. **Type Safety**: TypeScript enforces correct types
5. **Debuggability**: Easy to inspect what's being used

**Example: Creating a Request Handler**

```typescript
// Bad: Hidden dependencies
class RequestHandler {
  async handle(request: Request) {
    // Where do these come from? Magic!
    const person = await AuthService.getInstance().resolve(request);
    const tools = ToolRegistry.getInstance().getAll();
    Logger.getInstance().info('handling request');
  }
}

// Good: Explicit dependencies
interface RequestHandlerDeps {
  authService: AuthService;
  toolRegistry: ToolRegistry;
  logger: Logger;
  memoryProvider: MemoryProvider;
}

class RequestHandler {
  constructor(private deps: RequestHandlerDeps) {}

  async handle(request: Request) {
    // Clear where everything comes from
    const person = await this.deps.authService.resolve(request);
    const tools = this.deps.toolRegistry.getAll();
    this.deps.logger.info('handling request');
  }
}

// Testing is trivial
const handler = new RequestHandler({
  authService: mockAuthService,
  toolRegistry: mockToolRegistry,
  logger: mockLogger,
  memoryProvider: mockMemoryProvider,
});
```

---

## Health Tracking Pattern

### Integration Health Monitoring

Track the health of all external integrations to enable graceful degradation:

```typescript
interface IntegrationHealth {
  name: string;
  status: 'healthy' | 'degraded' | 'unavailable';
  lastCheck: Date;
  lastError?: Error;
  consecutiveFailures: number;
}
```

**Health Check Implementation:**

```typescript
class HealthMonitor {
  private healthStatus = new Map<string, IntegrationHealth>();

  async checkIntegration(name: string): Promise<IntegrationHealth> {
    const integration = this.integrations.get(name);

    try {
      await integration.healthCheck();

      const health: IntegrationHealth = {
        name,
        status: 'healthy',
        lastCheck: new Date(),
        consecutiveFailures: 0,
      };

      this.healthStatus.set(name, health);
      return health;

    } catch (error) {
      const previousHealth = this.healthStatus.get(name);
      const consecutiveFailures = (previousHealth?.consecutiveFailures || 0) + 1;

      const health: IntegrationHealth = {
        name,
        status: consecutiveFailures > 3 ? 'unavailable' : 'degraded',
        lastCheck: new Date(),
        lastError: error,
        consecutiveFailures,
      };

      this.healthStatus.set(name, health);
      return health;
    }
  }

  async checkAll(): Promise<Map<string, IntegrationHealth>> {
    const checks = Array.from(this.integrations.keys()).map(name =>
      this.checkIntegration(name)
    );

    await Promise.all(checks);
    return this.healthStatus;
  }
}
```

**CLI Commands:**

```bash
family-assistant health             # Show all integration health status
family-assistant health --provider anthropic
family-assistant health --integration google-calendar
```

### Graceful Degradation Strategy

When integrations fail, degrade gracefully instead of crashing:

```typescript
async function executeWithDegradation(
  tool: Tool,
  input: any,
  context: RequestContext
): Promise<ToolResult> {
  const integration = tool.requiresIntegration;

  if (!integration) {
    // No integration needed, execute normally
    return tool.execute(input, context);
  }

  // Check integration health
  const health = await healthMonitor.getHealth(integration);

  if (health.status === 'unavailable') {
    // Integration unavailable - inform user
    throw new Error(
      `${integration} is currently unavailable. Last error: ${health.lastError?.message}`
    );
  }

  if (health.status === 'degraded') {
    // Warn user but try anyway
    await context.channel.sendMessage(context.person, {
      type: 'warning',
      text: `${integration} is experiencing issues. Will retry...`
    });
  }

  try {
    return await tool.execute(input, context);
  } catch (error) {
    // Update health status
    await healthMonitor.recordFailure(integration, error);
    throw error;
  }
}
```

**Graceful Degradation Examples:**

- **If Google Calendar unavailable**: Skip calendar tools, continue with other capabilities
- **If LLM provider fails**: Try fallback provider, then degrade to "service temporarily unavailable"
- **If memory service fails**: Use session memory only, warn user, continue operation
- **If integration fails**: Mark as unhealthy, retry with exponential backoff, notify user

---

## Execution Logging Pattern

### JSONL Append-Only Logs

All execution state is logged to append-only JSONL files for debugging and audit:

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

**Logging Strategy:**
- **Structured logging** (pino) for application events
- **Append-only JSONL** for execution traces
- **Session files** for debugging and replay

### Session File Organization

```typescript
// Session directory structure
interface SessionFiles {
  // Append-only execution trace
  executionLog: string; // execution.jsonl

  // Working memory (overwritten)
  context: string; // context.json

  // Tool invocations (append-only)
  toolLog: string; // tools.jsonl
}

// Helper: Get session file paths
function getSessionPaths(sessionId: string): SessionFiles {
  const baseDir = path.join(DATA_DIR, 'sessions', sessionId);

  return {
    executionLog: path.join(baseDir, 'execution.jsonl'),
    context: path.join(baseDir, 'context.json'),
    toolLog: path.join(baseDir, 'tools.jsonl'),
  };
}
```

**Example Session Files:**

`execution.jsonl`:
```jsonl
{"timestamp":"2026-03-18T10:30:00Z","event":"request","requestId":"req_123","message":"What's on my calendar?"}
{"timestamp":"2026-03-18T10:30:00Z","event":"identity_resolved","requestId":"req_123","personId":"person_john"}
{"timestamp":"2026-03-18T10:30:01Z","event":"tool_executed","requestId":"req_123","toolName":"calendar.get_events","duration":245}
{"timestamp":"2026-03-18T10:30:02Z","event":"llm_invoked","requestId":"req_123","provider":"anthropic","model":"claude-sonnet-4","tokens":150}
{"timestamp":"2026-03-18T10:30:03Z","event":"response","requestId":"req_123","duration":3000}
```

`context.json`:
```json
{
  "sessionId": "session_123",
  "personId": "person_john",
  "householdId": "household_smith",
  "workingMemory": {
    "currentDate": "2026-03-18",
    "timezone": "America/Los_Angeles"
  },
  "conversationHistory": [
    {
      "role": "user",
      "content": "What's on my calendar?"
    },
    {
      "role": "assistant",
      "content": "You have 3 events today..."
    }
  ]
}
```

`tools.jsonl`:
```jsonl
{"timestamp":"2026-03-18T10:30:01Z","tool":"calendar.get_events","input":{"startDate":"2026-03-18T00:00:00Z"},"duration":245,"status":"completed"}
```

### What to Log, What to Redact

**Always Log:**
- Request/response metadata (timing, status)
- Identity resolution results
- Authorization decisions
- Tool selection and execution (sanitized input)
- LLM invocation metadata (provider, model, token count)
- Errors and failures

**Always Redact:**
- API keys and OAuth tokens
- Passwords and secrets
- Personal identification numbers (SSN, etc.)
- Credit card numbers
- Raw credential objects

**Credential Redaction Pattern:**

```typescript
function redactSecrets(obj: any): any {
  if (!obj || typeof obj !== 'object') {
    return obj;
  }

  const redacted = Array.isArray(obj) ? [] : {};

  for (const [key, value] of Object.entries(obj)) {
    // Redact sensitive keys
    if (SENSITIVE_KEYS.includes(key.toLowerCase())) {
      redacted[key] = '[REDACTED]';
      continue;
    }

    // Recursively redact nested objects
    if (typeof value === 'object' && value !== null) {
      redacted[key] = redactSecrets(value);
    } else {
      redacted[key] = value;
    }
  }

  return redacted;
}

const SENSITIVE_KEYS = [
  'password',
  'secret',
  'apikey',
  'api_key',
  'token',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'credential',
  'credentials',
  'authorization',
];

// Usage
const sanitizedInput = redactSecrets(toolInput);
logger.info({ tool: toolName, input: sanitizedInput }, 'executing tool');
```

**Example: Logging with Redaction**

```typescript
// Before redaction
const toolInput = {
  integration: 'google-calendar',
  credentials: {
    accessToken: 'ya29.a0AfH6SMBx...',
    refreshToken: '1//0gHN...',
  },
  startDate: '2026-03-18',
};

// After redaction
const sanitized = redactSecrets(toolInput);
// {
//   integration: 'google-calendar',
//   credentials: {
//     accessToken: '[REDACTED]',
//     refreshToken: '[REDACTED]',
//   },
//   startDate: '2026-03-18',
// }

await appendExecutionLog(sessionId, {
  timestamp: new Date().toISOString(),
  event: 'tool_executed',
  tool: 'calendar.get_events',
  input: sanitized, // Safe to log
});
```

---

## Summary

These patterns form the foundation for building integrations and tools in the Family Assistant platform:

1. **Tool Execution**: Typed, validated, permission-checked atomic operations
2. **Integration Delegation**: Delegate complex authorization to external systems
3. **Permission Checking**: Hybrid role-based + granular permission model
4. **Memory Access**: Scope-enforced queries prevent data leakage
5. **Lifecycle Hooks**: Event-driven extensibility without coupling
6. **Cancellation**: AbortSignal propagation for user control
7. **Approval Workflows**: Security boundary for high-risk operations
8. **Channel Adapters**: Unified messaging across platforms
9. **Dependency Injection**: Explicit dependencies for testability
10. **Health Tracking**: Graceful degradation when integrations fail
11. **Execution Logging**: Comprehensive audit trail with credential redaction

Use these patterns to build robust, secure, and maintainable integrations.
