# College Football Team Board

A private, mobile-friendly dashboard for nine people and their six college
football teams each. **Start with
[context/project-notes.md](context/project-notes.md)**: how it is built, what
was learned, what is deployed, and what is left. The original specification and
the phase-by-phase build plan are archived in
[context/archive/](context/archive/).

**Status: Phases 1–4 are complete. Phase 5 (admin and ship) is built and
deployed: the site is live at <https://cfb-board-pfc.pages.dev>, on real ESPN
data, and committed as `5dd38b3`.** What remains is yours: 24 hours of usage
numbers (see
[Testing Phase 5](#testing-phase-5-on-your-machine) and
[docs/ops.md](docs/ops.md)). The website has a home page listing every board,
each person's board of six team cards, a full team page (rank, record, the
live game, the previous and next games, the matchup prediction, and the whole
season's schedule), and an admin console for the administrator: add, rename,
and delete people, and add, remove, and reorder each board's teams. Nobody
signs in to look at boards. The data comes from ESPN or from a built-in mock
season. When ESPN fails, the API serves the last good data labeled as stale,
and the site shows that label instead of breaking the page.

---

## What's here

```
packages/shared/     Types and pure logic shared by the API and the browser
apps/api/            Cloudflare Worker: the application API
  src/               Router, middleware, auth, database client
    providers/       ESPN adapter, mock provider, fault injection
    cache/           TTL policy, the three cache tiers, stale-while-revalidate
    services/        Board, team, game, and search logic
    cron/            Cron warmers (calendar, rankings, team list, conferences)
  test/              Tests, plus test/fixtures/espn/ (20 real ESPN payloads)
apps/web/            The website: React + Vite + TypeScript
  src/app/           Routes, page frame, not-found page
  src/features/      home (board picker), board (cards), team (detail, schedule,
                     prediction), admin (sign-in, people, board editor)
  src/components/    Rank, record, game lines, live score, logos, freshness, states
  src/lib/           API client, polling intervals, date formatting
  src/auth/          The admin session (loaded only for the administrator)
  src/styles/        Design tokens and global CSS
supabase/            SQL migrations, RLS policies, seed data, and test/ (the
                     security model, verb by verb, on real Postgres)
scripts/             ESPN fixture capture, RLS verifier, season-literal check,
                     bundle secret scan, smoke test for a running Worker
docs/                espn-notes.md (API findings), supabase-setup.md (setup
                     guide), ops.md (deploying and running it)
context/             project-notes.md (the whole project, distilled), and
                     archive/ (the original spec and the build plan)
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
| `npm run dev:web`          | Starts the website at <http://localhost:5173> (needs `npm run dev`)   |
| `npm run build:web`        | Builds the website for production into `apps/web/dist`                |
| `npm run verify:rls`       | Tests your real Supabase security rules (needs setup)                 |
| `npm run smoke -- <url>`   | Read-only checks against a running Worker, local or deployed          |
| `npm run check:bundle`     | Fails if a privileged key is in the built Worker or site              |
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
 Test Files  31 passed (31)
      Tests  704 passed (704)
✓ No hard-coded year literals outside packages/shared/src/season.ts
```

(Those are the Phase 5 totals. Phase 1 on its own was 4 files and 101 tests.
Phase 2 brought it to 13 files and 287, Phase 3 to 20 and 387, and Phase 4 to
24 and 473.)

That one command runs four checks:

| Check            | What it proves                                                                         |
| ---------------- | -------------------------------------------------------------------------------------- |
| **typecheck**    | The code is valid strict TypeScript. The API and the shared types agree on every shape |
| **lint**         | No `any` types and no sloppy patterns (§41)                                            |
| **test**         | 704 tests. Each phase's are listed under its own "Testing Phase N" section             |
| **check:season** | No year like `2026` is hard-coded anywhere, so next season needs no code change (§21)  |

What Phase 1's 101 tests cover:

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
| Fixtures cover all 11 cases, and `espn-notes.md` is written                      | [docs/espn-notes.md §9](docs/espn-notes.md) | ✅ 19 fixtures, all real       |
| No season literal outside `season.ts`                                            | Level 1                                     | ✅ passes                      |

---

## Testing Phase 2 on your machine

Phase 2 is the sports data layer. Levels A and B need only the Supabase setup
from Phase 1, which gives the API users and their teams. The sports data comes
from a **mock season** that is generated on the fly, so no network or ESPN is
needed. Level C switches to real ESPN data.

### Level A — Automated checks

```powershell
npm run verify
```

The result should be 13 test files and 287 tests passing. Phase 2 added these:

- **ESPN parsing and HTTP** (84 tests), run against the 19 real ESPN payloads
  in `test/fixtures/espn/`:
  - Unranked teams, bye weeks, postponed games (never shown as "Final 0–0"),
    live games, a missing predictor, TBD kickoff times, and unknown statuses.
  - A property-style test deletes and corrupts random fields in every payload,
    for up to 200 rounds per payload, and checks that nothing ever throws.
  - Timeouts, one retry, ESPN's 403 treated as throttling, and a 200 response
    that carries an error body.
- **The cache** (22 tests):
  - The TTL table, and the three tiers.
  - Stale data never gets a new timestamp, and there is a KV write budget.
  - Six boards asking for the same team at once make one ESPN call.
- **Game logic** (33 tests). Which game counts as "previous" and which as
  "next", byes, a finished season, and the live-score overlay.
- **The routes** (33 tests):
  - Every read route works with no login.
  - A board with one broken team still shows the other five.
  - With the provider down, the last good data comes back marked stale, with
    its original timestamps.
- **The mock season** (14 tests). It is deterministic, every team has a bye
  week, and live games and postseason both work.

### Level B — Call the API (mock data)

**Terminal 1:** `npm run dev`, and wait for `Ready on http://127.0.0.1:8787`.

**Terminal 2:** load a board. These lines use PowerShell's `Invoke-RestMethod`,
which turns the JSON into objects you can poke at:

```powershell
$API = "http://127.0.0.1:8787/api"
$wilson = ((Invoke-RestMethod "$API/users").users | Where-Object displayName -eq "Wilson").id
$board = Invoke-RestMethod "$API/users/$wilson/board"

$board.anyLive          # True while any of the six teams is playing
$board.teams | ForEach-Object {
  $s = $_.snapshot
  "{0,-10} {1,-10} {2}" -f $_.team.abbreviation, $s.freshness.state, $s.data.record.summary
}
```

Every team should have a record and a state of `fresh`. Run the
`Invoke-RestMethod "$API/users/$wilson/board"` line again right away and the
states change to `cached`: the board was served from the Worker's cache. The
headers show the same thing:

```powershell
curl.exe -s -D - -o NUL "$API/users/$wilson/board" | Select-String "X-Cache|Cache-Control"
```

A board served from the cache says `X-Cache: hit`. One that was just built
says `miss`: that happens on the first load, and again once the cache entry
expires. The board is cached for 60 seconds, or 15 seconds while a team is
playing. The `Cache-Control: max-age` counts down to that expiry.

The rest of the read routes. Mock data is labeled as mock everywhere, for
example `"source": "mock_predictor"`:

```powershell
$first = $board.teams[0]
$team = $first.team.id                  # our id for the team
$tid  = $first.team.providerTeamId      # the provider's id for it

Invoke-RestMethod "$API/teams/$team"                                    # identity plus snapshot
(Invoke-RestMethod "$API/teams/$team/schedule").schedule.data.items     # the whole season, byes included
$game = $first.snapshot.data.previousGame.providerGameId
(Invoke-RestMethod "$API/games/${game}?team=$tid").game.data            # score from this team's side
(Invoke-RestMethod "$API/games/$game/prediction").prediction            # win probability, or null
Invoke-RestMethod "$API/health"                                         # also shows the KV write ledger
```

Team search is admin-only. With no token it must return 401:

```powershell
curl.exe -i "$API/admin/teams/search?q=texas"
```

With the admin token from Level 3c, it returns up to 20 matches. Accents and
capitals don't matter:

```powershell
Invoke-RestMethod "$API/admin/teams/search?q=texas" -Headers @{ Authorization = "Bearer $ADMIN" }
```

### Level B2 — Break things on purpose

`SPORTS_PROVIDER_FAULT` makes chosen provider calls fail, so you can watch the
failure handling without waiting for ESPN to have a bad day. Add a line to
`apps/api/.dev.vars`, then restart `npm run dev`, because the file is read
only at startup.

**Mind the cache.** A fault only fires when the API actually calls the
provider. After Level B, the local cache already holds every team's schedule
and the rankings. Restart with a fault inside their TTL and nothing fails:
the cards simply come back `cached`. So each drill below says which cache it
starts from:

- **Cold:** stop the server, clear the local cache from the repo root, then
  start it:

  ```powershell
  Remove-Item -Recurse -Force apps\api\.wrangler\state
  ```

- **Warm, expired:** load the board once with no fault, wait at least 15
  minutes (the schedule TTL), then add the fault and restart.

| Add this line                    | Start from    | Expected result                                                                                                                                                                             |
| -------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SPORTS_PROVIDER_FAULT=team:251` | Cold          | Still a 200. Texas's card has `"data": null` and the error `Sports data temporarily unavailable.`, and the other five cards are fine. `Cache-Control: max-age=10`, so the page retries soon |
| `SPORTS_PROVIDER_FAULT=rankings` | Cold          | Every rank is `{"kind":"unavailable"}`, shown as "—". It is never `unranked` ("NR"), because a failed lookup is not the same as not being ranked. Records are unaffected                    |
| `SPORTS_PROVIDER_FAULT=all`      | Warm, expired | Every card still has its data, but shows `stale` **with its original `fetchedAt`** (the time of the load before the fault). The response has `X-Cache: stale` and `max-age=10`              |
| `SPORTS_PROVIDER_FAULT=all`      | Cold          | Still a 200 with six cards. Each has `"data": null`, the error `provider_unavailable`, and the response's own `X-Request-Id`                                                                |

Remove the line when you're done.

### Level C — Real ESPN data

Add these to `apps/api/.dev.vars` and restart:

```
SPORTS_PROVIDER=espn
ESPN_USER_AGENT=...
```

**About `ESPN_USER_AGENT`:** with the Worker's default User-Agent, ESPN's CDN
answered **403 to every request** from local workerd. Node's own `fetch`, with
the same header, gets 200. In testing, the CDN accepted a User-Agent beginning
with a common HTTP-library name, such as `curl/8.9.1 college-football-bets/0.2`.
Choosing what the app sends is your decision, and the details are in
[docs/espn-notes.md §1](docs/espn-notes.md). Production Workers reach ESPN
through Cloudflare's network, so their result can only be known after deploying.

Then run the same commands as Level B. These results are from a real run on a
Friday night in week 3:

- **Wilson's board.** Rankings came from the AP Top 25 (Texas #1, Georgia #2),
  records like `2-0`, and the previous and next games against real opponents.
- **Finley's board.** Texas Tech was live against Houston. The card had a
  `liveGame` with the current score and clock, `anyLive: true`, and a 15-second
  board TTL.
- **Texas Tech's schedule.** 13 rows, including the week-6 bye, with
  not-yet-scheduled kickoffs marked `kickoffTbd: true`.
- **Predictions.** Both kinds worked: ESPN's matchup predictor for an upcoming
  game and for a live one.

### Phase 2 exit criteria and how each is checked

| Exit criterion (plan, Phase 2)                                                 | Checked by                        | Status                |
| ------------------------------------------------------------------------------ | --------------------------------- | --------------------- |
| The board returns six teams with rank, record, previous, next, and live        | Level A, Level B, Level C         | ✅ mock and real ESPN |
| Provider killed → still a 200 board from cache, `stale`, timestamps unchanged  | Level A, Level B2 (`all`)         | ✅ passes             |
| One team forced to fail leaves the other five intact                           | Level A, Level B2 (`team:251`)    | ✅ passes             |
| Every fixture survives random field deletion in `validate.ts` without throwing | Level A (property-style test)     | ✅ passes             |
| KV write counter shows zero writes for `live_game` and `board_composite`       | Level A, `/api/health` `kvWrites` | ✅ passes             |
| `SPORTS_PROVIDER=mock` serves a full board offline                             | Level B                           | ✅ passes             |

---

## Testing Phase 3 on your machine

Phase 3 is the website. Levels A and B need only what Phase 2 needed (the
Supabase setup from Phase 1, for the names and teams). The sports data is the
mock season, so live games, byes, and TBD kickoffs are always on screen
somewhere. Level C needs your admin account.

### Level A — Automated checks

Phase 3 added packages, so install first:

```powershell
npm install
npm run verify
```

The result should be 20 test files and 387 tests. Phase 3 added 100:

- **The team card** (29 tests). Every state the API can send renders words,
  never `undefined`, `NaN`, or `null`: ranked (`#4`), unranked (`NR`),
  ranking unavailable (`—`), no record, bye weeks, season complete, TBD
  kickoffs (never "12:00 AM"), postponed and unknown statuses, live games, a
  live game with no score, stale data, and a team whose data failed.
- **The board and team pages** (14). Six cards in board order, one failed card
  beside five good ones, six failed cards, the loading skeleton, a missing
  board, and the "Last updated" time taken from the oldest card.
- **The API client** (18). Board reads never send a token. An admin request
  that gets a 401 refreshes the session once, then signs out. A 403 is not
  treated as a lost session.
- **Dates and times** (16). Times in the viewer's own time zone, "Today" and
  "Tomorrow" (correct across a daylight-saving change), and TBD games kept on
  their real date for viewers west of Eastern.
- **Polling** (11), **freshness** (6), and **team colours** (3).
- **The API** (3). A new admin-only route, `GET /api/admin/session`, answers
  401, 403, or 200, so the admin page can tell "not signed in" from "signed in
  but not an administrator".

### Level B — The website, as a viewer

**Terminal 1:** `npm run dev` (the API). **Terminal 2:** `npm run dev:web`,
and wait for `Local: http://localhost:5173/`.

Viewers need no `.env`: the website's dev server forwards `/api` to the API on
port 8787. Now open a **private window** (`Ctrl+Shift+N` in Edge or Chrome),
press `F12`, pick the **Network** tab, and then go to <http://localhost:5173>.

1. **Home.** Nine names, and no sign-in anywhere. Click **Wilson**.
2. **Board.** Wilson's name, the season and week, `Rankings: Mock Top 25`, and
   `Last updated: <time>`. There are six cards, each with a logo, name,
   conference, rank, record, previous game and result, and next game with
   date and time. At least one card on some board shows a red **LIVE** block
   with the score. Leave it open: the score updates by itself, and the Network
   tab shows a `board` request every 15 seconds while a team is live (every
   60 seconds or 5 minutes when nothing is on).
3. **Team page.** Click any card. The team page shows the rank, record,
   previous game, and next game (Phase 4 added the prediction and the full
   schedule; see [Testing Phase 4](#testing-phase-4-on-your-machine)). The `Wilson's board` link at the top and the browser's back
   button both return to the board.
4. **No login traffic.** In the Network tab's filter box, type `supabase`.
   Nothing should match, on any of the three pages.
5. **Hidden tab.** Switch to another tab for a minute and come back. No
   `board` requests happen while the tab is hidden, and one happens as soon as
   it is visible again.

### Level B2 — Phone, tablet, desktop, and keyboard

- **Sizes.** In DevTools press `Ctrl+Shift+M` for the device toolbar, choose
  **Responsive**, and type the widths 320, 768, and 1440. That's one column of
  cards, then two, then three. At no width should the page scroll sideways.
  Also check **Emerson's** board, which has the longest team name (Southern
  Miss).
- **Keyboard only.** Click the address bar, then press `Tab` repeatedly:
  `Skip to content`, `CFB Board`, `Boards`, `All boards`, `Refresh`, then each
  of the six cards in turn, each with a visible green outline. Press `Enter`
  on a card to open that team.
- **Broken logos.** In the Network tab, right-click any logo request (the
  `.png` files from `a.espncdn.com`), choose **Block request domain**, and
  reload. Every logo becomes the team's initials in a grey circle, and the
  cards are otherwise unchanged. Unblock it afterwards under **More tools →
  Network request blocking**.
- **Dark mode.** The site follows your system's light or dark setting.

### Level B3 — Failure states

The same faults as Phase 2's Level B2 (add a line to `apps/api/.dev.vars`,
then restart `npm run dev`), seen through the website:

| Add this line                          | Start from    | What the board shows                                                                                                                                                                                                                    |
| -------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SPORTS_PROVIDER_FAULT=slate,team:251` | Any           | Cards with a live game get a dashed amber outline and `May be out of date. Last updated: <time>`, and so does the board header. Texas shows its logo and name, then `Sports data temporarily unavailable.`. The other cards look normal |
| `SPORTS_PROVIDER_FAULT=all`            | Cold          | Six cards, each with its logo and name, then `Sports data temporarily unavailable.`. There's no rank, no "Last updated", and no `undefined` anywhere                                                                                    |
| `SPORTS_PROVIDER_FAULT=all`            | Warm, expired | Every card keeps its data, with the dashed outline and its original "Last updated" time                                                                                                                                                 |

"Cold" and "Warm, expired" mean the same as in Phase 2's Level B2. `slate`
needs neither, because live scores are never cached for long.

If you stop the API while the board is open, the header says
`Couldn't refresh the board. Showing data from <time>.` within a minute, and
the cards stay on screen.

### Level C — Admin sign-in

The website needs the Supabase URL and key for this, and only for this. If
`apps/web/.env` doesn't exist, copy `apps/web/.env.example` to it and fill in
the same two values as `apps/api/.dev.vars` (a pasted `/rest/v1` on the URL is
tolerated). Restart `npm run dev:web` after any change to it.

1. Go to <http://localhost:5173/admin>. You land on **Admin sign-in**, since
   there's no session. There's no link to this page anywhere; it's reachable
   only by URL.
2. Try a wrong password. You get `Email or password is incorrect.`
3. Sign in with the administrator account. You land on **Admin**, which says
   the server confirmed the account. An **Admin** link now appears in the
   header.
4. Reload the page. You're still signed in (§29, persistent sessions).
5. **Sign out.** You're back on the home page, and the Admin link is gone.
6. Sign in as the non-admin account from Phase 1 (`VERIFY_NONADMIN_EMAIL`).
   You get **Not an administrator**, with a sign-out button. Since Phase 5 the
   header shows no **Admin** link for this account: it waits for the server to
   confirm an administrator.

### Phase 3 exit criteria and how each is checked

| Exit criterion (plan, Phase 3)                                                                  | Checked by                      | Status                            |
| ----------------------------------------------------------------------------------------------- | ------------------------------- | --------------------------------- |
| Home → board → team works against the real Worker in a private window, with no login step       | Level B                         | ✅ automated browser run · ✅ you |
| The board renders at 320, 768, and 1440 px with no horizontal scroll                            | Level B2                        | ✅ automated browser run · ✅ you |
| Provider forced to fail: cached values plus a visible stale marker; with no cache, clean states | Level A, Level B3               | ✅ automated browser run · ✅ you |
| No `undefined` or `NaN` anywhere                                                                | Level A (every state), Level B3 | ✅ passes                         |
| Keyboard only: header → all six cards, visible focus, Enter opens a team                        | Level B2                        | ✅ automated browser run · ✅ you |
| A blocked logo shows initials and leaves the card intact                                        | Level B2                        | ✅ automated browser run · ✅ you |

"Automated browser run" means these were checked in a real headless Edge
against a real `wrangler dev` Worker and your Supabase project, in both light
and dark mode, before handover. That script isn't part of the repo, because it
needs a browser download that CI doesn't have.

**Level C** isn't an exit criterion, but it was run the same way, with your real
admin and non-admin accounts. All six steps passed (31 checks). The Worker
answered `GET /api/admin/session` with 200 for the admin and 403 for the
non-admin. It also turned up two small sign-in issues, both left for Phase 5:

- The header shows an **Admin** link to a signed-in non-admin (step 6 above).
- An account created without **Auto Confirm User** is told
  `Email or password is incorrect.`, because every 400 from Supabase gets that
  message.

The full results are in the Phase 3 completion notes in
[context/plan.md](context/archive/plan.md).

## Testing Phase 4 on your machine

Phase 4 finishes the team page: the matchup prediction, the full season
schedule, live games, and the offseason. It needs nothing new: the same
Supabase setup as before, and the mock season for the sports data, so live
games, byes, postponements, and missing predictions are always on screen
somewhere.

### Level A — Automated checks

```powershell
npm run verify
```

The result should be 24 test files and 473 tests. Phase 4 added 86:

- **The team page** (30 tests), one group per exit criterion: every section
  in order under one heading; "Prediction unavailable" for each way of having
  none; a failed schedule leaving the rest of the page standing; a live game
  with its quarter and clock and no "Final" anywhere; and a finished season.
- **The schedule** (17). A real table with a caption and headers on wide
  screens, stacked entries on phones, bye weeks as rows, results told by
  letter, word, and shape (W solid, L outlined, T dashed), and no score ever
  invented for a postponed, canceled, or live game.
- **The prediction** (11). It is about the live or next game, never a
  finished one. The team's own side comes first. A figure that isn't a
  percentage is refused, never repaired.
- **Hidden tabs** (3). Polling stops while the tab is hidden and one refetch
  happens on return, checked against the app's real query settings.
- **Formatting, polling, and cards** (16), and **the API** (9): a live score
  carries the time it was read, and the offseason serves six finished seasons.

### Level B — The team page

Start both servers as in Phase 3 (`npm run dev`, then `npm run dev:web`) and
open <http://localhost:5173>.

1. **Everything on one page.** Open any board, then any team. Top to bottom:
   the name, rank, record, and conference; the previous game, the next game,
   and the **Matchup prediction** (two percentages, a bar, and
   `Source: Mock predictor (synthetic data)`); then the **schedule**: every
   game with its week, date and time, opponent, home or away, status, and
   result. Bye weeks are rows of their own, and the next game is marked
   **Next**.
2. **Widths.** In the device toolbar (`Ctrl+Shift+M`), try 320, 768, and 1440.
   Below 720 px the schedule turns into stacked entries. At no width does the
   page scroll sideways.
3. **A live game.** Find a card with a red **LIVE** block (some board always
   has one) and open that team. The live block comes first, with the quarter,
   the clock, the score, and `Updated <time>`, which is when that score was
   read. The schedule's live row says LIVE with the score and no W or L. The
   prediction panel says **Pregame prediction**, because a prediction is made
   before kickoff and doesn't change during the game. Nothing on the page says
   "Final".
4. **No prediction.** About one game in four has no mock prediction. Open
   teams until the panel says `Prediction unavailable` and
   `No prediction has been published for this game.` The rest of the page is
   complete.
5. **Hidden tab.** On the live team's page, open the Network tab: a request
   for the team goes out every 15 seconds. Switch to another tab for a minute,
   then come back. Nothing was requested while you were away, and one request
   goes out as soon as you return.

### Level B2 — Failure states

| Do this                                                                                          | Start from | What the team page shows                                                                                                                                        |
| ------------------------------------------------------------------------------------------------ | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| In the Network tab, right-click the `schedule` request, choose **Block request URL**, and reload | Any        | The schedule panel says `Schedule unavailable` with a **Try again** button. The name, rank, record, previous and next games, and prediction are all still there |
| Unblock it (**More tools → Network request blocking**), then press **Try again**                 | —          | The schedule appears, and the rest of the page never moved                                                                                                      |
| Add `SPORTS_PROVIDER_FAULT=prediction` to `apps/api/.dev.vars` and restart `npm run dev`         | Cold       | `Prediction unavailable` and `Sports data temporarily unavailable.`, with a reference number. Everything else is normal                                         |

"Cold" means the same as in Phase 2's Level B2: stop the server, run
`Remove-Item -Recurse -Force apps\api\.wrangler\state`, then start it. A
prediction is cached for 30 minutes, so without that the fault never fires.
Remove the line when you're done.

### Level B3 — The offseason

Add this line to `apps/api/.dev.vars`, using the current season's year, and
restart `npm run dev`:

```
SEASON_OVERRIDE=2026:postseason
```

Every card on every board says **Season complete**, with its final record, and
nothing is live. On a team page, the header says `<year> postseason`, the next
game says `Season complete`, the prediction says
`There's no upcoming game to predict.`, and the whole schedule is still there
with every result and bye week. Nothing says "Upcoming", `undefined`, or
`NaN`. The mock season's dates move back into the summer in this mode. That is
expected: the mock timeline is anchored to today. **Remove the line
afterwards**, or the site stays in the offseason.

### Phase 4 exit criteria and how each is checked

| Exit criterion (plan, Phase 4)                                                               | Checked by                  | Status                            |
| -------------------------------------------------------------------------------------------- | --------------------------- | --------------------------------- |
| The team page shows identity, rank, record, conference, previous, next, prediction, schedule | Level A, Level B step 1     | ✅ automated browser run · ⏳ you |
| With the prediction removed, the page renders fully with `Prediction unavailable`            | Level A, Level B step 4, B2 | ✅ automated browser run · ⏳ you |
| With the schedule forced to fail, the hero and game panels still render                      | Level A, Level B2           | ✅ automated browser run · ⏳ you |
| A live game shows the live block on board and page, with period and clock, and no "Final"    | Level A, Level B step 3     | ✅ automated browser run · ⏳ you |
| Offseason: no upcoming games, no crashes, `Season complete` shown                            | Level A, Level B3           | ✅ automated browser run · ⏳ you |
| Hidden tab: polling stops, then a single refetch on return                                   | Level A, Level B step 5     | ✅ automated browser run · ⏳ you |

"Automated browser run" means 57 checks in headless Edge against two real
`wrangler dev` Workers (one in season, one with the offseason override), in
light and dark mode, at 320, 768, and 1440 px, including an axe accessibility
scan of the team page. Details are in the Phase 4 completion notes in
[context/plan.md](context/archive/plan.md).

---

## Testing Phase 5 on your machine

Phase 5 adds the admin console, proves the security model table by table and
verb by verb, hardens the public API, and prepares the deploy. It needs what
Phase 3's Level C needed: `apps/web/.env`, your administrator account, and the
two `VERIFY_*` accounts in the root `.env`.

**Restart both servers first** (`npm run dev`, `npm run dev:web`). Phase 5
changed the API's routes and the website's page loading.

### Where Phase 5 stands

As of 2026-09-19. The full record is in
[context/plan.md, "Phase 5 — Completion Notes"](context/archive/plan.md#phase-5--completion-notes),
which starts with a handoff section for whoever picks this up next.

**Done and verified on this machine:**

- **The admin console:** people (add, rename, delete) and each board (team
  search showing logo and conference, add, remove with a confirmation, and
  reorder with Up and Down).
- **Security, proven three ways:**
  - every admin route against every way of not being an administrator (131 API
    tests);
  - every verb on every table, on real Postgres (44 database tests);
  - the live Supabase project, with `npm run verify:rls` passing 44/44. Public
    sign-ups are confirmed off.
- **Hardening:**
  - a per-address limit on public reads;
  - cron warmers, which also keep the free Supabase project awake;
  - logos resized by the API (a real board's six logos: 28 KB instead of about 180 KB);
  - each page loaded as its own chunk;
  - the fonts served from this site. Lighthouse on a phone, performance:
    home 98, board 93, team 89. Accessibility and best practices: 100 on every
    page.
- **Deploy preparation:** a production environment in `wrangler.toml`, a CI
  deploy job (off until you enable it), `npm run smoke`, `npm run check:bundle`,
  and [docs/ops.md](docs/ops.md).
- **In a real browser** (headless Edge):
  - 116 checks with your real admin and non-admin accounts, the console driven
    by keyboard only, and axe clean everywhere;
  - 26 checks on real ESPN data during Saturday's games.

**Deployed, and verified live** (2026-09-19, a Saturday, during games):

- The site is <https://cfb-board-pfc.pages.dev>, and the API is
  <https://cfb-api.cfb-api.workers.dev>. Both are on Cloudflare's free tier.
- **ESPN refused the app's default User-Agent from Cloudflare too.** You chose
  to try the default first and then fall back, so production now sends
  `curl/8.9.1 college-football-bets/0.5`. All nine boards filled (54 of 54
  cards, 11 live games).
- `npm run smoke` against the live API: 15/15, CORS included.
- **48 checks in headless Edge at phone width against the live site:**
  - every board, card, and team page on real data;
  - deep links and reloads;
  - axe clean on all six pages, in light and dark;
  - no sideways scroll at 390 or 320 px;
  - the whole admin flow with your real account (a probe person was added,
    two teams added and reordered, one removed, then the probe deleted);
  - your non-admin account turned away.
- `npm run verify:rls` again, against the database production uses: 44/44.
- The cron ran on schedule, with all five warmers `ok`.
- **One bug turned up only under real Saturday traffic, and is fixed:** a live
  card could briefly lose its live score and say "May be out of date" right
  after its schedule refreshed. It now keeps the score. There's a test for it.

**Not done, and waiting on you:**

1. **Done: the commit.** Phase 5 is `5dd38b3` on `main`. It isn't pushed
   anywhere, because there's no GitHub remote yet.
2. **Done: the site on your phone.** You opened it on your own phone
   (2026-09-19) and it works.
3. **After a day live:** the usage numbers
   ([Watching usage](docs/ops.md#watching-usage)). Look at CPU time especially:
   a cold board read on a Saturday measured up to 44 ms, against a documented
   10 ms limit. Cloudflare let every one through.
4. **Your test pass** of Levels B, B2, and B3 below, if you want to repeat
   them. Level A passes.

**Worth knowing before you test:**

- A board change shows at once in the console and in your own browser. Other
  people's open pages catch up within about a minute.
- The public API refuses more than 120 reads a minute from one address, and
  that applies under `npm run dev` as well.
- Search shows "Conference unknown" for teams outside FBS: conference names
  come only from FBS's conference list.
- `apps/api/dist` and `apps/web/dist` are build output from the last check.
  They are gitignored and safe to delete.

### Level A — Automated checks

```powershell
npm run verify
```

The result should be 31 test files and 704 tests. Phase 5 added 231:

- **Every admin route refuses every non-administrator** (90 of the 131 admin
  API tests). Each of the ten `/api/admin/*` routes is sent no token, a
  non-Bearer header, an `alg:none` forgery, an HS256 token keyed with the
  public key, a real token with edited claims, an expired token, and another
  project's token: all 401, with no database call. A valid non-admin token
  gets 403, and the only database call is `is_admin()`. The test checks
  itself against the router, so a new admin route that isn't added to it
  fails.
- **The console's API** (the other 41). Adding a team stores its provider
  identity and conference the first time any board takes it; a duplicate is a
  409 before any write, and again if one slips past; removal renumbers the
  board; a reorder is one `reorder_selections` call and a stale list is a 409.
  A write the database refuses is a 403 even when `is_admin()` said yes. After
  any change, the next public read of that board shows it.
- **The database itself** (44, `supabase/test/rls.test.ts`). The migration
  and seed files run on real Postgres (PGlite), with Supabase's roles and
  defaults simulated. As `anon` and as a signed-in stranger: insert, update,
  and delete on each of the three tables, one test each; `admins` unreadable;
  `reorder_selections` raising `42501`. As the administrator, every verb works.
- **Operations** (20): the per-address read budget and its 429, `Cache-Control`
  on every public read, and the cron warmers.
- **The website** (29): the board editor and people list as they render, the
  header's Admin link waiting for the server, and the sign-in message for an
  unconfirmed account. Plus 6 more for the ESPN conference lookup and the cache.
- **The live overlay** (1, added after the deploy): a live score read a moment
  before a newer schedule is still used, and the card is not marked stale.

Then the two builds and the key scan:

```powershell
npm run bundle --workspace @cfb/api
npm run build:web
npm run check:bundle
```

The last line should say `No service-role or secret key in … files`, and list
the publishable key as public by design.

### Level B — The admin console

Open <http://localhost:5173/login> and sign in as the administrator.

1. **The Admin link.** It appears in the header once the server has confirmed
   the account, and the console lists everyone with their team counts.
2. **Add a person.** Type `Test Person` in **Add a person**, press Enter. They
   appear with `0 teams`.
3. **Their board.** Press **Edit board** on their row. The page says the board
   has no teams yet.
4. **Add teams.** In **Find a team**, type `ala`. Each result shows a logo (or
   initials, in mock mode), its name, and its conference. Press **Add** on
   Alabama. Then add Georgia and Texas. The list shows them in that order, and
   `This board has 3 of its 6 teams.`
5. **No duplicates.** Search `ala` again. Alabama says **On this board**, with
   no Add button.
6. **Reorder.** Press **Up** on Texas twice. It moves to the top at once, and
   focus stays on Texas's buttons.
7. **Remove.** Press **Remove** on Georgia. A dialog asks first. Press Escape:
   nothing changes. Press **Remove** again, then the red **Remove**. Georgia
   is gone.
8. **The board.** Follow **View the board**. The cards read Texas, then
   Alabama. Reload: the same order.
9. **Rename and delete.** Back on **Admin**, **Rename** Test Person, then
   **Delete** them. The dialog names how many teams their board has. They are
   gone from the home page too.
10. **Keyboard only.** Do steps 2–9 again without the mouse: Tab to move,
    Enter to press, Escape to cancel a dialog. Every control shows a focus
    ring, and after each change focus lands somewhere sensible, never at the
    top of the page.
11. **Phone width.** In the device toolbar at 320 px, the console and the
    board editor fit with no sideways scroll, and each row's buttons share
    one line.

### Level B2 — The security boundary

1. **The live database, attacked directly.** `npm run verify:rls`. It should
   end `44 passed, 0 failed, 0 skipped` and
   `Every write path is refused by the database itself`. It now tries every
   verb on every table as `anon` and as the non-admin, checks that public
   sign-ups are off, and cleans up the probe rows it creates.
2. **A non-administrator.** Sign out, then sign in as the non-admin account.
   The page says **Not an administrator**, and the header has **no** Admin
   link (the Phase 3 finding, fixed).
3. **The API without a token.** With `npm run dev` running:

   ```powershell
   npm run smoke -- http://127.0.0.1:8787
   ```

   Every line passes, including the three that show the admin door shut.

### Level B3 — Hardening

1. **Cron warmers.** Stop `npm run dev`, then in `apps/api` run
   `npx wrangler dev --test-scheduled`. Open
   <http://127.0.0.1:8787/__scheduled?cron=*%2F10+*+*+8-12%2C1+FRI%2CSAT%2CSUN>.
   The terminal prints a `cron_warm` line with `ok: true` for the season,
   rankings, teams, conferences, and database. (The hourly schedule,
   `cron=0+*+*+*+*`, skips itself on autumn weekends.) Stop it and start
   `npm run dev` again.
2. **Smaller logos.** On any board, the Network tab's images come from
   `a.espncdn.com/combiner/…&w=144` (48 on a schedule), about a quarter of
   the old size. Blocking one still shows initials.
3. **Fonts.** The Network tab shows no request to Google Fonts: the two
   families are served from `/fonts/`.
4. **Lighthouse (optional).** `npm run build:web`, then
   `npx vite preview --port 4173` in `apps/web` (with `npm run dev` running),
   and run DevTools → Lighthouse → Mobile on <http://localhost:4173>.
   Accessibility and best practices should be 100.

### Level C — The live site, on your phone

The deploy is done (2026-09-19). How it was done, and how to redo it, is in
[docs/ops.md, "Deploying"](docs/ops.md#deploying-the-first-time).

1. **On your phone**, open <https://cfb-board-pfc.pages.dev>. The home page
   lists nine boards. A board shows six cards with AP ranks, records, and real
   games. A team page shows the schedule and ESPN's Matchup Predictor (or
   "Prediction unavailable").
2. **Deep links.** Open a board, copy its URL, and open it in a new tab. Reload
   a team page. Both load.
3. **Admin.** Open `/login` on the live site (it is never linked) and sign in.
   The header gains an **Admin** link. Change something small on a board, open
   that board, and check it. Change it back.
4. **The smoke test**, from the repo root, whenever you like:

   ```powershell
   npm run smoke -- https://cfb-api.cfb-api.workers.dev https://cfb-board-pfc.pages.dev
   ```

   It should end `15 passed, 0 failed`.

5. **After 24 hours**, read the usage numbers in the Cloudflare dashboard
   ([Watching usage](docs/ops.md#watching-usage)) and write them into
   [Recorded measurements](docs/ops.md#recorded-measurements).

### Phase 5 exit criteria and how each is checked

| Exit criterion (plan, Phase 5)                                                | Checked by                        | Status                                            |
| ----------------------------------------------------------------------------- | --------------------------------- | ------------------------------------------------- |
| Admin adds, removes, and reorders teams; the board reflects it on reload      | Level A, Level B, Level C         | ✅ automated · ✅ browser run · ✅ live site      |
| All negative authorization tests pass, including direct-to-database attempts  | Level A, Level B2 step 1          | ✅ automated · ✅ live `verify:rls` run (twice)   |
| axe reports no violations; keyboard-only operation of the admin console works | Level B step 10                   | ✅ browser run · ✅ axe on the live site          |
| Deployed URLs serve the app with real ESPN data on a phone                    | Level C                           | ✅ browser at phone size · ✅ your own phone      |
| 24 hours of normal use stays inside free-tier limits                          | Level C step 5, the dashboard     | ⏳ you, from 2026-09-20                           |
| Every §50 row is handled gracefully                                           | Level A, and the Phase 2–4 levels | ✅ automated · ✅ live fault drill · ✅ live 403s |

"Browser run" means headless Edge driven by `playwright-core` against real
`wrangler dev` Workers and the live Supabase project, with your real
administrator and non-admin accounts: 116 checks for the console, the viewer
pages, and axe in both themes at 320 and 1440 px, plus 26 on real ESPN data.
"Live site" means 48 more checks the same way, against the deployed site at
390 and 320 px. "Live 403s": before the User-Agent change, ESPN refused
everything from the deployed Worker, and every board still answered 200 with
labelled "unavailable" cards. Details are in the Phase 5 completion notes in
[context/plan.md](context/archive/plan.md).

---

## Troubleshooting

| Problem                                                    | Fix                                                                                                                                                                                                                              |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run dev` says port 8787 is in use                     | An old server is still running. Close that terminal, or run `npx wrangler dev --port 8788` in `apps/api`                                                                                                                         |
| `/api/users` returns 500 after setup                       | Check `apps/api/.dev.vars`, then restart `npm run dev`, which reads the file only at startup                                                                                                                                     |
| Admin calls always return 401                              | See step 3 of `docs/supabase-setup.md`. The project may have no public signing key                                                                                                                                               |
| Things worked last week and nothing does now               | Free Supabase projects pause after about 7 days idle. Press Restore in the dashboard                                                                                                                                             |
| `verify:rls` says "Could not read any app_users"           | The seed has not been run, or the root `.env` points at a different project                                                                                                                                                      |
| The website says "Unable to load boards"                   | The API isn't running. Start `npm run dev` in another terminal, then press **Try again**                                                                                                                                         |
| The website runs on 5174, not 5173                         | Something else holds 5173. Either port works: the dev server forwards `/api` to 8787 regardless                                                                                                                                  |
| `/login` says "Admin sign-in isn't set up"                 | `apps/web/.env` is missing or incomplete (Level C). Restart `npm run dev:web` after editing it                                                                                                                                   |
| The team page says "Schedule unavailable"                  | The schedule is its own request. Press **Try again**. If it keeps failing, check that DevTools isn't blocking it (Phase 4, Level B2) and that `npm run dev` is running                                                           |
| Every card says "Season complete" in September             | `SEASON_OVERRIDE` is still in `apps/api/.dev.vars` from the offseason drill (Phase 4, Level B3). Remove the line and restart `npm run dev`                                                                                       |
| A test account gets "Email or password is incorrect."      | The account isn't in this Supabase project, its password doesn't match `.env`, or its email was never confirmed. Recreate it in **Authentication → Users** with **Auto Confirm User** ticked. Keep the non-admin out of `admins` |
| The console says "That team is already on this board."     | It is. The database refuses a team twice on one board (§3); the search marks such teams **On this board**                                                                                                                        |
| The console says "This board changed since it was loaded." | Another tab or device changed the board. Reload the page and try again                                                                                                                                                           |
| A changed board still shows the old order elsewhere        | Other people's pages catch up within about a minute (the board's cache). Your own admin browser sees it at once                                                                                                                  |
| The API answers 429 "Too many requests."                   | More than 120 reads a minute from one address. Wait a few seconds. For a load test, set `READ_RATE_LIMIT_PER_MINUTE=off` in `apps/api/.dev.vars`                                                                                 |
| Anything about deploying                                   | See the troubleshooting table at the end of [docs/ops.md](docs/ops.md#troubleshooting-a-deployment)                                                                                                                              |

For database-side problems, the full table is at the bottom of
[docs/supabase-setup.md](docs/supabase-setup.md).
