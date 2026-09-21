# Team Search — Implementation Plan

## Phase Checklist

- [ ] **Phase 1 — A team page for any team.** The contract gains `PageTeam`, and
      `GET /api/teams/:teamId` accepts either our uuid or a provider team id, so
      a team with no database row has a page.
- [ ] **Phase 2 — A public search endpoint.** `GET /api/search/teams?q=`, reusing
      the ranking and team list the admin console already uses.
- [ ] **Phase 3 — The `/search` page.** A lazy page with debounced live results,
      a shareable URL, and rows that open the team page.
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
