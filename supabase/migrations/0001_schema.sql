-- ─────────────────────────────────────────────────────────────────────────────
-- 0001 — Schema
--
-- Three application-owned tables (§3) plus an admin registry. Note what is NOT
-- here: no records, no rankings, no games, no scores, no schedules. All of that
-- belongs to the sports provider and lives in cache, never in a table (§45). A
-- `games` table would become a stale second source of truth within one Saturday.
--
-- RLS is switched on immediately after each CREATE TABLE, in this file, not
-- later in 0002. Supabase grants `anon` full privileges on every new table in
-- `public` by default, so a table without RLS is writable by anyone holding the
-- public anon key for as long as it stays that way. With RLS on and no policies
-- yet, every table here is shut to the API until 0002 opens exactly what it
-- should: the gap between running this file and the next one fails closed.
--
-- Safe to re-run: every statement is IF NOT EXISTS / OR REPLACE / idempotent,
-- and nothing here drops anything.
--
-- Apply in the Supabase SQL editor, in file-number order.
-- ─────────────────────────────────────────────────────────────────────────────

-- `gen_random_uuid()` ships with Postgres 13+; Supabase also preinstalls pgcrypto.
create extension if not exists pgcrypto with schema extensions;

-- ─── Board participants ──────────────────────────────────────────────────────
-- NO auth identity and NO admin flag. Viewers never sign in (plan §11.1), so a
-- "user" here is purely a display profile that owns a board. Adding viewer
-- logins later means adding an auth link here AND narrowing the read policies in
-- 0002 — two deliberate changes, not one incidental one.
create table if not exists public.app_users (
  id            uuid primary key default gen_random_uuid(),
  display_name  text        not null check (length(trim(display_name)) between 1 and 60),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
alter table public.app_users enable row level security;

comment on table public.app_users is
  'Board participants. Display profiles only — no authentication identity (plan §11.1).';

-- ─── The only auth identities in the system ──────────────────────────────────
-- A separate table rather than a boolean on app_users, which satisfies §29's
-- separation of identity from profile more cleanly and means an administrator
-- need not be one of the nine board participants.
--
-- RLS is enabled here and this table NEVER gets a policy, making it unreadable
-- through the API by anyone. `is_admin()` (0002) reaches it only because it is
-- SECURITY DEFINER.
create table if not exists public.admins (
  auth_user_id uuid primary key references auth.users(id) on delete cascade,
  label        text,
  created_at   timestamptz not null default now()
);
alter table public.admins enable row level security;

comment on table public.admins is
  'Administrator registry. Deliberately has no RLS policies — invisible to the API. Managed with SQL, not a UI.';

-- ─── Team identity ───────────────────────────────────────────────────────────
-- §43 — selections reference a real provider entity, so a board stays correct
-- even when a provider tweaks a display name.
create table if not exists public.teams (
  id                uuid primary key default gen_random_uuid(),
  provider          text        not null default 'espn',
  provider_team_id  text        not null,
  name              text        not null,
  display_name      text,
  abbreviation      text,
  logo_url          text,
  conference        text,
  primary_color     text,
  alt_color         text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint uq_teams_provider_identity unique (provider, provider_team_id)
);
alter table public.teams enable row level security;

comment on column public.teams.provider_team_id is
  'The provider''s own id, e.g. ESPN "333" for Alabama. The stable key (§43).';

-- ─── Selections ──────────────────────────────────────────────────────────────
create table if not exists public.user_team_selections (
  id              uuid        primary key default gen_random_uuid(),
  user_id         uuid        not null references public.app_users(id) on delete cascade,
  team_id         uuid        not null references public.teams(id)     on delete restrict,
  selection_order smallint    not null check (selection_order between 1 and 24),
  created_at      timestamptz not null default now(),

  -- §3 — the same team must not appear twice on one board.
  constraint uq_user_team unique (user_id, team_id),

  -- §44 — one team per slot. DEFERRABLE is what makes an atomic reorder
  -- possible: swapping positions 2 and 3 transiently duplicates a value, and a
  -- non-deferrable constraint would reject the transaction mid-flight. See
  -- 0003_rpc.sql, and the swap test in docs/supabase-setup.md.
  constraint uq_user_order unique (user_id, selection_order) deferrable initially deferred
);
alter table public.user_team_selections enable row level security;

create index if not exists idx_selections_user_order
  on public.user_team_selections (user_id, selection_order);

-- `on delete restrict` above means a team referenced by any board cannot be
-- deleted. That is intentional (§42 — never leave an orphaned card), and Phase 5
-- surfaces it as a clear message rather than a 500.

-- 24, not 6: §52 wants headroom without a migration. Six is a UI convention.

-- ─── updated_at maintenance ──────────────────────────────────────────────────
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- CREATE OR REPLACE TRIGGER (Postgres 14+) keeps this file re-runnable without
-- a DROP, which Supabase's SQL editor would otherwise flag as destructive.
create or replace trigger trg_app_users_touch
  before update on public.app_users
  for each row execute function public.touch_updated_at();

create or replace trigger trg_teams_touch
  before update on public.teams
  for each row execute function public.touch_updated_at();
