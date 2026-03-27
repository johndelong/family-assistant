# Extensions

This app treats extensions as the unit of platform customization.

An extension is a directory containing:

- `skill.json`: validated manifest for tool matching, activation, guards, and optional structured execution
- `SKILL.md`: optional prompt guidance shown to the model when the extension is active

## Required manifest metadata

Each extension manifest must include a `package` block:

- `version`: semver-like package version such as `1.0.0`
- `apiVersion`: extension contract version, currently `1`

Optional package metadata:

- `author`
- `homepage`
- `tags`

## Load order

Extensions are loaded from these locations, highest precedence first:

1. `<workspace>/skills`
2. `<DATA_DIR>/skills`
3. directories listed in `EXTENSION_DIRS`

If two extensions share the same manifest `name`, the higher-precedence copy wins.

Extensions with an unsupported `package.apiVersion` are rejected at load time.

## What an extension can define

- tool matchers
- activation rules
- forced tool inclusion
- execution guards
- structured execution configuration
- workflow definitions

## Runtime behavior

- LLM skill prompting and execution guards consume the same validated registry
- structured execution/workflows consume that same registry
- admin and CLI inspection surfaces read from the registry rather than rescanning the filesystem

## Inspection

- CLI: `family-assistant extension list`
- CLI detail: `family-assistant extension show <name>`
- CLI validate: `family-assistant extension validate --from /path/to/extension`
- Admin API: `GET /admin/extensions`
- Admin API detail: `GET /admin/extensions/:name`

## Managed lifecycle

Managed extensions live under `<DATA_DIR>/skills`.

- Install: `family-assistant extension install --from /path/to/extension`
- Update: `family-assistant extension update --from /path/to/extension`
- Remove: `family-assistant extension remove <name>`
