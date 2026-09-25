# Team Search — Implementation Plan

## Phase Checklist

- [x] **Phase 1 — A team page for any team.** The contract gains `PageTeam`, and
      `GET /api/teams/:teamId` accepts either our uuid or a provider team id, so
      a team with no database row has a page. *Done 2026-09-20; notes below.*
- [x] **Phase 2 — A public search endpoint.** `GET /api/search/teams?q=`, reusing
      the ranking and team list the admin console already uses. *Done 2026-09-20;
      notes below.*
- [x] **Phase 3 — The `/search` page.** A lazy page with debounced live results,
      a shareable URL, and rows that open the team page. *Done 2026-09-22;
      notes below.*
- [x] **Phase 4 — The header control, docs, and ship.** A search box on every
      page, the accessibility pass, the README and notes, and the deploy.
      *Built 2026-09-23, **deployed 2026-09-24**; notes below.*

**Part Two — who has this team.** A search result says nothing about the nine
boards. These three phases make it say so, and make the name a way in.

- [x] **Phase 5 — The pick index.** `GET /api/selections`: every board's picks,
      inverted to provider team id → who has that team. One Postgres read, no
      provider call. *Done 2026-09-24; notes below.* See
      [Part Two](#part-two--who-has-this-team-phases-57).
- [x] **Phase 6 — "Picked by" on the search results.** A shared `PickedBy`
      component under each result row, each name a link to that board. The
      result row's whole-row link had to shrink for it. *Done 2026-09-25;
      notes below.*
- [x] **Phase 7 — The team page, docs, and ship.** The same line in the team
      page's hero, the accessibility pass, the documents, and the deploy.
      *Built 2026-09-25; notes below. The deploy is the one step left.*

Phases are sequential. Each ends at a verifiable state, and `npm run verify`
must be green before the next one starts. Part Two started from **777 tests in
35 files**, Phase 6 from **788 in 35**, and Phase 7 from **809 in 37**, ending
at **821 in 37**.

This plan is written against [project-notes.md](project-notes.md) (how the
application is built) and the archived [spec](archive/spec.md) — `§n` references
point at the spec's numbered sections.

---

## Context

The site can only show the 54 teams that sit on somebody's board. A team page is
reachable only through a board card, because `GET /api/teams/:teamId` is keyed by
our own Postgres uuid, and a `teams` row exists only for a team an administrator
has added to a board.

The owner wants any visitor to look up **any** college football team and see what
a board team shows: rank, record, previous game, next game, the matchup
prediction, the live score while it is playing, and the full season schedule.

Reading the code before planning paid off: **the uuid earns nothing**.
`services/team.ts` uses it for the lookup and for nothing else —
`buildSnapshot`, `readLiveSchedule`, `deriveSlots`, `scheduleItems`, `rankingOf`
and `perspective.ts` all key off `providerTeamId`, and `snapshot.ts identityOf()`
already strips the uuid. `services/search.ts` already resolves a provider id to a
full identity with no database access (`findTeamIdentity`) and already ranks the
762-team list (`searchTeams`), with nothing admin-specific in it.

So this is mostly a routing and contract change, plus one new page. Very little
new machinery.

### Decisions taken with the owner

| Question                                    | Answer                                                                                                                  |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Who can search                              | Everyone, no login, like every other read (§11.1)                                                                       |
| Entry point                                 | A box in the header on every page; Enter opens `/search?q=…`                                                            |
| Coverage                                    | Every team the provider lists (~762, all divisions)                                                                     |
| Header behaviour                            | Navigates to a results page. No dropdown over every page: the app has deliberately avoided combobox keyboard handling   |
| Admin "add to board" from a searched team   | Not now. Search is viewer-only; boards are still edited in the console                                                  |

### Two rules this must not break

- **No public path writes to the database.** Looking a team up must not create a
  `teams` row. Rows are created only by `storedTeam`, inside
  `POST /api/admin/users/:userId/selections`, with the administrator's own token;
  RLS refuses anything else (§30, §31). The tests assert this structurally: no
  PostgREST request is recorded on either new public path.
- **Nothing invented** (§4, §46). An FCS team shows **"NR"** for its rank — the
  AP poll was read and does not list them, which is exactly what §7's "unranked"
  means — and "Conference unknown" for its conference, because the conference map
  is FBS only. Both are existing vocabulary. A fourth "not eligible" state would
  need division data the provider's team list does not carry, so it is not built.

---

## Phase 1 — A team page for any team

**Goal:** `GET /api/teams/:teamId` serves a team identified either by our uuid
(as today) or by a provider team id, with no database row required.

### Scope

| File                                      | Change                                                                                                                                    |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/shared/src/domain/team.ts`      | Add `PageTeam` (below). `Team` and `TeamIdentity` unchanged                                                                               |
| `packages/shared/src/domain/index.ts`     | Export `PageTeam`                                                                                                                         |
| `packages/shared/src/api/responses.ts`    | `TeamDetailResponse.team` and `TeamScheduleResponse.team` become `PageTeam`, with a comment saying the uuid is there only for a team we store |
| `apps/api/src/providers/ids.ts` **(new)** | `PROVIDER_ID_PATTERN` and `isProviderId()`, lifted out of `routes/games.ts`                                                               |
| `apps/api/src/routes/games.ts`            | Import them; delete the local copy. Behaviour identical                                                                                   |
| `apps/api/src/services/snapshot.ts`       | `buildSnapshot` takes a `TeamIdentity`. `identityOf` **keeps its explicit field copy**                                                     |
| `apps/api/src/services/team.ts`           | Add `resolveTeam`; both readers use it                                                                                                    |
| `apps/api/src/routes/teams.ts`            | Drop the two `isUuid` guards; id-shape knowledge moves into `resolveTeam`                                                                 |

```ts
/**
 * A team as a page shows it: the provider's identity, plus our own uuid when
 * the team has a row (someone put it on a board) and `null` when it has not.
 */
export interface PageTeam extends TeamIdentity {
  id: string | null;
}
```

`Team` stays `{ id: string }` and remains assignable to `PageTeam`, which is what
keeps the blast radius small.

```ts
// services/team.ts — uuid FIRST, and no fallback between the two shapes.
export async function resolveTeam(
  services: Services,
  db: PostgrestClient,
  teamId: string,
): Promise<PageTeam> {
  if (isUuid(teamId)) return await getTeamById(db, teamId); // throws notFound
  if (!isProviderId(teamId)) throw notFound('No such team.');
  const identity = await findTeamIdentity(services, teamId); // no Postgres at all
  if (identity === null) throw notFound('No such team.');
  return { ...identity, id: null, logoUrl: sizedLogoUrl(identity.logoUrl, TEAM_LOGO_PX) };
}
```

`getTeamDetail` and `getTeamSchedule` each swap `getTeamById` for `resolveTeam`;
everything below them already works from `team.providerTeamId`.

**Who reads `team.id` off these two responses: nobody.** `TeamPage` reads only
identity fields. The only `team.id` readers are `TeamCard.tsx` and `useTeam.ts`,
both on `BoardResponse`, which is unchanged. The `teamDetail` and
`scheduleResponse` builders in `apps/web/src/test/fixtures.ts` widen to
`PageTeam`.

### Exit criteria

- `/api/teams/<uuid>` and its schedule behave exactly as before, with `id` set.
- `/api/teams/<providerTeamId>` and its schedule answer 200 for a team **not** in
  the `teams` table, with `id: null`, and with the same snapshot and schedule
  content a board team gets.
- That request records **no PostgREST request at all** in the Supabase stub.
- An unknown provider id, a malformed id, and an over-long id are clean 404s.
- A board team fetched both ways shares the provider work: the second read is
  `X-Cache: hit`, and ESPN is not called twice.
- Regression guard: on every board card, `'id' in snapshot.data.identity` is
  `false`.

### Watch out for

- **A uuid also matches the provider-id pattern** (36 characters of hex and
  hyphens). Resolve the uuid first and never fall through to the provider list,
  or a deleted row would quietly start resolving as a provider id.
- **`identityOf` must stay an explicit field copy.** Widening `buildSnapshot` to
  `TeamIdentity` and passing a `Team` straight through would put `id` inside
  `snapshot.identity` on the wire for every board card. Excess properties survive
  at runtime, so TypeScript cannot see this one.
- The existing test "404s an unknown team and a malformed id" still passes, but
  its meaning changes: `/api/teams/texas` is now "no such team in the provider's
  list". Add an explicit case for a **valid** provider id answering 200, or the
  change is untested.
- In mock mode `listTeams()` reports `provider: 'mock'` while stored rows say
  `'espn'` (`teamNamespace`). Nothing renders that field; do not write a test
  asserting the two paths are deep-equal.
- A searched team depends on the 24-hour team list. If that list cannot be
  loaded, the page is a clean error, whereas a board team still shows its
  identity from Postgres. Accept that asymmetry and record it; do not engineer it
  away.

### Completion notes (2026-09-20)

Built as planned, with one deliberate change of signature and one small repair
found on the way (the error message below). `npm run verify` is green: 715 tests
in 31 files, up from 704.

**`resolveTeam` takes a database *factory*, not a client.** The plan's
`resolveTeam(services, db: PostgrestClient, teamId)` reads fine, but the route
has to build that client before calling it, and `supabasePublic()` is also what
asserts Supabase is configured at all. Removing the `isUuid` guard from
`routes/teams.ts` would therefore have turned `/api/teams/<garbage>` on an
unconfigured Worker from a clean 404 into a 500 — precisely the regression
`routes.test.ts` already pins for `/api/users/<garbage>` ("the id used to be
validated only after the database client was built"). So the parameter is
`DbFactory = () => PostgrestClient`, the route passes `() => supabasePublic(c.env)`,
and the provider-id path never constructs one. A nice side effect: "no PostgREST
request on the public path" is now true because no client exists to make one,
not merely because nothing called it. A searched team page works with no
database configured at all, which is tested.

Everything else matched the reading. `buildSnapshot` widened to `TeamIdentity`
with no other call site touched; `identityOf`'s explicit field copy was left
alone. The `PROVIDER_ID` regex moved to `providers/ids.ts` unchanged, so the
game routes behave identically. The two response types widened to `PageTeam`
and nothing on the web side needed changing — the prediction that no one reads
`team.id` off these two responses held, and only the two `apps/web/src/test/fixtures.ts`
builders widened.

**On the leak guard.** "On every board card, `'id' in snapshot.data.identity` is
`false`" is now a test — and it was checked the only way worth checking it:
`identityOf` was temporarily changed to spread its argument, the test failed,
and it was changed back. A guard against an invisible bug is worth nothing until
it has been seen to fail.

Eleven tests were added, all in `apps/api/test/board.test.ts` beside the existing
team-route tests: the provider-id page and its schedule; zero PostgREST requests
on both; the two URLs agreeing on the sports half (compared field by field, not
deep-equal, for the `teamNamespace` reason above); the uuid resolved first and
not falling through; the three 404 shapes; the team list being down; the
no-database case; the leak guard; and, over the real ESPN captures, one team
fetched both ways sharing its schedule read (`X-Cache: hit`, one ESPN call) and
an FCS team coming back with `conference: null` rather than a guess.

Also checked by hand against `npm run dev` (mock provider) and, for the
uuid path, against the live database: `/api/teams/2` answers 200 with `id: null`,
a 1-2 record, a final previous game and a bye next; the second read is
`X-Cache: hit`; `/api/teams/2/schedule` returns 12 items; `999999`, `texas!`, a
41-character id and an unknown uuid are all 404; and Texas fetched as
`/api/teams/0a974681-…` and as `/api/teams/251` gives the same name and the same
2-1 record, differing only in `team.id`.

### Findings

**§45 now has an exception, and it should be written down.** "Identity is
application-owned: it comes from Postgres, not the provider" was true of every
path in the app until this phase. On `/api/teams/<providerTeamId>` it is false —
identity comes from the provider's 24-hour team list. That is the whole point of
the phase, but it is a load-bearing rule elsewhere in the codebase and the
comment in `snapshot.ts` asserting it had to be rewritten. Two consequences fall
out of it, both worth knowing before Phase 4 writes the docs:

- **A hand-curated conference on a stored row will not show on the provider-id
  URL.** The plan already lists this under Risks; it is now real rather than
  predicted.
- **The freshness envelope does not cover identity on this path.** The response's
  `Cache-Control` was `max-age=899` — the 15-minute schedule TTL. Nothing in the
  envelope says the team's *name* came from a list that may be a day old. That
  is defensible (the name is not a sports fact that changes hourly) but it is a
  gap between what §23 promises and what this path delivers, and it should be a
  sentence in `docs/ops.md` rather than a surprise.

**Widening who can reach a code path silently re-points its user-facing copy.**
`readTeamList` threw `'Team search is temporarily unavailable.'` — accurate while
only admin search and admin add-to-board could reach it. Phase 1 put it behind a
public team page, and `TeamPage.tsx:71` renders `error.message` verbatim, so a
visitor whose team page failed would have been told that a *search* was
unavailable. Fixed here to `'Team information is temporarily unavailable.'`, with
a test that pins the string and asserts it does not match `/search/i`. Worth
generalising: when a function gains a caller, grep its user-facing strings, not
just its types. The compiler cannot see this class of error at all.

**A team with no logo is normal, not exceptional.** 671 of the 762 teams in
ESPN's list carry a logo — **91 do not**, about 12%. And in mock mode
`listTeams()` returns `logoUrl: null` for *every* team, while board cards get
their logos from Postgres. So in local development every searched team page will
be logo-less while every board card has one. Phase 3 should expect the initials
fallback (§36) on the results list and the searched team hero as a routine state
to design for, and nobody should file it as a bug when they see it locally.

**`supabasePublic()` does two jobs, and where you call it changes the error.**
It builds the client *and* asserts Supabase is configured. That coupling means
the placement of the call decides what a malformed id returns — which is exactly
why the `DbFactory` change above was needed, and it is the same trap
`routes.test.ts` already pins for the user route. Anything future that removes an
id guard from a route should check whether it also moved a configuration
assertion earlier in the request.

**An assertion about absence is worth nothing until it has been seen to fail.**
This phase leans on several: no `id` in `snapshot.identity`, no PostgREST
request, no JWKS fetch, no second ESPN call. Each of those passes just as
happily against a route that is broken in some unrelated way. The `identityOf`
guard was verified by temporarily making it spread its argument and watching the
test go red. The others are paired with a positive assertion in the same or a
neighbouring test (a 200, a non-null snapshot, a specific list of request paths)
so that a wholesale failure cannot read as a pass.

**The plan's untested claim, now tested.** "If that list cannot be loaded, the
page is a clean error" was written under "Watch out for" but had no exit
criterion. It does now: `SPORTS_PROVIDER_FAULT=teams` makes `/api/teams/2` a 503
`provider_unavailable` carrying its request id. That is the asymmetry the phase
accepted, pinned so a later refactor cannot quietly turn it into a 500.

**`getTeamById` keeps its own `isUuid` guard**, so id-shape knowledge now sits in
both `db/queries.ts` and `resolveTeam` rather than only the latter. Left as is:
it is one cheap re-check on a function that is reachable from one place, and
deleting it would make `getTeamById` unsafe for any future caller. Noted because
the plan said the knowledge "moves into `resolveTeam`", and it is more accurate
to say it was *added* there.

**Environment, not code: a stale `workerd` was holding port 8787.** The readiness
probe for the dev Worker passed against a process started on 2026-09-19 that had
never exited, while the Worker actually running this phase's code bound 8788 and
said so in its log. Everything would have "passed" against yesterday's build.
Two lessons: `npm run dev` does not always land on the 8787 that
`project-notes.md §11` documents, so read the "Ready on" line rather than
assuming; and a readiness probe should ask for a fact only the new build can
answer, not merely whether *something* answers.

---

## Phase 2 — A public search endpoint

**Goal:** anyone can ask the API for the teams matching a query.

### Scope

- **`apps/api/src/routes/search.ts` (new, ~25 lines)** — `GET /teams?q=`, reusing
  `parseQuery` and `searchTeams` from `services/search.ts` **unchanged**, and
  returning the existing `TeamSearchResponse`. `Cache-Control: public,
  max-age=300` is set **after** the await, so an error response never inherits it.
- **`apps/api/src/app.ts`** — mount at `/api/search`, after `/api/games` and
  before `/api/admin`, so it sits inside the read budget and outside the admin
  branch.
- **`apps/api/src/services/search.ts`** — doc comment only; it is no longer "the
  admin search". No code change.
- **`apps/api/src/routes/admin.ts`** — unchanged. The console keeps its own
  `private, no-store` route, and the admin route matrix keeps enumerating it.
- **`scripts/smoke.mjs`** — a search check and a provider-id team check.

Why `/api/search/teams` and not `/api/teams/search`: once `/api/teams/:teamId`
accepts non-uuid ids, that second path segment _is_ the provider's id namespace.
Hono resolves the static segment first, so it would work by luck, but a provider
id spelled `search` would be permanently unreachable and the ambiguity would be
invisible in the route table.

A flat `public, max-age=300` (as `routes/users.ts` does for its lists) rather
than `setCacheHeaders`: the response carries no `Freshness` of its own, the
underlying list has a one-day TTL, and five minutes is what makes repeated
keystroke traffic free in the browser's cache.

### Exit criteria

- 200 with no token: no JWKS fetch, every database request's `authorization`
  null, no PostgREST request at all, and `Cache-Control: public, max-age=300`.
- Ranking parity with the admin route: `?q=TEXAS` puts Texas first, and
  `?q=san jose` folds accents.
- `?q=a`, a missing `q`, and a 61-character `q` are all 400s.
- Team list unavailable → 503 `provider_unavailable`. Conference map unavailable
  → still 200, with conferences null: it degrades, never fails.
- `/api/search/teams` spends the per-address read budget and 429s with
  `Retry-After`; `/api/admin/teams/search` still does not.

### Watch out for

- Do not reuse the admin module's `NO_STORE`. A public search that cannot be
  cached defeats the point of making it public.
- Resist adding a `limit` parameter: `SEARCH_LIMIT = 20` on the server is the
  abuse ceiling.
- `rankMatches` folds about 762 names per request. Sub-millisecond when warm, but
  it is on the request path, and the first deploy already measured a cold board
  at 44 ms against a documented 10 ms budget.

### Completion notes (2026-09-20)

Built as planned. `npm run verify` is green: **729 tests in 31 files**, up from
715. The route is 12 lines of handler; everything it does was already there.

One source file was added and four changed, and three of those four are
comment-only — which is the honest summary of the phase. `routes/search.ts` is
new, `app.ts` mounts it, and `services/search.ts`, `routes/admin.ts` and
`packages/shared/src/api/requests.ts` had comments that Phase 2 made false.
`services/search.ts` has **no code change**: the ranking, the 2–60 character
bounds and the 20-result ceiling are the admin console's, unmodified, which is
what the parity test pins. `scripts/smoke.mjs` gained the two checks the plan
asked for, and two more that fell out of them — that the search answer is
cacheable, and that the team page a result opens has a whole snapshot behind it.

**Two departures from the plan's Scope, both comment-only.**

- The plan says `routes/admin.ts` is unchanged. Its code is, but the doc comment
  over `GET /api/admin/teams/search` said the route was admin-only "so that an
  open search box is not one more public endpoint to crawl" — a reason this
  phase deletes. It now says what is actually true of the pair: same ranking,
  same list, different cache headers and different doors. This is the Phase 1
  finding recurring ("when a function gains a caller, grep its user-facing
  strings"), one level up: when a *route* gains a public twin, re-read the
  comment explaining why it is private.
- `TeamSearchResponse` lives in `packages/shared/src/api/requests.ts`, a file
  whose header says it holds `/api/admin/*` bodies. It is now the odd one out,
  and says so. Moving it would have churned imports on both sides of the wire
  for no behavioural gain.

**Fourteen tests were added**: twelve in `apps/api/test/board.test.ts` beside
the admin-search block, two in `ops.test.ts` (the read budget, and the route
added to the "every public read sets Cache-Control" list). They cover every
exit criterion: public with no JWKS fetch; zero PostgREST requests; the
five-minute lifetime; ranking parity asserted as `toEqual` against the admin
route's body for the same query; accent folding; the 20-result cap with a
`limit` parameter ignored; the three 400s; the 503 with its reference number;
an error never inheriting the cache lifetime; ESPN conferences present, and
absent when the map is down; the KV ledger unchanged by repeated searching; and
the 429 with `Retry-After` while the admin route still answers 401 to the same
exhausted address.

**Three of those were watched to fail before being kept**, per the Phase 1 rule
about assertions of absence. Moving `c.header('Cache-Control', …)` above the
await turned the error-lifetime test red (`expected 'public, max-age=300' not to
match /max-age/`); making the route read `app_users` turned the no-database test
red; exempting `/api/search` in `rate-limit.ts` turned the budget test red. Each
was reverted.

Checked by hand against `wrangler dev` on the mock provider, and then against
**real ESPN** with the production User-Agent (`SPORTS_PROVIDER:espn`, cold
`--persist-to`). On live data: `q=mercer` returns one FCS team with
`conference: null`; `q=san jose` finds San José State; `q=state` returns exactly
20 of ~116 matches; `q=zzzzqq` is a 200 with `{"teams":[]}`, not an error;
`/api/teams/2382` then serves Mercer with `id: null`, `{"kind":"unranked"}`,
a real 2-2 record and a 13-row schedule. `npm run smoke` is 18/18 against that
Worker, including the four new checks.

### Findings

**A search costs about 2 ms of the 10 ms CPU budget, and one KV write a day.**
Both numbers were guesses in the plan and are now measured against real ESPN.
Twenty warm round trips over loopback: `/api/health` (no provider work) 12.2 ms,
`?q=zzzzqq` (0 matches) 14.5 ms, `?q=state` (116 matches, 20 returned) 14.1 ms.
So the fold over 762 names plus two cache reads is **~2 ms**, and the number of
matches does not move it — the sort runs over the matched subset, not the list.
A dozen searches wrote KV **three times**: `season_calendar`, `team_list`,
`conferences`, once each, exactly as the write intervals promise. Opening one
searched team page then added two more (`rankings`, `schedule`). That is the
shape of the crawler risk, stated precisely: **searching is nearly free; it is
the team pages that searching leads to which spend the KV budget.** The counter
to watch after the deploy is `schedule`, not `team_list`.

**`wrangler dev` persists the Cache API between runs, so a fault drill can pass
against a warm cache.** The first `SPORTS_PROVIDER_FAULT=teams` run returned a
cheerful 200 with three Texas teams. The binding was set — the log listed it —
but the previous dev Worker had written `team_list` into the local `caches.default`,
which wrangler keeps in `.wrangler/state` across restarts, and a one-day TTL
means no provider call was ever attempted. `--persist-to <fresh dir>` produced
the real answer: 503, `provider_unavailable`, "Team information is temporarily
unavailable.", with a request id and **no `Cache-Control` at all**. This is the
Phase 1 stale-`workerd` lesson in a new costume: the drill must make the failure
*reachable*, not merely configured. A cold persist directory is the cheap way.

**ESPN puts North Dakota State in the Mountain West, and the app says so.**
`q=north dakota` returns North Dakota (155) with `conference: null` and North
Dakota State (2449) with `Mountain West`. That looked like a misattribution in
`getConferences`, so it was checked at the source: ESPN's core API lists 2449
among group 17's ten teams for the 2026 season, and group 17 is
`Mountain West Conference`. It is the provider's own answer, passed through
unaltered (§46). Worth writing down because the plan's phrasing — "an FCS team
shows Conference unknown" — invites exactly the wrong conclusion when one does
not: **the map is not a division filter.** A team carries a conference if ESPN's
FBS groups list it, whatever division it looks like it belongs to, and nobody
should "fix" that by inference.

**The 429 and the 503 carry no `Cache-Control`, which is load-bearing and was
nearly invisible.** Hono merges headers set on the context into whatever
response finally leaves, including the error handler's. Set the five-minute
lifetime before the await and a browser would hold a failed search for five
minutes — on a page where the user's instinct is to retype, i.e. to produce the
same URL and be served the same stale failure from their own cache. The plan
called for setting it after the await; what was missing was any test that the
ordering held, since both orderings look identical on the success path. There is
one now, and it was watched to fail.

**Rate limiting a keystroke endpoint is a Phase 3 constraint, not an API one.**
The budget works — 200 parallel requests from one address in workerd gave 129
allowed and 71 refused, with `Retry-After: 1`, and a second address was
unaffected. But the default is 120 a minute and the bucket refills at two a
second, so a sequential loop of 124 requests never trips it at all. A person
typing cannot exhaust it; a person typing *without the debounce* very nearly
could, and the failure would be a 429 on the one endpoint whose whole purpose is
to feel instant. Phase 3's 250 ms debounce and normalized query key are what
keep this true, so they are not polish — they are what makes the budget hold.

**`/api/search/teams` sets no `X-Cache`, deliberately, and that is now a small
inconsistency worth knowing.** It uses the flat `public, max-age=300` that
`routes/users.ts` uses, not `setCacheHeaders`, because the response carries no
`Freshness` of its own to derive a lifetime from. The cost is that the one
header that would tell an operator whether a search was served from the team
list's cache or from ESPN is absent. The KV ledger in `/api/health` answers the
same question, which is why this was left alone rather than half-solved.

---

## Phase 3 — The `/search` page

### Scope

| File                                                          | Purpose                                                                                                                       |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/lib/api.ts`                                     | `api.searchTeams(query, signal)` through `getPublic`; `queryKeys.search(q)` — **not** under the `'admin'` prefix, which sign-out clears |
| `apps/web/src/features/search/SearchPage.tsx` + `.module.css` | The page (new)                                                                                                                |
| `apps/web/src/features/search/useTeamSearch.ts`               | `useQuery` with `enabled` above the minimum, `staleTime` 5 minutes, `placeholderData: keepPreviousData` (new)                  |
| `apps/web/src/app/pages.ts`, `routes.tsx`                     | A lazy `/search` route, and its loader added to `prefetchViewerPages()` since the header links to it from everywhere           |
| `apps/web/src/features/team/useTeam.ts`                       | The board placeholder matches `team.id === teamId || team.providerTeamId === teamId`, so a search result for a team on a loaded board paints instantly |
| `apps/web/src/test/fixtures.ts`                               | Widen `teamDetail`/`scheduleResponse` to `PageTeam`; add a search-response builder and an FCS team with no conference          |

Modelled closely on `features/admin/TeamSearch.tsx`, which is already proven
accessible: a 250 ms debounce, a two-character minimum, an always-rendered
`role="status"` line ("Searching…" / "N teams found." / "No teams match “q”."), a
separate `role="alert"` carrying `Reference: {requestId}`, and results as a plain
`<ul role="list" aria-label="Search results">`.

The input is seeded from `?q=` and keeps the URL in step with
`setSearchParams(…, { replace: true })`, so a result page can be shared and
reloaded without filling the history. Each row is a single whole-row
`<Link to={'/teams/' + team.providerTeamId}>` carrying
`state.from = { path: '/search?q=…', label: 'Search' }`, which the existing
`readFromState` accepts, so the team page's back link reads "Search" and returns
with the query intact.

### Exit criteria

- Two characters or more lists matches; the URL can be shared and reloaded.
- A result opens that team's page with everything a board team shows, and
  "Search" returns to the results.
- A team nobody has selected works end to end; an FCS team shows "Conference
  unknown" and "NR", with no invented values.
- Every state renders in the string-based tests with no `undefined`, `NaN` or
  `null`: empty results, a provider outage, and a 429.
- `/search` is its own chunk and pulls in no Supabase auth code.

### Watch out for

- **Do not autofocus the input.** `RootLayout` focuses `<main>` after every
  navigation, and parent effects run after child effects, so the focus would be
  stolen silently. Make the input the first focusable element inside `<main>`
  instead.
- Normalize the query key (`trim().toLowerCase()`), or "Texas" and "texas" become
  two cache entries and two requests.
- `replace: true` on the URL update, or every keystroke becomes a history entry
  and the back button becomes useless.
- Keep the page's minimum in step with the API's `SEARCH_MIN_LENGTH`. Below it,
  never call the API: a 400 per keystroke is the failure mode.

### Completion notes (2026-09-22)

Built as planned, with one addition to a shared test helper and one piece of
machinery the plan did not call for but Phase 4 will need. `npm run verify` is
green: **761 tests in 33 files**, up from 729. No API code was touched at all —
`git status` shows seven changed files and two new ones, every one of them under
`apps/web/`.

**The page is `features/search/`: `SearchPage.tsx`, `SearchPage.module.css`,
`useTeamSearch.ts`.** `MIN_QUERY` (2) and `DEBOUNCE_MS` (250) live in the hook
rather than the page, because the hook's `enabled` is what actually keeps a
short query from reaching the API; a constant that lives beside the thing it
guards cannot drift away from it. The status line is a single always-rendered
`role="status"` that says all three states ("Searching…" / "N teams found." /
"No teams match “q”."), copied from `features/admin/TeamSearch.tsx`. An
`EmptyState` for the no-match case was considered and dropped: it would have
said "No teams match" twice on the same screen.

**Two departures from the plan's Scope.**

- **`renderAt` gained an optional fifth parameter, `state`.** The exit criterion
  "a result opens that team's page … and 'Search' returns to the results" is
  carried entirely in router state, which never reaches the markup the
  string-based tests read. The first version of that test asserted
  `encodeURIComponent('texas a&m') === 'texas%20a%26m'` — a tautology that would
  pass against a page with no links at all. `renderAt(path, routePath, element,
  client, state)` lets a test render `TeamPage` *as a search result opened it*,
  and the criterion is now two real assertions: the back link reads "Search" and
  points at `/search?q=mercer`. `searchFrom(query)` is exported from
  `SearchPage.tsx` for the same reason, so the state can be round-tripped
  through `readFromState`, which is its real consumer and the thing that would
  reject a malformed path.
- **The URL sync runs in both directions, not just page → URL.** The plan asked
  for `setSearchParams(…, { replace: true })`. That alone is a Phase 4 bug
  waiting to happen: the header's box navigates to `/search?q=…`, and from
  `/search` that is a param change, not a remount, so the page would have shoved
  its own stale text straight back into the URL. A `written` ref records what
  this page last put in `?q=`; a value that differs from it came from somewhere
  else — the header, or a history step — and wins. Eight lines, and it is why
  Phase 4's `HeaderSearch` can be as simple as the plan describes.

`useTeam`'s board placeholder now matches `team.id === teamId ||
team.providerTeamId === teamId`, and `fixtures.ts` gained `makeIdentity`,
`fcsIdentity` (Mercer: no conference, no logo) and `searchResponse`, with
`makeSnapshot` widened from `Team` to `PageTeam`.

**Thirty-two tests were added**: 24 in `SearchPage.test.tsx`, 3 in
`TeamPage.test.tsx` (the board placeholder, by each id and by neither), and 5 in
the new `lib/api.test.ts`. They cover every exit criterion — the seeded input,
the plain list with no combobox attributes, the provider-id hrefs, the whole-row
link with a decorative logo, "Conference unknown" and the initials fallback, the
below-minimum hint with no request, no `?q=` at all, "Searching…", the empty
state, the 503, the 429, a failure with no reference number, no autofocus, the
input as the first focusable element, and one `h1` in every one of those states.

**Six were watched to fail before being kept**, per the Phase 1 rule. Reverting
`useTeam` to match the uuid only turned the provider-id placeholder test red;
moving `queryKeys.search` under the `'admin'` prefix turned both key tests red
(including the sign-out sweep); dropping `role="status"` from the live region,
dropping `decorative` from the row's logo, and adding `autoFocus` to the input
each turned their own test red. All five edits were reverted and the suite is
green again.

**Checked by hand in headless Edge** (`playwright-core` in the session
scratchpad, as in Phase 5) against `npm run dev` on the mock provider:

- `/search` cold: title `Search | CFB Board`, one `h1`, one `search` landmark,
  focus on `<main>` and **not** on the input, and exactly one Tab to reach it.
- Typing `tex`: one request (`/api/search/teams?q=tex`), 3 results, URL becomes
  `/search?q=tex`. Backtracking `tex` → `te` → `tex` issued **one** request for
  `te` and **zero** going back to `tex`.
- `q=a`: zero requests, no results list, the hint showing, URL still in step.
  `q=zzzzqq`: "No teams match “zzzzqq”."
- `history.length` was 2 before typing and 2 after — `replace: true` holding.
- Keyboard only: Tab, Tab, Enter opened `/teams/251`; the team page showed
  "NR", 1-1, previous, next, prediction and the 12-row schedule under one `h1`;
  the back link read "Search" and returned to `/search?q=texas` with the input
  and the results intact.
- `/teams/333` deep-linked (live game and all), `/search?q=texas` reloaded
  directly, and an old `/teams/<uuid>` board link still worked, giving the same
  team as `/teams/251` bar the logo.
- 320 px, 375 px and 1280 px: **no sideways scroll at any width**, the input
  44 px tall, each result row 68 px. A 70-character unbroken team name still
  did not overflow at 320 px.
- Failure drills: with the team list down, `/search?q=texas` is a `role="alert"`
  reading "Team information is temporarily unavailable." plus its reference
  number; a forced 429 shows the rate-limit message immediately. With
  `SPORTS_PROVIDER_FAULT=schedule`, search still works and a searched team page
  keeps its identity, conference and "Search" back link while both the snapshot
  and the schedule degrade with reference numbers. No raw value, and no page
  error, in any state.

**The chunk criterion, checked at the build.** `npm run build:web` emits
`SearchPage-*.js` at 2.99 kB (1.56 kB gzip) plus its own 1.68 kB stylesheet. It
imports exactly three things — the index chunk, `TeamLogo`, `useDebouncedValue` —
and the strings `supabase` and `gotrue` appear in it **zero** times; the 225 kB
auth chunk stays behind its lazy boundary, referenced from the index chunk only
as an import specifier. `npm run check:bundle` is clean. This is a build-time
check like `check:bundle`, not a unit test, because the chunk graph only exists
after a build.

### Findings

**A 503 takes about four seconds to reach the screen, and that is the retry
policy, not a hang.** The first fault drill looked like a failure: with the team
list down, `/search?q=texas` sat on "Searching…" and the team page on "Loading
team data…". `lib/queryClient.ts` retries any 5xx twice with 1 s + 2 s backoff
(`shouldRetry`), so at 1.2 s the query is genuinely still in flight. Past ~4 s
both render their error with a reference number. A 429 appears **instantly**,
because it is below 500 and never retried — the right asymmetry on a rate
limiter, and worth knowing it is deliberate. Anyone drilling failure states on
this app must wait past the retry budget or they will mistake retrying for
hanging, and will "fix" something that is not broken.

**`SPORTS_PROVIDER_FAULT` is a wrangler var, not a shell variable.** Running
`SPORTS_PROVIDER_FAULT=teams npx wrangler dev` returned a cheerful 200 with
three Texas teams — the *identical symptom* Phase 2 traced to a warm Cache API,
from a completely unrelated cause. Phase 2's remedy (`--persist-to <fresh dir>`)
was already in place and did nothing, because the fault had never reached the
Worker at all. **The check is wrangler's own binding table in its startup
output**: if `env.SPORTS_PROVIDER_FAULT` is not listed there, the drill is not
armed, whatever the shell says. `--var SPORTS_PROVIDER_FAULT:teams` arms it.
Generalising Phase 2's lesson: a fault drill needs the fault to be *reachable*
(a cold cache) **and** *present* (a real binding), and both failure modes look
exactly like success.

**The plan's "an FCS team shows Conference unknown" is true of the results row
and not of the team page.** `TeamPage`'s hero joins `[name, conference]` and
drops the nulls, so Mercer's hero reads "Mercer Bears" with no conference line
at all — Phase 4 behaviour, unchanged and correct. Only the search row
substitutes the words "Conference unknown". Nothing to fix; but **Phase 4's docs
must not promise "Conference unknown" on the team page**, because it is not
there.

**The board placeholder now carries a uuid onto a provider-id URL, briefly.**
Matching `team.id === teamId || team.providerTeamId === teamId` means opening
`/teams/251` for a team that is on a loaded board paints a placeholder whose
`team.id` is our uuid, where the real response a moment later has `null`. It is
harmless only because of Phase 1's finding that **nothing reads `team.id` off
`TeamDetailResponse`** — and this is now the second thing leaning on that fact.
If anything ever does start reading it, `useTeam.ts` and `resolveTeam` are the
two places to fix, together.

**Backtracking over a prefix is free, measured.** `tex` → `te` → `tex` cost one
request and then zero. The Risks table predicted "a realistic search is two to
four requests, and backtracking over a prefix costs none"; that is now observed
rather than argued. The four things that produce it — the 250 ms debounce, the
`trim().toLowerCase()` key, the five-minute `staleTime`, and the route's own
`max-age=300` — are load-bearing together, and removing any one of them would
turn a keystroke back into a Worker request.

**A stale `workerd` does not die when you kill it.** Killing the process
listening on a drill port left another listener there within a second: wrangler
restarts its child. The parent must go too, or — much cheaper — use a port
nothing has touched. This is the third appearance in three phases of the same
family of problem (Phase 1's stale 8787, Phase 2's warm cache, this): **the dev
environment lies in ways that read as success**, and every one of them was
caught by asking for a fact only the new state could produce.

**Two local-environment facts that are not regressions, and will recur.**

- `npm run dev:web` reported "Port 5173 is in use" and landed on **5174**.
  `project-notes.md §11` documents 5173. Read the "Local:" line, exactly as
  Phase 1 said to read the "Ready on" line.
- `npm run smoke` against the local Worker is **17/18**, failing "every card has
  sports data — 3 of 6". California, Army and Central Michigan come back
  `not_found`. This is the mock roster, which is by its own comment "the fifty
  seeded in `supabase/seed.sql`", meeting the live database, which no longer
  holds the seeded boards (project-notes §9: the real nine people replaced them
  on 2026-09-19). Local dev against the live database will always show those
  cards unavailable and smoke will always report 17/18 there. Nothing in Phase 3
  touched the API; the same failure is there at `HEAD`.

**In mock mode every searched team is logo-less and every board team is not,**
now observed rather than predicted (Phase 1 called it). The same team fetched
two ways proves it in one line: `/teams/<uuid>` rendered an `<img>` from
Postgres, `/teams/251` rendered the initials fallback, because mock
`listTeams()` returns `logoUrl: null` for all of them. On a result row the
fallback prints the abbreviation, so a row reads "TEX Texas Longhorns SEC · TEX"
locally and shows a real crest in production. Nobody should file that as a bug.

**For Phase 4, three things this phase fixed in place:**

- The page's landmark is `<form role="search" aria-label="Team search">`. The
  header's must be labelled differently — the plan says "Site search" — or the
  two landmarks are indistinguishable.
- `prefetchViewerPages()` now loads three chunks, not two.
- The page reads `?q=` as the source of truth and yields to any value it did not
  write itself, so `HeaderSearch` can navigate to `/search?q=…` from `/search`
  itself and simply clear its own box, exactly as the plan describes.

---

## Phase 4 — The header control, docs, and ship

### Scope

- **`apps/web/src/components/HeaderSearch.tsx` + `.module.css` (new)** — a
  `<form role="search" aria-label="Site search">` with a visually-hidden label, an
  `<input type="search">`, and a submit button. On submit it navigates to
  `/search?q=…` and clears itself, so the two inputs can never disagree.
- **`AppHeader.tsx` and its CSS** — placed between the wordmark and the nav. The
  row wraps to a second line below about 30rem, so 320 px still fits.
- **`AppHeader.test.tsx`** — the two exact-text assertions become
  `'CFB Board Search Boards'` and `'CFB Board Search Boards Admin'`. Update them
  deliberately: they exist to say "these are the only things in the header". Add
  a case for the `search` landmark and its navigation.
- **Docs** — a "Testing the search on your machine" section in the README,
  following the existing convention (Level A automated, Level B the website,
  Level B2 failure states, Level C the live site); `context/project-notes.md`
  gains the new route, the endpoint, and the quota note; `docs/ops.md` gains the
  route and the crawler note below.
- **Accessibility, across all four phases** — one `<h1>` per page including
  loading and error states; the live region present before results arrive; the
  two `search` landmarks distinctly labelled; 44 px touch targets on the header
  input, its button, and each result row; no sideways scroll at 320 px
  (`min-width: 0` on flex children holding text, `overflow-wrap: anywhere` on
  team names); a plain list, never a combobox.

### Exit criteria

- `npm run verify` green, and `npm run check:bundle` clean after `build:web`.
- The header search is present on home, board, team, `/search`, and admin pages.
- Keyboard only: Tab, type, Enter, Tab into the results, Enter opens a team, and
  back returns with the query intact.
- Deployed, smoke-tested including the two new checks, and opened on a phone.

### Completion notes (2026-09-23)

Built as planned, with **one departure that moves the box**, and one piece of
accessibility work the plan asked for in a sentence and that turned out to
touch five files. `npm run verify` is green: **777 tests in 35 files**, up from
761. No API code was touched in this phase either — every changed file is under
`apps/web/`, plus the four documents.

**The box is after the nav, not between the wordmark and the nav.** The plan
asks for it between them. Built that way, at 320 px it costs a *third* header
row: the box cannot fit beside the wordmark, so it breaks onto line two, and
the nav — which comes after it in the markup — is pushed onto line three. The
only ways to avoid that are to squeeze the input to about 100 px, or to reorder
the row in CSS so that Tab stops visiting things in the order they appear (§48,
and a thing this codebase has been careful about). Putting it last instead
gives, measured in headless Edge:

| | between (as planned) | after the nav (built) |
| --- | --- | --- |
| Header at 320 px and 375 px | 165 px, three rows | **113 px, two rows** |
| One row from | 768 px | **480 px** |
| The input at 320 px | full width | full width |
| Markup order vs visual order | the same | the same |

On a wide screen this reads `CFB Board … Boards [Search teams] [Search]`, with
the nav and the box together at the right; on a phone, the wordmark and nav on
one line and the box across the whole of the next. The admin's extra nav link
adds no row at any width (measured by cloning the link into the live DOM and
re-measuring). The consequence for the plan's other instruction: the two
exact-text assertions are `'CFB Board Boards Search'` and
`'CFB Board Boards Admin Search'`, not the order the plan predicted.

**The submit button carries visible text, and that is what the plan's expected
strings were telling us.** An icon-only button with a visually-hidden label
would have been more compact, but `visibleText` strips visually-hidden spans,
so `'CFB Board Search Boards'` can only be produced by a button that visibly
says "Search". Reading the expected string as a specification rather than as a
detail to update saved a design decision from being made by accident.

**`searchPath(text)` is exported from `HeaderSearch.tsx`,** for the same reason
Phase 3 exported `searchFrom`: navigation never reaches the markup the
string-based tests read. Trimming, encoding and the empty case are asserted
directly, and then one test renders `SearchPage` at `searchPath('texas a&m')`
and checks its input comes back seeded — the header's half and the page's half
of the round trip, joined.

**The accessibility pass found one real gap, outside this feature.** "One `h1`
per page, including loading and error states" was already true of every page
that renders data, and of every page-level `ErrorState` (it defaults to
`headingLevel: 1`). It was **not** true of four page-level waits, all of which
rendered `LoadingNote` alone: `RootLayout`'s Suspense fallback while a page's
chunk downloads, `RequireAdmin`'s two session checks, `LoginPage`'s, and
`BoardEditorPage`'s. `LoadingNote` gained `isPage`, which renders its text as
the page's `h1` inside a `role="status"` wrapper — the wrapper, because
`role="status"` on the `<h1>` would *replace* its heading role rather than add
to it, leaving the page heading-less with nothing to show for the change. The
chunk-download case is the one this feature made reachable from everywhere: the
header links to `/search` from every page.

**Sixteen tests were added**, in three files:

- `AppHeader.test.tsx` (4 → 12): the two exact-text assertions; the `search`
  landmark labelled "Site search" and explicitly *not* "Team search"; a plain
  box and a submit button with no combobox attributes anywhere; the accessible
  name; no autofocus; the box empty whatever the URL says; and the four
  `searchPath` cases including the round trip through `SearchPage`.
- `routes.test.tsx` (new, 3): every page is a child of the one layout route
  that carries the header. This is where "a search box on every page" can
  actually fail — it is structure, not repetition, and a page added outside
  `RootLayout` would have no header and no component test would notice.
- `States.test.tsx` (new, 5): a page-level wait has exactly one `h1` and keeps
  it a heading; an inline wait adds no second one; a page-level failure is an
  alert with an `h1`, and a sectional one steps down to `h3`.

**Four were watched to fail before being kept**, per the Phase 1 rule.
Relabelling the header landmark "Team search" turned the distinct-label test
red; removing the box from `AppHeader` turned six red; moving `role="status"`
onto the `<h1>` turned the live-region test red; moving `/search` out of the
layout route turned two route tests red. All four edits were reverted.

**Checked in headless Edge** (`playwright-core` in the session scratchpad),
against a `wrangler dev` Worker on the mock provider, and then **again against
the production build** served by `vite preview`. **54 checks, both times:**

- The box is present exactly once, and there is exactly one `h1`, on home, a
  board, a board team's page, a searched team's page, `/search`, `/login`,
  `/admin` (turned away), and a URL that does not exist.
- On `/search` there are two `search` landmarks and they carry different
  labels: "Site search" and "Team search".
- Keyboard only: from the skip link, Tab reaches the wordmark, the nav, the box,
  then its button; typing `texas` and pressing Enter opens `/search?q=texas`;
  the header box empties itself and the page's box holds the query; history
  grows by exactly one, so Back returns to the page you searched from; one Tab
  from the page's box lands on the first result and Enter opens it (Texas); the
  back link reads "Search" and returns with `texas` still in the box.
- From `/search` itself: submitting `mercer` in the header box moves the page's
  box, the URL and the results, and the header box empties. An empty submit
  opens `/search` with no `?q=`.
- At 320, 375, 768 and 1280 px: no sideways scroll; the header input and its
  button are 44 px tall and each result row 67.7 px. Header height 113 px on a
  phone, 61 px from 480 px up, unchanged by the Admin link.
- axe (WCAG 2.0/2.1 A and AA): clean on `/search` at 320 and 1280 px, on home,
  a board, a searched team page and the not-found page at 390 px, and on three
  of those again in **dark** mode.

**A forced outage, drilled separately** (`--var SPORTS_PROVIDER_FAULT:teams`,
cold `--persist-to`, binding confirmed in wrangler's startup list): 10 more
checks. Submitting from the header during the outage still navigates; after the
retry budget the page shows "Team information is temporarily unavailable." with
a reference number, under one `h1`, with the query still in the box to edit and
no raw value anywhere; a searched team page fails the same way with a **Try
again**; and the header box is still there to try with.

**At the build.** `npm run build:web` is clean and `npm run check:bundle` lists
only the publishable key. `SearchPage` is still its own 2.99 kB chunk with zero
occurrences of `supabase` or `gotrue`. The header box lands in the index chunk,
as it must — it is on every page — and costs **0.86 kB** there (0.32 kB
gzipped), measured by building once without it (376.62 kB) and once with
(377.48 kB).

`npm run smoke` against the local Worker is **17/18**, failing only "every card
has sports data — 3 of 6". That is Phase 3's recorded local-only mismatch (the
repo's mock roster meeting the live database's real boards), it is there at
`HEAD` too, and no API code changed in this phase.

### The deploy (2026-09-24)

Worker version `051f9871-5347-4127-a82b-33647958e06e`, and a Pages deployment
to the same project. **No configuration changed** — same origin, same KV
namespace, same `ESPN_USER_AGENT` — so it was `docs/ops.md` steps 5 and 7 only,
with no step 8. Numbers are recorded in
[ops.md, "The team search release"](../docs/ops.md#the-team-search-release-2026-09-24).

Checked before deploying, so that "it works" could not be a false positive:
`/api/search/teams?q=texas` and `/api/teams/251` were **404 on the live Worker**
beforehand and 200 after. Phases 1–3 were committed but had never been
deployed, so this release carried all four phases at once.

Afterwards, on real ESPN data:

- `npm run smoke` against both URLs: **20 passed, 0 failed**, including the four
  search checks and both CORS checks, with 6 of 6 cards filled on the board it
  samples.
- `npm run verify:rls`: **44 passed, 0 failed, 0 skipped**, probe rows cleaned
  up. Worth repeating on a release that adds a public route, which is exactly
  what this was.
- The same 54-check browser pass as locally, against the **deployed** site:
  54/54, plus 6 axe scans clean in light and dark at 390 px. `?q=texas` returns
  12 matches on real data rather than the mock's 3, and the header is still
  113 px at 320 px.
- Mercer, end to end: `Conference unknown · MER` on the row, **NR** and a real
  2-2 record and schedule on the page. North Dakota State comes back **Mountain
  West** — Phase 2's finding, still true, still the provider's own answer.
- A warm search from a browser's distance: **~110–120 ms** for `?q=texas` and
  `?q=state` including the network, and the match count does not move it.

**The KV shape Phase 2 predicted, confirmed in production.** Across the whole
verification run — dozens of searches and a good many team pages — that
isolate's ledger read **9 writes: `schedule` 7, `rankings` 1, `prediction` 1,
and zero from `team_list` or `conferences`**, because the cron had already
warmed those. Searching wrote nothing at all; the team pages searching leads to
did all of it. `schedule` is the counter to watch tomorrow.

**Still open, and the owner's:** the site on their own phone, and the 24-hour
usage numbers ([Watching usage](../docs/ops.md#watching-usage)).

### Findings

**A layout constraint can only be settled by measuring it, and it moved the
plan.** "A search box between the wordmark and the nav; the row wraps to a
second line below about 30rem" was written from reasoning and is wrong in one
respect: with the box in the middle of the markup, the row wraps to a *third*
line, because flex packs items onto lines in order and the nav cannot climb
back past the box. Every way of getting two rows with the box in the middle
costs something real — a 100 px input, or a CSS `order` that separates Tab
order from reading order. Moving it after the nav costs only the plan's own
phrasing. Two screenshots and two numbers (165 px, 113 px) decided this in a
couple of minutes; no amount of further reasoning would have.

**The expected string in a test was a design decision in disguise.** The plan
said the header assertions become `'CFB Board Search Boards'`. Taken as a
specification, that sentence rules out an icon-only submit button, because
`visibleText` strips visually-hidden text — the word "Search" can only be there
if the button visibly says it. It would have been very easy to build the icon
button, see the test fail, and "update the expectation". A test the plan writes
in advance is worth reading for what it implies, not only for what it asserts.

**`role="status"` on a heading takes the heading away.** The obvious way to give
a loading page its `h1` is `<h1 role="status">Loading…</h1>`. ARIA roles
replace the implicit role rather than adding to it, so that page has a live
region and *no* heading — the exact thing the change was made to fix, now
invisible because the text looks right on screen and reads right in the markup.
The wrapper (`<div role="status"><h1>…</h1></div>`) is the whole fix, and the
test that pins it was watched to fail against the wrong version.

**An accessibility rule is only checked where it is hardest to reach.** "One
`h1` per page" held on every page that renders data — the states everyone
looks at. The four that failed it were all page-level *waits*: a chunk still
downloading, a session still being checked. They are hard to catch by eye
because they last a few hundred milliseconds, and no test rendered them,
because tests render the interesting states. The pass that finds them is the
one that enumerates page states rather than pages.

**A structural promise needs a structural test.** "The search box is present on
every page" cannot be proved by rendering pages: it is true because every route
is a child of one layout, and it would stop being true the moment someone adds
a route beside that layout rather than inside it. `routes.test.tsx` asserts the
route table's shape, and it was watched to fail by moving `/search` out. Eight
component tests rendering eight pages would have cost more and proved less.

**The dev server measures StrictMode, not what ships.** Checking the tab order
from the top of the home page failed at first: the first Tab landed on a board
card, three focusable elements too far in. `RootLayout` deliberately leaves the
*first* page load alone and focuses `<main>` only after a navigation — but
React's StrictMode double-invokes effects in development, so the first run
clears the `firstRender` guard and the second run focuses `<main>` anyway. The
same script against `vite preview` of the production build reports focus on
`<body>`, which is the documented behaviour. **Anything measured about focus,
effects or timing against `npm run dev:web` should be re-measured against the
build before it is believed.** Both runs are 54/54; only this one line differed.

**`2>&1 | Out-File` on `wrangler dev` produces a Worker that starts and never
answers.** The first attempt at a local Worker printed its whole banner
including `Ready on http://127.0.0.1:8793`, bound the port, and then timed out
on every request — `/api/health`, the search route, everything, via two
different clients. The port was listening and the process was alive. Piping a
native command's merged output through PowerShell 5.1 (which wraps every stderr
line in an ErrorRecord) is what did it; run under the harness's own capture, the
identical command serves immediately. This is the **fourth** appearance in four
phases of the same family — a stale 8787, a warm Cache API, a wrangler that
restarts its child, and now a blocked stdout pipe — and it has the same shape
every time: **the dev environment fails in ways that read as success.** "Ready
on" is not readiness; the only proof is a fact only the running thing can
produce.

**And its cousin, again: a killed `wrangler dev` comes back.** Killing the
workerd holding the port left another listener there within a second, twice.
`taskkill /PID <the node that started it> /T /F` is what actually ends it —
or, as Phase 3 said and this phase then re-learned, use a port nothing has
touched.

**The header box costs 0.86 kB in the chunk every page already downloads**, and
that is the right place for it. Worth stating because the instinct on a
code-split app is to keep things out of the index chunk: a control that is on
every page belongs there, and the number is small enough to end the argument.
`/search` itself stays lazy, its chunk is unchanged at 2.99 kB, and the 225 kB
auth chunk is still behind its own boundary.

---

## Part Two — who has this team (Phases 5–7)

### Context

A search result is identity and nothing else: name, conference, abbreviation.
Search a team that three of the nine boards hold and the results say nothing
about it, and there is no way from a result to a board that holds it.

**What the owner asked for (2026-09-24):** searching a team that somebody has
picked shows who has it, and their name opens their board.

The data is already public and already stored: `user_team_selections` joins
`app_users` to `teams`, all three readable by `anon` (§4 `read_sel`). Nothing new
goes in the database and no migration is needed. The work is one read, one
projection, and one small component used in two places.

### Decisions taken

| Question | Answer |
| --- | --- |
| Where the owners come from | **One endpoint, not the search response.** `GET /api/selections` returns the whole index once; the browser joins it onto results by `providerTeamId` |
| Why not put them on `/api/search/teams` | That route is one keystroke away. Phase 2 pins "no PostgREST request at all" on it, which is what keeps typing free of Postgres latency and of a Postgres outage. The index is one request per page session instead of one per keystroke — and the team page needs the same answer anyway, so a search-only field would be read twice |
| Key | The **provider's** team id. A search result has no uuid, and `PageTeam.providerTeamId` is present on both team-page addresses |
| Naming | The route is named for the table it reads (`/api/selections`); everything downstream is named for the answer it gives (`TeamOwnersResponse`, `api.teamOwners`, `useTeamOwners`, `PickedBy`) |
| Sort order | Display name, ascending — the same order the home page lists people in |
| Board position ("#3 on Wilson's board") | Not shown, and not in the response. Nothing asked for it, and the board itself says it |
| A team nobody picked | Absent from the index, and the row shows no line at all. Most of the ~762 teams are on nobody's board; "Nobody has this team" on every row is noise |
| The admin console's own search | Unchanged. It is for editing boards, and the editor already shows what a board holds |

### The rules this must not break

- **Still no public path writes.** `/api/selections` reads as `anon` through the
  existing read policy. The Phase 1–2 assertion that no PostgREST request is
  recorded at all stays pinned where it was — on `/api/search/teams` and on
  `/api/teams/:providerTeamId` — and must not be relaxed to accommodate this.
- **Owners are garnish (§38, §42).** A search must list teams when the index is
  slow, broken, or not yet loaded. This is the conference map's precedent: it
  degrades, it never fails.
- **Nothing invented.** A name shown next to a team is a row that exists. No
  "probably on someone's board", no counts derived from anything but the index.

---

## Phase 5 — The pick index

**Goal:** `GET /api/selections` answers, for every team on any board, who has it.

### Scope

| File | Change |
| --- | --- |
| `packages/shared/src/api/responses.ts` | Add `TeamOwner` and `TeamOwnersResponse` (below) |
| `apps/api/src/db/rows.ts` | `OwnerSelectionRow`, and `toTeamOwners(rows, namespace)` |
| `apps/api/src/db/queries.ts` | `listTeamOwners(db, namespace)` — one `select`, no filters |
| `apps/api/src/routes/selections.ts` **(new, ~20 lines)** | `GET /`, `public, max-age=300` set **after** the await |
| `apps/api/src/app.ts` | `app.route('/api/selections', selectionRoutes)`, after `/api/users` |
| `apps/api/test/helpers/supabase-stub.ts` | `selections?: unknown[]`, answering `GET /rest/v1/user_team_selections` |
| `scripts/smoke.mjs` | Two checks (below) |

```ts
// packages/shared/src/api/responses.ts
/** Someone whose board holds a team. `userId` addresses `/u/:userId`. */
export interface TeamOwner {
  userId: string;
  displayName: string;
}

/**
 * Every board's picks, inverted: PROVIDER team id → who has that team, sorted
 * by display name. Keyed by the provider's id because that is the id a search
 * result carries and the one id both team-page addresses share; our uuid exists
 * only for a team we store. A team nobody picked is absent, not an empty array.
 */
export interface TeamOwnersResponse {
  owners: Record<string, TeamOwner[]>;
}
```

```ts
// db/queries.ts — identity only (§45). No order param: see "Watch out for".
export async function listTeamOwners(
  db: PostgrestClient,
  namespace: ProviderName,
): Promise<Record<string, TeamOwner[]>> {
  const rows = await db.select<OwnerSelectionRow>('user_team_selections', {
    select: 'app_users(id,display_name),teams(provider,provider_team_id)',
  });
  return toTeamOwners(rows, namespace);
}
```

`toTeamOwners` drops a row whose embed is `null`, exactly as `toSelections` does
(an orphan should be impossible under `on delete restrict`, and half an owner is
worse than none), drops a row whose `teams.provider` is not `namespace`, and
sorts each list by `displayName` then `userId`. No de-duplication: `unique
(user_id, team_id)` means one row per person per team.

The route takes the namespace from `servicesFor(c).provider.teamNamespace`, as
`routes/admin.ts` already does for `storedTeam`.

### Exit criteria

- 200 with no token: no JWKS fetch, **exactly one** PostgREST request, its
  `authorization` null, and `Cache-Control: public, max-age=300`.
- **No ESPN request at all**, and `SPORTS_PROVIDER_FAULT=teams` still answers
  200. This route is app-owned data and must not depend on the provider.
- A team on two boards lists both, alphabetically. A team on no board is absent
  from `owners`. An empty database is `{"owners":{}}` at 200, not a 404.
- A row from another provider's namespace is dropped; a row with a null
  `app_users` or `teams` embed is dropped and the others survive.
- Database unreachable → a clean 5xx with a request id and **no**
  `Cache-Control`. Same for a Worker with no database configured.
- `/api/selections` spends the per-address read budget and 429s with
  `Retry-After` (it is under `/api/*`).
- Added to `ops.test.ts`'s "every public read sets Cache-Control" list.

### Watch out for

- **Set the header after the await.** Phase 2's finding: a lifetime set on the
  context is merged into the error handler's response too, so setting it up
  front pins a 503 in every browser for five minutes. There is a test for the
  ordering on the search route; write the same one here.
- **No server-side cache, deliberately.** `/api/users` has none either: app-owned
  data carries no freshness envelope (§45) and KV is for provider data. If this
  ever becomes the constraint, the pattern is an L1 entry plus `tiers.evictL1`
  on the admin write, as the board composite does — not KV.
- **Do not order by an embedded column** (`order=app_users(display_name).asc`).
  PostgREST's support for it varies by version; sort in `toTeamOwners`, as
  `toSelections` already sorts defensively.
- **No pagination.** Nine boards of six is 54 rows, and the schema's ceiling is
  24 per board, so 216 for these nine — well inside any row cap PostgREST is
  configured with (Supabase's is 1,000 where it is set at all; check
  `/api/selections` against the live project rather than assuming). Past roughly
  150 boards this route needs a limit, and that is a different plan.
- The stub returns `options.appUsers` for *any* `GET /rest/v1/app_users`
  regardless of the `select`, which is why this query reads the selections table
  instead: a new stub path, so an owner-index test and a `/api/users` test can
  share one stub without their row shapes colliding.
- **`refreshPublic` is Phase 6's job.** Until then an administrator's own
  browser can hold a five-minute-stale index after a board change.

### Smoke checks

- `/api/selections` is 200, `public, max-age=300`, and every `userId` in it
  appears in `/api/users` (self-consistent whatever data the project holds).
- The board the script already samples: every team on it appears in the index
  with that board's owner among its names.

### Completion notes (2026-09-24)

Built exactly as planned — every file in the Scope table, no additions and no
departures. `npm run verify` is green: **788 tests in 35 files**, up from 777.
The route is 12 lines of handler and the projection is 20 lines; everything
else it needs was already there.

**Eleven tests were added**: ten in `apps/api/test/board.test.ts` beside the
public-search block, one in `ops.test.ts` (the read budget), plus
`/api/selections` on `ops.test.ts`'s "every public read sets Cache-Control"
list. They cover every exit criterion — one anonymous PostgREST request and no
JWKS fetch; the five-minute lifetime; no provider call at all and a 200 with
`SPORTS_PROVIDER_FAULT=teams`; a shared team listing both names alphabetically;
an unpicked team absent rather than empty; an empty database as
`{"owners":{}}` at 200; a foreign namespace and a broken embed dropped while
the rest survives; a Postgres failure as a clean 5xx with a reference number
and no `Cache-Control`; the unconfigured Worker saying so and still not
caching it; and zero KV writes however often the index is read.

**Five were watched to fail before being kept**, per the Phase 1 rule. Moving
`c.header('Cache-Control', …)` above the await turned *both* error-lifetime
tests red (`expected 'public, max-age=300' not to match /max-age/`); deleting
the namespace filter in `toTeamOwners` turned the dropped-row test red;
deleting its sort turned the alphabetical test red (Wilson before Jordan, the
order the rows arrive in); adding a `provider.listTeams()` call to the route
turned the provider-down test red (503, not 200); exempting `/api/selections`
in `rate-limit.ts` turned the budget test red. All five edits were reverted.

**The stub's new `selections` option, and why it is not `appUsers`.** The
plan's reasoning held in practice: `installSupabaseStub` answers `appUsers` for
*any* `GET /rest/v1/app_users` whatever the `select` asked for, so an
owner-index row shape and a `/api/users` row shape would collide in any test
that used both — and the `ops.test.ts` Cache-Control table is exactly such a
test. Reading `user_team_selections` from its own end keeps them apart.
`test/helpers/boards.ts` gained `ownerRow` and `ownerRows`, which build the
embedded shape from the same seeded boards the rest of the suite uses.

**Checked by hand against `wrangler dev`** on the mock provider and the live
database, on a port nothing had touched and a cold `--persist-to`:

- `/api/selections` is 200, `public, max-age=300`, 54 teams picked, ~136 ms
  cold. Nine boards of six: the 54 picks sum exactly to the nine `teamCount`s
  that `/api/users` reports, and every `userId` in it is one of those nine.
- **Every one of the 54 board picks appears in the index under the right
  name** — checked board by board, 54 of 54, which is the smoke check's
  assertion run over all nine rather than one.
- A searched team and its board twin share the index key: `/teams/<uuid>` and
  `/teams/251` give `providerTeamId: '251'` with `team.id` a uuid and `null`
  respectively, and `'251'` is the key the index uses.
- Three mock teams (Arizona State, Michigan State, NC State) are on nobody's
  board and are absent from `owners`, so Phase 6's no-line case is reachable
  locally.
- **Twelve index reads wrote nothing to KV** — the ledger read
  `{season_calendar:1, rankings:1, schedule:39, conferences:1, team_list:1}`
  before and after, unchanged. That is Phase 7's "no new category" criterion,
  already true.
- The read budget: a parallel burst of 200 from one address gave 126 allowed
  and 74 refused with `Retry-After: 1` and no `Cache-Control`; a second address
  was unaffected.

**Two fault drills, each on its own Worker with the binding confirmed in
wrangler's startup table** (the Phase 3 rule — a fault that is not in that
table is not armed):

- `--var SPORTS_PROVIDER_FAULT:teams` — `/api/selections` answers **200 with
  all 54 teams** while `/api/search/teams` and `/api/teams/251` are both 503
  "Team information is temporarily unavailable.". App-owned data does not
  depend on the provider, demonstrated rather than asserted.
- `--var SUPABASE_URL:http://127.0.0.1:9` — `/api/selections` is a 500,
  `internal`, "The application database is temporarily unreachable.", its
  `requestId` equal to `X-Request-Id`, and **no `Cache-Control` at all**.
  `/api/search/teams` answers 200 in the same breath: Phase 2's "no PostgREST
  request" guarantee is still what keeps typing alive through a Postgres
  outage.

`npm run smoke` against that Worker is **21 passed, 1 failed** — all four new
checks green, and the one failure is Phase 3's recorded local-only mismatch
("every card has sports data — 3 of 6": the repo's 50-team mock roster meeting
the live database's real boards). It is there at `HEAD` too, and no code on the
board path changed in this phase.

### Findings

**The nine real boards share no teams at all.** 54 picks, 54 distinct teams,
every list in the index exactly one name long. The plan's worked example
("a team three of the nine boards hold") does not exist in production, and the
shared-team case — the one that needs sorting, and the only one where `Picked
by` names more than one person — **cannot be seen by hand on this data**. It is
covered by the test that pins Alabama on both seeded boards, which is now the
only place it is exercised. Two consequences for Phase 6: do not expect to
verify the alphabetical order in a browser, and do not let the multi-name CSS
go unstyled because every screen shows one chip.

**A five-minute cache on a public route is a decision about outages, not about
load.** The lifetime itself is uncontroversial (`/api/users` has had it since
Phase 5 of the original plan). What is load-bearing is that the header is set
*after* the await, and the reason is the same on this route as on the search
route: Hono merges a header set on the context into the error handler's
response too, so the ordering decides whether a browser pins a failed read for
five minutes on a page whose only recovery is a reload. Writing the second
instance of this made the shape clear — **any route that sets a lifetime and
can fail needs the ordering test, and the success path cannot distinguish
them.** There are now two such routes and two such tests.

**`toProviderName` was already the right filter, and using it avoided a bug the
plan did not flag.** The `teams.provider` column is `text`, so a row could say
anything; `toTeamOwners` compares `toProviderName(row.provider)` rather than
the raw string, which is the same normalisation `toTeam` applies. Comparing
raw strings would have dropped nothing today (the live rows all say `espn`) and
would have quietly diverged from the rest of the codebase the first time a row
said something else.

**The mock provider's `teamNamespace` is what makes this work locally at all.**
It reports `espn`, because its roster borrows ESPN's ids, so a mock-mode Worker
reading the live database's `espn` rows keeps all 54. Had it reported `mock`,
the namespace filter would have emptied the index in local development and the
route would have looked broken while being exactly right. Worth knowing before
anyone "fixes" the filter after seeing `{"owners":{}}`.

**The dev environment lied again, in its established way, and the established
remedy worked.** Killing the three drill Workers left all three ports listening
within seconds, under new pids — wrangler restarting its child, for the third
time across five phases. `taskkill /PID <the node running wrangler-dist/cli.js>
/T /F` is what actually ends it; killing the `workerd` alone never does. The
ports were confirmed free with `netstat` afterwards rather than assumed.

---

## Phase 6 — "Picked by" on the search results

**Goal:** a result for a picked team names the boards that hold it, and each
name opens that board.

### Scope

| File | Purpose |
| --- | --- |
| `apps/web/src/lib/api.ts` | `api.teamOwners(signal)`; `queryKeys.owners = ['owners']` — **not** under the `'admin'` prefix; `/api/selections` added to `publicPathsFor` **and** to the `userId === null` path list in `useAdminWrite.ts` |
| `apps/web/src/lib/useTeamOwners.ts` **(new)** | The query, and a lookup: `(providerTeamId) => readonly TeamOwner[]`. In `lib/` because Phase 7 uses it from a second feature |
| `apps/web/src/components/PickedBy.tsx` + `.module.css` **(new)** | The line itself. Renders `null` for an empty list |
| `apps/web/src/features/search/SearchPage.tsx` + `.module.css` | `ResultRow` restructured around the nested-link problem; `PickedBy` under the top line |
| `apps/web/src/features/admin/useAdminWrite.ts` | Also invalidate `queryKeys.owners` after a write |
| `apps/web/src/test/fixtures.ts` | `ownersResponse(...)` builder |

```ts
// lib/useTeamOwners.ts
const NONE: readonly TeamOwner[] = [];

/**
 * Who has each team, by provider team id. Loading and "nobody has it" are the
 * same answer on purpose: both render nothing, so a slow or failed index costs
 * the page nothing (plan Part Two, "owners are garnish").
 */
export function useTeamOwners(): (providerTeamId: string) => readonly TeamOwner[] {
  const { data } = useQuery({
    queryKey: queryKeys.owners,
    queryFn: ({ signal }) => api.teamOwners(signal),
    staleTime: 5 * 60_000,
  });
  return (providerTeamId) => data?.owners[providerTeamId] ?? NONE;
}
```

**The copy, exactly** — it is the same string in both phases, and the tests
assert it: the label is `Picked by`, each chip's text is the display name, and
each chip's `aria-label` is `` `${displayName}'s board` ``. Names are separated
by CSS, not by a character in the markup.

```tsx
// components/PickedBy.tsx
<p className={styles.pickedBy}>
  <span className={styles.label}>Picked by</span>
  {owners.map((owner) => (
    <Link
      key={owner.userId}
      to={`/u/${owner.userId}`}
      className={styles.chip}
      aria-label={`${owner.displayName}'s board`}
    >
      {owner.displayName}
    </Link>
  ))}
</p>
```

```tsx
// SearchPage.tsx — the row is no longer one link (see "Watch out for").
<li key={team.providerTeamId}>
  <div className={styles.row}>
    <Link to={`/teams/${team.providerTeamId}`} state={state} className={styles.rowMain}>
      … logo, name, meta, exactly as now …
    </Link>
    <PickedBy owners={owners} />
  </div>
</li>
```

`.row` becomes the card (border, radius, background, hover); `.rowMain` becomes
the 44 px flex line, and the hover rule becomes `.rowMain:hover .rowName`.

### Exit criteria

- A result for a team on one board reads `Picked by Wilson`, and `Wilson` is
  `href="/u/<userId>"`. Two boards list both, alphabetically. A team on no board
  renders no line, no label, and no empty element.
- **No link nests inside another**: the markup contains no `<a` inside an open
  `<a>`, and the team link's accessible name is unchanged from Phase 3
  ("Alabama Crimson Tide, SEC · ALA").
- The index still loading, or failed, leaves the results list complete, with no
  owner line and **no error shown**. Proved with the index query in an error
  state and the search query succeeding.
- One index request per page, not one per keystroke: typing three more letters
  issues search requests only.
- Every state renders with no `undefined`, `NaN` or `null` (`RAW_VALUE`), and
  there is still exactly one `h1`.
- A result still opens by provider id, and its back link still reads "Search".
- 320 px: no sideways scroll with a 70-character team name and three owners.

### Watch out for

- **The nested link is the whole shape of this phase.** Phase 3 made the entire
  row one `<Link>` for the tap target. An owner link inside it is invalid HTML
  and two targets fighting for one click. Shrinking the link to the top line and
  putting `PickedBy` beside it inside the card is what keeps both: a 44 px row
  for the team, and real links for the names.
- **Target size.** The team row keeps `min-height: 44px`. Each chip gets
  `min-height: 32px` and `padding: 0 var(--space-2)` — above the 24 px minimum,
  and never a bare word inside a running sentence.
- **`aria-label` must contain the visible text** (2.5.3 label in name).
  `Wilson's board` contains `Wilson`; `Open board` does not.
- **Two independent queries, never one.** Do not gate the results on the index
  with `enabled`, `Promise.all`, or a combined `queryFn`. A slow index must not
  delay a search by a millisecond.
- `queryKeys.owners` stays out of the `'admin'` prefix: signing out sweeps that
  prefix, and a viewer's index is not the admin's. Same trap as
  `queryKeys.search`.
- **Prime and invalidate after an admin write**, or the administrator who just
  moved a team sees the old index in their own browser for five minutes.
  `/api/selections` goes in `publicPathsFor` *and* in the `userId === null`
  branch, because a rename changes names in the index too.
- Keep `<li key={team.providerTeamId}>`. The owners do not belong in the key.
- In local development the site's boards are the live database's real nine
  people, while `supabase/seed.sql` is nine placeholders (project notes §9). Do
  not treat a local search whose results name unfamiliar people as a bug.

### Completion notes (2026-09-25)

Built as planned, with one small change to the plan's own markup (a space,
below) and one file the plan did not ask for. `npm run verify` is green:
**809 tests in 37 files**, up from 788 in 35. No API code was touched — Phase 5
built everything the server side needed, and every changed file is under
`apps/web/`.

**The files.** `lib/api.ts` (`api.teamOwners`, `queryKeys.owners`,
`PUBLIC_INDEX_PATHS`), `lib/useTeamOwners.ts` (new), `components/PickedBy.tsx`
+ `.module.css` (new), `features/search/SearchPage.tsx` + `.module.css`
(`ResultRow` restructured), `features/admin/useAdminWrite.ts`, and
`test/fixtures.ts` (`makeOwner`, `ownersResponse`). Three test files: the new
`components/PickedBy.test.tsx` and `features/admin/useAdminWrite.test.tsx`, and
additions to `SearchPage.test.tsx` and `lib/api.test.ts`.

**Three departures from the plan's Scope.**

- **`PUBLIC_INDEX_PATHS` is one exported constant, not two lists.** The plan
  says `/api/selections` goes in `publicPathsFor` *and* in the
  `userId === null` branch of `useAdminWrite.ts`. Written as two literals they
  would drift the first time a third such read appears, and the failure would
  be silent (an administrator seeing their own stale index). `publicPathsFor`
  now spreads the constant and the `null` branch passes it, so "the reads any
  write makes stale" exists once.
- **There is a real space character between the names**, which the plan's
  markup does not have. "Names are separated by CSS, not by a character in the
  markup" is right about punctuation and wrong about whitespace: CSS `gap` puts
  no space in the *text*, so `<span>Picked by</span><a>Wilson</a>` reads and
  copies as "Picked byWilson". Each chip is preceded by a `{' '}` text node,
  which a flex container does not render as an item (a whitespace-only
  anonymous flex item is not rendered), so the layout is unchanged and the
  sentence is a sentence. Caught by asserting the whole rendered line, not the
  presence of its pieces.
- **`useAdminWrite.test.tsx` is new.** `useAfterAdminWrite` had no test at all,
  and Phase 6 adds a third thing for it to get right. The hook's callback is
  captured out of a `renderToStaticMarkup` render and then called, which is
  what a button press does; `fetch` is stubbed and the assertion is on the
  URLs re-fetched and on `isInvalidated`.

**`.row` is now the card and `.rowMain` the link**, exactly as the plan
describes. The hover highlight stays on the card (so hovering a name highlights
the card too, which is fine and is what the plan asked for); the underline rule
is `.rowMain:hover .rowName`.

**Twenty-one tests were added**: 12 in `SearchPage.test.tsx` (exits 5–8), 5 in
`PickedBy.test.tsx`, 2 in `useAdminWrite.test.tsx`, and 5 in `lib/api.test.ts`
(minus one merged). They cover every exit criterion — the one-board line and
its `href`; two names in the index's order; no line and no empty element for an
unpicked team; no nested `<a>`; the team link's inner markup identical to the
same row rendered without owners; a failed index and a loading index each
leaving the results complete, silent and alert-free; one `h1` and no raw value
in all of those; one index cache entry across three different queries; the
constant key surviving the sign-out sweep; and both halves of the admin refresh.

**Six were watched to fail before being kept**, per the Phase 1 rule.

| The edit | What went red |
| --- | --- |
| `SearchPage` stops calling `useTeamOwners` | exits 5, 6 and **8** — 5 tests |
| `PickedBy` moved inside the team `<Link>` | both exit 6 tests |
| `useTeamOwners` invents an owner for an empty answer | both exit 7 tests, and exit 2's link count |
| `PickedBy` renders an empty `<p>` instead of `null` | "renders nothing at all" |
| `queryKeys.owners` moved under the `'admin'` prefix | the sweep test and exit 8 |
| `/api/selections` removed from `PUBLIC_INDEX_PATHS`, then the `owners` invalidation removed | the two `useAdminWrite` tests and the path test |

All six were reverted and the suite is green.

**Checked in headless Edge** (`playwright-core` from an earlier session's
scratchpad) against the **production build** served by `vite preview`, proxying
to a `wrangler dev` Worker on the mock provider and the live database, on a
port nothing had touched with a cold `--persist-to`. **33 checks, all green:**

- `/search?q=texas`: Texas reads **"Picked by Axel"**, the name is
  `href="/u/41fc1d7f-…"`, its `aria-label` is `Axel's board` and contains the
  visible text, and the chip is 32 px tall. `document.querySelectorAll('a a')`
  is **0**. Playwright's `ariaSnapshot()` of the team link is
  `link "Texas Longhorns SEC · TEX"` — Phase 3's accessible name, unchanged,
  with no owner in it. One `h1`, no raw value, axe clean at 1280 px.
- `/search?q=state`: 8 rows, **3 of them with no line at all** (mock teams 9,
  127 and 152 are on nobody's board) and no empty element left behind.
- Typing `alaba` then `ma`: **one** `/api/selections` and two
  `/api/search/teams`. Alabama reads "Picked by Eli".
- Keyboard only: from the page's box, Tab reaches the team line and a second
  Tab reaches "Axel's board"; Enter opens `/u/41fc1d7f-…` and the board's own
  `h1` is Axel; Back returns to `/search?q=texas` with the query still in the
  box.
- 320 px with a 70-character team name and three owners injected into the live
  DOM: **no sideways scroll** (320 = 320), three chips at 32 px, the team line
  still a 44 px target, the card 146 px tall, axe clean. Axe also clean at
  390 px in **dark** mode.
- `/api/selections` aborted at the browser and left past the retry budget
  (5 s): 3 rows still listed, **0 owner lines, 0 alerts**, the status line
  still "3 teams found.", one `h1`, no raw value.
- The **home page asks for nothing**: no `/api/selections` request on `/`. And
  within one document, search → a board → Back asks for the index once, not
  twice.

**At the build.** `npm run build:web` is clean, `npm run check:bundle` lists
only the publishable key. `SearchPage` is **3.69 kB** (1.84 kB gzip), up from
2.99 kB, with `supabase` and `gotrue` still appearing **zero** times; its
stylesheet is 2.28 kB. The index chunk is 377.57 kB and holds `/api/selections`
(it is in `lib/api.ts`). `PickedBy` and `useTeamOwners` are in the *SearchPage*
chunk for now, because only one page imports them — Phase 7 is what moves them
into the index chunk, and these are the two numbers to measure that against.

`npm run smoke` against the local Worker is **22 passed, 2 failed**, both
environmental: Phase 3's recorded "every card has sports data — 3 of 6" (the
repo's mock roster meeting the live database's real boards, present at `HEAD`),
and "CORS allows http://localhost:4179", which is the preview port not being in
the Worker's `ALLOWED_ORIGINS` — the browser pass never needed CORS, because
vite proxies `/api` on the page's own origin.

### Findings

**CSS `gap` is not a space, and the markup is what gets read and copied.** The
plan's `PickedBy` puts the label and the names in a flex row and lets `gap`
separate them. On screen that is right; in the text it is not, and the two are
different documents. `<span>Picked by</span><a>Wilson</a>` has no whitespace
between the elements, so the paragraph's text content — what a screen reader
reads for the line, and what a person gets when they select and copy it — is
"Picked byWilson". The fix is one `{' '}` per chip. What found it was writing
the assertion as the whole sentence (`'Picked by Jordan Wilson'`) rather than
as `toContain('Jordan')`: the second spelling passes against the broken
version. **Assert the line a person reads, not the pieces it is made of.**

**An assertion of absence needs a counterfactual that makes something appear.**
The exit-7 tests — a failed index leaves the results complete and silent —
stayed green when `useTeamOwners` was removed from the page entirely, which is
exactly the class of false pass Phase 1 warned about. They only went red
against a `useTeamOwners` that invents an owner for an empty answer. The rule
that falls out: for a test that says "nothing appears", the edit that proves it
must make something appear, and an edit that removes the feature proves a
*different* test. Both counterfactuals are recorded in the table above so the
next person does not have to re-derive which proves which.

**`useQuery` registers its key in the query cache during
`renderToStaticMarkup`**, and that is what makes "one index request per page,
not one per keystroke" testable at all in this suite. Rendering the page at
three different `?q=` values against one client leaves three `['search', …]`
entries and exactly one `['owners']` entry. It is a structural proof rather
than a request count — no fetch happens in SSR — but it fails for the right
reason: removing the hook turns it red, and so does putting the key under the
`'admin'` prefix.

**A link's accessible name cannot be read off the markup string, and two
different tools were needed.** `textContent` of the team link gives
`TEXTexas LonghornsSEC · TEX`: the initials fallback is `aria-hidden` (so a
browser drops it) and the name and meta spans are grid items (so a browser puts
a boundary between them). Neither fact is visible to a regex. The unit test
therefore compares the link's *inner markup* against the same row rendered with
no owners — "unchanged from Phase 3" stated as an identity, which is what the
criterion actually means — and the browser pass asks Playwright for
`ariaSnapshot()`, which answers `link "Texas Longhorns SEC · TEX"`. **When a
criterion is about what a browser computes, pin the invariant in the unit test
and the value in the browser.**

**A `goto` is a fresh query cache; only SPA navigation is a "page session".**
The first version of the one-request-per-page check went `/` → `/search` →
Back → Forward and read **two** `/api/selections`, which looked like a bug in
the hook. Both of those history steps crossed documents, because each `goto` is
a full load, and each full load builds a new `QueryClient`. Clicking a link and
pressing Back — one document, the router navigating — reads one. The claim in
the plan ("one request per page session") is about a document's lifetime, and
the measurement has to be too. Phase 7 will measure the same thing on the team
page and will hit this on the way.

**A broken index is invisible, which is the design and also the risk.** The
drill (`route.abort` on `/api/selections`, then five seconds for the two
retries) produces a page indistinguishable from "nobody picked any of these
teams": 3 rows, 0 lines, 0 alerts, the status line unchanged. That is the
behaviour Part Two asked for — owners are garnish — but it means no one will
ever notice the index is down by looking at the site. The only signals are the
Worker's own logs and `/api/health`; nothing on the page will ever say so, and
Phase 7's documents should say that plainly rather than leaving it implied.

**The nine real boards still share no teams, so the multi-name case has to be
manufactured to be seen.** Phase 5 found it; Phase 6 confirms it in the
browser. Every owner line on real data is one name long, so the wrap behaviour,
the gap between chips and the 320 px measurement were all taken against three
chips injected into the live DOM. With a 70-character team name and three
owners the card is 146 px tall at 320 px and nothing scrolls sideways. Anyone
"simplifying" the CSS after seeing only single-name lines on screen should
re-run that injection before believing it is unused.

**Only the page that uses it asks for it — today.** The home page makes no
`/api/selections` request, and neither does a board. That is worth writing down
because Phase 7 changes it: the team page will ask too, and a cold
`/teams/251` opened from outside the app becomes one extra small Postgres read
where today it is none. Arriving from a search still costs nothing, since the
index is already in the query cache.

---

## Phase 7 — The team page, docs, and ship

**Goal:** the same line on a team's own page, then ship the feature.

### What Phase 6 leaves in place

Everything the team page needs already exists; Phase 7 adds two lines to
`TeamPage.tsx` and then does the documents and the deploy.

```tsx
import { PickedBy } from '../../components/PickedBy';
import { useTeamOwners } from '../../lib/useTeamOwners';

const owners = useTeamOwners();          // (providerTeamId) => readonly TeamOwner[]
<PickedBy owners={owners(identity.providerTeamId)} />   // renders null when empty
```

- `useTeamOwners()` is the whole query: key `queryKeys.owners` (`['owners']`,
  constant, outside the `'admin'` prefix), `staleTime` five minutes, no error
  surface of any kind. Two callers share one request per document.
- `PickedBy` takes `readonly TeamOwner[]` and nothing else, renders `null` for
  an empty list, and carries its own CSS. The copy, the `/u/:userId` links and
  the `` `${displayName}'s board` `` labels are pinned in
  `components/PickedBy.test.tsx`, so Phase 7 need not re-test them — only that
  the hero renders the component with the right team's owners, by **both**
  URLs.
- The admin refresh is done: `/api/selections` is in `PUBLIC_INDEX_PATHS` and
  `queryKeys.owners` is invalidated after every write, both branches.
- `PickedBy` and `useTeamOwners` are currently inside the `SearchPage` chunk
  (3.69 kB; the index chunk is 377.57 kB). A second importer is what moves them
  into the index chunk, which is the measurement this phase's criterion asks
  for.

### Scope

- **`apps/web/src/features/team/TeamPage.tsx`** — `<PickedBy owners={owners(identity.providerTeamId)} />`
  **inside the hero `Card`**, between the `.hero` block and `.heroFooter`. Not
  between the hero and the live score: §11 and §51 put a game in progress before
  everything else, and this is identity, so it belongs in the identity card.
  Keyed on `providerTeamId`, never on `team.id`, which is `null` for a searched
  team.
- **Docs** — a "Testing who has a team" section in the README, following the
  existing convention (Level A automated, Level B the website, Level B2 failure
  states, Level C the live site); `context/project-notes.md` gains the route in
  its public surface (§2), the one-read-per-page-session note (§4), and the
  staleness note (§9); `docs/ops.md` gains the route and the release record.
- **Accessibility** — one `h1` per page unchanged in every state; the chips in
  reading order (they follow the team link in the markup, which is where they
  are on screen); axe (WCAG 2.0/2.1 A and AA) on `/search` and on a team page at
  320 px and 1280 px, light and dark.
- **Ship** — deploy the Worker and the site, `npm run smoke` against both,
  `npm run verify:rls` (a release that adds a public route, exactly as Phase 4
  was), and read the KV counter.

### Exit criteria

- A team on a board shows `Picked by …` in its hero by **both** URLs — the uuid
  a board card links to and the provider id a search result links to. A team on
  no board shows nothing, and the hero is unchanged from Phase 4.
- `npm run verify` green; `npm run check:bundle` clean after `build:web`.
- The `/search` chunk still contains `supabase` and `gotrue` zero times.
  `useTeamOwners` and `PickedBy` land in the index chunk, because two pages use
  them — measure the cost the way Phase 4 measured the header box (build once
  without, once with).
- Keyboard only: from a result, Tab to an owner chip, Enter opens that board,
  and browser Back returns to the results with the query intact.
- The KV write ledger gains **no new category**: this feature makes no provider
  call. Confirm before and after a dozen searches.
- Deployed, smoke green including Phase 5's two checks, `verify:rls` 44/44.

### Watch out for

- **One more request on a deep-linked team page.** Arriving from a search costs
  nothing (the index is already in the query cache); a cold `/teams/251` costs
  one small Postgres read. Do not reach for it inside `useTeam`'s placeholder
  path — it is a separate query with its own lifetime.
- **Do not promise the line on every team page** in the documents. Most of the
  ~762 teams are on nobody's board, which is the normal case, not a failure.
- Phase 3's four-second retry budget applies here too: a failing index retries
  twice before settling. It renders nothing throughout, so the symptom is the
  absence of a line, not a spinner — which is correct, and is also why a broken
  index is easy to miss. Drill it deliberately (`restFailure` in tests, and the
  database blocked in the browser pass).

### Completion notes (2026-09-25)

Built as planned. `npm run verify` is green: **821 tests in 37 files**, up from
809. The code is what the plan said it would be — two lines in `TeamPage.tsx`,
an import each for `PickedBy` and `useTeamOwners`, and nothing else. **No CSS
was written**: the hero card is already a grid with a `--space-4` gap, so the
line spaces itself, and the measurements below confirm that rather than assume
it. `git diff --stat` before the documents was two files, both under
`apps/web/`, +196 lines — 17 of them the page, 179 the tests.

**Twelve tests were added**, all in `TeamPage.test.tsx`, in four `describe`s
matching the exit criteria: the line by both addresses and read by the
provider's id rather than the uuid; two boards named in the index's order; the
hero of an unpicked team asserted as an *identity* against the same page
rendered with no index at all; the placement inside the identity card with a
game in progress still ahead of everything below the card; a failed and a
still-loading index each leaving the page whole and silent; and one `['owners']`
entry however many team pages a document opens, shared with the search page.

**Four were watched to fail before being kept**, per the Phase 1 rule, and the
counterfactuals are recorded because Phase 6 found that which edit proves which
test is not obvious:

| The edit | What went red |
| --- | --- |
| `PickedBy` keyed on `identity.id ?? ''` instead of `providerTeamId` | 5 — both address tests, the uuid-keying test, the two-board test, and the placement test |
| `PickedBy` moved out of the `Card`, above the live score | 1 — the placement test, and only that |
| `useTeamOwners` invents an owner for an empty answer | 4 — **both** exit-3 silence tests, the uuid-keying test, and the Phase-4 hero identity |
| `useTeamOwners` removed from the page | 5 — the address and two-board tests, placement, and the one-key-per-document test |

The third of those is the one that matters: removing the feature leaves the
silence tests green, so only an edit that makes something *appear* proves them.
The fourth row's other test — the search page and the team page sharing one key
— deliberately stayed green under it, because `SearchPage` registers the key on
its own; the first test in that describe is what pins the team page asking at all.

**The plan's chunk prediction was wrong, and the real answer is better.** The
criterion says `useTeamOwners` and `PickedBy` "land in the index chunk, because
two pages use them". They do not: Rollup gives a module shared by two *lazy*
chunks its own shared chunk, because the entry chunk never imports it. Measured
the way Phase 4 measured the header box, building once without the team page's
use and once with:

| | without (Phase 6) | with (Phase 7) |
| --- | --- | --- |
| Index chunk | 377.57 kB (120.34 gzip) | **377.65 kB** (120.37 gzip) |
| `SearchPage` chunk | 3.69 kB (1.84 gzip) | **3.19 kB** (1.63 gzip) |
| `SearchPage` stylesheet | 2.28 kB | **1.73 kB** |
| `TeamPage` chunk | 16.58 kB | **16.68 kB** |
| Shared `useTeamOwners` chunk | — | **0.71 kB** (0.47 gzip) + 0.55 kB CSS |

So the index chunk grew 0.08 kB, not by the size of the component, and a
visitor who opens only the home page or a board downloads none of it. `/search`
costs 3.19 + 0.71 = 3.90 kB against 3.69 kB before — 0.21 kB for the module
boundary. `supabase` and `gotrue` appear **zero** times in all three of
`SearchPage`, `TeamPage` and the new shared chunk, and `npm run check:bundle`
lists only the publishable key.

**Checked in headless Edge** (`playwright-core` from an earlier session's
scratchpad) against the **production build** served by `vite preview`, proxying
to a `wrangler dev` Worker on the mock provider and the live database, on a port
nothing had touched with a cold `--persist-to`. **43 checks, all green:**

- `/teams/251` (the provider id a search result opens) and
  `/teams/0a974681-…` (the uuid a board card links to) both read **"Picked by
  Axel"**, with `href="/u/41fc1d7f-…"`, `aria-label="Axel's board"` containing
  the visible text, a 32 px chip, one `h1`, zero `a a`, and no raw value.
- `/teams/9` (Arizona State, on nobody's board): **no line, and no empty
  element** in the hero. The hero is what Phase 4 left.
- The line is inside the hero card and precedes its footer, which still reads
  "2026 season, week 6 · Last updated: …"; and on a team with a game in
  progress the live block still starts below the whole card (hero bottom 369,
  live top 389), so §11 and §51 are untouched.
- 320 px: no sideways scroll (320 = 320). With **three names and a
  58-character team name injected into the live DOM** — Phase 5's finding that
  the real boards share no teams, so this case has to be manufactured — still
  no sideways scroll, all three chips 32 px, the card 473 px tall, and the line
  reading "Picked by Axel Bartholomew Christabel" as a sentence.
- Requests: a cold deep-linked team page asks for the index **once**; within one
  document, `/search?q=texas` → clicking Texas asks **once**, not twice.
- Keyboard only: from the page's box, Tab reaches the team's line and a second
  Tab reaches "Axel's board" — the chip follows its own team in reading order —
  Enter opens `/u/41fc1d7f-…` whose `h1` is Axel, and Back returns to
  `/search?q=texas` with `texas` in the page's box, the header's box empty, and
  the three results still listed.
- `/api/selections` aborted and left past the retry budget: the team page whole,
  **0 owner lines, 0 alerts**, nothing naming the failure, no raw value.
- axe (WCAG 2.0/2.1 A and AA) clean on a team page and on `/search`, at 1280 px
  and 320 px in light and at 390 px in **dark** — six scans.

**The KV criterion, measured.** The ledger read
`{season_calendar 1, team_list 1, conferences 1, rankings 1, schedule 9,
prediction 3}` — 16 writes, all from the browser pass's team pages — and was
**identical** after a dozen searches and a dozen index reads. No new category,
and no write at all from this feature.

`npm run smoke` against that Worker is **21 passed, 1 failed**: the recorded
local-only mismatch ("every card has sports data — 3 of 6", the repo's mock
roster meeting the live database's real boards). It is there at `HEAD`, and no
API code changed in this phase.

**The documents.** A "Testing who has a team" section in the README on the
existing convention (Levels A, B, B2, C, and an exit-criteria table), plus two
troubleshooting rows; `context/project-notes.md` gains the route in §2, the
one-read-per-document note in §4, and four entries in §9 (the invisible
failure, the five-minute staleness, the names now appearing beside any searched
team, and the boards sharing no teams); `docs/ops.md` gains a "What 'who has
this team' costs" section and a release record carrying the pre-deploy numbers
above, with blanks for the deploy itself.

**Still open:** the deploy, and `verify:rls` against the live project after it.

### Findings

**A test's selector can quietly address the wrong one of two things, and the
failure reads as a bug in the app.** The browser pass reported that Back from a
board returned to `/search?q=texas` with an **empty** search box — apparently a
real regression in a Phase 3 behaviour. It was not: `/search` has *two*
`input[type="search"]`, the header's "Site search" and the page's "Team
search", and `document.querySelector` returns the header's, which Phase 4 made
deliberately always empty. The fix was to address the page's box through its
form's `aria-label`. Two distinctly-labelled landmarks were built precisely so
a person could tell them apart; a selector that ignores the label cannot.
**Anything asserting about "the search box" on this site has to say which one.**

**An assertion of absence has to be scoped to the thing that could produce it.**
"A team nobody picked leaves no empty element behind" was first written as
"there is no empty `<p>` on the page", and it failed — on a zero-height
`notice` paragraph inside a game panel, present on a *picked* team's page and on
board pages too, and nothing to do with this feature. A page-wide check for
absence picks up every pre-existing absence on the page and blames the newest
change. Scoped to the hero card, it passes and it means something.

**Pressing Enter after reading the tab order is not the same as pressing Enter
on the thing you read.** The keyboard check tabbed four times to record the
order, then pressed Enter — from the *fourth* stop, which is the second team's
owner chip, and opened the wrong board. The test then failed against entirely
correct behaviour. Walking the order and then walking it again to stop *on* the
chip is what a person does, and is what the test now does. Reading a sequence
and acting on it are different acts, and a script that conflates them measures
neither.

**Rollup's chunking answered a design question the plan had answered by
reasoning.** "Two importers put a module in the index chunk" is a sensible
belief and is wrong for a code-split app: the entry does not import it, so the
module becomes its own shared chunk that only the two lazy pages pull in. That
is strictly better than the plan's prediction — the home page and a board pay
nothing — and it was settled by two builds and a diff, exactly as Phase 4's
header-box measurement settled the layout. **A bundling claim is cheap to
measure and expensive to assume.**

**The dev environment behaved, for once, because every earlier lesson was
applied up front.** A port nothing had touched, a cold `--persist-to`, the
Worker's readiness confirmed by asking `/api/health` for its provider and its
ledger rather than trusting "Ready on", and the production build rather than the
dev server for anything about focus or timing. Four phases of findings
compressed into four precautions, none of which cost more than a minute. This is
the first phase in this plan with nothing to report under this heading, which is
itself the finding.

---

## Risks

| Risk                                              | Assessment                                                                                                                                                                                                                                                       |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Per-keystroke requests against the 120/min budget | A 250 ms debounce, a five-minute `staleTime`, `keepPreviousData`, a normalized key and `max-age=300` mean a realistic search is two to four requests, and backtracking over a prefix costs none. If production ever shows 429s, `READ_RATE_LIMIT_PER_MINUTE` is config, not code |
| Crawlers now reach ~762 team pages, not ~65       | Each is a schedule read that lands in KV, against a budget of about 1,000 writes a day. The write ledger (warn at 700, refuse at 900), the per-key write interval and the rate limiter bound it — but check the KV counter in `/api/health` the day after the deploy. This is the risk most worth watching |
| CPU and quota                                     | A search is a fold and a sort over ~762 identities: sub-millisecond when warm. The provider-id team page is _cheaper_ than the uuid page, because it skips Postgres entirely                                                                                      |
| Two URLs for one team                             | Server cache keys are provider-id based, so both share every expensive read; only the React Query entry is duplicated. Board links stay on the uuid, which keeps curated identity winning and leaves the board tests untouched                                    |
| Existing bookmarks                                | `/teams/<uuid>` is unchanged and checked first. The only change on the wire is `team.id` gaining `| null`, which nothing reads                                                                                                                                    |
| Identity drift between the two URLs               | A hand-curated conference on a stored row will not show on the provider-id URL. Cosmetic, and documented                                                                                                                                                          |

### Part Two

| Risk | Assessment |
| --- | --- |
| One more public read per page session | `/api/selections` is a single ~54-row Postgres query, `public, max-age=300`, with no provider call and no KV write. It costs one of the 120-a-minute read budget per page, not one per keystroke. If the free Supabase project ever becomes the constraint, the remedy is an L1 entry plus `evictL1` on the admin write — not KV, which is for provider data |
| Board membership up to five minutes stale in a viewer's browser | The same lifetime `/api/users` already has, for data that changes only when the administrator changes it. The admin's own browser is primed by `refreshPublic`, and a board change already takes about a minute to reach other screens (project notes §8) |
| Nine display names now appear beside any team a visitor searches | No new exposure: every board is already public at `/u/:userId` and every name is already on the home page. Recorded because it is the first time a person's name appears on a page reached without navigating to a board |
| The index fails silently | A broken index renders no line, which is indistinguishable from "nobody picked this team" — by design, and the reason Phase 7 drills it rather than trusting it |

---

## Verification

1. **Tests** — `npm run verify` at the end of every phase. The cases that carry
   the weight: public access with no token (no JWKS fetch, no `Authorization` on
   any database request), no PostgREST request at all on either new public path,
   a provider-id 404, the uuid path unchanged, `snapshot.identity` with no `id`,
   a short query 400, the team list down 503, the conference map down degrading
   to 200, a 429 on the search route, an FCS team with no conference and no rank,
   and a board team fetched both ways sharing its cache.
2. **Mock provider** — `npm run dev` and `npm run dev:web`: search "tex", "san
   jose" (accent folding), "a" (no request, the hint shows), and nonsense (the
   empty state). Open a result and check the hero, rank, record, previous and
   next game, prediction, and schedule. The back link says "Search" and keeps the
   query. Reload `/search?q=texas` directly, deep-link `/teams/333`, and confirm
   an old `/teams/<uuid>` link still works. Check 320 px and a keyboard-only pass.
3. **Failure states** — `SPORTS_PROVIDER_FAULT=teams` makes search a clean error
   with a reference number; `SPORTS_PROVIDER_FAULT=schedule` leaves a searched
   team page with its identity and an unavailable schedule.
4. **Real ESPN** — run the Worker with `SPORTS_PROVIDER=espn` and the production
   User-Agent, then search an FCS school (Mercer, North Dakota State) and confirm
   "Conference unknown", "NR", a real schedule, and nothing invented. Watch the KV
   write counter in `/api/health` before and after a dozen searches.
5. **Deploy** — deploy the Worker and the site, run `npm run smoke` against both,
   run `npm run verify:rls` to confirm the database boundary is unchanged by a
   release that added a public route, and read KV writes, requests and CPU in the
   Cloudflare dashboard the next day.
6. **The pick index (Part Two)** — the cases that carry the weight: one PostgREST
   request with no `Authorization`, no ESPN request at all, a team on two boards
   listing both alphabetically, a team on none absent from the index, an empty
   database as `{"owners":{}}`, a dropped row (null embed, foreign namespace)
   leaving the rest intact, the five-minute lifetime never inherited by an error,
   no nested `<a>` in a result row, a failed index leaving the results complete
   and silent, and `queryKeys.owners` surviving a sign-out sweep. By hand: search
   a team that is on a board and click the name through to the board; search one
   that is not and see no line; open the same team by uuid and by provider id and
   get the same names; block the database and confirm search still lists teams.
