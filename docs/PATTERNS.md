# Patterns and Integration Guide

This document captures the implementation patterns that keep the v1 architecture consistent.

## Tool Execution Pattern

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

### Execution Order

```typescript
async function executeTool(toolId: string, rawInput: unknown, context: RequestContext) {
  const tool = toolRegistry.get(toolId);
  if (!tool) throw new Error(`Unknown tool: ${toolId}`);

  if (context.invocationSource === 'conversation' && tool.exposure !== 'conversation') {
    throw new Error('Tool not exposed to conversation');
  }

  const input = tool.inputSchema.parse(rawInput);

  await validateTargetScope(tool, input, context);
  await checkCorePolicyIfNeeded(tool, context.person);
  await checkCapabilities(tool, input, context.person);
  await requireApprovalIfNeeded(tool, input, context);

  return tool.execute(input, context);
}
```

### Design Rules

- Validate scope before execution
- Authorization happens outside the tool body whenever possible
- Conversation exposure is metadata, not a separate tool type
- Approval is the last gate before execution

## Scope Validation Pattern

```typescript
async function validateTargetScope(tool: Tool<any, any>, input: any, context: RequestContext) {
  switch (tool.targetScope) {
    case 'self':
      if (input.targetPersonId && input.targetPersonId !== context.person.id) {
        throw new Error('Cross-person access not allowed');
      }
      return;

    case 'owner_shared':
      if (!input.ownerId) throw new Error('ownerId required');
      if (input.ownerId === context.person.id) return;

      const allowed = await checkSharedCapability(
        context.person.id,
        input.ownerId,
        tool.requiredCapabilities?.[0] ?? ''
      );
      if (!allowed) throw new Error('Shared access not granted');
      return;

    default:
      return;
  }
}
```

## Core Tool Pattern

Core tools run in-process and call trusted services directly.

```typescript
const memorySearchTool: Tool<{ query: string }, MemorySearchResult> = {
  id: 'memory.search',
  description: 'Search private and shared memories available to the caller',
  inputSchema: z.object({
    query: z.string().min(1),
  }),
  requiredCapabilities: ['memory.search'],
  exposure: 'conversation',
  approvalPolicy: 'never',
  targetScope: 'self',

  async execute(input, context) {
    return context.memory.search({
      personId: context.person.id,
      householdId: context.person.householdId,
      query: input.query,
    });
  },
};
```

## Integration Driver Pattern

Integrations are modeled separately from tools.

```typescript
interface IntegrationDriver {
  key: string;
  driverType: 'native' | 'rest' | 'mcp';
  connect(personId: string, input: unknown): Promise<IntegrationConnection>;
  disconnect(connectionId: string): Promise<void>;
  listTools(connection: IntegrationConnection): Promise<Tool<any, any>[]>;
  healthCheck(connection: IntegrationConnection): Promise<HealthStatus>;
}
```

### Why This Pattern

- Tool execution stays uniform
- Driver details are isolated
- Native, REST, and future MCP implementations can coexist cleanly

## Integration-Backed Tool Pattern

```typescript
const calendarReadTool: Tool<{ start: string; end: string; ownerId?: string }, CalendarEvent[]> = {
  id: 'calendar.read',
  description: 'Read calendar events for the caller or a shared owner',
  inputSchema: z.object({
    start: z.string(),
    end: z.string(),
    ownerId: z.string().optional(),
  }),
  requiredCapabilities: ['calendar.read'],
  exposure: 'conversation',
  approvalPolicy: 'never',
  targetScope: 'owner_shared',

  async execute(input, context) {
    const ownerId = input.ownerId ?? context.person.id;
    const connection = await context.integrations.getConnection(ownerId, 'google-calendar');
    if (!connection) throw new Error('Calendar not connected');

    return context.integrations.invoke(connection, 'calendar.read', input);
  },
};
```

## Approval Pattern

Approval is metadata-driven and centrally enforced.

```typescript
async function requireApprovalIfNeeded(tool: Tool<any, any>, input: any, context: RequestContext) {
  if (tool.approvalPolicy === 'never') return;

  if (tool.approvalPolicy === 'admin_only') {
    const allowed = await checkCorePermission(context.person, 'system.configure');
    if (!allowed) throw new Error('Admin only');
    return;
  }

  const approved = await context.approvals.request({
    personId: context.person.id,
    toolId: tool.id,
    input,
  });

  if (!approved) throw new Error('Approval denied');
}
```

## Secret Handling Pattern

Do not accept raw secrets through standard conversation handlers.

Preferred approaches:
- admin UI or API entry
- OAuth/browser handoff
- dedicated secure submission flow that bypasses ordinary transcript logging

This is a design constraint, not an implementation detail.

## Skills Pattern

Skills are saved orchestrations, not executable plugins.

```typescript
interface SkillDefinition {
  id: string;
  description: string;
  toolAllowlist: string[];
  systemPrompt?: string;
  defaults?: Record<string, unknown>;
}
```

### Why This Matters

- Skills remain lightweight
- No extra runtime loading system is required
- Existing tools and policies remain the enforcement points

## Anti-Patterns to Avoid

- Mixing core policy and dynamic capabilities into one giant permission enum
- Treating JSONL traces as authoritative configuration
- Adding separate runtime paths for plugin tools, manifest tools, and skills
- Requiring long-lived external process fleets before proving a single useful integration
- Allowing raw secret submission through normal chat transcripts
