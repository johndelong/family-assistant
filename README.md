# Family Assistant - Modular Household Assistant Platform

## Overview

Build a modular TypeScript-based household assistant platform that supports multiple people within the same household. The system identifies who is interacting with it, determines what information and tools they are authorized to access, and responds using connected services such as Google accounts, calendars, contacts, and future integrations. This is not a single-user chatbot—the platform is designed around a household with multiple users, each having their own identity, linked accounts, permissions, and private data, while also supporting shared family context.

## Core Philosophy

- **Lean Core + Rich Extensions**: Keep the core orchestrator lightweight; capabilities ship as plugins
- **Local-First**: Configuration via CLI and files, with optional UI later
- **Explicit over Hidden**: Favor deterministic, traceable code over framework magic
- **Terminal-First by Design**: CLI and file-based config ensure understanding and git-trackability

## Quick Architecture

The platform follows a **lean core architecture** with four focused services running within a single Node.js process (v1):

1. **Gateway Service** - WebSocket entry point that manages connections, routes messages, and streams responses
2. **Identity & Auth Service** - Security boundary that resolves identities, enforces pairing, and validates permissions
3. **Orchestrator Service** - Lightweight coordinator that assembles context, executes tools, and invokes LLM providers
4. **Memory Service** - Dual-storage persistence layer (PostgreSQL for durable memory, JSONL for execution traces)

**Additional Components:**
- **CLI + File-Based Configuration** - `family-assistant` CLI for all configuration with Git-trackable YAML/JSON files
- **Admin UI (Optional, Future)** - Web interface consuming same APIs as CLI (post-v1)

**Why Separate Services?** Clean architectural boundaries enable independent testing, evolution, and future deployment flexibility while maintaining operational simplicity in v1.

## Primary Goals

- Support multiple people within a household
- Enforce identity and authorization in application code
- Support both private per-user context and shared household context
- Provide execution tracking and visualization for debugging and observability
- Keep the architecture modular so components can be replaced or improved over time
- Favor explicit, deterministic application logic over hidden agent abstractions
- Lean core with plugin-based extensions
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

**Core Platform**:
- Single household with multiple persons
- Four-service architecture (Gateway, Identity/Auth, Orchestrator, Memory)
- Channel abstraction layer with WebSocket implementation
- Identity pairing flow with 6-digit codes, 15-minute expiry, rate limiting
- Capability-based dynamic permission system
- Resource limits (request size, concurrency, rate limiting, timeouts)
- PostgreSQL for durable memory (private/shared scopes)
- JSONL for ephemeral session state (execution traces)
- Session lifecycle management with file rotation
- WebSocket-based real-time communication with event streaming
- Request cancellation with AbortSignal propagation
- Lifecycle event system with hook points
- Structured logging with append-only JSONL execution logs
- Multiple LLM providers: Anthropic (Claude), OpenAI (GPT), Ollama (local) with fallback chain
- Self-configuration tools with four-tier permission model
- AES-256-GCM credential encryption with key management
- Credential redaction (secrets never logged)
- CLI for all configuration and diagnostics
- Config export/import (git-trackable YAML/JSON)
- Hot reload dev mode

**Tool System (Three-Tier Architecture)**:
- **Bundled Tools**: Core platform capabilities (5-10 tools)
  - Memory search/store, system health, person info
- **MCP Integration**: Model Context Protocol for external services
  - Per-person MCP server instances with credential isolation
  - Universal capability discovery across all tool sources
  - Dynamic, schema-driven permission grants
  - Process isolation with verified MCP server allowlist
  - Install community MCP servers (Google Calendar, GitHub, etc.)
- **Adapter-Based Tools**: Optional for special cases requiring bidirectional communication

### Not in v1

- Admin UI (deferred to post-v1)
- Container isolation for MCP servers (v1 uses process isolation)
- Complex visualizations and analytics dashboards
- Additional channels (Telegram, WhatsApp, SMS) - architecture ready
- Tool development CLI helpers
- Sub-agent architecture for autonomous workflows
- Unverified/community MCP servers (v1 allowlist only)
- Multi-tenant support
- Voice input/output integration
- Horizontal scaling

## Quick Start

### Prerequisites

- Node.js 18+ with npm or yarn
- PostgreSQL 14+ (for durable memory storage)
- Anthropic API key (or OpenAI key, or local Ollama instance)

### Installation

```bash
npm install -g family-assistant
```

### Initial Configuration

```bash
# Initialize a new household
family-assistant init

# Add family members
family-assistant person add --name "John" --role parent
family-assistant person add --name "Sarah" --role parent

# Configure LLM provider
family-assistant llm add --provider anthropic --key YOUR_API_KEY
```

### First Interaction

Connect via WebSocket and pair your channel identity using the 6-digit pairing code generated by the CLI. Once paired, send messages to the assistant and watch real-time execution events stream back.

## Documentation

- **[ARCHITECTURE.md](./docs/ARCHITECTURE.md)** - System design, four services, component interactions
- **[TOOLS.md](./docs/TOOLS.md)** - Three-tier tool architecture, MCP integration, capability discovery
- **[SECURITY_MODEL.md](./docs/SECURITY_MODEL.md)** - Identity, pairing, capability-based permissions, encryption
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
