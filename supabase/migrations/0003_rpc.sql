-- ─────────────────────────────────────────────────────────────────────────────
-- 0003 — Reorder RPC
--
-- §44 — reordering a board must be ONE transaction. Six sequential UPDATEs would
-- leave the board half-swapped if the fifth failed, and the deferred unique
-- constraint on (user_id, selection_order) is the only thing standing between a
-- position swap and a constraint violation mid-statement.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.reorder_selections(
  p_user_id     uuid,
  p_ordered_ids uuid[]
)
returns void
language plpgsql
-- SECURITY INVOKER (the default, stated for emphasis): RLS still applies to the
-- UPDATE below. The explicit is_admin() check above it is not the boundary — it
-- exists so a non-admin gets a clean 42501 instead of a silent zero-row update.
security invoker
set search_path = ''
as $$
declare
  v_updated int;
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if p_ordered_ids is null or array_length(p_ordered_ids, 1) is null then
    raise exception 'orderedIds must not be empty' using errcode = '22023';
  end if;

  -- One statement. The deferred constraint is checked at COMMIT, by which point
  -- every row holds its final position.
  update public.user_team_selections s
     set selection_order = t.ord
    from (
      select unnest(p_ordered_ids)                  as id,
             generate_subscripts(p_ordered_ids, 1)  as ord
    ) t
   where s.id = t.id
     and s.user_id = p_user_id;

  get diagnostics v_updated = row_count;

  -- Every id must belong to this user's board. A mismatch means the caller sent
  -- someone else's selection ids, and silently reordering five of six rows is
  -- worse than refusing.
  if v_updated <> array_length(p_ordered_ids, 1) then
    raise exception 'orderedIds do not all belong to user %', p_user_id
      using errcode = '22023';
  end if;
end;
$$;

comment on function public.reorder_selections(uuid, uuid[]) is
  'Atomically renumbers a board''s selections. Raises 42501 for non-administrators (§44).';

-- Revoking from PUBLIC is not enough on Supabase: its default privileges grant
-- EXECUTE on every new function in `public` to `anon` DIRECTLY, and a revoke
-- from PUBLIC does not touch a direct grant. Found by running these migrations
-- against real Postgres with Supabase's defaults simulated — without the
-- explicit `from anon`, anon could call this function and was stopped only by
-- the is_admin() check inside it. Now it is stopped twice.
revoke execute on function public.reorder_selections(uuid, uuid[]) from public, anon;
grant execute on function public.reorder_selections(uuid, uuid[]) to authenticated;
