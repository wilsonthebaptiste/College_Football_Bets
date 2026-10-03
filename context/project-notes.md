# Project Notes — College Football Team Board

Everything worth carrying forward from building this application, in one file:
what it is, how it is put together, what was learned the hard way, what is
deployed, and what is left.

Written at the close of Phase 5, 2026-09-19, when the application went live.
Updated 2026-09-24, when team search was deployed, and 2026-10-02, when
projected points was built and deployed.

> **Projected points is live** (since 2026-10-02) — the first *computed* sports
> number in the application, and the first feature that reads a publisher other
> than ESPN. **§12 is its record**, and it is the section to read before
> touching `packages/shared/src/scoring.ts`,
> `apps/api/src/providers/playoffstatus/`, `apps/api/src/services/projection.ts`,
> or `apps/web/src/lib/projection.ts`. What is left of it is the owner's: a
> phone check and the KV counter the day after (§10).

- The behaviour the app was built to (the specification) is
  [archive/spec.md](archive/spec.md). `§n` references throughout the code and
  docs point at its numbered sections.
- The build plan, phase by phase, with completion notes for each, is
  [archive/plan.md](archive/plan.md). It is the long history; this file is the
  distillation.
- [archive/plan-search-engine.md](archive/plan-search-engine.md) — the public team search, so
  any team can be looked up and not only the 54 on boards. All four phases are
  built, verified, and live since 2026-09-24.
- [predicting_score.md](predicting_score.md) — projected points. All five
  phases built, each with its own completion notes, and live since 2026-10-02.
  That file holds the measured source data, the rubric, and the plan; **§12 of
  this file holds what building it actually taught us.**
- [plan-matchup-board.md](plan-matchup-board.md) — the matchup board: every
  game in a week between two boards. **Phase 1 (the API) is committed
  (`1380a99`); Phase 2 (the two screens) is built and verified, not committed;
  nothing is deployed.** Phase 3 (the live game page, docs, deploy) is next.
  §13 below is the short version.
- Operations — deploying, configuration, limits, troubleshooting — is
  [../docs/ops.md](../docs/ops.md).
- ESPN's undocumented API, as observed: [../docs/espn-notes.md](../docs/espn-notes.md).
- playoffstatus.com, the scraped conference odds, as observed — and how to fix
  the scrape when it breaks: [../docs/playoffstatus-notes.md](../docs/playoffstatus-notes.md).
- Supabase setup: [../docs/supabase-setup.md](../docs/supabase-setup.md).
- How to test each phase by hand: the [README](../README.md).

---

## 1. What it is, and where it is

A private dashboard for nine people, each with a board of six college football
teams. Anyone with the link can read every board, can look up any of the ~762
teams the provider lists, on or off a board, and can see which boards hold a
team and open them; only the administrator can change the boards.

| | |
| --- | --- |
| Site | <https://cfb-board-pfc.pages.dev> (Cloudflare Pages project `cfb-board`) |
| API | <https://cfb-api.cfb-api.workers.dev> (Worker `cfb-api`, `--env production`) |
| Database | Supabase Postgres: 9 people, 54 selections, 65 team rows (11 no longer on any board) |
| Cost | Nothing. Every service is on a free tier, with no card on file |
| Source | Branch `main`, on <https://github.com/wilsonthebaptiste/College_Football_Bets> (remote created 2026-09-20; search pushed 2026-09-25, projected points 2026-10-02) |
| Tests | 1073, in 45 files. `npm run verify` runs typecheck, lint, tests, and the season check |
| Publishers | ESPN (everything, including FPI) and playoffstatus.com (four conference pages, for projected points only) |

Built in five phases: foundation and contracts, the sports data layer, the
website, the team page, then admin, hardening, and the deploy. Each phase's
exit criteria and completion notes are in the archived plan. Two features came
after the deploy, both live: team search and projected points (§12).

## 2. The shape of the system

```
Browser ── the site (React, static files on Pages)
   │
   │  every read is public and needs no token; admin writes carry the admin's own JWT
   ▼
Worker (Hono) ── routes → services → cache tiers → provider (ESPN or mock)
   │                                      │
   │                                      └── L1 isolate memory → L2 Cache API → L3 Workers KV
   ▼
Supabase Postgres ── people, teams, selections, admins. Nothing from ESPN (§45)
```

The public surface, for reference. Pages: `/` (every board), `/u/:userId` (one
board), `/teams/:teamId` (a team, by our uuid **or** the provider's team id),
`/search?q=` (any team the provider lists), plus `/login` and `/admin/*` for
the administrator. API: `/api/health`, `/api/meta/season`, `/api/users`,
`/api/users/:id`, `/api/users/:id/board`, `/api/teams/:teamId`,
`/api/teams/:teamId/schedule`, `/api/games/:id`, `/api/games/:id/prediction`,
`/api/search/teams?q=`, `/api/selections` (every board's picks, inverted to
provider team id → who has that team), `/api/projections` (every board's
projected total), `/api/users/:id/projection` (one board, per-team
breakdown) and `/api/teams/:teamId/projection` (one team, by either address) —
all public, no token — and `/api/admin/*`, which is the only branch
that verifies a JWT.

Three rules hold the structure together, and everything else follows from them:

1. **The browser never talks to ESPN or to Postgres.** It calls the Worker, which
   returns normalized data designed for the screen (§26).
2. **Only `apps/api/src/providers/espn/` knows ESPN exists.** Outside it, `espn`
   appears only as a label type (`ProviderName`, `PredictionSource`) so that
   sources can be named honestly on screen (§46). Swapping providers is a new
   directory plus one line in `providers/registry.ts`. The rule has a mirror
   now that there is a second publisher: only
   `apps/api/src/providers/playoffstatus/` knows that site exists, and it has
   its own small interface and its own registry entry so the two can fail, be
   drilled, and be mocked independently (§12).
3. **The database is the authorization boundary, not the UI.** Every write goes
   to PostgREST with the administrator's own token, and Row Level Security
   decides. There is no service-role key anywhere in the repo, CI, or the
   Worker — deliberately, so nothing can quietly bypass RLS.

### Where things live

```
packages/shared/     Types and pure logic shared by the API and the browser
                     (domain model, freshness envelope, season logic, and
                     scoring.ts — the projected-points rubric, §12)
apps/api/            The Worker
  src/routes/        HTTP surface: public reads, /api/admin/*, health,
                     projections (the three projected-points endpoints, §12)
  src/services/      Board, team, snapshot, live overlay, search, context,
                     projection (the two publishers, the name join, and the
                     assembled leaderboard and breakdown, §12)
  src/cache/         TTL policy (one table), the three tiers, stale-while-revalidate
  src/providers/     espn/ (client, raw types, validate, normalize, logos, FPI),
                     playoffstatus/ (client, parse, conferences — conference
                     odds and nothing else, §12), mock/, faults, registry
  src/db/            PostgREST client, queries, row mapping
  src/middleware/    CORS, rate limit; auth lives in src/auth/
  src/cron/          The warmers
  test/              tests live here and beside the web sources (958 in all);
                     test/fixtures/espn/ holds 21 real ESPN payloads and
                     test/fixtures/playoffstatus/ the four scraped pages
apps/web/            The site (React + Vite, strict TS)
  src/features/      home, board, team, search, admin (home, board and team
                     each carry projected points, §12)
  src/components/    Cards, logos, states, dialog, header, Projection (the six
                     rubric lines and the provenance note)
  src/lib/           API client, query keys, polling, formatting, projection
                     (every word a screen says about a projection)
  src/auth/          Admin session, loaded only for the administrator
supabase/            Migrations, RLS policies, the reorder RPC, seed, and
                     test/ (the security model on real Postgres, via PGlite)
scripts/             verify-rls, smoke, check-bundle-secrets, check-season-literals,
                     capture-espn-fixtures, capture-playoffstatus-fixtures
```

## 3. Decisions that shaped everything

**Viewers have no accounts** (plan §11.1, confirmed with the owner). This
overrides the spec's assumption of authenticated viewers, for reads only. The
consequences run through the whole app: RLS read policies name `anon`
explicitly; the JWT middleware runs only on `/api/admin/*`; the site must render
with no session; the Supabase auth library is a separate chunk that only the
administrator ever downloads; and because the API is open, it needed a read
budget and cache headers (§5.3).

**Freshness is a first-class value, not a timestamp** (§23, §39). Every sports
value travels in an envelope carrying `state` (fresh / cached / stale /
unavailable), `fetchedAt`, `ttlSeconds`, `expiresAt`, and the provider name.
Rules that proved worth enforcing in code:

- Stale data keeps its **original** `fetchedAt`. Nothing is ever relabelled as
  current.
- A composite (a card, a board) takes the **worst** state and the **oldest**
  timestamp of its parts, so nothing on screen is newer than it claims.
- Slow-moving reference data (rankings) can make a card stale but cannot drag
  its timestamp backwards — otherwise an hour-old poll would make a live
  Saturday board look an hour old.

**Never invent sports information** (§4, §46). There is no computed ranking and
no computed prediction. A missing ranking renders "—" (unavailable), which is
deliberately different from "NR" (genuinely unranked). Betting odds are never
read, and mock data is always labelled as mock.

Projected points (§12) is the **one** deliberate exception, and it is narrow:
every probability is quoted from a publisher, the arithmetic is the owner's own
rubric, and exactly one quantity — P(a team finishes in the final Top 25) — is
modelled by us and labelled as ours wherever it appears. Nothing else in the
application may add a second exception without the same three conditions.

**Errors are isolated** (§42). One team's failure leaves the other five cards
intact. On the team page, the schedule is its own request, so a failed schedule
leaves the identity, games, and prediction standing.

**Six teams is a UI convention, not a schema constraint.** The database allows
1–24 selections per board; the editor warns past six.

**A team has two addresses, and identity comes from a different place on
each** (the search feature, 2026-09-23). `/teams/<uuid>` is a team we store,
and its name, logo, and conference come from Postgres — §45's rule that
identity is application-owned. `/teams/<providerTeamId>` is any of the ~762
teams the provider lists, and there identity comes from the provider's own
24-hour team list, because no row exists. That is the one place in the app
where §45 does not hold, and two things follow from it:

- A conference curated by hand on a stored row will not show on the
  provider-id URL. Cosmetic, and accepted.
- The response's freshness envelope covers the *sports* data (a 15-minute
  schedule), not the name it is shown under, which may be a day old. A name is
  not a fact that changes hourly, but the envelope does not say so.

Board links stay on the uuid, which keeps curated identity winning where it
exists. Both URLs share every expensive read, because the server's cache keys
are provider-id based throughout.

## 4. The cache, and staying free

Three tiers, because the free tier forces it: **L1** isolate memory (instant, no
quota, dies with the isolate), **L2** the Cache API, **L3** Workers KV (durable,
but only 1,000 writes a day). One TTL table in `cache/policy.ts` is the single
source of truth for every category:

| Data | TTL | Notes |
| --- | --- | --- |
| Live slate (scores) | 25 s | L1 only. Never written to KV |
| Board composite | 60 s, or 15 s while a team is live | L1 only |
| Team schedule | 15 min | The big one; stale window 6 h |
| Rankings | 1 h | |
| Prediction | 30 min | |
| Team list, conferences | 1 day | Warmed by cron |
| Projection inputs (FPI) | 6 h | Stale 1 day. Warmed by cron (§12) |
| Conference odds (scraped) | 6 h | Stale 7 days — it is a scraped page. Warmed by cron |
| Projection composite | 2 min | L1 only, never KV. The assembled answer, not a document (§12) |

Protections that exist because of real limits:

- **A KV write ledger** warns at 700 writes and refuses at 900, against the
  1,000/day limit. Each key also has a minimum write interval.
- **Cron warmers** refresh the calendar, rankings, team list, conference map,
  and the two projection documents off the request path, and run one Postgres
  `select` so the free Supabase project never pauses. They deliberately do
  **not** warm schedules: fifty teams hourly would be about 1,200 KV writes a
  day. A cron run now makes six KV writes, and the two projection documents are
  at most eight a day between them.
- **A per-address read budget**: 120 reads a minute per isolate, then 429 with
  `Retry-After`. Best-effort by design — it stops one noisy client, not a
  distributed crawl. The content is nine display names and otherwise-public
  sports data, so exposure is a quota concern, not a privacy one.
- **`Cache-Control` on every public read**, so repeat traffic is absorbed by the
  browser and the edge before it reaches the Worker. Degraded or stale responses
  get a short 10-second lifetime, so a broken card is never pinned for a full TTL.

**What search changed about the budget, measured.** A search is a fold and a
sort over ~762 names: about **2 ms** of the 10 ms CPU budget, and the number of
matches does not move it. Twelve searches wrote KV **three** times — the team
list, the calendar, and the conference map, once each — and then opening a
single searched team page added two more. So **searching is nearly free; the
team pages searching leads to are what spend KV.** Crawlers can now reach ~762
team pages instead of ~65, each one a schedule read, against about 1,000 writes
a day. Three things bound it: the ledger (warn at 700, refuse at 900), the
per-key minimum write interval, and the per-address read budget. The counter to
watch after the search is deployed is `schedule`, not `team_list`.

A person typing cannot spend the read budget either, and that is four things
holding together rather than one: a 250 ms debounce, a query key normalized
with `trim().toLowerCase()`, a five-minute client `staleTime`, and the route's
own `public, max-age=300`. Backtracking over a prefix costs no request at all
(measured). Remove any one of them and a keystroke becomes a Worker request.

**The pick index costs one read per document, not one per keystroke.**
`GET /api/selections` is a single ~54-row Postgres query with no provider call
and **no KV write of any kind** — measured: a dozen searches and a dozen index
reads left the write ledger byte-for-byte unchanged. It is deliberately not a
field on the search response, which would have put a Postgres read in front of
every keystroke and made typing depend on a database the search route
otherwise never touches. Its key is a constant (`['owners']`), so the search
page and the team page share one request; only pages that show the names ask
for it, so the home page and a board ask for nothing. A full page load is a new
document and therefore a new query cache, so it asks again — that is the
measurement's unit, not a leak. There is no server-side cache: app-owned data
carries no freshness envelope (§45) and KV is for provider data. If this ever
becomes the constraint, the pattern is an L1 entry plus `evictL1` on the admin
write, as the board composite does.

## 5. What we learned about ESPN

ESPN publishes no documentation for these endpoints, so everything in
[../docs/espn-notes.md](../docs/espn-notes.md) was observed from real payloads,
which are saved as fixtures.

- **A 403 is not an authorization failure.** ESPN sits behind Akamai, which
  answers bursts with a bare 403. It is throttling: retryable, surfaced as
  `provider_unavailable`, never as `forbidden`.
- **The 403 is also a client check.** Akamai appears to judge the User-Agent
  *together with* the TLS fingerprint. Node's fingerprint passes with any
  User-Agent. For curl-like fingerprints — which include workerd's, and
  Cloudflare's — only a User-Agent **beginning** with a known HTTP-library name
  passes. `curl/8.9.1 college-football-bets/0.5` passes; the same two tokens in
  the other order does not. This cost a day in Phase 2 and was confirmed again
  from the deployed Worker in Phase 5.
- **Three API families are needed** and they share no conventions:
  `site.api.espn.com` for browser-facing shapes, `sports.core.api.espn.com` for a
  hypermedia API of `$ref` URLs, and — since projected points —
  `site.web.api.espn.com` for the Football Power Index, where figures arrive in
  parallel `names`/`values` arrays rather than as named fields. Conference names
  need two hops.
- **The FPI table's columns are positional, and that is the trap.**
  `probwintitle` is the eleventh slot, with projected wins and losses a few
  places away, so an off-by-one does not crash — it puts a projected loss where
  a probability belongs, and 1.6 looks like a perfectly ordinary probability
  once divided by 100. Columns are read by name, and four field sums catch a
  broken read (espn-notes §12).
- **The predictor keeps returning pregame numbers after kickoff,** which is why
  a live game's prediction is labelled "Pregame prediction, made before kickoff"
  rather than hidden or refreshed.
- **Provider data is untrusted input** (§40). `validate.ts` guards every field,
  and a property-style test deletes and corrupts random fields in every fixture,
  up to 200 rounds each, asserting that nothing ever throws. Unknown game
  statuses normalize to `'unknown'` and render neutrally, rather than being
  guessed at.

A **mock provider** generates a full deterministic season with no network. It
keeps local development and CI off ESPN entirely, and it always has a live game,
a bye, a TBD kickoff, and a missing prediction somewhere, which is what makes
those states easy to see. `SPORTS_PROVIDER_FAULT` forces chosen provider calls
to fail, so failure states can be exercised on purpose.

## 6. How correctness was checked

The suite is 1073 tests in 45 files. What carried the most weight:

- **The authorization matrix** (90 tests). Every `/api/admin/*` route against
  every way of not being an administrator: no token, a non-Bearer header, an
  `alg:none` forgery, an HS256 token signed with the public key, a real token
  with edited claims, an expired token, another project's token. All 401, with
  no database call. A valid non-admin token gets 403, and the only database call
  is `is_admin()`. **The test enumerates the router**, so a new admin route that
  is not covered fails the suite.
- **The database's own rules** (44 tests) run the real migrations and seed on
  real Postgres through PGlite, simulating Supabase's roles. Every verb on every
  table, as `anon` and as a signed-in stranger, is tested separately — `for all`
  policies are easy to get subtly wrong.
- **`npm run verify:rls`** repeats that against the live project, building
  requests by hand the way an attacker would, skipping the Worker entirely. It
  also checks that public sign-ups are disabled, and cleans up its probe rows.
  44/44 before and after the deploy.
- **Real payload fixtures** for ESPN parsing, including the damage test above.
- **Browser runs** in headless Edge with `playwright-core`, axe, and Lighthouse:
  116 checks locally in Phase 5, 26 on real ESPN data, and 48 against the
  deployed site at phone width. These scripts live in the session scratchpad,
  not the repo, because they need a browser binary CI does not have; the README
  describes the same checks by hand.
- **Guard scripts**: `check:season` fails the build on any hard-coded year
  outside `season.ts`; `check:bundle` fails if a service-role or secret key ever
  lands in a built bundle.
- **A rubric pinned at its limit, and against real teams** (58 tests, §12). The
  projected-points arithmetic is asserted twice over: at the end of the season,
  where it must produce the rubric's own integers exactly, and against the eight
  real teams of 2026-09-30, where the published totals are the expected values.
  Its bounds are proved over 2,500 randomized inputs.

- **Both of projected points' publishers, against real captured payloads, and
  in both directions** (§12). The FPI table is held to reading its columns by
  name — a reordered `names` array still reads correctly, a renamed column
  fails validation rather than reading its neighbour — and the scrape is held
  to a row count, two column sums, and a two-way name join that resolves 67 of
  67 rows against the conference map captured the same day. The scrape's parse
  also has its own totality test: the HTML is truncated and mangled at 300
  random points per page and must never throw.

- **Every way of losing a projection's inputs, one at a time** (22 tests, §12).
  The two endpoints are driven with each of the five reads faulted on its own
  and with both publishers down together, asserting that the answer is a 200
  that degrades in labelled pieces and never a 0.00 or a 500. One of the 22
  runs the **real captured payloads of both publishers** end to end — the FPI
  table, the four conference pages, the poll, and the conference map — through
  the route to a projected total, which is what caught the feature's worst bug:
  the one quantity this application models was labelled as ESPN's (§12).

- **The three projection screens, in every state and in a browser** (§12). Each
  screen is rendered for loading, a failed request, a 429, one publisher down,
  both down, a team nobody publishes about, a board with no teams, and the plan's
  eight worked teams. Every state is asserted to have one `<h1>` and no raw
  value, in both seen and spoken text. A separate run of 47 checks in headless
  Edge covered no sideways scroll at 320 px with every breakdown open, 44 px
  rows, Enter opening a row, every projection route aborted, and axe in light
  and dark at 320 and 1280 px. One more run used the real publishers.

- **Projected points, drilled and deployed** (§12). Four fault drills on the
  real runtime against both real publishers (`odds`, `projections`,
  `projections,odds`, `all`), each reference matched to the log line it must
  lead to; three changed-page drills (a redesigned page, a dropped row, a
  renamed FPI column) driven through the route on the real captures; and 46
  browser checks against the **deployed** site.

**`npm run verify` does not check formatting.** `format:check` is a separate
script. Prettier reformatted two of the five files Phase 1 touched *after* a
green `verify`, eleven of Phase 2's, and seven of Phase 3's, so run
`npm run format:check` (or `npm run format`) before committing, or CI's
formatting step will be the thing that fails.

## 7. Findings from the deploy (2026-09-19)

The first deploy produced more surprises than the four phases before it.

| Finding | What it means |
| --- | --- |
| **ESPN refused the default User-Agent from Cloudflare too**, 403 on everything | Production sets `ESPN_USER_AGENT`. If ESPN ever changes the rule, every card goes "unavailable" at once, labelled, and the fix is one line of config |
| **The app degraded exactly as designed, unplanned and in public.** During those 403s every board still answered 200, with six cards reading "Sports data temporarily unavailable" and a date-derived season | The most convincing test of §50 came from an accident, not a drill |
| **The Cache API works on `workers.dev`** (`l2Available: true`) | The plan expected it to be inert. The probe round-trips a real value, so this is measured, not assumed. The tier code tolerates either |
| **CPU: median 1 ms, but a cold board peaked at 44 ms** against a documented 10 ms free limit | Every request finished `ok`; Cloudflare did not enforce it. This is the number to watch. Remedies, in order: warm the scoreboard from cron on game days, stagger a cold board's schedule loads, or move to a paid plan |
| A new Cloudflare account must **verify its email** before deploying a Worker | Error 10034, and it stops the deploy dead |
| Wrangler 4.13x **delegates `pages project create`** to the newer Workers-based Pages, which fails at a workspace root | `--force` once, to create a classic Pages project, which is what `_headers` and the SPA fallback assume |
| A taken `pages.dev` name **gets a suffix** | The site is `cfb-board-pfc.pages.dev`, not `cfb-board.pages.dev`. Nothing in the app assumes the name |
| Run without a prompt, wrangler **names the `workers.dev` subdomain after the Worker** | Hence `cfb-api.cfb-api.workers.dev`. Renaming it means rebuilding the site with a new `VITE_API_BASE_URL` |

### The bug only production found

A live card could briefly lose its live score and show "May be out of date",
though nothing was out of date.

The live overlay lays a 25-second **slate** (the day's scoreboard) over a
15-minute **schedule**. The code refused any slate older than the schedule,
to stop an old slate from moving a game backwards (live → pre-game). On the
deployed Worker, six teams load in parallel: one team's read fetches the slate,
and another team's schedule arrives from ESPN a moment later. That schedule is
now *newer* than a perfectly current slate, so the overlay was discarded, the
game lost its live block, and the whole card was marked stale. Four of nine
boards did this on their first read.

The fix narrows the rule to what it was actually guarding against: only a slate
that is **itself stale** — kept past its TTL after a failed refresh — and older
than the schedule is refused. A current slate is used, and its score is dated by
its own read. The accepted trade-off is that a game can lag its schedule by up
to 25 seconds; it is labelled with the time the score was read, so nothing
claims to be newer than it is.

**The lesson**: a whole-object timestamp comparison was standing in for a
statement about one game's progression. It was untestable in the small and
invisible locally, because local runs never had six teams racing over a real
network. The test that now covers it reproduces the race directly.

## 8. Other things worth knowing

- **PGlite reports `on delete restrict` as 23001**, not 23503. Nothing in the app
  deletes teams, so how PostgREST maps that was never resolved.
- **A modal `<dialog>` makes the page behind it inert**, so focusing an element
  behind it fails *silently*. The confirm dialog asks for its focus target in the
  effect cleanup, once the dialog is gone.
- **Reordering is a save queue, not one request per press.** Each press moves the
  row at once; the newest order is saved; presses during a save go together when
  it lands. Without this, a fast second press was dropped.
- **After a person is deleted, the console re-reads their public pages and gets
  two 404s** in the browser console. That is intentional: the 404 replaces the
  cached 200 in the admin's browser cache. The console lines are the browser's
  generic 4xx log, not an app error.
- **A board change reaches other people's screens within about a minute** (the
  board's cache), and the admin's own browser at once. A version check on every
  board read would have cost a Postgres round trip per poll.
- **Self-hosting the two fonts** removed about 0.9 s of render-blocking on a
  phone: Lighthouse performance went from 86/88 to 98/93/89, with accessibility
  and best practices 100.
- **Sizing logos through the API** (ESPN's image combiner) took a board's six
  logos from about 180 KB to 28 KB.
- **`check:season` caught a date inside a code comment.** Slightly annoying, and
  exactly the kind of over-broad rule that is worth keeping: a year in source is
  never something to wave through.

## 9. Known limitations, carried forward

- **CPU on a cold board (44 ms) exceeds the documented free limit.** Not yet
  enforced by Cloudflare. Watch for `exceededCpu` / error 1102.
- **ESPN access depends on a curl-style User-Agent**, and on an undocumented,
  unofficial API generally.
- **A live score can lag its schedule by up to 25 s** (the trade-off above).
- **The read budget is per isolate**, and keyed on an address that a shared
  network shares. Sized for nine people.
- **Conferences are FBS-only**; everyone else shows "Conference unknown". The
  map is not a division filter, though: a team carries a conference if ESPN's
  FBS groups list it, whatever division it looks like it belongs to. ESPN puts
  North Dakota State in the Mountain West, and the app says so (§46).
- **A searched team page depends on the 24-hour team list.** If that list
  cannot be loaded the page is a clean 503, whereas a board team still shows
  its identity from Postgres. The asymmetry is accepted and tested.
- **A broken pick index is invisible on the site.** "Who has this team" renders
  nothing when nobody has the team, when the index is still loading, and when
  it has failed — the same answer on purpose, so a slow or broken index costs
  the pages that use it nothing (§38, §42). The cost is accepted and real:
  nothing on screen will ever say the index is down, and the only signals are
  the Worker's logs and `/api/health`. It is drilled rather than trusted.
- **Board membership can be up to five minutes stale in a viewer's browser** —
  the same lifetime `/api/users` has had, for data that changes only when the
  administrator changes it. The admin's own browser is primed after every write
  (`/api/selections` is in `PUBLIC_INDEX_PATHS` and `queryKeys.owners` is
  invalidated), and a board change already takes about a minute to reach other
  screens.
- **Nine display names now appear beside any team a visitor searches.** No new
  exposure — every board is already public at `/u/:userId` and every name is
  already on the home page — but it is the first time a person's name appears
  on a page reached without navigating to a board.
- **The nine real boards share no teams at all.** 54 picks, 54 distinct teams,
  every line one name long. The two-name case is real, sorted, and tested, but
  it cannot be seen by hand on production data; anyone checking the wrapping or
  the multi-name CSS has to inject extra names into the live DOM.
- **Nothing deletes a `teams` row.** Removed teams stay as harmless cached
  identity: replacing the seeded boards with the real ones left 11 such rows.
- **The console's interactions are covered only by the browser runs**, which are
  outside CI. The component tests render states statically — which is also why
  the header search box is proved by parts (where a submitted query goes, and
  that `/search` reads it back) rather than by one test that types and presses
  Enter. The whole journey is covered by the browser run.
- **A real screen-reader pass was never done.** Only axe and accessible names.
- **The repo's seed is not production's data, on purpose.** `supabase/seed.sql`
  still creates nine placeholder people and 50 teams, four of them shared
  between boards, because the database tests rely on that shape to exercise the
  shared-team path (§27) and a team nobody selected. The live boards were
  replaced with the real nine people and their teams on 2026-09-19, through the
  admin API.
- **Projected points is a projection, and only as fresh as its slowest
  publisher.** FPI recomputes daily; playoffstatus after game days, and its four
  pages in two batches — on 2026-10-02 its stamps were six days old. The
  screens print each publisher's own stamp and never say "live".
- **One number in it is ours**: the chance of a Top-25 finish, from the poll
  (and FPI's rank for an unranked team). It is labelled "Our estimate"
  everywhere, its constants are a judgement (0.95 at #1, 0.55 at #25, decay 18),
  and it alone never makes a total.
- **The two publishers disagree about conference odds** by up to ~0.75 points
  per team (Ohio State's champion line: 0.27 from playoffstatus, 1.23 from FPI,
  measured on the live runtime). Never averaged; FPI is only the labelled
  fallback.
- **The scrape's only warning of a redesign is its integrity checks** — a row
  count, two column sums, and the two-way name join. A refused page is served
  stale for about a week, then falls back to FPI, labelled; the screen and the
  logs both say so (docs/playoffstatus-notes.md §8).
- **A fresh isolate's first leaderboard read used 24–39 ms of CPU**, the same
  order as the cold board's 44 ms, against a documented 10 ms. Not enforced so
  far; watch `/api/projections` for `exceededCpu` too.
- **Under the FPI fallback a team reads `complete: true`**, because the
  runner-up's quoted zero counts as known. The line's own words say FPI
  publishes no runner-up odds; `complete` alone does not mean the whole rubric
  was quoted.
- **The eight worked rows in `scoring.test.ts` sit a few thousandths from a
  rounding boundary.** Retuning a Top-25 constant will break some of them, on
  purpose: re-solve the inputs, do not loosen the tolerance (§12).
- **The team projection by provider id is a 503 when the team list is down**,
  like the team page at that address. By our uuid it is a degraded 200.
- **The CI deploy job is still untested.** The remote has existed since
  2026-09-20 and the `verify` job passes on every push; the `deploy` job is
  gated on a `DEPLOY_ENABLED` repository variable that is not set, and every
  deploy so far has been by hand. Worth knowing: between 2026-09-20 and
  2026-09-25 the whole search feature sat committed but **unpushed**, seven
  commits ahead of the remote, so CI had never seen any of it. A local `main`
  that is green proves nothing about what the remote has verified.

## 10. What is left

1. **Read the 24-hour usage numbers** in the Cloudflare dashboard (requests, KV
   writes, CPU) and fill in the last row of
   [../docs/ops.md](../docs/ops.md#recorded-measurements). Wrangler's OAuth token
   has no analytics scope, so this has to be done in the dashboard. This is the
   only Phase 5 exit criterion still open: the owner confirmed the live site on
   a real phone on 2026-09-19, which closed the other one.
2. **Read the KV write counter** the day after the search release
   (2026-09-24), and watch the `schedule` category rather than `team_list`:
   searching is nearly free, and the team pages it leads to are what write.
   [ops.md, "The team search release"](../docs/ops.md#the-team-search-release-2026-09-24)
   records what it looked like on the day.
3. **Read the KV write counter** the day after the "who has this team" release
   (2026-09-25) as well. It should look like the search release's: `schedule`
   doing the work, and nothing from the pick index, which makes no provider call
   and writes no KV at all.
   [ops.md, "The 'who has this team' release"](../docs/ops.md#the-who-has-this-team-release-2026-09-25)
   records what it looked like on the day.
4. **Open the live site on a phone** and check the **Picked by** line: search a
   team that is on a board and press the name under it.
5. **Optional:** turn on the CI deploy job — the remote exists and `main` is
   pushed, so all that is left is the token, the variables, and
   `DEPLOY_ENABLED` (docs/ops.md, "Continuous deployment"); a screen-reader pass.
6. **Projected points, the owner's two checks.** Open the live site on a phone,
   read a total, open a board and a team's row, and confirm the screen alone
   says where each number came from and how old it is. Then read the **KV write
   counter** the day after (2026-10-03): `projection_inputs` and
   `conference_odds` should be about four writes a day each, from the cron.
   [ops.md, "The projected-points release"](../docs/ops.md#the-projected-points-release-2026-10-02)
   records what it looked like on the day.
7. ~~Flip `CONFERENCE_ODDS_PROVIDER` to `playoffstatus`.~~ Done in the
   2026-10-02 deploy; the deployed Worker has read the four pages since.

## 11. Commands worth remembering

| Command | What it does |
| --- | --- |
| `npm run verify` | Typecheck, lint, 1073 tests, season check. The one to run |
| `npm run format:check` | Prettier. **Not** part of `verify`, but CI runs it |
| `npm run dev` / `npm run dev:web` | The API on 8787 (mock data) and the site on 5173 |
| `npm run verify:rls` | Attacks the live database directly, as `anon` and as a non-admin |
| `npm run smoke -- <api> [site]` | Read-only checks against a running Worker, local or live |
| `npm run check:bundle` | Fails if a privileged key is in a built bundle |
| `npm run deploy --workspace @cfb/api` | Deploys the Worker (`--env production`) |
| `npm run build:web` + `wrangler pages deploy apps/web/dist --project-name cfb-board --branch main` | Deploys the site |
| `npm run capture:fixtures` | Re-downloads the ESPN sample payloads, FPI included |
| `npm run capture:odds` | Re-downloads the four conference pages and the ESPN conference map |

## 12. Projected points

All five phases, built 2026-09-30 to 10-02 and **deployed 2026-10-02** (Worker
`a178469a`, Pages `cbbac44c`, `CONFERENCE_ODDS_PROVIDER = "playoffstatus"`).
`npm run verify` green: 1073 tests in 45 files, up 252 from 821. The release
record is in [ops.md](../docs/ops.md#the-projected-points-release-2026-10-02);
the drills and departures are in the plan's
[Phase 5 completion notes](predicting_score.md#phase-5--completion-notes).

### What Phase 5 taught us (the drills and the deploy)

**A reference number is only worth quoting if it leads to a log line.** A
degraded projection is a 200, so there is no error body to carry one, and the
plan's first idea — the request id on each response — points at the wrong
request: the board and leaderboard answers are cached for two minutes and the
Worker writes no access log, so the request being answered may have logged
nothing at all. The id worth quoting is the one the failure was logged under.
Every failed envelope already carried it in `error.requestId`, and the
assembly was dropping it. Now `ProjectionInputStatus.error` keeps it, the
screens print it, and a test asserts each response's reference is one a logged
`cache_refresh_failed_*` line carries — across two requests sharing one cached
answer. **The general lesson: test a reference by following it, not by checking
it is present.**

**The leftover-process trap is worse on Windows than Phase 4 knew.** Three
drill Workers from earlier sessions were still running, and one held the port
this phase then chose. `wrangler dev` bound the same address anyway, printed
"Ready", and the **old** process answered — a mock Worker with the odds fault
armed, posing as a cold real one. Checking the port was free beforehand would
have missed it on a different port; what caught it was `/api/health`'s
`provider` and the mock labels on figures that should have been real. Check
what answers, not what listens. Stopping a stray drill afterwards by matching
`--port N` on command lines also matches the shell that ran the command, so a
stop script should exclude its own ancestry.

**A fault drill tests the combination it names — so name all four.** The
four runtime drills produce four different screens (the plan's table in the
Phase 5 notes): `odds` falls back to FPI, labelled; `projections` keeps the
conference half and loses unranked teams' finish lines; `projections,odds` is
the case the Phase 4 rubric fix exists for, and on the real runtime Texas showed
its own finish line and no total; `all` takes the identity of a provider-id team
down with it, which makes that one route a 503 rather than a degraded 200.

**Production matched local to the cent**, on the same publishers the same
evening, and the cron fetched both documents within a minute of the deploy,
before any viewer did. The measurement worth carrying forward is the CPU: a
fresh isolate's first leaderboard read is 24–39 ms, the same order as the cold
board, and the likely cost is the 762-team list the name join parses.

### Before Phase 5

The handoff written after Phase 4 follows, unchanged except where marked: it is
still the best account of why the feature is shaped the way it is.

### What Phase 4 taught us (the screens)

The plan's own completion notes for the phase list the seven departures and the
Phase 5 handoff. What belongs here is what outlives the plan.

**The rubric had a hole that only a screen could show.** With both publishers
down and the poll up, the one known line on every team is *our own* Top-25
estimate, which needs only the poll. Phase 1's `anyKnown` counted it as known,
so every team got a "total", every board read 6 of 6, and the home page would
have shown nine confident numbers made of nothing but our model during a double
outage. Phase 3's "both down" drill used `SPORTS_PROVIDER_FAULT=all`, which also
kills the poll, so it never got there. The fix is one line in `scoring.ts`: a
total now needs a known line **other than** `final_ranking`, which is what the
code's own comment had said all along. **The general lesson extends §12's
labelling one: a fault drill tests the combination it names and nothing else.**
`all` is not the worst case; `projections,odds` is a different and nastier one.

**A mixed mode is its own state.** Production today runs real FPI beside the
**mock** odds publisher. The mock pages' stamp is the sentence "Mock projection
(synthetic data)", and the first version of the "as of" line printed it where a
date goes. Nothing in the tests caught it, because they ran either all-mock or
all-real. `provenance` now names a mock half as "mock data (national odds)" or
"mock data (conference odds)", and it is tested on its own.

**Rounding once is visible on screen, and the plan's own data proves it.** The
eight worked teams print rows summing to 22.64 under a total of 22.65, and Texas
prints six lines summing to 5.74 under 5.73. The screens print the API's
`display` strings, never re-round, and say in one small line that totals are
added up before rounding. Any future screen that sums printed figures will
disagree with the API by a cent, and that is the reason not to.

**Vocabulary lives in one module.** Every sentence a screen says about a
projection comes from `apps/web/src/lib/projection.ts`, and it is unit-tested:
"Not a result.", "Projection · as of …", "Our estimate, from the current poll",
the reasons for a `—` and for a structural `0.00`. The board and team panels
share `components/Projection.tsx`. A wording change is one edit, and the
wording cannot drift between screens.

**The leftover-process trap.** A workerd from an earlier session was still
listening on 8788, and every "the flag doesn't work" symptom was that old
process answering. Stopping an `npx wrangler` wrapper from a tool does not
always stop its workerd child. Check `/api/health`'s `provider` and the
listening port's owner before trusting any drill.

### What Phases 1–3 taught us

The plan, the measured source data, and the per-phase exit criteria are in
[predicting_score.md](predicting_score.md), which carries each phase's own
completion notes. **What follows is the part that does not belong in a plan:
what went wrong, what the plan got wrong, and what later phases trip over.** It
was written after Phase 3. The bullets Phase 4 settled are marked as settled
rather than removed.

### What exists

| File | What it is |
| --- | --- |
| `packages/shared/src/domain/projection.ts` | The types. `ProjectionSource`, `OutcomeKind`, `ProjectionTerm`, `ConferenceStanding`, `ProjectionInputs`, `TeamProjection`, `BoardProjection`, `ProjectionAnomaly` |
| `packages/shared/src/scoring.ts` | `RUBRIC`, `projectTeam`, `projectTeamAtWeight`, `projectBoard`, `top25Probability`, `top25Baseline`, `roundPoints`, `formatPoints`, and every tunable constant |
| `packages/shared/src/season.ts` | `seasonProgress(season)` and `REGULAR_WEEKS`, added to the one module allowed to reason about the calendar |
| `packages/shared/src/envelope.ts` | `ProviderName` widened with `playoffstatus`; `SportsProviderName` introduced beside it (see below) |
| `apps/api/src/providers/espn/` | `ESPN_FITT_API`, `RawFpiPage`, `readFpiPage`, `toProjectionInputs`, `getTeamProjections` — the FPI table |
| `apps/api/src/providers/playoffstatus/` | **New.** `client.ts`, `parse.ts`, `provider.ts`, `conferences.ts`. The only code that knows that site exists |
| `apps/api/src/providers/mock/projections.ts` | Synthetic figures for both halves, labelled `mock_projection` |
| `apps/api/src/services/projection.ts` | The two cached reads, the two-way join, `conferenceStandingFor` — and, since Phase 3, the five-read assembly, the composite freshness, and both answers (`getAllProjections`, `getBoardProjection`) |
| `apps/api/src/services/teamNames.ts` | Name normalization and the one alias |
| `apps/api/src/routes/projections.ts` | **New in Phase 3.** `GET /api/projections` and `GET /api/users/:userId/projection`, mounted at `/api`; Phase 4 added `GET /api/teams/:teamId/projection` (either address, no composite cache, no Postgres for a provider id) |
| `apps/web/src/lib/projection.ts` | **New in Phase 4.** Every sentence a screen says about a projection: `lineView`, `provenance`, the fixed notes |
| `apps/web/src/components/Projection.tsx` | **New in Phase 4.** `ProjectionLines` and `ProjectionNote`, shared by the board and team panels |
| `apps/web/src/features/{home,board,team}/` | **Phase 4.** The tile totals, `board/ProjectionPanel.tsx` (`<details>` per team), `team/ProjectionPanel.tsx` |
| `apps/api/src/db/queries.ts` | `listBoardsWithSelections`: every board and its picks, in one PostgREST request |
| `packages/shared/src/api/responses.ts` | The wire contract: `ProjectionsResponse`, `BoardProjectionResponse`, `Points`, `ProjectionInputStatus` |
| `apps/api/test/fixtures/playoffstatus/` | The four captured pages, the ESPN conference map, and a manifest recording both |

### The labelling bug that mattered, and why nothing caught it sooner

Phase 3 put a `ProjectionSource` on the wire for the first time, and found that
**the one quantity this application models was labelled as ESPN's.** The
Top-25 estimate's source was being derived from the same helper as FPI's, so in
ESPN mode every finish term came out `espn_fpi` — §46's named example of what
not to do, and the inverse of the single condition the whole feature's licence
rests on (§3: exactly one quantity is modelled by us, *and it is labelled as
ours*).

Two things about how it was found are worth keeping:

- **Mock mode could not have caught it.** There every label is
  `mock_projection`, so the bug was invisible in the mode that most tests run
  in. The test that found it drives both routes with the **real captured
  payloads of both publishers** and asserts the three labels a team's terms
  carry: `espn_fpi` for the national half, `playoffstatus` for the conference
  half, `espn_poll_estimate` for the finish term. One test, three assertions,
  and it is the most valuable one in the feature.
- **The mirror bug was in Phase 2's code and had been passing tests for two
  days.** `conferenceStandingFor` hard-coded `playoffstatus` and `espn_fpi`, so
  mock mode labelled synthetic conference odds with a real publisher's name. It
  had no test because nothing had ever read a conference term's `source`.

**The general lesson: a label is only tested when something reads it.** Phase 2
tested that the mock's FPI figures said `mock_projection` and stopped there,
because that was the only label anything looked at. Any future publisher should
get its label asserted at the edge that renders it, in the mode where it is
real, on the day it is added.

### A fallback that was correct in isolation and wrong in context

`conferenceStandingFor` decides `not_eligible` from the team's conference, and a
`null` conference skips that branch and falls through to FPI's `probwinconf`.
Read on its own, each branch is right. Composed, they mean that **if the
conference map fails, a Mountain West team is paid 3 points times its chance of
winning the Mountain West** — a conference the rubric does not pay for at all.

The assembly now offers the fallback only for a team whose conference is *known*
to be power four, so a failed map sends every conference term to `unavailable`.
Worth remembering as a shape rather than a one-off: the three-state discipline
(§7) protects a value against a missing value, but it does not protect a
*fallback* against a missing precondition. The guard has to sit where both
facts are in scope, which was the caller.

### Phase 2's own four departures are in the plan, not here

They are decisions a later phase could undo, so they live with the plan's own
reasoning: the stamp that is per-page rather than per-document, the second
`SwrCache`, the document-shaped `getTeamProjections`, and the field-sum warning
moving out of `validate.ts`. See
[predicting_score.md, Phase 2 — Completion Notes](predicting_score.md#phase-2--completion-notes).
What follows is the material that outlives the plan.

### The type split that keeps a publisher from owning a team

`ProviderName` is now `espn | mock | playoffstatus`, and
**`SportsProviderName` (`espn | mock`) was introduced beside it** rather than
widening one type for both jobs. The wide type is for freshness labels, which a
publisher of conference odds genuinely needs. The narrow one is for everywhere
that means "whose team is this": `SportsDataProvider.name`, `teamNamespace`,
`TeamIdentity.provider`, `db/rows.ts toProviderName`, `providerName(env)`,
`HealthResponse.provider`.

Without the split, a `teams` row could have claimed `provider:
'playoffstatus'` — a team identity from a site that publishes none (§43).

**One consequence is easy to miss and expensive.** `isCacheEntry` in
`cache/tiers.ts` narrows a stored entry's provider against a **runtime** set,
which had to gain `playoffstatus` as well as the type. Miss that half and the
symptom is not a type error: it is a permanent cache miss, refetching and
rewriting the key on every read. Only a second isolate reading the first's KV
copy catches it, and there is now a test that does exactly that. Any future
publisher needs both lines.

### Four places the plan was wrong, and what was done instead

Each of these is a decision a later phase could undo, so the reasoning matters
more than the change.

**1. `TeamProjection.total` had to become `number | null`.** The plan specified
an unrounded `total` plus a `complete` flag. But a non-power-four team with both
sources down has two `not_eligible` conference terms contributing a legitimate
zero and four unknowns — and it would therefore total a confident **0.00**. That
is exactly the lie the feature exists to avoid, and exactly what Phase 3's "it
never answers 0.00" criterion is about. So `total` is `null` unless at least one
term is `known`, and `BoardProjection.total` is `null` unless at least one team
has one. **Phase 3 and Phase 4 must both handle null, and must not coalesce it
to zero on the way out.**

**2. The exit criterion asks for `w = 1`; `seasonProgress` never returns 1.**
Postseason is 0.95 on purpose — the final poll follows the bowls. So the weight
is an explicit parameter: `projectTeamAtWeight(inputs, w)` is the real function
and `projectTeam(inputs, season)` is a one-line wrapper over
`seasonProgress(season)`. The limit tests use the former and assert the rubric's
integers exactly (12, 11, −1). Nothing outside the tests should call
`projectTeamAtWeight`.

**3. Anomalies are returned, not logged.** `packages/shared` is zero-dependency
and runs in the browser, so a `console.warn` buried in a pure function is both
untestable and in the wrong place. `TeamProjection.anomalies` carries the
`b < a` floor, a clamped out-of-range probability, and a discarded non-finite
one. **Phase 3's route is what logs them**, and it should, because the plan is
right that a publisher inverting two nested probabilities is worth knowing about.
A caller that drops the list loses a warning, never correctness.

**4. There are three source labels per team, not one.** `fpi.source`,
`conference.source`, and `ProjectionInputs.estimateSource`. Three inputs, three
publishers, and this is how mock mode avoids wearing a publisher's name: set all
three to `mock_projection` and every term in the result is labelled mock (§46,
tested). A single source field would have forced the mock provider to lie.

### A fourth ranking case the plan's table does not have

The plan's Top-25 table has three rows: ranked, unranked-with-an-FPI-rank, and
neither. A **failed** poll read is a fourth case, and it resolves to
`unavailable` even when FPI's rank is known — the blend needs to know whether the
team is ranked *right now*, and a failed poll is precisely what does not say.
Tested both ways. The practical consequence: `top25Baseline` returns `null` for
`{ kind: 'unavailable' }` regardless of `fpiRank`, so **the rankings read is
load-bearing for the finish term of every team**, and Phase 3's "with FPI down,
the finish term is still computed from the poll" criterion is about the poll
succeeding and saying `unranked`, not about it failing.

### The worked table cannot be reproduced exactly, and why that is fine

This was the single biggest time sink, and anyone retuning a constant will hit it
again.

**The problem.** The plan's eight-team table publishes each term rounded to two
decimals but computes the total from unrounded values. So the underlying
probabilities are *under-determined*: Texas's `5a = 0.73` only says
`a ∈ [0.145, 0.147)`, and no choice inside that interval is "the" measured one.
Reproducing `5.73` exactly from the printed columns is impossible — the columns
sum to `5.74`.

**What was done.** The fixture carries probabilities reconstructed inside each
published interval, and the test asserts the two things the table was actually
demonstrating: every term matches the table to 2 dp, **and** the total matches
the table's total exactly. The conference figures needed no reconstruction —
playoffstatus publishes whole percents, and Georgia 11%, Texas 19%, Miami 22%
cross-check against the plan's own source-disagreement table.

**Three traps inside that, in the order they bit:**

- **A half-cent is not a rounding error, and `toBeCloseTo` will not accept one.**
  Three times playoffstatus's `<1%` reading (0.5%) is exactly 0.015, which
  displays as `0.01` or `0.02` depending on the float representation and the
  rounding mode. The plan's table prints `0.01`. Vitest's `toBeCloseTo(x, 2)`
  tolerance is a **strict** `< 0.005`, so a half-cent fails it. The test uses an
  explicit `<= 0.005 + 1e-9` helper (`expectToTwoDecimals`) and says why.
- **The first reconstruction sat 0.0008 from a rounding boundary.** Several teams
  needed their playoff probability deliberately re-picked to move the total away
  from a `.005` edge; the margins are now a few thousandths, not a few
  ten-thousandths. **This is the fixture's real fragility**: changing
  `TOP25_AT_1`, `TOP25_AT_25` or `FPI_DECAY` will break some of the eight rows,
  and that is the point — the plan wanted a constant change argued for against
  real teams. Expect to re-solve the inputs, not to loosen the tolerance.
- **The eight real rows turned out to be the rounding-drift test.** They board to
  **22.65** where the sum of the eight *rounded* totals is **22.64**, so the
  "sum unrounded, round once at the end" criterion needed no constructed case at
  all. Keep that assertion: it is the cheapest possible guard against someone
  rounding in the service instead of at the edge.

### A row of the plan's table looked wrong, and was not — settled in Phase 2

Phase 1 could only solve the three unranked teams' FPI ranks backwards from
their published finish terms, which pins a rank inside the poll no further than
"25 or better": the baseline is capped at the `TOP25_AT_25` anchor, so ranks
1–25 all reproduce the same term and 26 onward reproduces none of it.

On that basis Phase 1 recorded Texas A&M's row as internally inconsistent — a
team FPI ranks inside its own top 25 "does not have 3% playoff odds". **The
captured payload says it does**: FPI rank **16** with **3.2%** playoff odds,
unranked in the AP poll, on the same day the table was read. FPI rank is how
good a team is; playoff odds are the path in front of it, and a strong team that
has already lost is plausibly both. The plan's table needed no correction, and
the suspicion is the thing that was wrong.

The other two came out close: **Nebraska 14** (guessed ~20) and **Kansas 70**
(solved ~70, exactly). All three are now the *measured* values in the fixture,
and because of the cap, swapping them in changed no expected value. A
cross-check in `test/espn/fpi.test.ts` asserts the three against the captured
payload, so a re-capture cannot stale the shared fixture in silence.

**The general lesson is worth keeping:** two numbers from one publisher that
look contradictory may be measuring different things. Solving an input backwards
from a rounded output tells you less than it appears to, and the honest move —
reproducing the stated source and recording the doubt — was the right one.

### Things Phases 4–5 will get wrong if nobody says so (written after Phase 3; Phase 4 honoured each)

- **The finish term breaks the `contribution = points × probability` rule.** It
  is the full expectation over two paid states, `1·p + (−1)·(1 − p) = 2p − 1`,
  because a team finishes in exactly one of them. Phase 4 must render
  `term.contribution` and must **not** recompute it as `points × probability`,
  which would silently drop the −1 line of the rubric and turn a −0.93 into
  +0.03.
- **Divide FPI's percentages by 100 in normalization, never later.** The types
  state 0–1 throughout; `readProbability` clamps anything outside that range and
  records an anomaly, so a forgotten division shows up as every team pinned at
  1.0 with a pile of `probability_out_of_range` anomalies rather than as an
  obvious crash.
- **`roundPoints` is the only place `-0` is killed.** `-0.004` formats as
  `0.00`, never `-0.00`. Phase 4's `lib/format.ts` `formatPoints` should *wrap*
  this one and swap in a typographic minus sign — not re-implement the rounding,
  or two clients will disagree in the last digit.
- **The `min(TOP25_AT_25, …)` cap in `top25Baseline` is load-bearing**, not
  defensive clutter. Without it, a team FPI ranks inside its top 25 that the poll
  does not list would score *above* the #25 anchor.
- **`RUBRIC` is declared `as const satisfies Record<OutcomeKind, number>`.**
  Adding an `OutcomeKind` without a points entry is therefore a type error, which
  is the intent. Do not loosen that annotation.
- **`check:season` caught Phase 2 twice, both times in a doc comment** — an
  example `lastUpdated` value of `"2026-10-01T08:00Z"` in two files. Exactly the
  over-broad rule §8 says is worth keeping. Write `<yyyy>-MM-DDTHH:mmZ` instead.
  Fixtures and tests are exempt, so the captured payloads were never a problem.
- **The FPI fallback sets `reachConferenceGame` equal to `winConference`.** When
  the scrape is gone and FPI's `probwinconf` stands in, `max(0, e − d)` comes out
  at exactly zero, so the runner-up term is a quoted zero rather than an
  invention — FPI publishes no runner-up probability anywhere. **Phase 4 must not
  render that as "no chance of finishing second."** It means "this publisher does
  not say", and the term's `source` being `espn_fpi` rather than `playoffstatus`
  is the signal to read.
- **A `null` conference is `unavailable`, not `not_eligible`.** Not knowing a
  team's conference is not the same as knowing it is outside the power four, so
  if the conference map fails, every conference term goes `unavailable` —
  including for teams that genuinely are ineligible. Pessimistic and correct.
- **The conference-odds read resolves the season, so a cold read of both
  documents is three KV writes, not two.** `season_calendar` is shared with
  every other read and cron-warmed, so it is not a cost this feature adds; the
  test says so explicitly rather than looking wrong to somebody later.
- **A growing alias table in `services/teamNames.ts` is a bug, not diligence.**
  One entry, `pittsburgh → pitt`, resolves all 67 rows. If a second seems
  necessary, check the normalization first: replacing punctuation with a space
  instead of removing it produces a phantom second mismatch (`N.C. State`).
- **Settled in Phase 4: the screens exist.** What Phase 3 wrote here was this:
  on today's data
  `ConferenceOddsDocument.computedLabel` is **null**, because the four pages
  carry two different stamps. Phase 4's "as of \<playoffstatus stamp\>" has to
  come from the per-conference `pages[]` entry, which the response carries on
  its `conference_odds` source.
- **The displayed rows will not add up to the displayed total, and that is
  correct.** The API sums *unrounded* team totals and rounds once, so the board
  total can sit a cent away from the sum of the six numbers printed above it —
  the plan's eight worked teams board 22.65 against 22.64. Phase 4's exit
  criterion asks for the rows to sum to the total on screen; it cannot have both
  that and "round once at the edge". Render `total.display` and do not claim the
  column adds up.
- **Every points value arrives as `{ value, display }`.** Sum `value`, print
  `display`, and never re-round either: two clients that both re-rounded would
  disagree in the last digit, which is the whole reason both are shipped.
- **A projection's `total` is `null` for a team or a board nothing is known
  about**, and `teamsCounted` / `teamsTotal` say how much of a board is behind
  its number. One of the nine real boards currently counts **three of six**. A
  leaderboard that renders null as 0.00, or that omits the count, is comparing
  two different things.
- **Poll the projection at minutes, not seconds.** The routes answer
  `max-age=120` and their inputs move every six hours; `poll.ts`'s live cadence
  here would be thousands of pointless requests a day.
- **The projection composite is L1 only and writes no KV**, so Phase 3 added
  nothing to the write budget. The feature's KV cost is still Phase 2's: at most
  eight writes a day for the two documents.
- **An admin write drops three L1 keys now**, not one: the board composite, that
  board's projection, and the leaderboard (`forgetProjections` in
  `routes/admin.ts`). Any future derivation of the selections needs its own line
  there, or the administrator will see one view update and another not.

## 13. The matchup board (in progress)

Plan: [plan-matchup-board.md](plan-matchup-board.md). **Phase 1 is committed
(`1380a99`); Phase 2 is built and verified (2026-10-03), not committed; neither
is deployed.** Each phase's completion notes are the full record —
[Phase 1](plan-matchup-board.md#phase-1--completion-notes) (the API, thirteen
decisions) and [Phase 2](plan-matchup-board.md#phase-2--completion-notes) (the
screens, sixteen decisions). What belongs here is what a later feature will
trip over.

**From Phase 2 (the screens, `apps/web` only — 1230 tests, up 113):**

- **Two new pages**, `/matchups?week=` and `/matchups/:gameId`, lazy and
  prefetched, and a **"Matchups" header link** beside "Boards". The home page
  has one line linking there, which fetches nothing.
- **`PredictionPanel` is shared by two pages now**, through
  `subject: { game, order, label? }`; `predictionView(prediction, gameId,
  order)` takes a `PredictionOrder` (`viewed_team` or `away_home`). Change its
  wording once and both pages follow — that is the point; do not fork it.
- **All matchup display rules live in `lib/matchup.ts`** (sections, the
  viewer-zone day grouping, titles, "Both Wilson's", results, score states,
  the header's oldest-row freshness). The client's `isInProgress` mirrors the
  server's ordering rule (a mid-game delay is "Live now"); keep the two in step.
- **`['matchups']` is a fourth query prefix an admin write must invalidate**
  (`useAdminWrite.ts`), and `/api/matchups` is in `PUBLIC_INDEX_PATHS`.
- **The first `<h4>` in the app had no reset** — `global.css` covered h1–h3
  only, and a screenshot, not a test, found it. A future `h5` has the same trap.
- **A flex gap is not a space**: the board header read "week 5Rankings". Fixed
  on both headers; assert a real space with `visibleText`.
- **Browser checks (84 + a 3-check slate drill) passed on the mock provider
  only.** The real-ESPN and deployed runs are Phase 3's.

**From Phase 1 (the API):**

- **Two new public routes**, `GET /api/matchups?week=` and
  `GET /api/matchups/:gameId`, and two new provider methods,
  `getSeasonWeeks` and `getWeekGames`. Every provider (ESPN, mock, the fault
  wrapper, and any test fake) must implement both.
- **Two new cache rows**: `week_games` (15 min, stale 6 h, KV at most hourly; a
  week whose every game is final or canceled is kept a day and served stale for
  a week) and `matchup_composite` (60 s, 15 s live or degraded, L1 only). The
  week list rides the `season_calendar` category under its own key. Expected KV
  cost: about 24–28 writes a day, cron-driven.
- **The live overlay is now a function of any list of games**
  (`services/live.ts` `overlayLive`), and the matchup board uses the boards'
  own slate cache key, so a Saturday's boards and matchup board share one slate
  read per isolate (tested).
- **An admin write now drops four kinds of L1 key**: the board, that board's
  projection, the leaderboard, and every matchup composite (by prefix,
  `evictL1Prefix`). The §12 rule stands: any further derivation of the
  selections needs its own line in `routes/admin.ts`.
- **The real data matched the plan's measurement exactly**: 12 matchups in week
  6 (UCLA at Oregon both Wilson's), 11 in week 5 (Florida at Missouri both
  Jeremiah's), 22 one-sided each week, and no owned team's game missing from
  the `groups=80` week document (cross-checked against all 54 teams' own
  schedules, LSU–McNeese included).
- **A week document is the biggest parse in the app**: 0.8–1.07 MB, 5.6–8.3 ms
  median in Node and 16–19 ms on a cold first run, against the documented
  10 ms. The cron warms the current week. Watch `exceededCpu` after the deploy,
  as for the cold board (§9).
- **ESPN puts betting odds in every week-document event** (~74 KB of the 800 KB).
  The validator never reads the key; keep it that way (§3, espn-notes §6, §13).
- **A database failure on these routes is a 500 with a reference**, the
  application's convention for PostgREST failures, not the 503 the plan wrote.

