# CLI Design and Reference

## Philosophy

The Family Assistant platform adopts a **CLI-first approach** for v1, prioritizing terminal-based configuration and file-based management before building UI.

**Core Principles** (from Key Decisions lines 2362-2383):

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

**Why Terminal-First by Design** (from Core Philosophy lines 7-11):
- **Lean Core + Rich Extensions**: Keep the core orchestrator lightweight; capabilities ship as plugins
- **Local-First**: Configuration via CLI and files, with optional UI later
- **Explicit over Hidden**: Favor deterministic, traceable code over framework magic
- **Terminal-First by Design**: CLI and file-based config ensure understanding and git-trackability

---

## Configuration Architecture

### Layered Configuration

The system employs a three-tier configuration strategy (from lines 809-828):

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

### File Structure

Configuration lives in `~/.family-assistant/` (from lines 621-633):

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

**Benefits**:
- Git-trackable configuration
- No UI dependency for v1
- Terminal-first ensures understanding
- Faster to implement than full UI
- Can add UI later when usage patterns are clear

---

## Command Reference

### Setup and Initialization

```bash
# Interactive setup wizard
family-assistant init
```

---

### Development Workflow

**Start Development Server** (from lines 1036-1055, 1879-1883):

```bash
# Start with hot reload
family-assistant dev

# Debug logging enabled
family-assistant dev --verbose

# Node debugger on port 9229
family-assistant dev --inspect
```

**Hot Reload Features** (from Key Decisions lines 2387-2390):
- File watcher monitors source and config changes
- Fast iteration during development
- No manual restart needed

**Diagnostics and Health Checks**:

```bash
# System health check
family-assistant doctor

# Auto-fix common issues
family-assistant doctor --fix
```

**Doctor Checks** (from lines 1943-1952):
- Database connectivity
- Required tables exist with correct schema
- LLM provider API keys valid (test connection)
- Integration credentials valid
- File permissions correct (`~/.family-assistant/`)
- Port availability (WebSocket port)
- Session file integrity
- Disk space availability

---

### Household Management

```bash
# Create a new household
family-assistant household create <name>

# List all households
family-assistant household list
```

---

### Person Management

```bash
# Add person with standard member role
family-assistant person add --name "John" --email "john@example.com" --role member

# Add person with limited access
family-assistant person add --name "Grandma" --role limited

# List all persons in household
family-assistant person list

# Show detailed person information
family-assistant person show <person-id>
```

**Role Definitions**:

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
  - Example: Grandma can read dad's calendar if he grants her `integrations.share.calendar.read`
  - Device control delegated to connected integrations (e.g., Home Assistant)

---

### Permission Management

The platform uses **two permission systems**:

1. **Legacy role-based permissions** (for system-level operations)
2. **Capability-based permissions** (for tool execution - recommended)

See [Capability Management](#capability-management) section for the modern capability-based approach.

**Role-Based Permissions (Legacy):**

Used for system-level operations like managing users, configuring settings, etc.

```bash
# Change role (admin-only operation, requires CLI access)
family-assistant permissions set-role --person john --role admin

# Grant explicit permission to limited role user
family-assistant permissions grant --person grandma --permission memory.read.shared

# Revoke permission
family-assistant permissions revoke --person grandma --permission memory.read.shared

# List explicit permissions granted to a limited role user
family-assistant permissions list --person grandma
```

**Capability-Based Permissions (Recommended):**

For tool execution, use the modern capability-based system:

```bash
# Grant capability to person
family-assistant capabilities grant \
  --person john \
  --capability google-calendar:read

# Grant shared capability (dad shares his calendar with son)
family-assistant capabilities grant \
  --person son \
  --capability google-calendar:read \
  --owner dad

# List capabilities granted to person
family-assistant capabilities list --person john

# List shared capabilities
family-assistant capabilities list-shared-with --person son
family-assistant capabilities list-shared-by --person dad
```

See [Capability Management](#capability-management) for complete capability commands.

**Example Use Cases**:
- **Kids viewing parent's calendar**: Dad grants `integrations.share.calendar.read` to kids so they can ask "What days do I have school this week?"
- **Shared home control**: Dad grants `integrations.share.homeassistant` to wife so she can control lights using his Home Assistant account
- **Limited calendar editing**: Dad grants `integrations.share.calendar.write` to wife so she can add family events

---

### Identity Management

**Pairing Flow** (from lines 905-929):

1. Unknown identifier sends message to a channel
2. System generates 6-digit pairing code (expires in 15 minutes)
3. System responds via channel: "To link this identity, run: `family-assistant identity pair --code ABC123 --person <name>`"
4. User runs CLI command to approve pairing (requires physical CLI access)
5. Identity linked; future messages from this identity are processed normally

**CLI Commands** (from lines 597-600, 917-929, 1907-1915):

```bash
# Manual pairing request generation
family-assistant identity pair-request --channel telegram --identifier "@username"

# Approve pairing (links identity to person)
family-assistant identity pair --code ABC123 --person john

# List pending pairing requests
family-assistant identity pending

# Link identity manually
family-assistant identity link --person <id> --phone "+1234567890"
family-assistant identity link --person <id> --telegram "@username"

# Revoke identity
family-assistant identity revoke --identity-id <id>

# List all identities
family-assistant identity list
```

**Security Considerations**:
- Pairing codes expire after 15 minutes
- Failed pairing attempts are logged and audited
- Pairing requires physical access to CLI (secure by design)
- Rate limiting prevents brute-force attacks on pairing codes
- Unknown identities cannot execute tools or access memory

---

### LLM Provider Management

**CLI Commands** (from lines 601-605, 1916-1921):

```bash
# Add LLM providers
family-assistant llm add --provider anthropic --api-key "..."
family-assistant llm add --provider openai --api-key "..."
family-assistant llm add --provider ollama --endpoint http://localhost:11434

# List configured providers
family-assistant llm list

# Test connectivity
family-assistant llm test --provider anthropic
```

**Ollama Setup - Complete Example** (from lines 2199-2216):

Ollama provides local, private LLM inference without API costs:

```bash
# 1. Install Ollama (https://ollama.ai)
brew install ollama  # macOS
# or download from https://ollama.ai

# 2. Start Ollama service
ollama serve

# 3. Pull models
ollama pull llama3
ollama pull mistral

# 4. Add Ollama as a provider in Family Assistant
family-assistant llm add --provider ollama \
  --endpoint http://localhost:11434 \
  --model llama3

# 5. Set as household default (all family members use it)
family-assistant config set llm.household.default ollama:llama3

# 6. Set as system fallback (used when primary fails)
family-assistant config set llm.system.fallback ollama:mistral

# 7. Test connectivity
family-assistant llm test --provider ollama

# 8. Check available models
family-assistant llm list --provider ollama
```

**LLM Provider Hierarchy and Fallback**:

The system supports a three-tier fallback strategy:

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

**Hardware Recommendations**:
- **Minimum**: 8GB RAM, 4-core CPU (small models like Phi-3)
- **Recommended**: 16GB RAM, 8-core CPU (Llama 3 8B)
- **Optimal**: 32GB+ RAM, GPU with 8GB+ VRAM (larger models, faster inference)

---

### Tool Management

```bash
# List available tools
family-assistant tools list

# Show detailed tool information
family-assistant tools info <tool-name>

# Install additional tools (future)
family-assistant tools install <tool-package>
```

---

### Capability Management

The platform uses a **dynamic capability-based permission system** where capabilities are discovered from tool sources (bundled, adapter, MCP) rather than hard-coded. See [TOOLS.md](./TOOLS.md) for architecture details.

**Capability Discovery:**

```bash
# Discover capabilities from all tool sources
family-assistant capabilities discover

# Discover from specific source
family-assistant capabilities discover mcp:google-calendar
family-assistant capabilities discover adapter:home-assistant
family-assistant capabilities discover bundled:core

# Refresh all capabilities (re-discover from all sources)
family-assistant capabilities refresh
```

**List and Show Capabilities:**

```bash
# List all discovered capabilities
family-assistant capabilities list

# List capabilities by category
family-assistant capabilities list --category calendar
family-assistant capabilities list --category home-automation

# List capabilities by source
family-assistant capabilities list --source mcp:google-calendar

# Show detailed capability information
family-assistant capabilities show google-calendar:read

# Example output:
#   Capability: google-calendar:read
#   Description: List and view Google Calendar events
#   Source: mcp:google-calendar
#   Required Permissions: google-calendar:read
#   Category: calendar
#   Tags: google, calendar, events
```

**Grant and Revoke Capabilities:**

```bash
# Grant capability to person
family-assistant capabilities grant \
  --person john \
  --capability google-calendar:read

# Grant shared capability (owner's tool to grantee)
# Example: Dad shares his Google Calendar read access with son
family-assistant capabilities grant \
  --person son \
  --capability google-calendar:read \
  --owner dad

# Grant with expiration
family-assistant capabilities grant \
  --person guest \
  --capability google-calendar:read \
  --owner dad \
  --expires "2026-12-31"

# Revoke capability
family-assistant capabilities revoke \
  --person john \
  --capability google-calendar:read

# Revoke shared capability
family-assistant capabilities revoke \
  --person son \
  --capability google-calendar:read \
  --owner dad
```

**List Grants:**

```bash
# List person's granted capabilities
family-assistant capabilities list --person john

# List shared capabilities granted TO person
family-assistant capabilities list-shared-with --person son

# List shared capabilities granted BY person
family-assistant capabilities list-shared-by --person dad

# Example output:
#   Capabilities granted to son by dad:
#     - google-calendar:read (expires: never)
#     - google-calendar:write (expires: 2026-12-31)
```

---

### MCP Server Management

**MCP (Model Context Protocol)** is the primary integration method for external tools. Each person gets their own MCP server instance with isolated credentials. See [TOOLS.md](./TOOLS.md) for complete MCP architecture.

**Add and Remove MCP Servers:**

```bash
# Add MCP server to platform (admin only)
family-assistant mcp add google-calendar \
  --command "npx" \
  --args "-y @modelcontextprotocol/server-google-calendar"

# Add with Docker image (future v2)
family-assistant mcp add github \
  --image "modelcontextprotocol/server-github:latest"

# List installed MCP servers
family-assistant mcp list

# Example output:
#   Installed MCP servers:
#     - google-calendar (verified, 3 running instances)
#     - github (verified, 2 running instances)
#     - filesystem (verified, 1 running instance)

# Show MCP server details
family-assistant mcp show google-calendar

# Example output:
#   Server: google-calendar
#   Package: @modelcontextprotocol/server-google-calendar
#   Verified: Yes
#   Running instances: 3
#     - dad (pid: 12345, status: running)
#     - mom (pid: 12346, status: running)
#     - son (pid: 12347, status: running)

# Remove MCP server
family-assistant mcp remove google-calendar
```

**Start, Stop, Restart Servers:**

```bash
# Start MCP server for person
family-assistant mcp start --person john --server google-calendar

# Stop MCP server for person
family-assistant mcp stop --person john --server google-calendar

# Restart MCP server
family-assistant mcp restart --person john --server google-calendar

# List all running MCP server instances
family-assistant mcp ps

# Example output:
#   Running MCP servers:
#     - dad/google-calendar (pid: 12345, uptime: 2h 15m, healthy)
#     - mom/google-calendar (pid: 12346, uptime: 1h 30m, healthy)
#     - dad/github (pid: 12347, uptime: 45m, healthy)
```

**Health and Logs:**

```bash
# Check MCP server health
family-assistant mcp health --person john --server google-calendar

# View MCP server logs
family-assistant mcp logs --person john --server google-calendar

# Follow logs (tail -f)
family-assistant mcp logs --person john --server google-calendar --follow

# View logs for all instances of a server
family-assistant mcp logs --server google-calendar --all
```

**Credential Management:**

```bash
# Connect MCP integration (initiates OAuth flow)
family-assistant mcp connect google-calendar

# Example OAuth flow:
#   1. Opens browser to Google OAuth consent screen
#   2. User authorizes access
#   3. Tokens stored encrypted for this person
#   4. MCP server spawned with person's credentials

# Disconnect MCP integration
family-assistant mcp disconnect google-calendar

# List connected MCP integrations for person
family-assistant mcp connections --person john

# Example output:
#   Connected MCP integrations for john:
#     - google-calendar (connected: 2026-03-01, status: active)
#     - github (connected: 2026-03-10, status: active)

# Test MCP integration credentials
family-assistant mcp test google-calendar

# Refresh OAuth tokens
family-assistant mcp refresh google-calendar
```

**Allowlist Management (v1 only):**

In v1, only verified MCP servers can be installed for security. In v2, container isolation will remove this restriction.

```bash
# List verified MCP servers
family-assistant mcp verified

# Example output:
#   Verified MCP servers:
#     - google-calendar (@modelcontextprotocol/server-google-calendar)
#       Security notes: OAuth2 flow, read/write calendar access
#       Reviewed: 2026-03-01 by platform-team
#
#     - github (@modelcontextprotocol/server-github)
#       Security notes: Personal access token, repository access
#       Reviewed: 2026-03-01 by platform-team
#
#     - filesystem (@modelcontextprotocol/server-filesystem)
#       Security notes: Restricted to ~/Documents by default
#       Reviewed: 2026-03-01 by platform-team

# Check if server is verified
family-assistant mcp verified --server google-calendar
```

---

### Session and Debugging

**Session Management** (from lines 610-614, 1058-1063, 1926-1934):

```bash
# List all sessions
family-assistant sessions list

# Show active sessions only
family-assistant sessions active

# Show detailed session information
family-assistant sessions show <session-id>

# Replay session for debugging
family-assistant sessions replay <session-id>

# Close session manually
family-assistant sessions close <id>

# Remove old sessions (respects retention policy)
family-assistant sessions cleanup

# Remove sessions older than specified days
family-assistant sessions cleanup --days 30
```

**Real-Time Debugging** (from Key Decisions lines 2397-2400):
- Session files viewable with `tail -f`
- Session replay for bug reproduction
- Structured logs for tracing

Example:
```bash
# Watch session execution in real-time
tail -f ~/.family-assistant/data/sessions/<session-id>/execution.jsonl
```

---

### Configuration Export/Import

**CLI Commands** (from lines 606-609, 1865-1867, 1936-1941):

```bash
# Export configuration to YAML
family-assistant config export > config.yaml

# Import configuration from file
family-assistant config import config.yaml

# Validate configuration file
family-assistant config validate

# Set specific configuration value
family-assistant config set <key> <value>

# Get configuration value
family-assistant config get <key>
```

**Git Workflow Example**:

```bash
# Export current configuration
family-assistant config export > family-assistant-config.yaml

# Add to version control
git add family-assistant-config.yaml
git commit -m "Update family assistant configuration"
git push

# On another machine or after reset
git pull
family-assistant config import family-assistant-config.yaml
```

---

### Health and Diagnostics

**Health Monitoring** (from lines 1093-1097, 1887-1890):

```bash
# Show all integration health status
family-assistant health

# Check specific LLM provider
family-assistant health --provider anthropic

# Check specific integration
family-assistant health --integration google-calendar
```

---

### Resource Limits

**Configuration** (from lines 969-974):

```bash
# Set maximum request size (in bytes)
family-assistant config set limits.maxRequestSize 20971520  # 20MB

# Set maximum concurrent requests per person
family-assistant config set limits.maxConcurrentRequests 5

# View all resource limits
family-assistant config get limits
```

**Available Limits**:
- `maxRequestSize`: Maximum request size (default: 10MB)
- `maxConcurrentRequests`: Per person concurrent request limit (default: 3)
- `maxExecutionTime`: Maximum execution time in milliseconds (default: 300000ms / 5 min)
- `maxSessionFileSize`: Maximum session file size before rotation (default: 100MB)
- `maxMemoryEntriesPerPerson`: Maximum memory entries per person (default: 10000)
- `maxAuditLogDays`: Audit log retention in days (default: 90)
- `maxRequestsPerMinute`: Rate limit per person (default: 30)
- `maxToolExecutionsPerRequest`: Maximum tool executions per request (default: 20)

---

## Common Workflows

### First-Time Setup

1. **Install and initialize**:
   ```bash
   # Install Family Assistant
   npm install -g family-assistant

   # Run interactive setup
   family-assistant init
   ```

2. **Create household and admin user**:
   ```bash
   family-assistant household create "Smith Family"
   family-assistant person add --name "Dad" --email "dad@example.com" --role admin
   ```

3. **Configure LLM provider**:
   ```bash
   # Option 1: Use cloud provider
   family-assistant llm add --provider anthropic --api-key "sk-..."

   # Option 2: Use local Ollama
   ollama serve
   ollama pull llama3
   family-assistant llm add --provider ollama --endpoint http://localhost:11434 --model llama3
   ```

4. **Start the service**:
   ```bash
   family-assistant dev
   ```

---

### Adding a New Family Member

1. **Create person**:
   ```bash
   family-assistant person add --name "Mom" --email "mom@example.com" --role member
   ```

2. **Pair their messaging identity**:
   ```bash
   # Mom sends a message via Telegram
   # System responds with pairing code

   # Admin approves pairing
   family-assistant identity pair --code ABC123 --person mom
   ```

3. **Connect their integrations** (Mom does this herself):
   ```bash
   # Via natural language through assistant
   "Connect my Google Calendar"
   # OAuth flow happens, credentials stored
   ```

4. **Grant sharing permissions** (optional):
   ```bash
   # Dad allows Mom to read his calendar
   family-assistant permissions grant --person mom --permission integrations.share.calendar.read
   ```

---

### Granting Limited Access to Guest

**Scenario**: Grandma visits and needs limited assistant access

1. **Create limited user**:
   ```bash
   family-assistant person add --name "Grandma" --role limited
   ```

2. **Pair her device**:
   ```bash
   # Grandma sends message, gets pairing code
   family-assistant identity pair --code XYZ789 --person grandma
   ```

3. **Grant specific permissions**:
   ```bash
   # Allow reading Dad's calendar
   family-assistant permissions grant --person grandma --permission integrations.share.calendar.read

   # Allow reading shared household memory
   family-assistant permissions grant --person grandma --permission memory.read.shared
   ```

4. **Verify permissions**:
   ```bash
   family-assistant permissions list --person grandma
   ```

---

### Setting Up Local LLM with Ollama

**Complete setup from installation to testing** (from lines 2199-2216):

1. **Install Ollama**:
   ```bash
   # macOS
   brew install ollama

   # Or download from https://ollama.ai
   ```

2. **Start Ollama service**:
   ```bash
   ollama serve
   ```

3. **Pull desired models**:
   ```bash
   ollama pull llama3      # Meta's Llama 3 model
   ollama pull mistral     # Mistral AI model
   ```

4. **Configure Family Assistant**:
   ```bash
   # Add Ollama as a provider
   family-assistant llm add --provider ollama \
     --endpoint http://localhost:11434 \
     --model llama3
   ```

5. **Set as default or fallback**:
   ```bash
   # Set as household default (all family members use it)
   family-assistant config set llm.household.default ollama:llama3

   # OR set as system fallback (used when primary fails)
   family-assistant config set llm.system.fallback ollama:mistral
   ```

6. **Test connectivity**:
   ```bash
   family-assistant llm test --provider ollama
   ```

7. **Verify available models**:
   ```bash
   family-assistant llm list --provider ollama
   ```

---

### Debugging a Failed Request

1. **Check system health**:
   ```bash
   family-assistant health
   family-assistant doctor
   ```

2. **Find the session**:
   ```bash
   family-assistant sessions list
   family-assistant sessions show <session-id>
   ```

3. **Review real-time logs**:
   ```bash
   tail -f ~/.family-assistant/data/sessions/<session-id>/execution.jsonl
   ```

4. **Replay the session**:
   ```bash
   family-assistant sessions replay <session-id>
   ```

5. **Check integration health**:
   ```bash
   family-assistant health --integration google-calendar
   family-assistant health --provider anthropic
   ```

---

### Exporting Configuration for Version Control

**Git workflow for configuration backup**:

1. **Export current configuration**:
   ```bash
   family-assistant config export > family-assistant-config.yaml
   ```

2. **Review exported configuration**:
   ```bash
   cat family-assistant-config.yaml
   ```

3. **Add to version control**:
   ```bash
   git add family-assistant-config.yaml
   git commit -m "Add family assistant configuration"
   git push
   ```

4. **Restore on another machine**:
   ```bash
   git clone <repository>
   cd <repository>
   family-assistant config import family-assistant-config.yaml
   ```

5. **Validate imported configuration**:
   ```bash
   family-assistant config validate
   ```

---

## Interactive Development

### Hot Reload

**File Watcher Features** (from lines 1029-1055, Key Decisions 2385-2407):

- File watcher monitors source, config, and tool manifest changes
- Auto-restart server on changes
- Preserve active sessions across restarts when possible
- Fast iteration during development

```bash
# Start with hot reload (automatically restarts on file changes)
family-assistant dev
```

---

### Debug Mode

**Verbose Logging**:

```bash
# Enable debug logging
family-assistant dev --verbose
```

**Node Inspector**:

```bash
# Start with Node.js debugger on port 9229
family-assistant dev --inspect

# Then connect Chrome DevTools to:
# chrome://inspect
```

---

### Session Debugging

**Real-Time Monitoring**:

```bash
# Watch session execution live
tail -f ~/.family-assistant/data/sessions/<session-id>/execution.jsonl

# Show active sessions
family-assistant sessions active

# Show session details
family-assistant sessions show <session-id>
```

**Session Replay**:

```bash
# Replay a session for bug reproduction
family-assistant sessions replay <session-id>
```

---

## Configuration Reference

### Resource Limits

**Setting Limits** (from lines 969-974):

```bash
# Request limits
family-assistant config set limits.maxRequestSize 20971520       # 20MB
family-assistant config set limits.maxConcurrentRequests 5       # Per person
family-assistant config set limits.maxExecutionTime 300000       # 5 minutes (ms)

# Storage limits
family-assistant config set limits.maxSessionFileSize 104857600  # 100MB
family-assistant config set limits.maxMemoryEntriesPerPerson 10000
family-assistant config set limits.maxAuditLogDays 90

# Rate limiting
family-assistant config set limits.maxRequestsPerMinute 30       # Per person
family-assistant config set limits.maxToolExecutionsPerRequest 20

# View all limits
family-assistant config get limits
```

**Why Resource Limits Matter**:
- Household assistant runs on personal hardware with finite resources
- Prevents accidental resource exhaustion
- Security against malicious use
- Clear limits prevent surprising behavior

---

### LLM Provider Hierarchy

**Person → Household → System Fallback**:

Each person can have their own LLM preference, falling back to household default, then system fallback.

```bash
# Set person-specific LLM preference
family-assistant config set llm.person.dad.provider anthropic:claude-3-5-sonnet

# Set household default (used by all members without personal preference)
family-assistant config set llm.household.default openai:gpt-4

# Set system fallback (always available, used when others fail)
family-assistant config set llm.system.fallback ollama:llama3
```

**Example Configuration**:

```yaml
# Person preference: Anthropic Claude (high quality, costs money)
# Household default: OpenAI GPT-4 (good quality, some cost)
# System fallback: Ollama Llama3 (free, private, always available)

# Resolution behavior:
# 1. Try person's preference (Claude)
# 2. If unavailable, try household default (GPT-4)
# 3. If unavailable, use system fallback (Ollama)
# 4. System always has a working LLM
```

---

## Future: Optional REST APIs

**Phase 9: Admin UI (Optional)** - Note that v1 is CLI-only:

The admin UI is explicitly deferred to a future phase. All v1 functionality is accessible via CLI.

From the implementation plan:
- Admin UI is optional and built only after v1 proves core concepts
- UI will consume same APIs as CLI (when built)
- Nice-to-have, not required for v1
- CLI-first approach enables faster delivery and ensures understanding

**Benefits of CLI-First**:
- No UI dependency for v1
- Faster to implement
- Terminal-first ensures understanding
- Can add UI later when usage patterns are clear
- Git-trackable configuration
- Reproducible deployments

---

## Complete Command Index

### Setup
```bash
family-assistant init                    # Interactive setup wizard
```

### Development
```bash
family-assistant dev                     # Start with hot reload
family-assistant dev --verbose           # Debug logging
family-assistant dev --inspect           # Node debugger
```

### Diagnostics
```bash
family-assistant doctor                  # System health check
family-assistant doctor --fix            # Auto-fix common issues
family-assistant health                  # Integration health status
family-assistant health --provider <name>
family-assistant health --integration <name>
```

### Household Management
```bash
family-assistant household create <name>
family-assistant household list
```

### Person Management
```bash
family-assistant person add --name <name> --email <email> --role <role>
family-assistant person list
family-assistant person show <person-id>
```

### Permission Management (Legacy)
```bash
family-assistant permissions grant --person <name> --permission <permission>
family-assistant permissions revoke --person <name> --permission <permission>
family-assistant permissions list --person <name>
family-assistant permissions set-role --person <name> --role <role>
```

### Capability Management (Recommended)
```bash
family-assistant capabilities discover
family-assistant capabilities discover <source>
family-assistant capabilities list
family-assistant capabilities list --category <category>
family-assistant capabilities list --source <source>
family-assistant capabilities list --person <name>
family-assistant capabilities show <capability-name>
family-assistant capabilities grant --person <name> --capability <capability>
family-assistant capabilities grant --person <name> --capability <capability> --owner <owner>
family-assistant capabilities revoke --person <name> --capability <capability>
family-assistant capabilities list-shared-with --person <name>
family-assistant capabilities list-shared-by --person <name>
family-assistant capabilities refresh
```

### MCP Server Management
```bash
family-assistant mcp add <name> --command <cmd> --args <args>
family-assistant mcp remove <name>
family-assistant mcp list
family-assistant mcp show <name>
family-assistant mcp ps
family-assistant mcp start --person <name> --server <server>
family-assistant mcp stop --person <name> --server <server>
family-assistant mcp restart --person <name> --server <server>
family-assistant mcp health --person <name> --server <server>
family-assistant mcp logs --person <name> --server <server>
family-assistant mcp logs --person <name> --server <server> --follow
family-assistant mcp connect <server>
family-assistant mcp disconnect <server>
family-assistant mcp connections --person <name>
family-assistant mcp test <server>
family-assistant mcp refresh <server>
family-assistant mcp verified
family-assistant mcp verified --server <server>
```

### Identity Management
```bash
family-assistant identity link --person <id> --phone <number>
family-assistant identity link --person <id> --telegram <username>
family-assistant identity pair --code <code> --person <name>
family-assistant identity pair-request --channel <channel> --identifier <id>
family-assistant identity pending
family-assistant identity revoke --identity-id <id>
family-assistant identity list
```

### LLM Providers
```bash
family-assistant llm add --provider <name> --api-key <key>
family-assistant llm add --provider ollama --endpoint <url> --model <model>
family-assistant llm list
family-assistant llm list --provider <name>
family-assistant llm test --provider <name>
```

### Tools
```bash
family-assistant tools list
family-assistant tools info <tool-name>
family-assistant tools install <tool-package>
```

### Sessions & Debugging
```bash
family-assistant sessions list
family-assistant sessions active
family-assistant sessions show <session-id>
family-assistant sessions replay <session-id>
family-assistant sessions close <id>
family-assistant sessions cleanup
family-assistant sessions cleanup --days <days>
```

### Configuration
```bash
family-assistant config export > config.yaml
family-assistant config import config.yaml
family-assistant config validate
family-assistant config set <key> <value>
family-assistant config get <key>
```

---

*This document serves as the complete CLI reference for the Family Assistant platform. For architectural details, see IMPLEMENTATION_PLAN.md.*
