import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

export async function ensureSchema(db: NodePgDatabase): Promise<void> {
  await db.execute(sql`
    create table if not exists households (
      id uuid primary key,
      name text not null,
      created_at timestamptz not null
    )
  `);

  await db.execute(sql`
    create table if not exists persons (
      id uuid primary key,
      household_id uuid not null references households(id),
      name text not null,
      role varchar(32) not null,
      created_at timestamptz not null
    )
  `);

  await db.execute(sql`
    create table if not exists channel_identities (
      id uuid primary key,
      person_id uuid not null references persons(id),
      channel_type varchar(32) not null,
      external_id text not null,
      display_label text,
      created_at timestamptz not null
    )
  `);

  await db.execute(sql`
    create unique index if not exists channel_identities_channel_type_external_id_idx
      on channel_identities(channel_type, external_id)
  `);

  await db.execute(sql`
    create table if not exists pairing_requests (
      id uuid primary key,
      channel_type varchar(32) not null,
      external_id text not null,
      display_label text,
      code varchar(6) not null,
      status varchar(32) not null,
      expires_at timestamptz not null,
      paired_at timestamptz,
      paired_person_id uuid references persons(id),
      created_at timestamptz not null
    )
  `);

  await db.execute(sql`
    create unique index if not exists pairing_requests_code_idx
      on pairing_requests(code)
  `);

  await db.execute(sql`
    create table if not exists core_policy_grants (
      person_id uuid not null references persons(id),
      permission varchar(64) not null,
      granted_by uuid references persons(id),
      granted_at timestamptz not null,
      primary key (person_id, permission)
    )
  `);

  await db.execute(sql`
    create table if not exists integration_connections (
      id uuid primary key,
      person_id uuid not null references persons(id),
      integration_key varchar(100) not null,
      driver_type varchar(32) not null,
      status varchar(32) not null,
      encrypted_credentials jsonb not null,
      metadata jsonb,
      created_at timestamptz not null,
      updated_at timestamptz not null
    )
  `);

  await db.execute(sql`
    create unique index if not exists integration_connections_person_integration_idx
      on integration_connections(person_id, integration_key)
  `);

  await db.execute(sql`
    create table if not exists memory_entries (
      id uuid primary key,
      household_id uuid not null references households(id),
      person_id uuid references persons(id),
      scope varchar(32) not null,
      content text not null,
      created_at timestamptz not null
    )
  `);

  await db.execute(sql`
    create table if not exists tool_capabilities (
      capability_name varchar(200) primary key,
      tool_id varchar(200) not null,
      description text not null,
      target_scope varchar(50) not null,
      created_at timestamptz not null
    )
  `);

  await db.execute(sql`
    create table if not exists capability_grants (
      person_id uuid not null references persons(id),
      capability_name varchar(200) not null references tool_capabilities(capability_name),
      granted_by uuid references persons(id),
      granted_at timestamptz not null,
      expires_at timestamptz,
      primary key (person_id, capability_name)
    )
  `);

  await db.execute(sql`
    create table if not exists shared_capability_grants (
      owner_id uuid not null references persons(id),
      grantee_id uuid not null references persons(id),
      capability_name varchar(200) not null references tool_capabilities(capability_name),
      granted_at timestamptz not null,
      expires_at timestamptz,
      primary key (owner_id, grantee_id, capability_name)
    )
  `);
}
