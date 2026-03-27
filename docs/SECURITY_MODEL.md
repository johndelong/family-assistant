# Security Model

## Overview

The Family Assistant platform enforces security in application code. The LLM does not decide who the user is, what they can access, or which privileged operations are allowed.

Every sensitive action depends on explicit validation of:
- who the speaker is
- which core policies they hold
- which tool capabilities they hold
- whether the target scope is valid
- whether approval is required

## Identity Resolution

Incoming requests are resolved to a `Person` before any LLM invocation.

Supported identities may include:
- phone number
- email
- Telegram handle
- WhatsApp account
- device identity

In practice, channel integrations should prefer stable provider IDs over mutable display names. For Telegram, that means the numeric Telegram user ID should be the canonical inbound identity signal, with usernames treated as convenience metadata only.

### Pairing Flow

Unknown identities are blocked by default.

**Flow:**
1. Unknown identity sends a message
2. System generates a 6-digit code
3. Code expires in 15 minutes
4. Admin pairs it through the management surface
5. Future messages resolve directly to the linked person

**Rate Limits:**
- Max 3 failed attempts per code
- Max 5 pairing requests per hour per identity
- Max 20 pairing requests per minute system-wide

## Authorization Model

The platform uses a **two-layer model**.

### Layer 1: Core Policy

Fixed permissions for platform operations:

```typescript
type CorePermission =
  | 'system.configure'
  | 'household.manage'
  | 'person.manage'
  | 'identity.manage'
  | 'config.self'
  | 'approval.respond';
```

These permissions are stable and code-defined. They protect platform-level actions such as person management, role changes, and system configuration.

### Layer 2: Tool Capabilities

Dynamic permissions for executable tools:

```typescript
type CapabilityName = string;
// Examples:
// 'memory.search'
// 'calendar.read'
// 'calendar.write'
// 'homeassistant.control'
```

Capabilities can be:
- granted directly
- granted with expiry
- shared from an owner to another person

## Role Defaults

Roles provide defaults for core policy, not blanket access to every tool.

### admin
- Full core policy access
- May grant and revoke capabilities
- May manage other people and household configuration

### member
- Self-service defaults
- Can manage their own session/user settings
- Can connect their own integrations when allowed
- Uses explicit capability grants for tool access beyond defaults

### limited
- Minimal default access
- Primarily self-scoped and explicitly granted actions

## Policy Checks

### Core Policy Check

```typescript
async function checkCorePermission(person: Person, permission: CorePermission): Promise<boolean> {
  if (person.role === 'admin') return true;

  const memberDefaults: CorePermission[] = ['config.self', 'approval.respond'];
  const limitedDefaults: CorePermission[] = ['config.self'];

  if (person.role === 'member') return memberDefaults.includes(permission);
  if (person.role === 'limited') return limitedDefaults.includes(permission);

  return false;
}
```

### Capability Check

```typescript
async function checkCapability(personId: string, capabilityName: string): Promise<boolean> {
  const directGrant = await getCapabilityGrant(personId, capabilityName);
  return !!directGrant;
}
```

### Shared Capability Check

```typescript
async function checkSharedCapability(
  granteeId: string,
  ownerId: string,
  capabilityName: string
): Promise<boolean> {
  const sharedGrant = await getSharedCapabilityGrant(ownerId, granteeId, capabilityName);
  return !!sharedGrant;
}
```

## Scope Enforcement

Security decisions are not just about permission names. They also depend on scope.

Supported target scopes:
- `self`
- `household`
- `owner_shared`
- `system`

Examples:
- `session.configure` is `self`
- `memory.search` may be `self` plus household shared
- `calendar.read` may be `self` or `owner_shared`
- `system.configure` is `system`

Cross-person access is never inferred. It must be explicitly expressed in the tool input and validated against a share grant.

## Channel Gating vs Authorization

Channels may have transport-level gating rules such as:
- allowlists
- pairing-only DM policies
- group mention requirements

These are useful exposure controls, especially for remote channels like Telegram.

But they are not the full authorization model.

Example:
- Telegram may allow messages only from approved Telegram user IDs
- once a message is accepted, the system must still map that Telegram identity to a `Person`
- after that, core policy and capability checks decide what happens next

This separation is important because the same person may use multiple channels, and the same authorization rules should apply regardless of transport.

## Approval Model

Sensitive operations can require explicit confirmation.

Approval levels:
- `never`
- `confirm`
- `admin_only`

### v1 Guidance

Use approval for:
- connecting a new integration
- enabling paid LLM providers
- destructive data writes

Do not use approval as a substitute for authorization. A user must already be allowed to attempt the action before approval is requested.

## Conversational Self-Configuration

Conversational configuration is intentionally narrow in v1.

### Allowed
- session preferences
- self-scoped user preferences
- initiating connect flows

### Not Allowed
- changing another person's settings
- role escalation
- household-wide admin changes
- raw secret submission through ordinary conversation logs

## Secrets and Credentials

All credentials are encrypted at rest.

### Storage

```typescript
interface EncryptedSecret {
  ciphertext: string;
  iv: string;
  authTag: string;
  version: number;
}
```

### Key Management

- master key stored in `ENCRYPTION_MASTER_KEY`
- key never stored in the database
- key loaded into memory only at runtime

### Redaction

All logs and traces must redact:
- API keys
- access tokens
- refresh tokens
- password-like fields
- encrypted secret payloads

### Important Rule

Users should not paste raw secrets into normal conversation flows. Secret capture should happen via:
- admin UI or API entry
- dedicated secure setup flow
- integration OAuth handoff

This reduces the risk of transcript leakage and accidental log exposure.

## LLM Context Boundaries

The LLM never receives:
- encrypted credential blobs
- raw secrets
- hidden policy state that should not influence user-visible output

It may receive:
- the resolved person identity
- non-sensitive connection status
- tool results that have already passed authorization checks

## Resource Management

```typescript
interface ResourceLimits {
  maxRequestSize: number;
  maxConcurrentRequestsPerPerson: number;
  maxExecutionTimeMs: number;
  maxSessionTraceSize: number;
  maxRequestsPerMinutePerPerson: number;
  maxToolExecutionsPerRequest: number;
}
```

Enforcement points:
- request size at the gateway
- concurrency and timeout in the orchestrator
- tool execution count in the tool runner
- trace rotation in the trace writer

## Audit Requirements

Audit logs should capture:
- identity resolution decisions
- grant changes
- approval prompts and outcomes
- integration connect/disconnect events
- tool executions involving shared access

Audit logs should never capture raw credential values.

## Security Boundaries

Hard rules for v1:
- unknown identities are blocked by default
- identity resolution happens before LLM use
- core platform actions use fixed policy checks
- tool execution uses capability checks
- shared access requires explicit owner grants
- secrets never enter model context
- approval does not replace authorization

These are the boundaries that let the system grow without weakening the security model.
