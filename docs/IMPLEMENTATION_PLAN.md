# Implementation Plan

## Development Strategy

This implementation follows an incremental, v1-first plan. The goal is to build a usable assistant quickly without locking the codebase into premature abstractions.

**Key Principles:**
- **Ship vertical slices**: Each phase should produce something testable
- **Keep the core small**: Add mechanisms only when they solve a real v1 problem
- **Prefer consistency over optionality**: One clear model beats three overlapping ones
- **CLI-first administration**: The CLI is the primary management surface in v1
- **Database-backed state**: PostgreSQL is the source of truth
- **Trace everything important**: JSONL for replay and debugging, not config

## Phase Order

```text
Phase 1: Foundation
  Core models, database schema, logging, secrets service, CLI skeleton

Phase 2: Identity and Core Policy
  Identity resolution, pairing, core permissions, approval framework

Phase 3: Request Pipeline
  Orchestrator, WebSocket gateway, cancellation, lifecycle events, resource limits

Phase 4: Memory
  Durable memory in PostgreSQL, scoped retrieval, JSONL traces, session replay

Phase 5: Core Tooling
  Shared Tool interface, tool registry, core in-process tools

Phase 6: LLM Providers
  OpenAI, Anthropic, Ollama, fallback chains, streaming

Phase 7: Integrations
  Unified integration connection model and 1-2 initial drivers

Phase 8: Conversational Self-Config
  Safe self-scoped config and approval-gated sensitive flows

Phase 9: Skills
  Declarative tool compositions on top of proven primitives

Phase 10: Hardening and Expansion
  Comprehensive testing, security review, performance, future adapters
```

## Why This Order

- We avoid the bootstrap loop where conversational configuration exists before conversations do
- We prove the request pipeline before adding external integration complexity
- We standardize tools before adding integration-backed tools
- We leave room for MCP later without forcing v1 to manage per-person external process fleets

---

## Phase 1: Foundation

**Goal**: Establish repository structure, core domain models, persistence, logging, and CLI scaffolding.

**Key Deliverables:**
- Clean TypeScript module layout
- PostgreSQL schema and migration setup
- Base entities: `Household`, `Person`, `ChannelIdentity`, `IntegrationConnection`, `MemoryEntry`
- Secrets service with encryption at rest
- Structured logging with pino
- JSONL trace writer for request execution
- CLI scaffolding with Commander.js
- Basic admin commands for household and person management
- Resource limit configuration

**Scope Boundaries:**
- No LLM calls
- No external integrations
- No conversational configuration

---

## Phase 2: Identity and Core Policy

**Goal**: Build deterministic identity resolution and stable platform authorization.

**Key Deliverables:**
- Channel identity mapping
- Pairing flow with 6-digit code and 15-minute expiry
- Unknown identity blocking by default
- Fixed core policy model for platform actions
- Role defaults for `admin`, `member`, `limited`
- Approval service for sensitive operations
- CLI commands for identities and grants

**Important Rule:**
This phase defines **core policy only**. Dynamic tool capabilities come later and do not replace the core policy layer.

---

## Phase 3: Request Pipeline

**Goal**: Build the request lifecycle and transport plumbing.

**Key Deliverables:**
- Request context assembly
- WebSocket gateway
- Channel adapter interface
- Lifecycle event system
- Streaming response support
- Request cancellation via `AbortSignal`
- Rate limiting and concurrency controls
- Session identifiers and request traces

**Scope Boundaries:**
- Tool execution path may exist, but only for a minimal trusted internal set
- No external integrations yet

**Design Note:**
Build this phase so that WebSocket is the first adapter, not the only adapter. Telegram should be able to plug into the same request envelope without changing identity resolution or authorization logic.

---

## Phase 4: Memory

**Goal**: Implement durable and ephemeral memory in the right places.

**Key Deliverables:**
- PostgreSQL memory provider
- Private and shared memory scopes
- Scope enforcement in queries and schema
- Session replay and request trace JSONL files
- Retention and cleanup commands
- Memory search for core workflows

**Design Rule:**
PostgreSQL stores authoritative durable memory. JSONL is for traces and ephemeral replay/debug state.

---

## Phase 5: Core Tooling

**Goal**: Introduce one consistent tool runtime model.

**Key Deliverables:**
- Shared `Tool` interface
- Tool registry
- Tool metadata for exposure, approval, and target scope
- Core in-process tools:
  - `system.health`
  - `config.get`
  - `memory.search`
  - `memory.store`
  - `session.configure`
- Tool execution pipeline with validation and authorization
- Tool invocation tracing

**Design Rule:**
v1 has one runtime tool concept. We do not introduce separate plugin, manifest, and skill runtimes here.

---

## Phase 6: LLM Providers

**Goal**: Add model-backed conversations on top of the request and tool pipeline.

**Key Deliverables:**
- Swappable LLM provider interface
- OpenAI provider
- Anthropic provider
- Ollama provider
- Provider fallback chain
- Provider preference hierarchy:
  - Person preference
  - Household default
  - System fallback
- Token and latency logging
- Streaming output over WebSocket

**Scope Boundaries:**
- Provider configuration is primarily CLI-driven in v1
- No secret submission through ordinary conversation transcripts

---

## Phase 7: Integrations

**Goal**: Add external service access without overcomplicating the runtime model.

**Key Deliverables:**
- Unified `IntegrationConnection` schema
- Shared `IntegrationDriver` interface
- Encrypted person-scoped credentials
- 1-2 initial integration drivers using native SDK or REST
- Integration-backed tools exposed through the same registry
- Health checks and degraded-mode behavior
- CLI commands for connect, disconnect, list, and test

**Examples:**
- Google Calendar
- Home Assistant

**Design Rule:**
Support for MCP is deferred as an additional driver type unless it is required to unlock a concrete v1 integration.

---

## Phase 7.5: Telegram Channel (Optional Late-v1)

**Goal**: Add a high-value remote chat channel without changing the trust model.

**Key Deliverables:**
- Telegram `ChannelAdapter`
- Bot token configuration
- Telegram identity ingestion using stable Telegram user IDs
- Pairing or allowlist gating for first contact
- Mapping from Telegram identity to household `Person`
- Reuse of the same orchestrator, memory, tool, and auth pipeline

**Design Rule:**
Telegram improves reach and usability, but it must not become a second authorization system. Channel-level controls can gate access, while person mapping and permission enforcement remain in the core Identity and Authorization layer.

---

## Phase 8: Conversational Self-Configuration

**Goal**: Add safe conversational configuration only after tools and LLMs already work.

**Key Deliverables:**
- Self-scoped config tools
- Approval-gated sensitive operations
- Tool exposure filtering
- Cross-person protection
- Approval audit trail

**Allowed in v1:**
- Session preferences
- User-owned settings
- Initiating secure connect flows

**Not Allowed in v1:**
- Role changes through conversation
- Household-wide admin changes through conversation
- Raw secret capture in ordinary chat logs

---

## Phase 9: Skills

**Goal**: Add lightweight higher-level behaviors without introducing a new runtime subsystem.

**Key Deliverables:**
- Declarative skill definitions
- Tool allowlists per skill
- Prompt templates and defaults
- A few example workflows such as scheduling or household summaries

**Design Rule:**
Skills are orchestrations over existing tools, not installable runtime code.

---

## Phase 10: Hardening and Expansion

**Goal**: Prepare the platform for wider use and future extension.

**Key Deliverables:**
- End-to-end test coverage
- Security review
- Load and resource testing
- Replay-based regression tests
- Better diagnostics and doctor commands
- Optional future work:
  - MCP driver support
  - Additional channels
  - REST APIs for UI
  - Plugin packaging

## Non-Goals for v1

To protect the architecture from premature complexity, v1 does **not** require:
- Long-lived per-person MCP server management
- A plugin marketplace
- Multiple writable configuration authorities
- Autonomous agents/workflow engines
- Full REST administration APIs

Telegram is still a reasonable late-v1 addition because it fits the existing channel seam and materially improves real-world usability.

## Success Criteria

v1 is successful if it can:
- Identify household members reliably
- Enforce access decisions in code
- Hold durable private and shared memory
- Run a small set of trusted tools safely
- Use at least one LLM provider end-to-end
- Connect at least one useful external integration
- Support safe self-service without leaking secrets

That is enough structure to keep building on without committing to a major refactor.
