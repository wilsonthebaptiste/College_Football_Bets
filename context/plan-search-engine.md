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
- [ ] **Phase 4 — The header control, docs, and ship.** A search box on every
      page, the accessibility pass, the README and notes, and the deploy.

Phases are sequential. Each ends at a verifiable state, and `npm run verify`
must be green before the next one starts.

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
