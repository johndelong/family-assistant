# Extensions

This app treats extensions as the unit of platform customization.

An extension is a directory containing:

- `skill.json`: validated manifest for tool matching, activation, guards, and optional structured execution
- `SKILL.md`: optional prompt guidance shown to the model when the extension is active

Extensions can also contribute tool runtimes through the manifest, which lets first-party or third-party packages register tools without baking those registrations into the runtime context.

## Required manifest metadata

Each extension manifest must include a `package` block:

- `version`: semver-like package version such as `1.0.0`
- `apiVersion`: extension contract version, currently `1`

Optional package metadata:

- `author`
- `homepage`
- `tags`

## Load sources

Extensions are loaded from these sources, highest precedence first:

1. Core extensions from `<workspace>/extensions/core`
2. Package extensions from `<workspace>/extensions/packages`
3. Installed extensions from `<DATA_DIR>/extensions`

In the product surface, these appear as:

- `core`: ships with the platform and is part of the runtime distribution
- `package`: capability package, whether it lives in the repo or is installed into runtime storage

If two extensions share the same manifest `name`, the higher-precedence copy wins.

Extensions with an unsupported `package.apiVersion` are rejected at load time.

## What an extension can define

- tool matchers
- activation rules
- forced tool inclusion
- execution guards
- tool runtime registration
- structured execution configuration
- workflow definitions

## Runtime behavior

- LLM skill prompting and execution guards consume the same validated registry
- tool runtime registration can be driven from the same registry
- structured execution/workflows consume that same registry
- admin inspection surfaces read from the registry rather than rescanning the filesystem

## Inspection

- Admin API: `GET /admin/extensions`
- Admin API detail: `GET /admin/extensions/:name`

## Managed lifecycle

Installed extensions live under `<DATA_DIR>/extensions`.

Package workspace scaffolds can be created under `<DATA_DIR>/packages`.

- Install: `POST /admin/extensions/install`
- Remove: `DELETE /admin/extensions/:name`
- Create package scaffold: `POST /admin/extensions/package-scaffold`
