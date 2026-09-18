# Supabase Setup (Phase 1.3)

About 15 minutes, all in the Supabase web dashboard. No CLI and no Docker.

Everything in this guide needs your account, so it cannot be scripted from the
repo. When you finish, `npm run verify:rls` confirms it worked.

> Supabase renames dashboard menus from time to time. If a label below does not
> match exactly, look for the setting it describes. What each step must achieve
> is stated in bold.

---

## 1. Create the project

1. Go to <https://supabase.com/dashboard> and choose **New project**. The free
   tier is enough.
2. Choose a region close to you and set a strong database password. Save the
   password in your password manager. This app never uses it, but you will want
   it if you ever connect with `psql`.
3. Wait for provisioning to finish, which takes about two minutes.

## 2. Collect the two values the app needs

| Value                      | Where to find it                     | Example                                 |
| -------------------------- | ------------------------------------ | --------------------------------------- |
| **Project URL**            | Project Settings → Data API (or API) | `https://abcdefghijkl.supabase.co`      |
| **Anon / publishable key** | Project Settings → API Keys          | `sb_publishable_…` or a long `eyJ…` JWT |

The app accepts either key format. Both are **safe to expose**: they identify the
project, and they grant nothing that the RLS policies do not allow.

**Do not copy the `service_role` / `sb_secret_…` key anywhere in this project.**
Nothing here needs it, and it bypasses every security rule in the database. The
reasons are explained in `apps/api/src/db/client.ts`.

## 3. Confirm the project signs tokens with an asymmetric key

**Goal: the JWKS endpoint returns at least one key.**

The Worker verifies admin tokens against Supabase's published public keys
(JWKS). Open this URL in a browser, using your project URL:

```
https://YOUR-PROJECT-REF.supabase.co/auth/v1/.well-known/jwks.json
```

**✅ Success looks like this.** One or more entries inside `"keys":[ … ]`, each
with `"kty":"EC"` and `"alg":"ES256"`:

```text
{"keys":[{"alg":"ES256","crv":"P-256","ext":true,"key_ops":["verify"],"kid":"015b…","kty":"EC","use":"sig","x":"…","y":"…"}, …]}
```

If you see this, **step 3 is done. Move on to step 4.** There is nothing to
change and nothing to copy, and the Worker fetches these keys by itself.

- **Two or more keys is normal.** Supabase publishes the current signing key
  alongside a standby or previously used key, so tokens stay valid across a key
  rotation. The Worker picks the right one using each token's `kid`.
- **Don't keep generating new keys.** Each new key only adds another entry, and
  this page never changes to a different kind of "done" state. What you already
  see is the finished state.
- **These are public keys**, published so anyone can check a token's signature.
  Sharing them is harmless.

**❌ Failure looks like `{"keys":[]}`**, an empty list. Only in this case does
the project still use the legacy shared HS256 secret. Go to **Project Settings →
JWT Keys**, create an **ECC (P-256)** signing key, and make it the current key.
Reload the URL and it should now look like the success example above.

If the list is empty, every admin request returns 401. The Worker refuses to
accept tokens it cannot verify, on purpose.

## 4. Disable public sign-ups

**Goal: nobody can create an account on this project from outside.**

Go to **Authentication → Sign In / Providers** (or Authentication → Settings)
and turn off **Allow new users to sign up**.

Viewers never sign in (plan §11.1), so self-service sign-up has no purpose here.
Turning it off does **not** stop you from adding users by hand in step 6.

## 5. Run the migrations and seed

**Goal: four tables, RLS on, nine users, 54 selections.**

Open **SQL Editor → New query**. For each file below, in this order: open it in
VS Code, copy all of it, paste it into the editor, and click **Run**. Use a
fresh query tab for each file, or replace the editor's contents each time.

| #   | File                                  | Expect                                                                                        |
| --- | ------------------------------------- | --------------------------------------------------------------------------------------------- |
| 1   | `supabase/migrations/0001_schema.sql` | "Success. No rows returned"                                                                   |
| 2   | `supabase/migrations/0002_rls.sql`    | "Success. No rows returned"                                                                   |
| 3   | `supabase/migrations/0003_rpc.sql`    | "Success. No rows returned"                                                                   |
| 4   | `supabase/seed.sql`                   | A results grid: **9 users, 50 teams, 54 selections**, then nine rows each with `team_count` 6 |

All four files are safe to run again, and running them twice changes nothing.

### Warnings Supabase may show before running

Supabase scans each query before it runs and may ask you to confirm. These
warnings are expected, and it is safe to confirm and run:

| File         | Warning                               | Why it is safe                                                                                                                                                                                                                                                  |
| ------------ | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0001         | None expected                         | The file enables RLS on each table right after creating it, and it drops nothing. If a "destructive" warning still appears, it is reacting to `create or replace`, which updates a trigger or function in place. That is safe                                   |
| 0002         | "Destructive operations"              | Triggered by `drop policy if exists` and `revoke`. Each `drop policy` removes only a same-named policy that the very next line recreates, which is what makes the file re-runnable. Each `revoke` _removes_ access, so it tightens security. No data is touched |
| 0003         | Possibly "destructive operations"     | Triggered by `revoke execute`, which stops anonymous visitors from calling the reorder function. It tightens security                                                                                                                                           |
| Any of these | "Creates tables without enabling RLS" | It should not appear with the current files. If it does, you either ran an older copy of 0001 or the editor still held something else. Either way, run the current 0001 and then 0002. Both enable RLS                                                          |

**When to stop instead:** the warning itself is generic and doesn't say which
statement triggered it. Before confirming, you can press `Ctrl+F` in the editor
and search for `delete from`, `truncate`, and `drop table`. None of these four
files contain any of them. If a search finds one, something other than these
files is in the editor, so clear it and paste the file again.

> **Renaming the nine people.** Every name except Wilson is a placeholder
> (Avery, Blake, Casey, …). You can rename them at any time:
>
> ```sql
> update public.app_users set display_name = 'Real Name' where display_name = 'Avery';
> ```
>
> Boards are linked by id, not by name, so renaming never disturbs a board.

## 6. Create the administrator and one throwaway test account

**Goal: one account that is an admin, and one that is deliberately not.**

Go to **Authentication → Users → Add user → Create new user** and create two
accounts. Tick **Auto Confirm User** for both, if the option is offered.

| Account                     | Purpose                                                                              | Goes in `admins`? |
| --------------------------- | ------------------------------------------------------------------------------------ | ----------------- |
| Your real email             | The administrator                                                                    | **Yes**           |
| e.g. `stranger@example.com` | A signed-in account that must still be refused. Used only by the verification script | **No, never**     |

Click your admin user to open it and copy its **User UID**, which is a UUID.
Then run this in the SQL Editor:

```sql
insert into public.admins (auth_user_id, label)
values ('PASTE-YOUR-USER-UID-HERE', 'Owner');
```

That line is the only way to make someone an administrator. It is deliberately
not possible from the app (plan §5.1).

## 7. (Optional) Watch the deferred constraint work

The plan asks for this check to be done now rather than discovered in Phase 5.
It has already passed on real Postgres during development. If you want to see it
yourself, run this block in the SQL Editor:

```sql
-- Swap Alabama (position 1) and Georgia (position 2) on Wilson's board using
-- two separate UPDATEs. After the first statement, two rows both hold
-- position 2. That is only legal because uq_user_order is
-- DEFERRABLE INITIALLY DEFERRED: uniqueness is checked at COMMIT, not per
-- statement.
begin;
update public.user_team_selections s set selection_order = 2
  from public.app_users u, public.teams t
 where u.id = s.user_id and t.id = s.team_id
   and u.display_name = 'Wilson' and t.provider_team_id = '333';   -- Alabama → 2
update public.user_team_selections s set selection_order = 1
  from public.app_users u, public.teams t
 where u.id = s.user_id and t.id = s.team_id
   and u.display_name = 'Wilson' and t.provider_team_id = '61';    -- Georgia → 1
commit;

-- Georgia should now be first and Alabama second.
select s.selection_order, t.display_name
  from public.user_team_selections s
  join public.app_users u on u.id = s.user_id
  join public.teams t on t.id = s.team_id
 where u.display_name = 'Wilson'
 order by s.selection_order;
```

To put them back, run the same block with the two numbers exchanged: Alabama
gets `1`, Georgia gets `2`.

The constraint still catches a real mistake. If both UPDATEs set position `1`,
the COMMIT fails with `duplicate key value violates unique constraint
"uq_user_order"`, and nothing changes.

## 8. Point the app at the project

**Goal: two local files, both gitignored, holding the values from step 2.**

> **Use the project root URL,** such as `https://abcdefghijkl.supabase.co`. The
> dashboard also shows a REST URL ending in `/rest/v1/`, and that is the wrong
> one here. The app adds `/rest/v1` and `/auth/v1` itself, so with the REST URL
> every request would go to `/rest/v1/rest/v1/…` and fail.

**`apps/api/.dev.vars`** is read by the Worker **when `npm run dev` starts**.
If the server is already running when you create or edit this file, stop it
with `Ctrl+C` and start it again:

```
SUPABASE_URL=https://YOUR-PROJECT-REF.supabase.co
SUPABASE_ANON_KEY=YOUR-ANON-OR-PUBLISHABLE-KEY
```

**`.env`** at the repo root is read by `npm run verify:rls`:

```
SUPABASE_URL=https://YOUR-PROJECT-REF.supabase.co
SUPABASE_ANON_KEY=YOUR-ANON-OR-PUBLISHABLE-KEY
VERIFY_ADMIN_EMAIL=you@example.com
VERIFY_ADMIN_PASSWORD=…
VERIFY_NONADMIN_EMAIL=stranger@example.com
VERIFY_NONADMIN_PASSWORD=…
```

Both files have committed templates (`apps/api/.dev.vars.example` and
`.env.example`), and both real files are in `.gitignore`. Before your first
commit, run `git status` and make sure neither real file is listed.

Then follow **"Level 3"** in the root `README.md` to prove it all works.

---

## If something goes wrong

| Symptom                                                | Likely cause                                                                                                                                |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Seed says `relation "public.app_users" does not exist` | The migrations were not run first, or 0001 failed. Run them in order                                                                        |
| `/api/users` returns 500, "temporarily unreachable"    | Wrong `SUPABASE_URL` in `.dev.vars`, or the project is paused (see below)                                                                   |
| `/api/users` returns `{"users":[]}`                    | The seed has not been run in this project                                                                                                   |
| Admin requests always return 401                       | The JWKS is empty (step 3), or the token has expired (they last one hour)                                                                   |
| Admin requests return 403 for **your** account         | Your UID is not in `public.admins` (step 6), or you pasted the wrong UID                                                                    |
| `verify:rls` reports admin writes failing              | Same as above. `is_admin()` returns false for your token                                                                                    |
| Everything worked last week, and now nothing does      | Free projects **pause after about 7 days of inactivity**. Press Restore in the dashboard. Phase 5 adds a keep-alive ping. This is not a bug |
