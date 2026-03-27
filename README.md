# Family Assistant - Modular Household Assistant Platform

## Overview

Build a modular TypeScript-based household assistant platform that supports multiple people within the same household. The system identifies who is interacting with it, determines what information and tools they are authorized to access, and responds using connected services such as Google accounts, calendars, contacts, and future integrations. This is not a single-user chatbot—the platform is designed around a household with multiple users, each having their own identity, linked accounts, permissions, and private data, while also supporting shared family context.

## Core Philosophy

- **Lean Core + Clear Boundaries**: Keep the orchestrator small and the module seams explicit
- **CLI-First**: Use the CLI as the primary management surface in v1
- **Database as Source of Truth**: Persist authoritative state in PostgreSQL
- **Explicit over Hidden**: Favor deterministic, traceable code over framework magic
- **Local-First**: Use exports and JSONL traces for portability and debugging without creating a second config authority

## Repo Layout

- `frontend/` - the thin admin/operator UI that talks to the runtime API
- `runtime/` - the runtime, API, CLI, orchestration, permissions, and automation engine
- `extensions/core/` - preinstalled platform extensions that ship with the runtime
- `extensions/packages/` - package-style extensions for integrations and capability packs

## Quick Architecture

The platform uses a modular architecture within a single Node.js process in v1:

1. **Gateway** - WebSocket first, with room for Telegram later
2. **Identity and Authorization** - Maps channel identities to household members and enforces policy
3. **Orchestrator** - Coordinates tools, integrations, and LLM providers
4. **Memory** - PostgreSQL for durable state and JSONL for traces/replay
5. **Integration Layer** - Person-scoped external connections behind a shared driver interface
6. **CLI/Admin Surface** - Primary setup and management entry point

## Primary Goals

- Support multiple people within a household
- Enforce identity and authorization in application code
- Support both private per-user context and shared household context
- Provide execution tracking and visualization for debugging and observability
- Keep the architecture modular so components can be replaced or improved over time
- Favor explicit, deterministic application logic over hidden agent abstractions
- Lean core with a single tool runtime model
- Make logging, traceability, and troubleshooting first-class concerns from the start
- Secure secrets and credentials management
- CLI-first, UI-later approach for faster v1 delivery

## Design Principles

- Lean core, rich extensions
- Modular
- Testable
- Readable
- Explicit over hidden
- Production-minded but pragmatic
- Easy to extend
- Easy to debug
- Observable by default
- Traceable and visualizable
- Secure by default
- CLI-first, UI-later

## What's In v1 / Not In v1

### In v1

- Multi-person household model
- Identity pairing and channel identity mapping
- Split authorization model:
  - fixed core policy for platform actions
  - dynamic capabilities for tool execution
- Single runtime tool model
- PostgreSQL-backed durable state
- JSONL traces for debugging and replay
- WebSocket channel first, with Telegram as a strong late-v1 candidate
- Multiple LLM providers with fallback
- Person-scoped integration connections
- CLI-first management and diagnostics
- Secure secret handling with encrypted-at-rest credentials

### Not required for the first solid v1

- Plugin marketplace
- Long-lived per-person MCP server fleets
- Full automation engine
- Admin UI
- Voice I/O
- Horizontal scaling

## Quick Start

### Prerequisites

- Node.js 20+
- PostgreSQL 14+

### Installation

```bash
pnpm install
pnpm typecheck
pnpm runtime:dev
```

For the thin admin UI:

```bash
pnpm frontend:dev
```

If you run the frontend separately in development, make sure the runtime allows its origin:

```bash
FRONTEND_ORIGINS=http://127.0.0.1:5173,http://localhost:5173
```

## Documentation

- **[ARCHITECTURE.md](./docs/ARCHITECTURE.md)** - System design, channel layer, auth split, integration model
- **[TOOLS.md](./docs/TOOLS.md)** - Single tool runtime model and integration-backed tools
- **[SECURITY_MODEL.md](./docs/SECURITY_MODEL.md)** - Identity, pairing, core policy, capabilities, encryption
- **[IMPLEMENTATION_PLAN.md](./docs/IMPLEMENTATION_PLAN.md)** - Development phases, dependencies, roadmap
- **[PATTERNS.md](./docs/PATTERNS.md)** - Implementation patterns for tools, capabilities, and extensions
- **[CLI_DESIGN.md](./docs/CLI_DESIGN.md)** - Complete command reference and configuration guide

## Contributing

This project is in active development. Contributions are welcome! Please see [IMPLEMENTATION_PLAN.md](./docs/IMPLEMENTATION_PLAN.md) for the detailed roadmap and architectural vision.

For bugs and feature requests, please open an issue. For code contributions:

1. Fork the repository
2. Create a feature branch
3. Follow the established code style and testing patterns
4. Submit a pull request with a clear description of changes

---

**Status**: v1 Architecture & Implementation in progress

For the complete technical specification, architecture decisions, and implementation order, see [IMPLEMENTATION_PLAN.md](./docs/IMPLEMENTATION_PLAN.md).
