-- ─────────────────────────────────────────────────────────────────────────────
-- 0002 — Row Level Security
--
-- This file IS the security model (§30, §31). The Worker's 401/403 responses are
-- a nicer error message in front of it; if every line of `apps/api` were deleted
-- and someone pointed curl straight at PostgREST, the rules below would still
-- hold.
--
-- Two sentences describe the whole policy set:
--   • Read  — public. `anon` included, deliberately (plan §11.1).
--   • Write — administrators only, every table, every verb.
-- ─────────────────────────────────────────────────────────────────────────────

-- Already enabled by 0001 at the moment each table was created, so no table was
-- ever exposed. Repeated here (a no-op) so that this file states the entire
-- security model on its own, and so a hand-edited 0001 cannot silently lose it.
alter table public.app_users            enable row level security;
alter table public.teams                enable row level security;
alter table public.user_team_selections enable row level security;

-- Zero policies, forever. RLS with no policy denies everything, which makes the
-- admin registry unreadable through PostgREST by any role the API can assume.
alter table public.admins               enable row level security;

-- Belt and braces: RLS filters what a GRANT already allows, so removing write
-- privileges from `anon` at the table level means an unauthenticated write is
-- refused twice, by two independent mechanisms.
grant usage on schema public to anon, authenticated;

grant select on public.app_users, public.teams, public.user_team_selections
  to anon, authenticated;

grant insert, update, delete on public.app_users, public.teams, public.user_team_selections
  to authenticated;

-- `anon` is granted no write privilege at all, and `admins` is granted nothing
-- to anybody. Revoke explicitly in case a previous run or a Supabase default
-- left something behind.
revoke insert, update, delete on public.app_users, public.teams, public.user_team_selections
  from anon;
revoke all on public.admins from anon, authenticated;

-- ─── is_admin() ──────────────────────────────────────────────────────────────
-- SECURITY DEFINER because it must read `public.admins`, which has no policies
-- and is therefore invisible to the caller's own role.
--
-- Get this wrong (leave it SECURITY INVOKER) and the failure is quiet and
-- baffling: the function returns false for a genuine administrator, every admin
-- write is refused, and nothing anywhere reports an error — the row simply is
-- not visible to the function.
--
-- `search_path = ''` with fully qualified names closes the search-path
-- hijacking hole that SECURITY DEFINER otherwise opens.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.admins a
    -- (select auth.uid()) rather than auth.uid(): Postgres caches the subquery
    -- once per statement instead of re-evaluating it per row.
    where a.auth_user_id = (select auth.uid())
  );
$$;

comment on function public.is_admin() is
  'True when the caller''s auth identity is registered in public.admins. SECURITY DEFINER so it can read that policy-less table.';

revoke execute on function public.is_admin() from public;
grant execute on function public.is_admin() to anon, authenticated;

-- ─── Read: public ────────────────────────────────────────────────────────────
-- `anon` is named explicitly, and this comment is why: viewers do not sign in
-- (plan §11.1, decided 2026-09-17). If someone later "corrects" these policies
-- to `authenticated` only, every board goes dark for every viewer.
--
-- What is exposed: nine display names and a list of college football teams.
-- The exposure is a quota concern, not a data one (plan §10 risk register).

drop policy if exists read_users on public.app_users;
create policy read_users on public.app_users
  for select to anon, authenticated using (true);

drop policy if exists read_teams on public.teams;
create policy read_teams on public.teams
  for select to anon, authenticated using (true);

drop policy if exists read_selections on public.user_team_selections;
create policy read_selections on public.user_team_selections
  for select to anon, authenticated using (true);

-- ─── Write: administrators only ──────────────────────────────────────────────
-- `for all` covers insert, update, and delete. `anon` gets no write policy at
-- all, so an unauthenticated write is refused by the database itself — which is
-- exactly the §30 requirement that a user "should not be able to modify data
-- merely by manually constructing a network request".
--
-- Both USING (which rows may be touched) and WITH CHECK (what the result may
-- look like) are required. USING alone would let an admin check pass on read
-- while an INSERT slipped through unguarded.

drop policy if exists admin_write_users on public.app_users;
create policy admin_write_users on public.app_users
  for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

drop policy if exists admin_write_teams on public.teams;
create policy admin_write_teams on public.teams
  for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

drop policy if exists admin_write_selections on public.user_team_selections;
create policy admin_write_selections on public.user_team_selections
  for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
