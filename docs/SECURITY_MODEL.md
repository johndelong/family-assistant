# Security Model

## Overview

The Family Assistant platform is built with security as a core principle. Authorization must be enforced in application code. The LLM must not decide what a user is allowed to access.

**Security Philosophy**: Explicit authorization, no privilege escalation. Tool execution must only occur after validating:
- who the speaker is
- what integrations are accessible
- what scopes are permitted

---

## Identity Resolution

### Channel Identities

Incoming requests must be mapped to a specific person through deterministic application logic.

Examples of channel identity include:
- phone number
- email address
- Telegram account
- WhatsApp account
- device identity

Identity resolution must happen before any LLM invocation or tool execution.

### Identity Pairing Flow

**Default Posture**: Unknown identities are blocked until explicitly paired.

**Pairing Process**:
1. Unknown identifier sends message to a channel
2. System generates 6-digit pairing code (expires in 15 minutes)
3. System responds via channel: "To link this identity, run: `family-assistant identity pair --code ABC123 --person <name>`"
4. User runs CLI command to approve pairing (requires physical CLI access)
5. Identity linked; future messages from this identity are processed normally

**Security Considerations**:
- **Pairing codes expire after 15 minutes** - Limits attack window
- **Failed pairing attempts are logged and audited** - Tracks unauthorized access attempts
- **Pairing requires physical access to CLI** - Secure by design, no remote pairing
- **Rate limiting prevents brute-force attacks** - See rate limiting specification below
- **Unknown identities cannot execute tools or access memory** - Complete lockout until paired

### Pairing Rate Limiting Specification

To prevent brute-force attacks on 6-digit pairing codes (1,000,000 combinations):

**Per-Code Limits:**
- Maximum 3 failed attempts per pairing code
- After 3 failures, code is invalidated (even if not expired)
- New code must be generated

**Per-Channel Identity Limits:**
- Maximum 5 pairing requests per hour per channel identity
- After limit reached, channel identity is temporarily blocked for 1 hour
- All attempts logged with channel identity and timestamp

**Global System Limits:**
- Maximum 20 pairing requests per minute (system-wide)
- Prevents distributed attack across multiple identities
- Rate limit configurable via `security.pairing.maxRequestsPerMinute`

**Enforcement:**
```typescript
interface PairingRateLimiter {
  checkCodeAttempts(code: string): Promise<boolean>;  // Max 3 per code
  checkChannelRate(channelId: string): Promise<boolean>;  // Max 5 per hour
  checkGlobalRate(): Promise<boolean>;  // Max 20 per minute

  recordFailedAttempt(code: string, channelId: string): Promise<void>;
  invalidateCode(code: string): Promise<void>;
}
```

**Audit Logging:**
- All pairing requests logged: `pairing.request` event
- All pairing attempts logged: `pairing.attempt` event with success/failure
- Failed attempts include: code, channel identity, timestamp, IP (if available)
- Exceeded rate limits logged: `pairing.rate_limit_exceeded` event

**CLI Commands**:
```bash
# Manual pairing request generation
family-assistant identity pair-request --channel telegram --identifier "@username"

# Approve pairing (links identity to person)
family-assistant identity pair --code ABC123 --person john

# List pending pairing requests
family-assistant identity pending

# Revoke identity
family-assistant identity revoke --identity-id <id>
```

**Key Decisions** (from Implementation Plan):
1. **Security Default**: Deny unknown identities
   - Prevents unauthorized access
   - Requires explicit pairing approval

2. **Pairing Mechanism**:
   - 6-digit codes (easy to type, sufficient entropy)
   - 15-minute expiry (security vs usability balance)
   - CLI-based approval (requires physical access)

3. **Pairing Flow**:
   - System generates code
   - User receives code via channel
   - User runs CLI command to approve
   - Identity linked permanently

4. **Revocation**:
   - Identities can be revoked at any time
   - Revoked identities return to unknown state

---

## Authorization Model

### Three-Tier Role System

The system supports a three-tier role model with granular permission extension:

```typescript
interface Person {
  id: string;
  householdId: string;
  name: string;
  email?: string;
  role: 'admin' | 'member' | 'limited';
  permissions: Permission[];  // Granular permissions
  createdAt: Date;
  updatedAt: Date;
}
```

**Roles**:

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
  - Example: Grandma can read dad's calendar if he grants her 'integrations.share.calendar.read'
  - Device control delegated to connected integrations (e.g., Home Assistant)

**Role Permissions Table**:

| Permission | admin | member | limited |
|------------|-------|--------|---------|
| system.configure | ✓ | ✗ | ✗ |
| llm.configure | ✓ | ✗ | ✗ |
| household.manage | ✓ | ✗ | ✗ |
| person.manage | ✓ | ✗ | ✗ |
| memory.read.shared | ✓ | ✓ | explicit |
| memory.write.shared | ✓ | ✓ | explicit |
| memory.read.private | ✓ (own) | ✓ (own) | ✓ (own) |
| memory.write.private | ✓ (own) | ✓ (own) | ✓ (own) |
| integration.connect | ✓ | ✓ | ✓ |
| config.self | ✓ | ✓ | ✓ |

### Granular Permissions

```typescript
type Permission =
  // System permissions
  | 'system.configure'
  | 'llm.configure'
  | 'integration.connect'

  // Household permissions
  | 'household.manage'
  | 'person.manage'

  // Memory permissions
  | 'memory.read.shared'
  | 'memory.write.shared'
  | 'memory.read.private'   // Always granted to own private memory
  | 'memory.write.private'  // Always granted to own private memory

  // Integration sharing permissions
  // These control whether others can use YOUR connected integrations
  | 'integrations.share.calendar.read'    // Allow others to read your calendar
  | 'integrations.share.calendar.write'   // Allow others to write to your calendar
  | 'integrations.share.contacts.read'    // Allow others to read your contacts
  | 'integrations.share.homeassistant'    // Allow others to control devices via your HA account

  // Self-configuration
  | 'config.self';
```

### Permission Checking

Authorization checks happen before tool execution:

```typescript
async function checkPermission(
  person: Person,
  requiredPermission: Permission,
  grantedBy?: Person  // For sharing permissions, who granted access
): Promise<boolean> {
  // Admins have all permissions
  if (person.role === 'admin') {
    return true;
  }

  // For sharing permissions, check if grantedBy person has granted this permission
  if (requiredPermission.startsWith('integrations.share.') && grantedBy) {
    // Check if the owner (grantedBy) has explicitly granted this to the requesting person
    const sharingGrants = await getPermissionGrants(grantedBy.id, person.id);
    return sharingGrants.includes(requiredPermission);
  }

  // Members have standard permissions
  if (person.role === 'member') {
    const memberPermissions = [
      'memory.read.shared', 'memory.write.shared',
      'memory.read.private', 'memory.write.private',
      'integration.connect',
      'config.self'
    ];
    if (memberPermissions.includes(requiredPermission)) {
      return true;
    }
  }

  // Limited users: check explicit permissions
  if (person.role === 'limited') {
    // Everyone can configure themselves
    if (requiredPermission === 'config.self') {
      return true;
    }
    // Everyone can read their own private memory
    if (requiredPermission === 'memory.read.private' ||
        requiredPermission === 'memory.write.private') {
      return true;
    }
    // Check explicit grants
    return person.permissions.includes(requiredPermission);
  }

  return false;
}

// Helper: Get permissions that ownerId has granted to granteeId
async function getPermissionGrants(
  ownerId: string,
  granteeId: string
): Promise<Permission[]> {
  const grants = await db.query(
    `SELECT permission FROM sharing_grants
     WHERE owner_id = $1 AND grantee_id = $2`,
    [ownerId, granteeId]
  );
  return grants.rows.map(row => row.permission);
}
```

---

## Integration Sharing Permissions

### How Sharing Works

Integration sharing permissions control whether others can use YOUR connected integrations. Here's how it works in practice:

1. **Connect Your Own Integration**: Each person connects their own integration accounts
   ```bash
   # Dad connects his Google Calendar
   family-assistant integrations connect google-calendar
   # OAuth flow happens, dad's credentials stored
   ```

2. **Grant Sharing Access**: The integration owner decides who can use their integration
   ```bash
   # Dad allows his kids to read his calendar
   family-assistant permissions grant --person son --permission integrations.share.calendar.read
   family-assistant permissions grant --person daughter --permission integrations.share.calendar.read
   ```

3. **Access Check During Tool Execution**: When someone requests calendar data:
   ```typescript
   async function getCalendarEvents(requestingPerson: Person, ownerId: string) {
     // Check if requesting person can access owner's calendar
     if (requestingPerson.id === ownerId) {
       // Own calendar - always allowed
       const account = await getConnectedAccount(ownerId, 'google-calendar');
       return fetchCalendarEvents(account.credentials);
     }

     // Requesting someone else's calendar - check if owner has granted sharing
     const owner = await getPerson(ownerId);
     const hasSharedAccess = await checkPermission(
       requestingPerson,
       'integrations.share.calendar.read',
       owner // Check against owner's granted permissions
     );

     if (!hasSharedAccess) {
       throw new Error(`${owner.name} has not shared their calendar with you`);
     }

     // Use owner's credentials to fetch data
     const account = await getConnectedAccount(ownerId, 'google-calendar');
     return fetchCalendarEvents(account.credentials);
   }
   ```

**Example Scenarios**:
- **Kids viewing parent's calendar**: Dad grants `integrations.share.calendar.read` to kids so they can ask "What days do I have school this week?"
- **Shared home control**: Dad grants `integrations.share.homeassistant` to wife so she can control lights using his Home Assistant account
- **Limited calendar editing**: Dad grants `integrations.share.calendar.write` to wife so she can add family events

**CLI Commands**:

```bash
# Create person with role
family-assistant person add --name "Grandma" --role limited

# Grant sharing access to YOUR calendar integration (run as the integration owner)
# This allows grandma to read events from YOUR connected Google Calendar
family-assistant permissions grant --person grandma --permission integrations.share.calendar.read

# Grant sharing access to specific integrations
# This allows son to control devices using YOUR Home Assistant account
family-assistant permissions grant --person son --permission integrations.share.homeassistant

# Revoke sharing access
family-assistant permissions revoke --person grandma --permission integrations.share.calendar.read

# List sharing grants you've made to others
family-assistant permissions list-sharing-grants

# List what integrations others have shared with you
family-assistant permissions list-shared-with-me

# List explicit permissions granted to a limited role user
family-assistant permissions list --person grandma

# Change role (admin-only operation, requires CLI access)
family-assistant permissions set-role --person john --role admin
```

### Database Schema

**Note**: This schema is illustrative only and shows the conceptual model. The actual implementation may vary.

```sql
CREATE TABLE persons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id UUID NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255),
  role VARCHAR(20) NOT NULL CHECK (role IN ('admin', 'member', 'limited')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE person_permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  permission VARCHAR(100) NOT NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  granted_by UUID REFERENCES persons(id),
  UNIQUE(person_id, permission)
);

-- Legacy sharing permissions (deprecated in favor of capability_grants)
CREATE TABLE sharing_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,  -- Who owns the integration
  grantee_id UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE, -- Who is being granted access
  permission VARCHAR(100) NOT NULL,  -- e.g., 'integrations.share.calendar.read'
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(owner_id, grantee_id, permission)
);

-- New: Capability-based permissions (replaces hard-coded permissions)
-- See TOOLS.md for complete capability system documentation
CREATE TABLE tool_capabilities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type VARCHAR(20) NOT NULL, -- 'bundled' | 'adapter' | 'mcp'
  source_name VARCHAR(100) NOT NULL,
  capability_name VARCHAR(200) NOT NULL UNIQUE,
  description TEXT NOT NULL,
  input_schema JSONB NOT NULL,
  required_permissions TEXT[] NOT NULL,
  metadata JSONB,
  discovered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_verified TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE capability_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  capability_name VARCHAR(200) NOT NULL REFERENCES tool_capabilities(capability_name),
  granted_by UUID REFERENCES persons(id),
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  UNIQUE(person_id, capability_name)
);

CREATE TABLE shared_capability_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  grantee_id UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  capability_name VARCHAR(200) NOT NULL REFERENCES tool_capabilities(capability_name),
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  UNIQUE(owner_id, grantee_id, capability_name)
);
```

---

## Self-Configuration Security (Four-Tier Model)

### Philosophy

**From Implementation Plan**: Balance convenience with security through a four-tier permission model that prevents privilege escalation, credential leaks, and unauthorized access while enabling helpful self-service configuration.

Enable helpful self-service while preventing privilege escalation, credential leaks, and unauthorized access.

### Four Security Tiers

**Tier 1: Read-Only** (Always Allowed)

No modification of system state. Cannot leak sensitive data. Available to all authenticated users.

**Examples**:
```typescript
'system.health'      // Check system health status
'config.get'         // Read configuration values
'llm.list'          // List configured LLM providers
'llm.test'          // Test provider connectivity
'integration.list'  // List integrations
'integration.test'  // Test integration health
'tools.list'        // List available tools
'memory.search'     // Search memories (scope-aware)
'sessions.list'     // List sessions
```

**Tier 2: Self-Scoped** (Person Configures Themselves)

Modifications limited to requesting person. Cannot affect other users or system.

**Validation**: `requestingPerson.id === targetPerson.id`

**Examples**:
```typescript
'person.configure.self'  // Configure own settings
'session.configure'      // Configure current session

// Examples:
// - Set verbose mode
// - Change default LLM
// - Update preferences
// - Configure notification settings
```

**Tier 3: Approval-Required** (Explicit Confirmation)

Sensitive operations requiring user awareness. 60-second approval timeout. All approvals audited.

**Examples**:
```typescript
'llm.add'              // Add LLM provider (stores credentials)
'integration.connect'  // Connect integration (OAuth flow)

// Approval flow:
// 1. LLM requests approval with clear explanation
// 2. User must type 'APPROVE' within 60 seconds
// 3. Operation executes if approved
// 4. Approval logged to audit trail
```

**Tier 4: Admin-Only** (CLI-Only, Never Exposed to LLM)

Critical system operations requiring physical server access. Not callable via conversation.

**Examples**:
```typescript
// Never exposed as tools - CLI only
'system.configure'      // System-level configuration
'permissions.grant'     // Grant/revoke permissions
'secrets.rotate'        // Rotate encryption keys
'household.delete'     // Delete household
'database.migrate'     // Database operations
'person.delete'        // Delete users

// These require: family-assistant CLI access (physical security)
```

### Security Boundaries

**From Key Decisions**:
- Self-scoped tools validate `requestingPerson === targetPerson`
- Tier 4 tools never exposed to LLM
- Credentials redacted in all logs and traces
- Approval requests timeout after 60 seconds
- Cross-person configuration blocked

### Approval Workflow

```typescript
async function requestApproval(
  context: RequestContext,
  tool: Tool,
  input: any
): Promise<boolean> {
  const approvalId = generateApprovalId();

  // Send approval request to user
  await context.channel.sendMessage(context.person, {
    type: 'approval_request',
    approvalId,
    tool: tool.name,
    description: tool.approvalPrompt,
    risks: tool.risks,
    timeout: 60, // seconds
  });

  // Wait for approval (or timeout)
  const result = await waitForApproval(approvalId, 60000); // 60 seconds

  // Audit log
  await auditLog.write({
    type: 'approval',
    approvalId,
    tool: tool.name,
    person: context.person.id,
    approved: result.approved,
    timestamp: new Date(),
  });

  return result.approved;
}
```

**From Key Decisions**:
- Clear explanation of operation and risks
- User must type 'APPROVE' (exact match)
- 60-second timeout for approval
- All approvals and rejections audited
- Rate limiting prevents approval spam

### Example Conversations

**✅ Safe (Tier 1 - Read-Only)**:
```
User: "What LLM am I using?"
Assistant: *calls config.get('person.john.llm')*
Assistant: "You're using Anthropic Claude Sonnet"

User: "Is the system healthy?"
Assistant: *calls system.health()*
Assistant: "System healthy. All integrations operational."
```

**✅ Safe (Tier 2 - Self-Scoped)**:
```
User: "Switch to verbose mode"
Assistant: *calls session.configure({ verbose: true })*
Assistant: "Verbose mode enabled for this session"

User: "Make Claude my default LLM"
Assistant: *calls person.configure.self({ llm: 'anthropic:claude' })*
Assistant: "Set Claude as your default LLM"
```

**✅ Approval Required (Tier 3)**:
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

**❌ Blocked (Tier 4 - Admin-Only)**:
```
User: "Make me a household admin"
Assistant: "I cannot change user roles. Role changes require CLI access:

  family-assistant permissions grant --person john --role admin

This ensures only someone with physical server access can change permissions."
```

**❌ Blocked (Cross-Person)**:
```
User: "Change Jane's default LLM to GPT"
Assistant: "I can only configure your own settings. To change Jane's settings, she needs to:

1. Log in and configure herself
2. Or ask an admin via CLI if needed

This prevents unauthorized access to other users' accounts."
```

---

## Resource Management (Security Feature)

### Resource Limits

**Purpose**: Prevent abuse and ensure fair allocation of resources.

```typescript
interface ResourceLimits {
  // Request limits
  maxRequestSize: number;           // Default: 10MB
  maxConcurrentRequests: number;    // Per person, default: 3
  maxExecutionTime: number;         // Default: 300000ms (5 min)

  // Storage limits
  maxSessionFileSize: number;       // Default: 100MB (triggers rotation)
  maxMemoryEntriesPerPerson: number; // Default: 10000
  maxAuditLogDays: number;          // Default: 90

  // Rate limiting
  maxRequestsPerMinute: number;     // Per person, default: 30
  maxToolExecutionsPerRequest: number; // Default: 20
}
```

**Why This Matters**:
- Household assistant runs on personal hardware with finite resources
- Prevents accidental resource exhaustion
- Security against malicious use
- Clear limits prevent surprising behavior

### Enforcement Points

**From Key Decisions**:
- **Request size**: API gateway - Oversized requests rejected with clear error message
- **Concurrency**: Orchestrator - Concurrent request limit prevents resource exhaustion
- **Timeout**: Per-request timer - Execution timeout prevents runaway operations
- **Rate limiting**: Per-person counter - Prevents abuse (accidental or malicious)
- **Session file rotation**: When size limit exceeded
- **Tool execution limits**: Prevent infinite loops

**CLI Configuration**:
```bash
family-assistant config set limits.maxRequestSize 20971520  # 20MB
family-assistant config set limits.maxConcurrentRequests 5
family-assistant config get limits  # View all limits
```

---

## Credential Management

### Storage Strategy

All credentials (OAuth tokens, API keys, passwords) are encrypted at rest using industry-standard encryption.

**Encryption Specification:**

```typescript
interface CredentialEncryption {
  algorithm: 'AES-256-GCM';  // Authenticated encryption
  keyDerivation: 'PBKDF2';    // Key derivation function
  keyLength: 256;              // bits
  iterations: 100000;          // PBKDF2 iterations
}
```

**Encryption Key Management:**

1. **Master Key Source** (v1):
   - Stored in environment variable: `ENCRYPTION_MASTER_KEY`
   - Must be 64 hex characters (256 bits)
   - Generated on first init: `family-assistant init` generates secure key
   - Admin must backup key securely (printed once, then stored in `.env`)

2. **Key Storage**:
   - Master key never stored in database
   - Master key loaded from environment on service start
   - Keys stored in memory only (never written to disk unencrypted)
   - Service restart requires master key in environment

3. **Key Rotation** (Future):
   - v1: Manual key rotation via CLI
   - Future: Automatic key rotation with versioning
   - Old keys retained temporarily for decryption of existing data

**Encryption Process:**

```typescript
interface EncryptedCredential {
  ciphertext: string;      // Base64-encoded encrypted data
  iv: string;              // Initialization vector (random, per-encryption)
  authTag: string;         // Authentication tag (AES-GCM)
  version: number;         // Encryption version (for key rotation)
}

async function encryptCredential(plaintext: string, masterKey: Buffer): Promise<EncryptedCredential> {
  // 1. Generate random IV (12 bytes for GCM)
  const iv = crypto.randomBytes(12);

  // 2. Create cipher with AES-256-GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey, iv);

  // 3. Encrypt plaintext
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final()
  ]);

  // 4. Get authentication tag
  const authTag = cipher.getAuthTag();

  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    version: 1
  };
}
```

**Database Storage:**

```sql
-- connected_accounts.credentials stores encrypted JSON
CREATE TABLE connected_accounts (
  id UUID PRIMARY KEY,
  person_id UUID REFERENCES persons(id),
  integration VARCHAR(100),
  credentials JSONB,  -- Stores EncryptedCredential object
  created_at TIMESTAMP DEFAULT NOW()
);
```

**Credential Redaction:**

All logging, tracing, and LLM context automatically redacts credentials:

```typescript
// Automatic redaction at serialization layer
class SecureSerializer {
  serialize(obj: any): string {
    return JSON.stringify(obj, (key, value) => {
      // Redact fields containing sensitive data
      if (this.isSensitiveField(key)) {
        return '[REDACTED]';
      }
      // Redact encrypted credentials
      if (value?.ciphertext && value?.iv && value?.authTag) {
        return '[ENCRYPTED]';
      }
      return value;
    });
  }

  private isSensitiveField(key: string): boolean {
    const sensitivePatterns = [
      'password', 'apiKey', 'api_key', 'token', 'secret',
      'accessToken', 'refreshToken', 'credentials'
    ];
    return sensitivePatterns.some(pattern =>
      key.toLowerCase().includes(pattern)
    );
  }
}
```

**Never in LLM Context:**

```typescript
// Before sending to LLM, strip all credentials
function prepareContextForLLM(context: RequestContext): LLMContext {
  return {
    person: {
      id: context.person.id,
      name: context.person.name,
      role: context.person.role,
      // Permissions list ok, but no credential fields
    },
    // Connected accounts list WITHOUT credentials
    connectedAccounts: context.connectedAccounts.map(a => ({
      integration: a.integration,
      // No credentials field
    })),
    // Memory, tools, etc. (already redacted via SecureSerializer)
  };
}
```

### Per-Person Integration Credentials

Each person connects their own integration accounts. The family assistant proxies requests to the integration using the requesting person's credentials.

```typescript
interface ConnectedAccount {
  id: string;
  personId: string;           // Who owns this connection
  integration: string;        // 'google-calendar', 'home-assistant', etc.
  credentials: {
    accessToken: string;      // OAuth token or API key
    refreshToken?: string;
    expiresAt?: Date;
  };
  metadata?: Record<string, any>;
}

// When executing a tool that requires an integration:
async function executeIntegrationTool(
  person: Person,
  integration: string,
  action: string,
  params: any
) {
  // 1. Get person's connected account for this integration
  const account = await getConnectedAccount(person.id, integration);

  if (!account) {
    throw new Error(`You need to connect your ${integration} account first`);
  }

  // 2. Use THEIR credentials to make the request
  // The integration enforces its own permissions
  return await integrationClient.execute(
    account.credentials.accessToken,
    action,
    params
  );
}
```

---

## Capability-Based Permission Model

The platform uses a **dynamic capability-based permission system** that adapts to discovered tools rather than relying on hard-coded permissions. See [TOOLS.md](./TOOLS.md) for complete architecture details.

### How Capability Permissions Work

**Traditional Approach (Hard-Coded):**
```typescript
// Hard-coded permission checks
const permissions = ['calendar.read', 'calendar.write', 'contacts.read'];

// New integration requires code changes
if (person.permissions.includes('new-integration.read')) { ... }
```

**Capability-Based Approach (Dynamic):**
```typescript
// Capabilities discovered from tool sources
const capabilities = await discoverCapabilities();
// [
//   { name: 'google-calendar:read', source: 'mcp:google-calendar' },
//   { name: 'google-calendar:write', source: 'mcp:google-calendar' },
//   { name: 'github:repos:list', source: 'mcp:github' },
// ]

// Permission checks use discovered capabilities
async function checkCapability(person: Person, capabilityName: string) {
  // Check capability_grants table
  const grant = await db.query.capability_grants.findFirst({
    where: and(
      eq(capability_grants.person_id, person.id),
      eq(capability_grants.capability_name, capabilityName)
    ),
  });

  return !!grant;
}
```

### Capability Grant Workflow

**1. Discover Capabilities**

All tool sources expose capabilities via the `ToolSource` interface:

```typescript
interface ToolSource {
  discoverCapabilities(): Promise<ToolCapability[]>;
}

// MCP server discovers capabilities
const mcpCapabilities = await mcpRunner.discoverCapabilities('google-calendar');
// [
//   { name: 'google-calendar:read', description: '...' },
//   { name: 'google-calendar:write', description: '...' },
// ]
```

**2. Store Capabilities**

Discovered capabilities are stored in the database:

```sql
INSERT INTO tool_capabilities (
  source_type,
  source_name,
  capability_name,
  description,
  input_schema,
  required_permissions
) VALUES (
  'mcp',
  'google-calendar',
  'google-calendar:read',
  'List and view Google Calendar events',
  '{"type": "object", ...}',
  ARRAY['google-calendar:read']
);
```

**3. Grant Capabilities to Users**

Admins or integration owners grant capabilities:

```bash
# Grant capability to person
family-assistant capabilities grant \
  --person john \
  --capability google-calendar:read

# Grant shared capability (dad shares with son)
family-assistant capabilities grant \
  --person son \
  --capability google-calendar:read \
  --owner dad
```

**4. Check Permissions at Runtime**

Before executing a tool, check capability permission:

```typescript
async function executeTool(tool: Tool, person: Person) {
  // Get required capabilities from tool
  const requiredCaps = tool.capabilities;

  // Check each capability
  for (const cap of requiredCaps) {
    const hasPermission = await checkCapability(person, cap);

    if (!hasPermission) {
      throw new Error(`Missing capability: ${cap}`);
    }
  }

  // Execute tool
  return tool.execute(...);
}
```

### Capability Permission Examples

**Example 1: Dad Shares Calendar with Kids**

```bash
# 1. Dad connects Google Calendar MCP integration
$ family-assistant mcp connect google-calendar
# OAuth flow completes, dad's credentials stored

# 2. Capabilities discovered automatically
$ family-assistant capabilities discover mcp:google-calendar
Discovered capabilities:
  - google-calendar:read
  - google-calendar:write
  - google-calendar:delete

# 3. Dad grants read access to son
$ family-assistant capabilities grant \
  --person son \
  --capability google-calendar:read \
  --owner dad

# 4. Son asks about dad's calendar
Son: "What's on dad's calendar tomorrow?"

System:
  - Checks: son has 'google-calendar:read' granted by dad ✓
  - Executes: dad's MCP server instance (dad's credentials)
  - Returns: Events from dad's calendar
```

**Example 2: Admin Installs New MCP Server**

```bash
# 1. Install GitHub MCP server
$ family-assistant mcp add github \
  --command "npx" \
  --args "-y @modelcontextprotocol/server-github"

# 2. Discover capabilities
$ family-assistant capabilities discover mcp:github
Discovered capabilities:
  - github:repos:list
  - github:issues:list
  - github:issues:create
  - github:pull-requests:list

# 3. Grant capabilities to team members
$ family-assistant capabilities grant \
  --person dad \
  --capability github:repos:list

$ family-assistant capabilities grant \
  --person mom \
  --capability github:issues:create
```

### Benefits of Capability-Based Permissions

**1. Dynamic and Extensible**
- New tools automatically expose capabilities
- No code changes needed for new integrations
- Permissions adapt to available tools

**2. Fine-Grained Control**
- Grant specific capabilities, not blanket permissions
- Example: `github:repos:list` but not `github:repos:delete`

**3. Discoverable**
- List all available capabilities via CLI
- Users know exactly what they can and cannot do

**4. Auditable**
- Track who granted each capability
- Expiration dates for temporary access
- Full audit trail in database

**5. Consistent Model**
- Same permission model for bundled, adapter, and MCP tools
- Unified capability discovery and checking

---

## MCP Server Security

MCP servers provide powerful integration capabilities but require careful security considerations. The platform implements a **defense-in-depth approach** with multiple security layers.

### v1: Process Isolation + Verified Allowlist

**Security Model:**

In v1, MCP servers run as **separate child processes** with a **manually verified allowlist** to prevent malicious servers.

**Allowlist Protection:**

```typescript
interface MCPServerAllowlistEntry {
  serverName: string;
  packageName: string;        // NPM package or command
  verified: boolean;          // Manually reviewed by maintainers
  securityNotes?: string;
  addedAt: Date;
  reviewedBy: string;
}

// Only allowlisted servers can be installed
const VERIFIED_MCP_SERVERS: MCPServerAllowlistEntry[] = [
  {
    serverName: 'google-calendar',
    packageName: '@modelcontextprotocol/server-google-calendar',
    verified: true,
    addedAt: new Date('2026-03-01'),
    reviewedBy: 'platform-team',
  },
  {
    serverName: 'github',
    packageName: '@modelcontextprotocol/server-github',
    verified: true,
    addedAt: new Date('2026-03-01'),
    reviewedBy: 'platform-team',
  },
  {
    serverName: 'filesystem',
    packageName: '@modelcontextprotocol/server-filesystem',
    verified: true,
    securityNotes: 'Restricted to ~/Documents by default',
    addedAt: new Date('2026-03-01'),
    reviewedBy: 'platform-team',
  },
];

// Installation validation
async function installMCPServer(serverName: string): Promise<void> {
  const entry = VERIFIED_MCP_SERVERS.find(s => s.serverName === serverName);

  if (!entry || !entry.verified) {
    throw new Error(
      `MCP server '${serverName}' is not on the verified allowlist.\n` +
      `For security, only verified servers can be installed.\n` +
      `To add a server to the allowlist, submit a security review request.`
    );
  }

  // Install from verified package
  await npmInstall(entry.packageName);
}
```

**Why Allowlist in v1:**
- MCP servers have full access to person's credentials
- Malicious server could exfiltrate sensitive data
- Process isolation alone is insufficient protection
- Manual review ensures server trustworthiness

**Process Isolation:**

Each person's MCP server runs in a separate process:

```typescript
// Dad's Google Calendar server
const dadProcess = spawn('npx', ['-y', '@modelcontextprotocol/server-google-calendar'], {
  env: {
    GOOGLE_ACCESS_TOKEN: dad.decrypted_access_token,
    GOOGLE_REFRESH_TOKEN: dad.decrypted_refresh_token,
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});

// Mom's Google Calendar server (separate process)
const momProcess = spawn('npx', ['-y', '@modelcontextprotocol/server-google-calendar'], {
  env: {
    GOOGLE_ACCESS_TOKEN: mom.decrypted_access_token,
    GOOGLE_REFRESH_TOKEN: mom.decrypted_refresh_token,
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});
```

**Benefits:**
- Process crash isolated to one person's server
- Credentials never shared between persons
- Server misbehavior contained to one process

**Limitations:**
- Processes can still access filesystem and network
- Limited resource controls (CPU, memory)
- Requires manual security reviews (allowlist)

### v2: Container Isolation (Future)

**Enhanced Security Model:**

In v2, MCP servers will run in **Docker/Podman containers** with strict resource and network controls.

**Container Configuration:**

```typescript
interface MCPServerContainerConfig {
  image: string;
  cpuLimit: number;              // CPU cores
  memoryLimit: string;           // '512Mi', '1Gi'
  networkPolicy: 'none' | 'restricted' | 'full';
  volumeMounts: VolumeMount[];
  securityContext: {
    readOnlyRootFilesystem: boolean;
    runAsNonRoot: boolean;
    allowPrivilegeEscalation: boolean;
    capabilities: string[];      // Linux capabilities
  };
}

// Example: Restricted GitHub MCP server
const githubConfig: MCPServerContainerConfig = {
  image: 'modelcontextprotocol/server-github:latest',
  cpuLimit: 0.5,                 // 0.5 CPU cores
  memoryLimit: '512Mi',          // 512 MB RAM
  networkPolicy: 'restricted',   // Only github.com
  securityContext: {
    readOnlyRootFilesystem: true,
    runAsNonRoot: true,
    allowPrivilegeEscalation: false,
    capabilities: [],            // No special capabilities
  },
};

// Spawn container per person
const container = await docker.run({
  image: config.image,
  env: {
    GITHUB_TOKEN: person.decrypted_github_token,
  },
  resources: {
    cpuLimit: config.cpuLimit,
    memoryLimit: config.memoryLimit,
  },
  network: {
    mode: config.networkPolicy,
    allowedHosts: ['github.com', 'api.github.com'],
  },
  security: config.securityContext,
});
```

**Container Security Benefits:**

1. **Stronger Isolation**
   - Filesystem isolation (read-only root)
   - Network isolation (restrict egress)
   - Resource limits (prevent DoS)

2. **Untrusted Servers**
   - Can run community servers without manual review
   - Container limits damage from malicious code
   - Network policies prevent data exfiltration

3. **Resource Management**
   - CPU and memory limits prevent resource exhaustion
   - Per-person quotas
   - System remains responsive

4. **No Allowlist Required**
   - Users can install any MCP server
   - Container security provides protection
   - Community ecosystem unlocked

**Migration Path:**
- v1: Process isolation + allowlist (ship quickly, secure)
- v2: Container isolation (remove allowlist, fully open ecosystem)

### Per-Person Credential Isolation

**Credential Storage:**

```sql
-- Per-person MCP credentials
CREATE TABLE mcp_credentials (
  id UUID PRIMARY KEY,
  person_id UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  server_name VARCHAR(100) NOT NULL,
  credentials JSONB NOT NULL, -- EncryptedCredentials object
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(person_id, server_name)
);
```

**Credential Flow:**

```typescript
// 1. OAuth flow per person
async function connectMCPIntegration(person: Person, serverName: string) {
  // Initiate OAuth for this specific person
  const authUrl = await generateOAuthUrl(serverName, person.id);

  // User completes OAuth (browser flow)
  const tokens = await waitForOAuthCallback(person.id);

  // Encrypt and store tokens
  const encrypted = await encryptCredentials(tokens);

  await db.insert(mcp_credentials).values({
    person_id: person.id,
    server_name: serverName,
    credentials: encrypted,
  });

  // Spawn MCP server for this person
  await mcpRunner.startServer(person.id, serverName);
}

// 2. Decrypt credentials only when spawning server
async function spawnMCPServer(personId: string, serverName: string) {
  // Load encrypted credentials from database
  const record = await db.query.mcp_credentials.findFirst({
    where: and(
      eq(mcp_credentials.person_id, personId),
      eq(mcp_credentials.server_name, serverName)
    ),
  });

  // Decrypt credentials in-memory
  const decrypted = await decryptCredentials(record.credentials);

  // Pass to server process (environment variables)
  const process = spawn(command, args, {
    env: {
      ...decrypted, // Short-lived, in-memory only
    },
  });

  // Credentials never logged, never stored unencrypted
}
```

**Security Properties:**
- Credentials encrypted at rest (AES-256-GCM)
- Decrypted only when spawning server
- Never logged or persisted unencrypted
- Isolated per person (dad's tokens ≠ mom's tokens)
- Automatic cleanup on person deletion

### MCP Security Best Practices

**For Platform Maintainers:**

1. **Verify Allowlist Additions**
   - Review source code of MCP server
   - Check for suspicious network calls
   - Validate credential handling
   - Test in isolated environment

2. **Monitor Server Behavior**
   - Log all MCP server spawns
   - Track resource usage (CPU, memory, network)
   - Alert on anomalous behavior

3. **Rotate Credentials**
   - Periodic credential rotation
   - Revoke tokens on MCP server uninstall
   - Audit credential access

**For Users:**

1. **Connect Only Necessary Integrations**
   - Only install MCP servers you need
   - Review server permissions before connecting
   - Disconnect unused integrations

2. **Review Shared Capabilities**
   - Periodically review who has access to your capabilities
   - Revoke unused grants
   - Use expiration dates for temporary access

3. **Monitor Access**
   - Review audit logs for capability usage
   - Alert on unexpected tool executions

---

## Security Testing

### Required Coverage

**From Implementation Plan** (100% coverage requirements for security-critical code):

**Security Tests**:
- ✓ Self-scoped tools cannot target other users
- ✓ Tier 4 tools not callable via conversation
- ✓ Credentials redacted in all logs
- ✓ Approval timeout enforced
- ✓ Failed approvals audited
- ✓ Cross-person configuration blocked
- ✓ Privilege escalation prevented

### Session API Authorization

REST API endpoints for session access require authorization:

**Authorization Rules:**

```typescript
// GET /api/sessions/:id - View session details
async function authorizeSessionAccess(person: Person, sessionId: string): Promise<boolean> {
  const session = await getSession(sessionId);

  // 1. Admin can view all sessions
  if (person.role === 'admin') {
    return true;
  }

  // 2. Person can view their own sessions
  if (session.personId === person.id) {
    return true;
  }

  // 3. Otherwise, denied
  return false;
}

// GET /api/sessions - List sessions
async function listAuthorizedSessions(person: Person): Promise<Session[]> {
  if (person.role === 'admin') {
    // Admin sees all household sessions
    return await getSessions({ householdId: person.householdId });
  } else {
    // Others see only their own sessions
    return await getSessions({ personId: person.id });
  }
}
```

**Session Data Sanitization:**

Even for authorized access, sensitive data is redacted:

```typescript
interface SessionResponse {
  id: string;
  personId: string;
  personName: string;
  startedAt: Date;
  endedAt?: Date;
  executionTrace: ExecutionLogEntry[];  // Already redacted via SecureSerializer
  // No raw credentials, no unredacted tool inputs
}
```

**Rate Limiting:**

Session API endpoints respect same rate limits as assistant requests:
- 30 requests per minute per person
- 3 concurrent requests per person

### Security Audit

**Success Criteria** (from Implementation Plan):
- Multiple persons in a household can interact with the assistant
- Each person is connected to their own service instances (Google, etc.)
- Three-tier role model works (admin, member, limited)
- Granular permissions can be granted and revoked via CLI
- Integration sharing permissions work (e.g., dad can grant kids read access to his calendar integration)
- Limited role members can be given specific permissions (e.g., grandma can be granted access to dad's calendar but not household memory)
- Admin role has all permissions automatically
- Member role has standard household permissions
- Unknown identities are blocked until paired (security default)
- Pairing flow works (6-digit codes, CLI approval)
- Identity is correctly resolved and authorization is enforced
- Permission checks happen before all tool executions
- Resource limits prevent abuse (request size, concurrency, rate limiting)
- Requests can be cancelled (long operations interruptible)
- Tools execute only with proper permissions
- Tools respect cancellation (AbortSignal propagation)
- Self-configuration works safely via conversation (four-tier security model)
- Users can configure themselves via conversation (self-scoped tools)
- Sensitive operations require approval (llm.add, integration.connect)
- Cross-person configuration is blocked (cannot configure others)
- Credentials are never logged (redacted to [REDACTED])
- Approval workflow works (60-second timeout, requires 'APPROVE')
- Admin operations remain CLI-only (physical security)
