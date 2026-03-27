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
    drop index if exists integration_connections_person_integration_idx
  `);

  await db.execute(sql`
    create index if not exists integration_connections_person_integration_idx
      on integration_connections(person_id, integration_key)
  `);

  await db.execute(sql`
    create table if not exists integration_exposed_tools (
      id uuid primary key,
      connection_id uuid not null references integration_connections(id),
      tool_name varchar(200) not null,
      description text not null,
      input_json_schema jsonb not null,
      enabled varchar(10) not null,
      created_at timestamptz not null,
      updated_at timestamptz not null
    )
  `);

  await db.execute(sql`
    create unique index if not exists integration_exposed_tools_connection_tool_name_idx
      on integration_exposed_tools(connection_id, tool_name)
  `);

  await db.execute(sql`
    create table if not exists connection_tool_grants (
      connection_id uuid not null references integration_connections(id),
      tool_id uuid not null references integration_exposed_tools(id),
      owner_id uuid not null references persons(id),
      grantee_id uuid not null references persons(id),
      granted_by uuid references persons(id),
      granted_at timestamptz not null,
      expires_at timestamptz,
      primary key (connection_id, tool_id, owner_id, grantee_id)
    )
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
    create table if not exists assistant_profiles (
      key varchar(64) primary key,
      instructions text not null,
      updated_at timestamptz not null
    )
  `);

  await db.execute(sql`
    create table if not exists assistant_identity (
      key varchar(64) primary key,
      name text not null,
      role_description text not null,
      introduction_policy varchar(64) not null,
      signature_name text,
      updated_at timestamptz not null
    )
  `);

  await db.execute(sql`
    create table if not exists household_profiles (
      household_id uuid primary key references households(id),
      instructions text not null,
      updated_at timestamptz not null
    )
  `);

  await db.execute(sql`
    create table if not exists person_profiles (
      person_id uuid primary key references persons(id),
      instructions text not null,
      updated_at timestamptz not null
    )
  `);

  await db.execute(sql`
    create table if not exists person_preferences (
      person_id uuid primary key references persons(id),
      show_progress varchar(10) not null,
      updated_at timestamptz not null
    )
  `);

  await db.execute(sql`
    do $$
    begin
      if to_regclass('public.person_runtime_preferences') is not null then
        insert into person_preferences (person_id, show_progress, updated_at)
        select legacy.person_id, legacy.show_progress, legacy.updated_at
        from person_runtime_preferences legacy
        on conflict (person_id) do nothing;
      end if;
    end
    $$;
  `);

  await db.execute(sql`
    create table if not exists conversation_sessions (
      id uuid primary key,
      person_id uuid not null references persons(id),
      channel_type varchar(32) not null,
      external_user_id text not null,
      chat_id text,
      summary text,
      created_at timestamptz not null,
      updated_at timestamptz not null
    )
  `);

  await db.execute(sql`
    create unique index if not exists conversation_sessions_person_channel_external_chat_idx
      on conversation_sessions(person_id, channel_type, external_user_id, coalesce(chat_id, ''))
  `);

  await db.execute(sql`
    create table if not exists session_messages (
      id uuid primary key,
      session_id uuid not null references conversation_sessions(id),
      role varchar(32) not null,
      content text not null,
      created_at timestamptz not null
    )
  `);

  await db.execute(sql`
    create table if not exists cron_jobs (
      id uuid primary key,
      person_id uuid not null references persons(id),
      name varchar(200) not null,
      status varchar(32) not null,
      schedule varchar(120) not null,
      timezone varchar(120) not null,
      mode varchar(32) not null,
      target jsonb not null,
      last_run_at timestamptz,
      next_run_at timestamptz not null,
      created_at timestamptz not null,
      updated_at timestamptz not null
    )
  `);

  await db.execute(sql`
    create index if not exists cron_jobs_status_next_run_idx
      on cron_jobs(status, next_run_at)
  `);

  await db.execute(sql`
    create table if not exists cron_runs (
      id uuid primary key,
      job_id uuid not null references cron_jobs(id),
      request_id uuid,
      trigger varchar(32) not null,
      status varchar(32) not null,
      scheduled_for timestamptz not null,
      started_at timestamptz not null,
      completed_at timestamptz,
      output text,
      error text
    )
  `);

  await db.execute(sql`
    create index if not exists cron_runs_job_started_idx
      on cron_runs(job_id, started_at desc)
  `);

  await db.execute(sql`
    create table if not exists structured_execution_runs (
      id uuid primary key,
      request_id uuid,
      person_id uuid references persons(id),
      skill_name varchar(200) not null,
      runtime varchar(64) not null,
      status varchar(32) not null,
      message_text text not null,
      current_step_id varchar(200),
      state jsonb,
      resume_token uuid,
      trace jsonb,
      result text,
      created_at timestamptz not null,
      updated_at timestamptz not null,
      completed_at timestamptz
    )
  `);

  await db.execute(sql`
    alter table structured_execution_runs
      add column if not exists current_step_id varchar(200)
  `);

  await db.execute(sql`
    alter table structured_execution_runs
      add column if not exists state jsonb
  `);

  await db.execute(sql`
    alter table structured_execution_runs
      add column if not exists resume_token uuid
  `);

  await db.execute(sql`
    create unique index if not exists structured_execution_runs_resume_token_idx
      on structured_execution_runs(resume_token)
      where resume_token is not null
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
