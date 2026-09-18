# College Football Team Board

A private, mobile-friendly dashboard for nine people and their six college
football teams each. The spec is in [context/spec.md](context/spec.md) and the
build plan is in [context/plan.md](context/plan.md).

**Status: Phase 1 (Foundation & Contracts) is built.** There is no website to
look at yet. Phase 1 is the API skeleton, the database, and the contracts the
later phases build on. The web UI arrives in Phase 3.

---

## What's here

```
packages/shared/     Types and pure logic shared by the API and (later) the browser
apps/api/            Cloudflare Worker: the application API
  src/               Router, middleware, auth, database client
  test/              Tests, plus test/fixtures/espn/ (18 ESPN payloads, 17 of them real)
supabase/            SQL migrations, RLS policies, seed data
scripts/             ESPN fixture capture, RLS verifier, season-literal check
docs/                espn-notes.md (API findings), supabase-setup.md (setup guide)
```

## Commands

Run all of these from the repo root.

| Command                    | What it does                                                          |
| -------------------------- | --------------------------------------------------------------------- |
| `npm install`              | Installs everything, once                                             |
| `npm run verify`           | **The one to remember.** Typecheck, lint, tests, and the season check |
| `npm run test`             | Unit and route tests only (fast, offline)                             |
| `npm run test:watch`       | Re-runs tests every time you save a file                              |
| `npm run dev`              | Starts the API locally at <http://127.0.0.1:8787>                     |
| `npm run verify:rls`       | Tests your real Supabase security rules (needs setup)                 |
| `npm run capture:fixtures` | Re-downloads ESPN sample payloads                                     |
| `npm run format`           | Auto-formats all code                                                 |

---

## Testing Phase 1 on your machine

There are three levels. Each builds on the one before, and each proves more.
Levels 1 and 2 need **no accounts at all**.

### Level 1 — Automated checks (2 minutes, no accounts)

Open a terminal in VS Code (**Terminal → New Terminal**) and run:

```powershell
npm install
npm run verify
```

A pass looks like this at the end:

```
 Test Files  4 passed (4)
      Tests  101 passed (101)
✓ No hard-coded year literals outside packages/shared/src/season.ts
```

That one command runs four checks:

| Check            | What it proves                                                                         |
| ---------------- | -------------------------------------------------------------------------------------- |
| **typecheck**    | The code is valid strict TypeScript. The API and the shared types agree on every shape |
| **lint**         | No `any` types and no sloppy patterns (§41)                                            |
| **test**         | 101 tests, listed below                                                                |
| **check:season** | No year like `2026` is hard-coded anywhere, so next season needs no code change (§21)  |

What the 101 tests cover:

- **Season logic.** A January bowl game counts toward the _previous_ season,
  late August starts the new one, and a broken ESPN connection still produces a
  sensible season.
- **Freshness envelopes.** Stale data keeps its _original_ "last updated" time
  and is never relabeled as current (§39).
- **JWT security.** These tests use real cryptographic keys, not mocks. Forged
  tokens (`alg:none`, HS256 key confusion), tampered, expired, wrong-project and
  wrong-audience tokens are all rejected.
- **API routes.** Public routes work with no login. Admin routes return 401
  with no token and 403 with a non-admin token. Reads query the database as the
  anonymous role, and admin writes carry the admin's own token.

**Try it yourself:** run `npm run test:watch`, open
[packages/shared/src/season.ts](packages/shared/src/season.ts), and change
`REGULAR_SEASON_START_DAY = 21` to `22`. Save, and one test goes red within a
second. Change it back and it goes green again. That loop is how you'll work
from here on. Press `q` to quit watch mode.

### Level 2 — Run the API and call it (5 minutes, no accounts)

This starts the Worker in **workerd**, Cloudflare's actual runtime, on your
machine. It is not a simulation in Node.

**Terminal 1.** Start the server:

```powershell
npm run dev
```

Wait for `Ready on http://127.0.0.1:8787`. Wrangler may ask one telemetry
question on its first run, and either answer is fine. Leave this terminal
running.

**Your browser.** Open these two URLs:

- <http://127.0.0.1:8787/api/health> should return `"status":"ok"` and the
  resolved `season`
- <http://127.0.0.1:8787/api/meta/season> should return the same season,
  wrapped in a `freshness` envelope

**Terminal 2** (click **+** in the terminal panel). Test the security boundary.
`curl.exe -i` prints the HTTP status line, which is the thing you are checking:

```powershell
# No token at all → must be 401 Unauthorized
curl.exe -i -X POST http://127.0.0.1:8787/api/admin/users

# A forged "alg:none" token (an unsigned token claiming to be valid) → must be 401
curl.exe -i -X POST http://127.0.0.1:8787/api/admin/users -H "Authorization: Bearer eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0."

# A bad user id → a clean 404 JSON error, not a crash
curl.exe -i http://127.0.0.1:8787/api/users/not-a-uuid
```

Every response has an `X-Request-Id` header. Any error body repeats that id, so
a failure can be traced to its log line.

> **Why `curl.exe` and not `curl`?** In Windows PowerShell, `curl` is an alias
> for a different command that prints the response differently. `curl.exe`
> is the real curl, which ships with Windows.

Before Supabase is connected, <http://127.0.0.1:8787/api/users> returns a 500
with `"The application database is not configured."` That is the expected
result. Look at Terminal 1 and you'll see a log line naming exactly what is
missing (`SUPABASE_URL and SUPABASE_ANON_KEY`) and how to fix it. Level 3
fixes it.

To stop the server, click into Terminal 1 and press `Ctrl+C`.

### Level 3 — Connect Supabase and prove the exit criteria

First work through **[docs/supabase-setup.md](docs/supabase-setup.md)**, which
takes about 15 minutes in the Supabase dashboard. Then:

**3a. Prove the database protects itself.** This matters more than any other
check in the phase:

```powershell
npm run verify:rls
```

This script talks to Supabase **directly**. It skips the Worker entirely and
builds requests by hand, the way an attacker would (§30). It checks three
identities:

1. **anon** (every viewer): can read the boards, cannot write anything
2. **a signed-in stranger**: can read the boards, cannot write anything, and
   gets `42501` from the reorder function
3. **you, the admin**: can read and write, and cleans up the test row it creates

It should end with `0 failed` and `Every write path is refused by the database
itself`. If it reports a failure, **do not deploy**. The message names the hole.

**3b. See real data through the API.** Start `npm run dev` again, since it now
reads `apps/api/.dev.vars`, and open:

- <http://127.0.0.1:8787/api/users> should list 9 users, each with
  `"teamCount":6`
- Copy any `id` from that list and open
  `http://127.0.0.1:8787/api/users/THAT-ID` to see the six teams in board order

**3c. Prove 403 and 201 with real tokens.** In Terminal 2, sign in as each
account and keep the token in a variable. Fill in your values first:

```powershell
$SUPABASE_URL = "https://YOUR-PROJECT-REF.supabase.co"
$ANON = "YOUR-ANON-OR-PUBLISHABLE-KEY"

function Get-Token($email, $password) {
  $body = @{ email = $email; password = $password } | ConvertTo-Json
  (Invoke-RestMethod -Method Post -Uri "$SUPABASE_URL/auth/v1/token?grant_type=password" `
     -Headers @{ apikey = $ANON } -ContentType "application/json" -Body $body).access_token
}

$STRANGER = Get-Token "stranger@example.com" "their-password"
$ADMIN    = Get-Token "you@example.com"      "your-password"
```

Then call the admin route once with each token:

```powershell
# Valid login, but not an admin → must be 403 Forbidden
curl.exe -i -X POST http://127.0.0.1:8787/api/admin/users -H "Authorization: Bearer $STRANGER" -H "Content-Type: application/json" -d '{\"displayName\":\"Should Not Exist\"}'

# The admin → 201 Created, and a 10th user now exists
curl.exe -i -X POST http://127.0.0.1:8787/api/admin/users -H "Authorization: Bearer $ADMIN" -H "Content-Type: application/json" -d '{\"displayName\":\"Test Person\"}'
```

The `\"` escapes are needed in Windows PowerShell 5.1. Without them PowerShell
strips the quotes out of the JSON before curl sees it.

Clean up the test user afterwards in the Supabase SQL Editor:

```sql
delete from public.app_users where display_name = 'Test Person';
```

Tokens expire after an hour. If you start getting 401s, run the two
`Get-Token` lines again.

### Phase 1 exit criteria and how each is checked

| Exit criterion (plan, Phase 1)                                                   | Checked by                                  | Status                         |
| -------------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------ |
| typecheck, lint, and test all green                                              | Level 1                                     | ✅ passes                      |
| `/api/health` returns a resolved season                                          | Level 2                                     | ✅ passes                      |
| `/api/users` returns 9 users with no token                                       | Level 3b                                    | ⏳ needs your Supabase project |
| `POST /api/admin/users` returns 401 with no token                                | Level 1 (automated) and Level 2             | ✅ passes                      |
| `POST /api/admin/users` returns 403 with a non-admin token                       | Level 1 (automated) and Level 3c            | ✅ automated · ⏳ live         |
| A raw PostgREST insert is refused **by the database** as anon and as a non-admin | Level 3a                                    | ⏳ needs your Supabase project |
| Fixtures cover all 11 cases, and `espn-notes.md` is written                      | [docs/espn-notes.md §9](docs/espn-notes.md) | ✅ 18 fixtures (1 synthetic)   |
| No season literal outside `season.ts`                                            | Level 1                                     | ✅ passes                      |

---

## Troubleshooting

| Problem                                          | Fix                                                                                                      |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `npm run dev` says port 8787 is in use           | An old server is still running. Close that terminal, or run `npx wrangler dev --port 8788` in `apps/api` |
| `/api/users` returns 500 after setup             | Check `apps/api/.dev.vars`, then restart `npm run dev`, which reads the file only at startup             |
| Admin calls always return 401                    | See step 3 of `docs/supabase-setup.md`. The project may have no public signing key                       |
| Things worked last week and nothing does now     | Free Supabase projects pause after about 7 days idle. Press Restore in the dashboard                     |
| `verify:rls` says "Could not read any app_users" | The seed has not been run, or the root `.env` points at a different project                              |

For database-side problems, the full table is at the bottom of
[docs/supabase-setup.md](docs/supabase-setup.md).
