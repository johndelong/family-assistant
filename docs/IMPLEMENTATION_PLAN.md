# Implementation Plan

## Development Strategy

This implementation follows a phased approach with incremental delivery. Each phase builds on the previous one, delivering working functionality that can be tested and refined before moving forward. The core philosophy is to keep the assistant service lean while building rich capabilities through plugins and extensions.

**Key Principles:**
- **Incremental Delivery**: Ship working functionality at each phase
- **Test as You Build**: Write tests alongside implementation
- **Keep Core Lean**: Extensions over bloat
- **CLI-First**: Terminal and file-based configuration ensure understanding and git-trackability
- **Local-First**: Configuration via files, with optional UI later
- **Explicit over Hidden**: Deterministic, traceable code over framework magic

## Phase Dependencies

The phases must be implemented in this order to maintain proper dependencies:

```
Phase 1: Architecture and Scaffolding
   ↓
   │  Deliverables: Core models, database schema, CLI scaffolding, logging
   │  Enables: All subsequent phases (foundation)
   ↓
Phase 2: Core Request Pipeline & Event System
   ↓
   │  Deliverables: Identity resolution, authorization, WebSocket, pairing
   │  Enables: Request processing, but cannot execute tools yet (no integrations)
   │  Dependency: Needs Phase 1 (database, models)
   ↓
Phase 3: Memory and Tool Registry
   ↓
   │  Deliverables: PostgreSQL memory, JSONL sessions, tool manifest
   │  Enables: Tool execution framework, but tools have no integrations yet
   │  Dependency: Needs Phase 2 (authorization for tool execution)
   ↓
Phase 5: Integrations (stubbed Google, HA health tracking)
   ↓
   │  Deliverables: Integration adapters, stubbed implementations, health tracking
   │  Enables: Tools can now call integrations (even if stubbed)
   │  Dependency: Needs Phase 3 (tools need integrations to be useful)
   │  Why before Phase 4/6: Calendar/contacts tools need integration stubs
   ↓
Phase 4: Self-Configuration Tools (renamed from 3B)
   ↓
   │  Deliverables: Four-tier security model, approval workflow, config tools
   │  Enables: Conversational configuration with safety guardrails
   │  Dependency: Needs Phase 5 (some config tools may need integrations)
   │  Why before Phase 6: LLM integration should be configurable via tools
   ↓
Phase 6: LLM Integration
   ↓
   │  Deliverables: Anthropic, OpenAI, Ollama providers, fallback chain
   │  Enables: Actual assistant conversations (finally!)
   │  Dependency: Needs Phase 4 (LLM should be configurable conversationally)
   │  Why separate phase: Tool execution and integrations should work without LLM first
   ↓
Phase 7: Skills (requires tools + LLM)
   ↓
   │  Deliverables: Skill abstraction, composite behaviors
   │  Enables: Higher-level multi-tool workflows
   │  Dependency: Needs Phase 6 (skills orchestrate tools via LLM)
   ↓
Phase 8: CLI Enhancement & Config Export
   ↓
   │  Deliverables: Config export/import, doctor command, session replay
   │  Enables: Production-ready CLI tooling
   │  Dependency: Needs all previous phases (validates entire system)
   ↓
Phase 9: Testing and Refinement
   ↓
   │  Deliverables: Comprehensive tests, security audit, performance benchmarks
   │  Enables: Production readiness
   │  Dependency: Needs complete system (tests everything)
   ↓
Phase 10: Optional REST APIs (Future)
   │  Deliverables: REST endpoints for future UI
   │  Enables: Web UI development (post-v1)
   │  Status: Optional, can defer
```

**Key Dependency Fixes:**
1. ✅ **Phase 5 (Integrations) before Phase 4 (Self-Config Tools)** - Calendar/contacts tools need integration stubs
2. ✅ **Phase 4 (Self-Config) before Phase 6 (LLM)** - LLM should be configurable conversationally
3. ✅ **Phase 6 (LLM) before Phase 7 (Skills)** - Skills require LLM to orchestrate tools
4. ✅ **Phase 9 (Testing) near end** - Tests require complete system
5. ✅ **Renamed Phase 3B → Phase 4** - More logical numbering

---

## Phase 1: Architecture and Scaffolding

**Goal**: Establish repository structure, core domain models, database foundation, CLI scaffolding, and development environment with hot reload.

**Key Deliverables:**
- Repository with clean modular structure
- Core TypeScript interfaces: Person, Household, Tool, ChannelAdapter, Permission
- PostgreSQL database with Drizzle/Prisma
- Database migrations for core tables (persons, households, permissions, memory_entries)
- Person model with role field (admin, member, limited)
- Granular permission system (person_permissions table)
- Resource limits configuration (request size, concurrency, timeouts)
- Structured logging with pino
- JSONL execution logger
- CLI scaffolding with Commander.js
- Basic CLI commands: household, person, config, permissions
- Dev mode with hot reload (nodemon or tsx watch)
- Secrets management with encrypted storage

**Scope Boundaries:**
- No LLM integration yet
- No real integrations (stubbed in Phase 5)
- No WebSocket server (Phase 2)
- Focus on foundation and data models

---

## Phase 2: Core Request Pipeline & Event System

**Goal**: Build identity resolution, authorization system, lifecycle events, WebSocket channel, pairing flow, and request cancellation.

**Key Deliverables:**
- Deterministic identity resolution (no LLM)
- Pairing service for unknown identities (6-digit codes, 15-min expiry)
- Authorization service with role-based and granular permissions
- `checkPermission` function (role-aware, permission-aware)
- Permission checks before all tool executions
- Resource limit enforcement (request size, concurrency, rate limiting)
- Lifecycle event system (hook-based for future plugins)
- WebSocket channel adapter (implements ChannelAdapter interface)
- Socket.io WebSocket server at `/assistant` endpoint
- Event broadcasting (status, tool, chunk, complete, cancelled)
- Request cancellation with AbortSignal propagation
- Basic orchestration with explicit dependency injection
- JSONL execution trace writer
- CLI commands: `sessions list`, `sessions show`, `identity pair`, `identity pending`
- Unknown identity blocking (security default)

---

## Phase 3: Memory and Tool Registry

**Goal**: Implement PostgreSQL memory storage, JSONL session files, manifest-based tool registry, and session lifecycle management.

**Key Deliverables:**
- PostgreSQL memory provider with scoping (household/person)
- Full-text search for memory queries
- Session working memory (JSONL files)
- Session lifecycle management (create, get, close, cleanup)
- Session file rotation (when maxSessionFileSize exceeded)
- Tool manifest system (bundled/managed/workspace)
- Tool registry with manifest loading
- Base Tool interface with async execution and cancellation support
- Initial bundled tools with authorization
- Tool execution with AbortSignal (respects cancellation)
- Tool execution logging to JSONL
- CLI commands: `tools list`, `tools info`, `sessions cleanup`, `sessions close`

**File Structure:**
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

---

## Phase 4: Self-Configuration Tools (Secure)

**Goal**: Enable safe conversational configuration with security boundaries that prevent privilege escalation while allowing helpful self-service.

**Security Philosophy**: Balance convenience with security through a four-tier permission model. See [SECURITY_MODEL.md](./SECURITY_MODEL.md) for complete details on the four-tier model.

**Key Deliverables:**
- Four-tier permission model (Read-Only, Self-Scoped, Approval-Required, Admin-Only)
- Tool exposure filtering (Tier 4 tools hidden from LLM)
- Self-scope validation (prevent cross-person configuration)
- Approval workflow with 60-second timeout
- Credential redaction system (`@secret` annotation)
- Approval audit logging
- Rate limiting for approval requests

**Tier 1 Tools (Read-Only)**: Safe read operations available to all authenticated users
- `system.health`, `config.get`, `llm.list`, `llm.test`, `integration.list`, `integration.test`, `tools.list`, `memory.search`, `sessions.list`

**Tier 2 Tools (Self-Scoped)**: Users can configure themselves only
- `person.configure.self`, `session.configure`
- Validation enforces: `requestingPerson.id === targetPerson.id`

**Tier 3 Tools (Approval-Required)**: Sensitive operations requiring explicit confirmation
- `llm.add`, `integration.connect`
- Requires user to type 'APPROVE' within 60 seconds

**Tier 4 Operations (Admin-Only)**: CLI-only, never exposed to LLM
- `system.configure`, `permissions.grant`, `secrets.rotate`, `household.delete`, `database.migrate`, `person.delete`
- Requires physical CLI access

**Example Conversations:**

Safe (Tier 2 - Self-Scoped):
```
User: "Switch to verbose mode"
Assistant: *calls session.configure({ verbose: true })*
Assistant: "Verbose mode enabled for this session"
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

Blocked (Cross-Person):
```
User: "Change Jane's default LLM to GPT"
Assistant: "I can only configure your own settings. To change Jane's settings, she needs to:

1. Log in and configure herself
2. Or ask an admin via CLI if needed

This prevents unauthorized access to other users' accounts."
```

**Security Tests:**
- Self-scoped tools cannot target other users
- Tier 4 tools not callable via conversation
- Credentials redacted in all logs
- Approval timeout enforced
- Cross-person configuration blocked
- Privilege escalation prevented

---

## Phase 7: Skills

**Goal**: Higher-level behaviors composed from tools.

**Key Deliverables:**
- Lightweight skill abstraction
- Example composite skills (e.g., "schedule meeting" = check calendar + create event)
- Simple, explicit skill loading (no complex plugin system)

---

## Phase 5: Tool System & MCP Integration

**Goal**: Implement three-tier tool architecture with MCP as the primary integration method, capability discovery system, and verified MCP servers for testing.

**Architectural Overview:**

The platform uses a **three-tier tool architecture**:
1. **Bundled Tools** (5-10 core capabilities): Direct access to platform services
2. **Adapter-Based Tools** (special cases): Custom code for bidirectional communication
3. **MCP-Based Tools** (primary method): Standard Model Context Protocol integrations

See [TOOLS.md](../TOOLS.md) for complete architecture documentation.

**Key Deliverables:**

**1. Three-Tier Tool Architecture:**
- ToolSource interface (unified capability discovery)
- Bundled tool implementation (5-10 core tools)
- Adapter tool interface (for bidirectional communication)
- MCP tool integration (primary integration method)

**2. Bundled Tools (5-10 core capabilities):**
- `memory.search` - Search personal/shared memories
- `memory.store` - Store memories with scope
- `session.configure` - Configure current session
- `system.health` - Check system health
- `config.get` - Read configuration values

**3. MCP Server Framework:**
- MCPServerRunner interface implementation
- Per-person MCP server spawning
- Process isolation (v1: child processes)
- MCP protocol client implementation
- Server lifecycle management (start, stop, restart)
- Credential isolation (per-person encrypted credentials)
- Health monitoring and graceful degradation

**4. Capability Discovery System:**
- Dynamic capability discovery from all tool sources
- Database schema (tool_capabilities, capability_grants, shared_capability_grants)
- Capability refresh mechanism
- CLI commands: `capabilities discover`, `list`, `show`, `refresh`

**5. MCP Server Installation (2-3 verified servers for testing):**
- Verified server allowlist (security in v1)
- Google Calendar MCP server (@modelcontextprotocol/server-google-calendar)
- GitHub MCP server (@modelcontextprotocol/server-github)
- Filesystem MCP server (@modelcontextprotocol/server-filesystem)

**6. CLI Commands:**
- **Capabilities**: `discover`, `list`, `show`, `grant`, `revoke`, `refresh`
- **MCP Servers**: `add`, `remove`, `list`, `show`, `ps`, `start`, `stop`, `restart`
- **MCP Credentials**: `connect`, `disconnect`, `connections`, `test`, `refresh`
- **MCP Health**: `health`, `logs`, `verified`

**Database Schema:**

```sql
-- Discovered capabilities from all tool sources
CREATE TABLE tool_capabilities (
  id UUID PRIMARY KEY,
  source_type VARCHAR(20) NOT NULL, -- 'bundled' | 'adapter' | 'mcp'
  source_name VARCHAR(100) NOT NULL,
  capability_name VARCHAR(200) NOT NULL UNIQUE,
  description TEXT NOT NULL,
  input_schema JSONB NOT NULL,
  required_permissions TEXT[] NOT NULL,
  metadata JSONB,
  discovered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_verified TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  stale BOOLEAN DEFAULT FALSE
);

-- Per-person capability grants
CREATE TABLE capability_grants (
  id UUID PRIMARY KEY,
  person_id UUID NOT NULL REFERENCES persons(id),
  capability_name VARCHAR(200) NOT NULL REFERENCES tool_capabilities(capability_name),
  granted_by UUID REFERENCES persons(id),
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  UNIQUE(person_id, capability_name)
);

-- Shared capability grants (e.g., dad shares calendar with son)
CREATE TABLE shared_capability_grants (
  id UUID PRIMARY KEY,
  owner_id UUID NOT NULL REFERENCES persons(id),
  grantee_id UUID NOT NULL REFERENCES persons(id),
  capability_name VARCHAR(200) NOT NULL REFERENCES tool_capabilities(capability_name),
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  UNIQUE(owner_id, grantee_id, capability_name)
);

-- Per-person MCP credentials
CREATE TABLE mcp_credentials (
  id UUID PRIMARY KEY,
  person_id UUID NOT NULL REFERENCES persons(id),
  server_name VARCHAR(100) NOT NULL,
  credentials JSONB NOT NULL, -- EncryptedCredentials object
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(person_id, server_name)
);

-- MCP server instances
CREATE TABLE mcp_server_instances (
  id UUID PRIMARY KEY,
  person_id UUID NOT NULL REFERENCES persons(id),
  server_name VARCHAR(100) NOT NULL,
  process_id INTEGER,
  status VARCHAR(20) NOT NULL, -- 'starting' | 'running' | 'stopped' | 'failed'
  last_health_check TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  stopped_at TIMESTAMPTZ,
  UNIQUE(person_id, server_name)
);
```

**Example Workflows:**

**Workflow 1: Install Google Calendar MCP server**
```bash
# 1. Admin installs MCP server (adds to verified allowlist)
$ family-assistant mcp add google-calendar \
  --command "npx" \
  --args "-y @modelcontextprotocol/server-google-calendar"

# 2. Discover capabilities
$ family-assistant capabilities discover mcp:google-calendar
Discovered capabilities:
  - google-calendar:read (List and view events)
  - google-calendar:write (Create and modify events)
  - google-calendar:delete (Delete events)

# 3. Dad connects his Google Calendar
$ family-assistant mcp connect google-calendar
# OAuth flow opens in browser
# Credentials stored encrypted for dad

# 4. Dad's MCP server spawned automatically
# Server runs with dad's OAuth tokens

# 5. Dad grants calendar access to son
$ family-assistant capabilities grant \
  --person son \
  --capability google-calendar:read \
  --owner dad

# 6. Son asks assistant about dad's calendar
Son: "What's on dad's calendar tomorrow?"
# System routes to dad's MCP server instance
# Uses dad's credentials to fetch events
```

**Workflow 2: Bundled tool execution**
```bash
# User asks to search memories
User: "What did I say about vacation last month?"

# System executes bundled memory.search tool
# - Direct access to Memory Service (no MCP needed)
# - Scoped to person's private + household shared memories
# - Returns relevant memories
```

**Security Considerations:**

**v1: Process Isolation + Verified Allowlist**
- MCP servers run as child processes (one per person per server)
- Only verified servers on allowlist can be installed
- Manual security review for each MCP server
- Credentials passed via environment variables (encrypted at rest)
- Process boundaries provide basic isolation

**v2: Container Isolation (Future - Phase 11)**
- MCP servers run in Docker/Podman containers
- Resource limits (CPU, memory, network)
- Network policies (restrict egress)
- Remove need for manual allowlist
- Stronger security for untrusted servers

**Testing:**

**Capability Discovery:**
- Discover capabilities from bundled tools
- Discover capabilities from MCP servers
- Capability refresh updates database
- Stale capabilities removed

**MCP Server Lifecycle:**
- Spawn MCP server per person
- Server starts successfully
- Health checks detect failures
- Restart failed servers
- Graceful shutdown on disconnect

**MCP Tool Execution:**
- Execute tool via person's MCP server
- Credentials isolated per person
- Shared capability execution (son uses dad's server)
- Permission checks enforce capability grants

**Security:**
- Allowlist prevents installation of unverified servers
- Credentials encrypted at rest
- Credentials decrypted only when spawning server
- Process isolation prevents credential leakage between persons
- Capability grants checked before execution

---

## Phase 6: LLM Integration

**Goal**: Multi-provider LLM support with fallback chain, including local models via Ollama.

**Key Deliverables:**
- LLM provider interface (swappable, supports API and local)
- Anthropic provider (Claude)
- OpenAI provider (GPT)
- Ollama provider (local LLM runtime)
- LLM selector with fallback chain
- Provider hierarchy (person → household → system)
- LLM invocations logged to `llm_invocations` table
- Health checking for all providers
- WebSocket response streaming
- CLI commands: `llm add`, `llm test`, `llm list`

**Ollama Setup Example:**
```bash
# Prerequisites: Ollama installed locally (https://ollama.ai)

# Add Ollama provider
family-assistant llm add --provider ollama --endpoint http://localhost:11434

# Pull model via Ollama CLI
ollama pull llama3

# Configure household to use Ollama
family-assistant config set llm.household.default ollama:llama3

# Test connectivity
family-assistant llm test --provider ollama
```

---

## Phase 8: CLI Enhancement & Config Export

**Goal**: Complete CLI with all configuration commands, config export/import, interactive setup, and diagnostics.

**Key Deliverables:**
- Complete CLI interface for all operations
- Interactive setup wizard (`family-assistant init`)
- Config export/import (git-trackable YAML)
- Session replay (`family-assistant sessions replay <id>`)
- Doctor command (health checks with auto-fix)
- Enhanced dev mode with better logging
- Pairing management commands
- Comprehensive CLI help and documentation
- CLI tests

**CLI Command Reference**: See [CLI_DESIGN.md](./CLI_DESIGN.md) for complete command reference.

**Key Commands:**
```bash
# Setup
family-assistant init                    # Interactive setup wizard

# Development
family-assistant dev                     # Start with hot reload
family-assistant dev --verbose           # Debug logging

# Diagnostics
family-assistant doctor                  # System health check
family-assistant doctor --fix            # Auto-fix common issues

# Configuration
family-assistant config export > config.yaml
family-assistant config import config.yaml
family-assistant config validate

# Sessions & debugging
family-assistant sessions list
family-assistant sessions show <session-id>
family-assistant sessions replay <session-id>
family-assistant sessions cleanup --days 30
```

**Doctor Command Checks:**
- Database connectivity and schema validation
- LLM provider API keys (test connection)
- Integration credentials validation
- File permissions (~/.family-assistant/)
- Port availability (WebSocket)
- Session file integrity
- Disk space availability

---

## Phase 9: Testing and Refinement

**Goal**: Comprehensive test coverage, performance optimization, and security audit.

**Testing Strategy:**

**Unit Tests** (`test:unit`):
- Pure functions (identity resolution, authorization logic)
- Tool schema validation
- Memory scope enforcement
- Pairing code generation/validation
- Resource limit enforcement
- No I/O dependencies (mocked)

**Integration Tests** (`test:integration`):
- Database operations
- File system operations (JSONL logs)
- Tool execution with mocked integrations
- WebSocket connection handling
- Channel adapter lifecycle
- Session lifecycle
- Configuration import/export

**End-to-End Tests** (`test:e2e`):
- Full request lifecycle (message → tool → LLM → response)
- Multi-step tool workflows
- Request cancellation
- CLI command validation
- Pairing flow
- Graceful degradation scenarios

**Live Tests** (`test:live`) - Optional:
- Real LLM provider calls (Anthropic, OpenAI, Ollama)
- Real Google API integration
- Run manually before releases (expensive, slow)

**Coverage Requirements:**
- Core security functions (pairing, authorization): **100%**
- Identity resolution: **100%**
- Resource limit enforcement: **100%**
- Tool execution: **>90%**
- Integration adapters: **>80%**
- CLI commands: **>80%**
- Overall: **>85%**

**Key Deliverables:**
- Comprehensive test suite with multiple test profiles
- >85% test coverage
- Performance benchmarks
- Security audit (secrets, permissions, SQL injection, pairing flow)
- Complete documentation (architecture, CLI usage, tool development, deployment)

---

## Phase 10: Optional REST APIs (Future)

**Goal**: Enable future UI without architectural changes.

**Status**: Optional for v1, can be deferred until UI is actually needed.

**Key Deliverables:**
- REST endpoints for configuration
- REST endpoints for session queries
- Authentication middleware
- OpenAPI/Swagger documentation
- API tests

---

## Phase 11: Container Isolation for MCP Servers (Future)

**Goal**: Replace process isolation with container-based isolation for MCP servers, enabling untrusted community servers and removing the need for manual allowlist verification.

**Status**: Future phase, not required for v1. v1 ships with process isolation + verified allowlist.

**Motivation:**

In v1, MCP servers run as child processes with a verified allowlist. This requires manual security review for each server and limits the community ecosystem. Container isolation provides stronger security guarantees, allowing users to install any MCP server safely.

**Key Deliverables:**

**1. Container Runtime Integration:**
- Docker/Podman container runtime support
- Container image building and caching
- Container lifecycle management (create, start, stop, remove)
- Container health monitoring

**2. Resource Limits:**
- CPU limits (prevent resource exhaustion)
- Memory limits (prevent OOM)
- Disk quotas (prevent disk filling)
- Network bandwidth limits

**3. Network Policies:**
- Restrict egress to required hosts only
- Example: GitHub MCP server can only connect to github.com
- Block local network access (prevent scanning)
- DNS filtering

**4. Security Context:**
- Read-only root filesystem
- Run as non-root user
- Minimal Linux capabilities
- AppArmor/SELinux profiles
- Seccomp filters

**5. Remove Allowlist Requirement:**
- Users can install any MCP server
- Container security provides protection
- Community ecosystem unlocked
- Still maintain recommended/verified list for discovery

**Container Configuration Example:**

```typescript
interface MCPServerContainerConfig {
  image: string;                          // Docker image
  cpuLimit: number;                       // CPU cores
  memoryLimit: string;                    // '512Mi', '1Gi'
  networkPolicy: 'none' | 'restricted' | 'full';
  allowedHosts?: string[];                // Whitelist for 'restricted' mode
  volumeMounts: VolumeMount[];
  securityContext: {
    readOnlyRootFilesystem: boolean;
    runAsNonRoot: boolean;
    allowPrivilegeEscalation: boolean;
    capabilities: string[];               // Minimal Linux capabilities
  };
}

// Example: GitHub MCP server with restricted network
const githubConfig: MCPServerContainerConfig = {
  image: 'modelcontextprotocol/server-github:latest',
  cpuLimit: 0.5,                         // Half a CPU core
  memoryLimit: '512Mi',                  // 512 MB RAM
  networkPolicy: 'restricted',
  allowedHosts: ['github.com', 'api.github.com'],
  securityContext: {
    readOnlyRootFilesystem: true,
    runAsNonRoot: true,
    allowPrivilegeEscalation: false,
    capabilities: [],                    // No special capabilities
  },
};
```

**Migration from Process to Container:**

- v1 installations continue with process isolation
- v2 opt-in: Users can enable container isolation
- Automatic migration tool converts process configs to container configs
- Feature flag for gradual rollout
- Both modes supported during transition

**Security Benefits:**

| Feature | v1 (Process) | v2 (Container) |
|---------|--------------|----------------|
| Credential isolation | ✓ | ✓ |
| Filesystem isolation | Partial | Full (read-only root) |
| Network isolation | None | Restricted egress |
| Resource limits | OS-level | Container-level |
| Privilege escalation | Possible | Blocked |
| Manual verification | Required | Optional |
| Community ecosystem | Limited | Full |

**Testing:**

- Container spawning and lifecycle
- Resource limits enforced (CPU, memory, disk)
- Network policies block unauthorized hosts
- Security context prevents privilege escalation
- Migration from process to container
- Rollback to process isolation if needed

---

## Future Considerations (Post-v1)

Features not required for v1 but planned for future releases:

- **Phase 11: Container Isolation** (see above)
- Admin UI (web-based configuration and monitoring)
- Sub-agent architecture for autonomous multi-step workflows
- MCP server support (expose assistant capabilities externally as MCP server)
- Advanced lifecycle hooks and middleware
- Additional transport channels (Telegram, WhatsApp, SMS)
- Timeline and hierarchy visualizations
- Analytics dashboards with aggregated metrics
- Voice input/output integration
- Managed/workspace tool installation (plugin marketplace)
- Horizontal scaling (session-based distribution)
- Multi-tenant support (multiple households with isolation)

---

## Success Criteria

v1 is successful if:

**Identity & Authorization:**
- Multiple persons in a household can interact with the assistant
- Each person connects to their own service instances (Google, etc.)
- Three-tier role model works (admin, member, limited)
- Granular permissions can be granted and revoked via CLI
- Integration sharing permissions work (e.g., dad grants kids read access to his calendar)
- Limited role members can be given specific permissions
- Admin role has all permissions automatically
- Member role has standard household permissions
- Unknown identities are blocked until paired (security default)
- Pairing flow works (6-digit codes, CLI approval)
- Identity is correctly resolved and authorization is enforced
- Permission checks happen before all tool executions

**Resource Management & Cancellation:**
- Resource limits prevent abuse (request size, concurrency, rate limiting)
- Requests can be cancelled (long operations interruptible)
- Tools respect cancellation (AbortSignal propagation)

**LLM & Integrations:**
- LLM provider selection works with proper fallback chain
- Ollama integration works (local LLM option available)
- LLM usage is tracked (provider, tokens, invocations)
- Integration health tracking works (detect failures, degrade gracefully)
- System continues with available integrations (graceful degradation)
- Per-person integration credentials work
- Device control delegated to home automation platforms (Home Assistant permissions respected)

**Self-Configuration Security:**
- Self-configuration works safely via conversation (four-tier security model)
- Users can configure themselves via conversation (self-scoped tools)
- Sensitive operations require approval (llm.add, integration.connect)
- Cross-person configuration is blocked
- Credentials are never logged (redacted to [REDACTED])
- Approval workflow works (60-second timeout, requires 'APPROVE')
- Admin operations remain CLI-only (physical security)

**Configuration & Operations:**
- All configuration manageable via CLI
- Configuration can be exported/imported (git-trackable)
- Execution history viewable via CLI (`family-assistant sessions show`)
- Session cleanup works (old sessions removed, disk managed)
- Doctor command works (health checks, diagnostics)
- Dev mode works (hot reload, fast iteration)

**Core Architecture:**
- Memory boundaries are never violated (PostgreSQL enforces scope)
- All requests are fully traceable through JSONL logs
- Secrets and credentials are stored securely
- Failed tool executions are handled gracefully with appropriate error messages
- The architecture is modular and can evolve (plugins, lifecycle hooks)
- Channel abstraction supports future channels (Telegram, WhatsApp ready)
- Lifecycle events enable plugins without core modifications
- Tests validate core security and traceability requirements
- System remains responsive under normal household usage patterns
- No UI required for full functionality

---

## Implementation Principles

**Incremental Delivery:**
- Ship working functionality at each phase
- Each phase builds on previous phases
- Test and validate before moving forward

**Test as You Build:**
- Write tests alongside implementation
- Maintain >85% code coverage
- 100% coverage for security-critical functions

**Keep Core Lean:**
- Lightweight orchestration engine
- Capabilities ship as plugins/extensions
- Avoid framework magic

**Documentation Alongside Code:**
- Update docs with each phase
- CLI help text for all commands
- Architecture documentation
- Tool development guides
