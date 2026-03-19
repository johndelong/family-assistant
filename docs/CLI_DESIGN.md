# CLI Design and Reference

## Philosophy

The Family Assistant platform is **CLI-first in v1**.

The CLI is the primary administrative and setup surface. It operates on the same service layer as the runtime and writes to the same authoritative PostgreSQL-backed model.

**Core Principles:**
- **CLI-first**: No UI dependency for setup or management
- **One source of truth**: Database-backed state, with export/import for portability
- **Operational clarity**: Every important action is inspectable and scriptable
- **Safe defaults**: Sensitive actions happen through CLI or secure handoff flows

## Configuration Model

### System

Environment and bootstrap settings:
- database connection
- encryption master key
- runtime defaults

### Application State

Stored in PostgreSQL:
- households
- people
- identities
- grants
- integration connections
- LLM provider configuration

### Exports

Export/import commands create portable snapshots, but exported files are not treated as a second writable authority during normal runtime.

## File Layout

```text
~/.family-assistant/
  exports/
    household-<id>.yaml
  data/
    sessions/
    audit/
```

## Command Reference

### Setup

```bash
family-assistant init
family-assistant doctor
family-assistant doctor --fix
```

### Development

```bash
family-assistant dev
family-assistant dev --verbose
family-assistant dev --inspect
```

### Household and Person Management

```bash
family-assistant household create <name>
family-assistant household list

family-assistant person add --name "John" --role member
family-assistant person list
family-assistant person show <person-id>
family-assistant person update <person-id>
```

### Identity Management

```bash
family-assistant identity pending
family-assistant identity pair --code ABC123 --person john
family-assistant identity link --person <id> --phone "+1234567890"
family-assistant identity link --person <id> --telegram-user-id "123456789"
family-assistant identity revoke --identity-id <id>
family-assistant identity list
```

### Core Policy Management

```bash
family-assistant policy grant --person john --permission config.self
family-assistant policy revoke --person john --permission config.self
family-assistant policy list --person john
```

### Capability Management

```bash
family-assistant capabilities list
family-assistant capabilities grant --person john --capability memory.search
family-assistant capabilities grant --person son --capability calendar.read --owner dad
family-assistant capabilities revoke --person john --capability memory.search
family-assistant capabilities list --person john
family-assistant capabilities list-shared-with --person son
family-assistant capabilities list-shared-by --person dad
```

### LLM Provider Management

```bash
family-assistant llm add --provider openai
family-assistant llm add --provider anthropic
family-assistant llm add --provider ollama --endpoint http://localhost:11434 --model llama3

family-assistant llm list
family-assistant llm test --provider openai
family-assistant llm set-default --household <id> --provider ollama:llama3
```

### Integration Management

```bash
family-assistant integrations list
family-assistant integrations connect google-calendar --person john
family-assistant integrations disconnect google-calendar --person john
family-assistant integrations status --person john
family-assistant integrations test google-calendar --person john
```

### Channel Management

```bash
family-assistant channels list
family-assistant channels enable websocket
family-assistant channels enable telegram --bot-token-env TELEGRAM_BOT_TOKEN
family-assistant channels show telegram
family-assistant channels test telegram
```

### Telegram Access Controls

```bash
family-assistant channels telegram allowlist add --telegram-user-id 123456789
family-assistant channels telegram allowlist remove --telegram-user-id 123456789
family-assistant channels telegram pairing enable
family-assistant channels telegram pairing disable
```

### Tool and Session Inspection

```bash
family-assistant tools list
family-assistant tools info memory.search

family-assistant sessions list
family-assistant sessions show <session-id>
family-assistant sessions cleanup
```

### Export and Import

```bash
family-assistant export household --id <household-id> --output ~/.family-assistant/exports/household-<id>.yaml
family-assistant import household --input ~/.family-assistant/exports/household-<id>.yaml
```

## v1 CLI Guidance

Prefer the CLI for:
- setup
- admin actions
- person and identity management
- secret entry
- integration connect/disconnect
- channel enablement and Telegram bot configuration
- audits and diagnostics

Do not rely on ordinary conversation flows for:
- role changes
- raw secret submission
- household-wide administrative changes

## Deferred from v1

These can come later if the product proves the need:
- plugin package installation commands
- MCP fleet management commands
- REST-first administration paths
- large command trees for runtime extension packaging
