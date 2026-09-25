# Project Notes — College Football Team Board

Everything worth carrying forward from building this application, in one file:
what it is, how it is put together, what was learned the hard way, what is
deployed, and what is left.

Written at the close of Phase 5, 2026-09-19, when the application went live.
Updated 2026-09-24, when team search was deployed.

- The behaviour the app was built to (the specification) is
  [archive/spec.md](archive/spec.md). `§n` references throughout the code and
  docs point at its numbered sections.
- The build plan, phase by phase, with completion notes for each, is
  [archive/plan.md](archive/plan.md). It is the long history; this file is the
  distillation.
- [plan-search-engine.md](plan-search-engine.md) — the public team search, so
  any team can be looked up and not only the 54 on boards. All four phases are
  built, verified, and live since 2026-09-24.
- Operations — deploying, configuration, limits, troubleshooting — is
  [../docs/ops.md](../docs/ops.md).
- ESPN's undocumented API, as observed: [../docs/espn-notes.md](../docs/espn-notes.md).
- Supabase setup: [../docs/supabase-setup.md](../docs/supabase-setup.md).
- How to test each phase by hand: the [README](../README.md).

---

## 1. What it is, and where it is

A private dashboard for nine people, each with a board of six college football
teams. Anyone with the link can read every board, and can look up any of the
~762 teams the provider lists, on or off a board; only the administrator can
change the boards.

| | |
| --- | --- |
| Site | <https://cfb-board-pfc.pages.dev> (Cloudflare Pages project `cfb-board`) |
| API | <https://cfb-api.cfb-api.workers.dev> (Worker `cfb-api`, `--env production`) |
| Database | Supabase Postgres: 9 people, 54 selections, 65 team rows (11 no longer on any board) |
| Cost | Nothing. Every service is on a free tier, with no card on file |
| Source | Branch `main`. Phase 5 is commit `5dd38b3`. **There is no git remote yet** |
| Tests | 777, in 35 files. `npm run verify` runs typecheck, lint, tests, and the season check |

Built in five phases: foundation and contracts, the sports data layer, the
website, the team page, then admin, hardening, and the deploy. Each phase's
exit criteria and completion notes are in the archived plan.

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
`/api/search/teams?q=` — all public, no token — and `/api/admin/*`, which is
the only branch that verifies a JWT.

Three rules hold the structure together, and everything else follows from them:

1. **The browser never talks to ESPN or to Postgres.** It calls the Worker, which
   returns normalized data designed for the screen (§26).
2. **Only `apps/api/src/providers/espn/` knows ESPN exists.** Outside it, `espn`
   appears only as a label type (`ProviderName`, `PredictionSource`) so that
   sources can be named honestly on screen (§46). Swapping providers is a new
   directory plus one line in `providers/registry.ts`.
3. **The database is the authorization boundary, not the UI.** Every write goes
   to PostgREST with the administrator's own token, and Row Level Security
   decides. There is no service-role key anywhere in the repo, CI, or the
   Worker — deliberately, so nothing can quietly bypass RLS.

### Where things live

```
packages/shared/     Types and pure logic shared by the API and the browser
                     (domain model, freshness envelope, season logic)
apps/api/            The Worker
  src/routes/        HTTP surface: public reads, /api/admin/*, health
  src/services/      Board, team, snapshot, live overlay, search, context
  src/cache/         TTL policy (one table), the three tiers, stale-while-revalidate
  src/providers/     espn/ (client, raw types, validate, normalize, logos),
                     mock/, faults, registry
  src/db/            PostgREST client, queries, row mapping
  src/middleware/    CORS, rate limit; auth lives in src/auth/
  src/cron/          The warmers
  test/              777 tests live here and beside the web sources;
                     test/fixtures/espn/ holds 20 real ESPN payloads
apps/web/            The site (React + Vite, strict TS)
  src/features/      home, board, team, search, admin
  src/components/    Cards, logos, states, dialog, header
  src/lib/           API client, query keys, polling, formatting
  src/auth/          Admin session, loaded only for the administrator
supabase/            Migrations, RLS policies, the reorder RPC, seed, and
                     test/ (the security model on real Postgres, via PGlite)
scripts/             verify-rls, smoke, check-bundle-secrets, check-season-literals,
                     capture-espn-fixtures
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

Protections that exist because of real limits:

- **A KV write ledger** warns at 700 writes and refuses at 900, against the
  1,000/day limit. Each key also has a minimum write interval.
- **Cron warmers** refresh the calendar, rankings, team list, and conference map
  off the request path, and run one Postgres `select` so the free Supabase
  project never pauses. They deliberately do **not** warm schedules: fifty teams
  hourly would be about 1,200 KV writes a day.
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
- **Two API families are needed** and they share no conventions:
  `site.api.espn.com` for browser-facing shapes, `sports.core.api.espn.com` for a
  hypermedia API of `$ref` URLs. Conference names need two hops.
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

The suite is 704 tests. What carried the most weight:

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
- **No git remote**, so CI has never run and the deploy job is untested.

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
3. **Optional:** create the GitHub remote, push `main`, and turn on the CI deploy
   job (docs/ops.md, "Continuous deployment"); a screen-reader pass.

## 11. Commands worth remembering

| Command | What it does |
| --- | --- |
| `npm run verify` | Typecheck, lint, 777 tests, season check. The one to run |
| `npm run dev` / `npm run dev:web` | The API on 8787 (mock data) and the site on 5173 |
| `npm run verify:rls` | Attacks the live database directly, as `anon` and as a non-admin |
| `npm run smoke -- <api> [site]` | Read-only checks against a running Worker, local or live |
| `npm run check:bundle` | Fails if a privileged key is in a built bundle |
| `npm run deploy --workspace @cfb/api` | Deploys the Worker (`--env production`) |
| `npm run build:web` + `wrangler pages deploy apps/web/dist --project-name cfb-board --branch main` | Deploys the site |
| `npm run capture:fixtures` | Re-downloads the ESPN sample payloads |
