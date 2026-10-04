# Matchup Board — Implementation Plan

## Phase Checklist

- [x] **Phase 1 — The week's matchups, as data.** A week of games in one
  provider read, joined to the boards' picks, served as
  `GET /api/matchups?week=` and `GET /api/matchups/:gameId`. API only.
  Built 2026-10-02/03, committed as `1380a99`, deployed 2026-10-04. See
  [Phase 1 — Completion notes](#phase-1--completion-notes).
- [x] **Phase 2 — The matchup board, and the way into a game.** The `/matchups`
  page, a header link, week navigation, and a first `/matchups/:gameId` page
  showing who has each side and the pregame win probability.
  Built 2026-10-03, web only, committed as `fb4e168`, deployed 2026-10-04. See
  [Phase 2 — Completion notes](#phase-2--completion-notes).
- [x] **Phase 3 — Inside the game, live; docs, drills, and the deploy.** Box
  score, leaders, line score, scoring plays, down and distance, and ESPN's live
  win probability, all updating while the game is on. Then the release.
  Built 2026-10-03/04, deployed with Phases 1 and 2 on 2026-10-04. One step
  left by its nature: the first real Saturday on the deployed site
  (2026-10-10). See [Phase 3 — Completion notes](#phase-3--completion-notes).

Phases are sequential and each ends at a state that can be checked. Phase 2
needs Phase 1's contract, not its ESPN accuracy: mock mode covers that, as it
did for every feature before this one.

Written 2026-10-02, the day projected points went live. Read
[project-notes.md](project-notes.md) first. It is the distilled history, and
most of the "Watch out for" items below come from it.

---

## Context

The application shows nine boards of six teams each. Each board is one
person's set of teams. What no screen shows yet is **where those boards meet**:
a Saturday when Eli's Georgia plays Steph's Alabama is the most interesting
game of the week for this group, and right now you would only find it by
opening two boards and noticing the same opponent.

The matchup board is a separate page from the boards. It lists every game in a
week where **a team on one board plays a team on another**, says who has each
side, and opens into a page per game. Before kickoff that page shows the
pregame win probability. During the game it shows the game itself, updating
live.

### Measured, not assumed (2026-10-02)

Three things were checked against real data before this plan was written:

| What | Measured |
| --- | --- |
| **A whole week is one ESPN request.** `scoreboard?week=6&seasontype=2&groups=80&limit=300` | 200, **58 games**, ~**800 KB**, over five days (Tue 3, Wed 4, Thu 1, Sat 46, and 4 dated Sunday UTC, which are Saturday-night Eastern kickoffs) |
| **How many games are matchups**, from the live pick index (`/api/selections`) against weeks 5 and 6 | **11 and 12** games with an owned team on both sides. **22** each week with only one side owned. **1** each week with the **same person on both sides** (week 5: Florida at Missouri, both Jeremiah's; week 6: UCLA at Oregon, both Wilson's) |
| **What the game summary carries** (the fixtures already in `apps/api/test/fixtures/espn/`) | Live and final: `boxscore.teams` (15 team stats: first downs, total yards, passing, rushing, turnovers, third downs, possession…), `leaders` (passing, rushing, receiving, sacks, tackles), per-quarter `linescores`, `scoringPlays`, `drives.current`, and `winprobability`, a series of ESPN's in-game probabilities. Upcoming: `boxscore.teams` holds **season per-game averages** instead (points, yards, and allowed), plus `predictor` |

One more fact the fixtures settle: **down, distance, and possession are not in
the summary.** They come from the scoreboard's `competitions[0].situation`
(`downDistanceText`, `possession`, `lastPlay` with its own probability). That
scoreboard is the same day slate the live overlay already reads every 25
seconds.

### Decisions this plan assumes (confirm before Phase 1)

Each one has a default, so the plan can proceed. Any can be changed before
Phase 1 starts; afterwards each is one localized change.

1. **A matchup is a game where both sides are on at least one board.**
   One-sided games (22 a week) are not on this page; the boards already show
   them. A game where **one person has both sides** is still a matchup. It
   happens weekly, and it is shown and marked as such ("Wilson vs Wilson").
2. **"Odds to win" means ESPN's published win probabilities, and nothing
   else.** Before kickoff that is the ESPN matchup predictor the team page
   already shows (§12). During the game it is ESPN's in-game win probability
   from the same summary payload, a separate model, labelled separately.
   **Betting lines (spread, moneyline, over/under) are not shown.** The
   summary carries `odds`, `pickcenter`, and `againstTheSpread`, and the
   project's standing rule is that betting data is never read
   (project-notes §3, espn-notes §6, spec §46). Showing them would be a
   deliberate second exception and needs the owner's explicit call. See Open
   questions.
3. **The page opens on the current week**, from the same season resolution
   everything else uses, with previous and next week links. A past week shows
   its finals; a future week shows kickoffs.
4. **Live means polling**, at the cadence the team page already uses (15 s
   while anything is live). No WebSocket. That has been a project decision
   since plan §3, and nothing here changes the reason for it.
5. **URLs:** `/matchups` (with `?week=`) for the board, `/matchups/:gameId`
   for one game. The game id is the provider's, as `/api/games/:gameId`
   already uses.

### The rules this must not break

Taken from project-notes §2–§3. Each one has broken something before.

- **The browser never talks to ESPN or Postgres.** Every number on these pages
  comes through the Worker.
- **Only `providers/espn/` knows ESPN exists.** The week scoreboard, the
  summary's box score, and the slate's `situation` are all ESPN shapes. They
  are normalized inside that directory, and nothing outside it sees a field
  name. The mock gets the same methods.
- **Nothing sports-related goes into Postgres (§45).** The matchup list is
  derived on every read from the week's games and the picks. There is no
  `matchups` table.
- **Freshness is a value.** Every matchup and every stats block carries an
  envelope. A composite takes the worst state and the oldest `fetchedAt` of
  its parts. A stale score keeps its original time.
- **Never invent sports information.** A missing stat is `—`, never `0`. A live
  game with no score says "score unavailable", never 0–0. A probability ESPN
  does not publish is "unavailable", never computed by us. This feature adds
  **no** modelled number, so project-notes §3's one exception (the Top-25
  estimate) stays the only one.
- **Errors are isolated.** One game failing leaves the other eleven cards. On
  the game page, the stats failing leaves the header and the prediction.

---

## Phase 1 — The week's matchups, as data

**Goal:** one public request returns every matchup in a week, with who has each
side, the score where there is one, and honest freshness, without spending
the KV budget.

### Scope

**1.1 A week of games, one provider read**

- New provider method `getWeekGames(season, week): Promise<ProviderGame[]>`.
  ESPN reads `scoreboard?week={n}&seasontype={type}&groups=80&limit=300` and
  normalizes through the **existing** scoreboard validator and `normalize.ts`
  path that `getSlate` uses. It is the same payload shape, so no new parser
  should be needed. Confirm that against a captured week before assuming it.
- `seasontype` comes from the resolved `Season.type`: regular is `2`,
  postseason `3`. The week list and date ranges come from the calendar already
  cached as `season_calendar` (week 6 is `2026-10-05T07:00Z` to
  `2026-10-12T06:59Z`). An out-of-range week is a 400; the offseason is an
  empty list with a reason, not an error.
- Mock: the generated season already pairs seeded teams round-robin, so nearly
  every mock game is a matchup. Add `getWeekGames` over the same timeline, and
  make sure some week always has a live matchup, a final, a postponed game, a
  TBD kickoff, and a same-owner game. The seed shares four teams between
  boards, so a side with **two** owners exists in mock even though production
  has none.
- `faults.ts` gains `week`, so the drills can fail this read alone.
- Capture `scoreboard-week.json` (`npm run capture:fixtures` gains it) and add
  it to the property-style damage test, like every other fixture. **Capture
  it on Saturday 2026-10-03, during games,** so the fixture includes live
  rows with `situation`, which Phase 3 needs.

**1.2 Caching it within the budget**

- New category `week_games` in `cache/policy.ts`: TTL 15 min, stale window 6 h,
  all three tiers, **a KV write at most hourly**. When every game in the week
  is final, the TTL becomes a day. A past week never changes.
- The cache holds the **normalized** `ProviderGame[]` (about 30 KB for 58
  games), not the 800 KB payload. Only a provider refresh pays the parse.
- The cron warmer refreshes the **current** week, so the first Saturday viewer
  does not pay the parse on the request path. Cost: about 24 KV writes a day at
  most, and one more per hour for each other week someone opens.
- **Live scores come from the existing live overlay, not from this
  document.** A game in the live window (live, or kicked off within 6 h and
  not final) has its status, score, and clock taken from that day's slate
  (25 s, L1 only, **the same cache key the boards use**). So on a Saturday the
  matchup board and nine boards share one slate read per isolate. Reuse
  `services/live.ts` as is, including its narrowed stale-slate rule from the
  deploy (project-notes §7). Do not write a second overlay.

**1.3 The matchup service**

- `services/matchups.ts`: the week's games, joined to the picks
  (`listBoardsWithSelections`, the same one-query read the pick index uses),
  filtered to games where both competitors have at least one owner.
- Each matchup carries:
  - the game, neutral (home and away, not one team's view);
  - for each side: identity, owners (`{ userId, displayName }[]`, sorted),
    rank, record;
  - `sameOwner: boolean`, true when one person has both sides;
  - its own freshness.
- **Identity comes from Postgres.** Both sides are by definition on a board, so
  a stored `teams` row exists, and §45 says identity is ours. The provider's
  `TeamRef` is only a fallback if the row is somehow missing.
- **Rank comes from the app's rankings read** (CFP, else AP, shared and cached
  for an hour), not ESPN's per-game `curatedRank`. Otherwise the matchup board
  and the boards could disagree about the same team on the same screen.
  `unavailable` stays `—`, distinct from `NR`.
- **Record** comes from the competitor's record in the week document, shown
  verbatim (`summary`).
- **Order:** live first, then upcoming by kickoff (TBD kickoffs last within
  their day), then finals, then postponed and canceled. This is §51's "what is
  happening now" first.

**1.4 The endpoints**

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/api/matchups?week=<n>` | `MatchupBoardResponse`: `season`, `week`, `weeks` (for navigation), `generatedAt`, `freshness`, `anyLive`, `matchups[]` |
| GET | `/api/matchups/:gameId` | `MatchupResponse`: one matchup, same shape as a board row, from the existing cached `getGame` read plus the live overlay, rankings, and owners. Works for **any** game; a side nobody has gets `owners: []` |

- Both are public, need no token, and send `Cache-Control` from their own
  expiry: `max-age=10` when stale or degraded, `no-store` when there is
  nothing to show. `X-Cache` as elsewhere.
- **A composite cache, `matchup_composite`:** 60 s, or 15 s while anything is
  live or degraded. L1 only, never KV. This mirrors `board_composite`.
- **An admin write must evict it.** Add it to the list in `routes/admin.ts`
  next to the board composite, the board projection, and the leaderboard
  (project-notes §12: "any future derivation of the selections needs its own
  line there"). Otherwise the administrator moves a team and the matchup board
  disagrees with the boards for a minute.
- Types go in `packages/shared/src/domain/matchup.ts` and `api/responses.ts`.

### Exit criteria

- `GET /api/matchups` in mock mode returns the current week's matchups. Every
  row has two owned sides, owners named, and rank and record in all three
  ranking states.
- Against the captured real week and the real pick index, the service returns
  the 12 week-6 matchups measured above, including UCLA at Oregon with
  `sameOwner: true`, and none of the 22 one-sided games.
- **Cross-check:** for every owned team, the game its own schedule says it
  plays that week appears in the week document. This proves `groups=80` misses
  no owned team's game, including one against an FCS opponent. Run it against
  the real captures and record the result.
- A live matchup's score and clock come from the slate, and its freshness is
  the slate's. With `SPORTS_PROVIDER_FAULT=slate`, the row is `stale` with its
  original time, and nothing claims to be current.
- Faults, one at a time and then together: `week` (a cold cache is a clean
  `unavailable`; a warm cache past its TTL is `stale` with the original
  `fetchedAt`), `rankings` (every rank `—`, nothing else lost), `slate`, and
  the Postgres read failing (a 503 with a reference, because without the picks
  there is no matchup to show).
- `/api/health`'s KV ledger shows **no** writes for `matchup_composite`, and at
  most one `week_games` write per week key per hour.
- An admin write followed by a read in the same isolate shows the change at
  once.
- `npm run verify` and `npm run format:check` are green.

### Watch out for

- **CPU.** The week document is about twice a Saturday slate, which measured
  around 7 ms to parse, against a documented 10 ms limit that Cloudflare has
  not enforced so far (project-notes §9). Measure the parse in Node and in
  workerd. The cron warm and the normalized cache keep it off most requests,
  but a cold isolate's first read still pays it. Watch for `exceededCpu`.
- **`isCacheEntry` narrows on a runtime set** (project-notes §12). A new
  category that is not added there does not fail a type check. It becomes a
  permanent cache miss that rewrites KV on every read. Test with a second
  isolate reading the first one's KV copy.
- **Sunday-UTC kickoffs belong to Saturday.** Four week-6 games are dated
  `2026-10-11` in UTC. The slate key is the US Eastern date (`slateKeyFor`),
  so use it and never `kickoffUtc.slice(0, 10)`. Group by day on the client
  in the viewer's time zone, through `Intl`.
- **Neutral sites** (Texas vs Oklahoma is one in week 6) are `vs`, not `@`.
  `homeAway` comes from the provider's `neutralSite`, never from list order
  (§19).
- **The production boards share no teams today**, so a side with two owners
  only appears in mock data. The sorted multi-owner rendering must be tested
  with the mock and the seed, as "Picked by" was.
- **`check:season` will catch a date in a doc comment.** Write
  `<yyyy>-MM-DD`, as Phase 2 of projected points learned twice.

### Phase 1 — Completion notes

Written 2026-10-03 (UTC; Friday night 2026-10-02 Eastern), at the end of the
phase, for whoever builds Phase 2. **Nothing is committed and nothing is
deployed**: the working tree on `main` holds the whole phase. `npm run verify`
is green — **1117 tests in 46 files, up 44 from 1073** — and
`npm run format:check` is green.

#### What exists now

| File | What it is |
| --- | --- |
| `packages/shared/src/domain/matchup.ts` | **New.** `SeasonWeek`, `MatchupOwner`, `MatchupSide`, `Matchup` |
| `packages/shared/src/api/responses.ts` | `MatchupBoardResponse`, `MatchupResponse`, `MatchupBoardNotice` |
| `apps/api/src/providers/types.ts` | Two new provider methods: `getSeasonWeeks(season)` and `getWeekGames(season, week)` |
| `apps/api/src/providers/espn/` | `getWeekGames` (`scoreboard?week=&seasontype=&groups=80&limit=300`, through the **existing** `readScoreboard` + `toProviderGame`), `getSeasonWeeks` (`readCalendarWeeks` + `toSeasonWeeks` over the bare scoreboard's `leagues[0].calendar`), `espnSeasonType` |
| `apps/api/src/providers/mock/` | `getWeekGames`, `getSeasonWeeks` (`mockSeasonWeeks`, Tue–Mon windows), and current-week roles (below) |
| `apps/api/src/providers/faults.ts` | The `week` token. The week list is the calendar, so it fails under `calendar` |
| `apps/api/src/cache/policy.ts` | `week_games` and `matchup_composite` rows; resources `week` and `matchups` |
| `apps/api/src/cache/tiers.ts` | `evictL1Prefix(prefix)` |
| `apps/api/src/services/live.ts` | `overlayLive(services, games, baseFetchedAt)` — the overlay, extracted from `readLiveSchedule` so a week reuses it. `readLiveSchedule` now calls it and behaves exactly as before |
| `apps/api/src/services/games.ts` | `readProviderGame` — the cached neutral game read, shared by `/api/games/:id` and `/api/matchups/:id` |
| `apps/api/src/services/matchups.ts` | **New.** `readSeasonWeeks`, `readWeekGames`, `defaultWeek`, `indexPicks`, `isMatchup`, `compareRows`, `getMatchupBoard`, `getMatchup` |
| `apps/api/src/routes/matchups.ts` | **New.** The two routes, mounted at `/api/matchups` in `app.ts` |
| `apps/api/src/routes/admin.ts` | `forgetMatchups` (called from `forgetBoard`) |
| `apps/api/src/cron/warm.ts` | Warms the week list and the current week's games (`results.week`) |
| `apps/api/test/matchups.test.ts` | **New.** 41 tests: provider, real data, mock, live, faults, KV, single game, pure functions |
| `apps/api/test/fixtures/espn/scoreboard-week-{5,6}.json` | **New.** Real week documents, in the manifest |
| `apps/api/test/fixtures/app/pick-index.json` | **New.** The deployed `/api/selections`, same night. `userId`s replaced with synthetic uuids; names and team ids real. Kept out of `fixtures/espn/` so the damage test does not treat it as an ESPN payload |
| `scripts/capture-espn-fixtures.ts` | Captures the current week on a full run, and `--weeks-only 5,6` captures just the week documents and merges the manifest |
| `docs/espn-notes.md` §13 | The week scoreboard, the calendar's weeks, and the cross-check, as observed |

#### Exit criteria, one by one

| Criterion | Result | Where |
| --- | --- | --- |
| Mock: current week's matchups, two owned sides, owners named, rank and record in all three ranking states | Met. `ranked` and `unranked` normally; every rank `unavailable` with `SPORTS_PROVIDER_FAULT=rankings` and nothing else lost | `matchups.test.ts`, "GET /api/matchups in mock mode" |
| Real week 6 + real pick index: the 12 measured matchups, UCLA at Oregon `sameOwner`, none of the 22 one-sided | **Met exactly**, and recomputed in the test from the raw payload with no app code. Week 5 also checked: 11 matchups, Florida at Missouri `sameOwner`, 22 one-sided | "the real week 6…", "the real week 5…" |
| Cross-check: every owned team's own schedule game is in the week document | **Met.** 54 teams × weeks 5 and 6: 108 team-weeks, 90 games, 18 byes, **0 missing**. LSU–McNeese (FCS) included. Run live against ESPN, not a test (54 schedule requests); recorded in espn-notes §13 | — |
| A live row's score and clock come from the slate, and its freshness is the slate's; with `slate` faulted the row is `stale` with its original time | Met. Proven with a 5-minute gap between the week document's read and the slate's | "a live matchup takes its score…" |
| Faults: `week` cold → clean `unavailable`; `week` warm past TTL → `stale`, original `fetchedAt`; `rankings`; `slate`; together; Postgres failing → error with a reference | Met, with one departure: the database failure is a **500**, not the plan's 503 (decision 2 below) | "faults" |
| `/api/health` ledger: no `matchup_composite` writes, at most one `week_games` write per week key per hour | Met in the test (an hour of 5-minute polls → 1 write; the 61st minute → 2) **and on local workerd** against real ESPN: `week_games: 2` for two week keys, nothing for the composite | "the KV budget" |
| Admin write then read in the same isolate shows the change at once | Met: an added team makes a new matchup, and a rename shows, on the very next read | `admin.test.ts`, last test of "the public board reflects an admin change…" |
| `npm run verify`, `npm run format:check` | Green | — |

Mutation checks were run by hand on the four rules most likely to rot (TBD
last within its day, the Eastern day key, the provider-namespace filter in
`indexPicks`, and `forceStale` for an unverified live row) plus `forgetMatchups`:
each mutant fails at least one test. The Eastern day key and the namespace
filter **survived the route tests** on real data and needed the pure-function
tests at the bottom of `matchups.test.ts` to be caught.

#### Measured

- **Real runtime (local `wrangler dev`, real ESPN, real Supabase, port 8793),**
  checked first that `/api/health` said `provider: "espn"` and that nothing else
  was listening (the leftover-process trap). `/api/matchups` cold **1.06 s**
  (calendar, week document, rankings, and Supabase over the network), then
  4–5 ms warm (`X-Cache: hit`, `max-age=59`). `?week=6` cold 0.30 s. The board
  showed exactly the measured 12 (week 6) and 11 (week 5), Pitt 35–33 at
  Virginia Tech as the one final. `/api/matchups/401858476` (Penn State at
  Northwestern, nobody has Northwestern) answered with `owners: []` and
  `team.id: null` on that side. `?week=40` → 400. The drill Worker was stopped
  by PID afterwards.
- **Parse cost in Node 22**, JSON.parse + validate + normalize, 30 runs: week 5
  (1.05 MB) median **8.3 ms**, first run 16.5 ms; week 6 (0.78 MB) median
  5.6 ms, first run 19.3 ms. A cold isolate's first read is over the documented
  10 ms. **Not measured in workerd**: `wrangler dev` reports no CPU time, and
  workerd's timers do not advance during synchronous work. Measure it with
  `wrangler tail` on the deployed Worker (`cpuTime`) in Phase 3.
- **Normalized size**: about **46 KB** a week, not the ~30 KB the plan
  estimated. Still about 5% of the payload.
- **What makes the payload big**: `competitors` ~455 KB, `leaders` ~102 KB,
  **`odds` ~74 KB** (betting lines inside every event, never read), calendar
  only 4 KB.

#### Decisions and departures — each one a localized change if reversed

1. **The week list is a new provider read, not the cached season.** The plan
   assumed the cached `season_calendar` held the week windows. It holds only a
   `Season` (`year`, `type`, `week`). Rather than change that cached shape
   (which every other read depends on), `getSeasonWeeks(season)` reads the
   bare scoreboard's `leagues[0].calendar` — the same request — and caches it
   under the `season_calendar` category with its own key
   (`…|season_calendar|<year>:<type>|weeks`). Cost: at most 4 more KV writes a
   day, cron-warmed.
2. **A database failure is a 500 with a reference, not a 503.** `DbError` maps
   an unreachable or failing PostgREST to `internal` (500) everywhere: the
   board and the projections answer the same way, and their tests assert it.
   Making it 503 is a one-line change in `db/postgrest.ts` but it changes every
   route, so it was left as the application's convention. The important part
   holds: an error body with `requestId`, never an empty 200.
3. **Row freshness.** A row whose game came off the live slate has the
   **slate's** freshness as its primary part, with the week document and the
   poll as reference parts (they can make it stale, not older) — so "its
   freshness is the slate's" holds literally. Every other row's freshness is
   the week document's. A live-window row that could not be checked is forced
   `stale` with the week document's `fetchedAt`. The board's own `freshness`
   is the week document's, plus the poll as reference, forced `stale` if any
   row is. Each row also carries **`scoreUpdatedAt`** (the slate's read for a
   live row, else the week document's) — Phase 2's "Updated" time on a card.
4. **The board answers `notice` and `error`, not just rows.** `notice:
   'offseason'` when the calendar has no weeks for the phase (preseason, or
   mock postseason); `'week_unknown'` when the calendar is unreadable and the
   season resolution has no week either (which is what `SPORTS_PROVIDER_FAULT=all`
   produces, since the date heuristic never knows the week). `error` carries
   the week read's failure with its `requestId`. A week with no games between
   boards is `notice: null, matchups: []`.
5. **Which week.** `?week=` must be 1–3 digits (else 400). A week the calendar
   does not list is a 400; with the calendar unreadable a requested week is
   taken on trust. With no `?week=`: the season's own week if listed, else the
   week whose window holds now, else the next one, else the last
   (`defaultWeek`). Tonight that opened on week 5.
6. **A complete week is kept for a day, stale for a week.** "Complete" is every
   game `final` or `canceled`; a week with a postponement keeps the 15-minute
   TTL. The KV write interval stays an hour either way.
7. **Admin eviction is by prefix.** The matchup composite is keyed per week and
   per game, so `forgetBoard` now calls `evictL1Prefix('v2|<provider>|matchups|')`.
   Other isolates catch up within 60 s, as with the board.
8. **The single-game route is cached too** (`matchup_composite`, key
   `…|matchups|game|<id>`), because a game page polling every 15 s would
   otherwise be a Postgres query every 15 s. Identity and owners come from the
   same one-query `listBoardsWithSelections`; a side nobody has gets the
   provider's identity with `id: null`, `conference: null`, no colours. A game
   unreadable with nothing cached is a 503 (the provider's error is the
   answer); an unknown game is a 404.
9. **The ESPN week read refuses a mismatched answer.** If the root
   `season`/`week` of the payload differs from what was asked, it is
   `invalid_response`, never shown as the requested week.
10. **Mock current week now shows every state.** The first three non-live
    pairings of the current week are made `final` (kicked off a game-length
    before the live ones), `postponed`, and `tbd`, assigned from the games that
    exist so a year's byes cannot remove one. No existing test changed. Under the
    seed every roster team is on a board, so **every mock game is a matchup**;
    same-owner games exist in some weeks (asserted across the season, not in a
    fixed week); two-owner sides are Alabama, Texas, Ohio State, and Notre Dame
    (Jordan's shared teams).
11. **Two week fixtures, captured Friday night rather than Saturday.**
    `scoreboard-week-5` (59 games: 54 pre, **1 in progress with `situation`**,
    4 post) and `scoreboard-week-6` (58 pre). The in-progress game was Penn
    State at Northwestern, which is not a matchup. So **Phase 3 still needs a
    capture with a live matchup in it.** Careful: `--weeks-only 5` overwrites
    `scoreboard-week-5.json`, and the tests assert its exact contents (the
    4:38 4th-quarter row, Pitt 35–33). Copy the current file aside first (or
    restore it from git once it is committed), capture, rename the new file
    (for example `scoreboard-week-5-live.json`), put the old one back, and
    point Phase 3's tests at the new name.
12. **`isCacheEntry` needed nothing.** The plan's watch-out says a new category
    must be added to a runtime set. In fact `isCacheEntry` checks the
    *provider* name against a runtime set and the category only for being a
    string. The second-isolate test was written anyway ("a second isolate
    serves the first one's KV copy") and passes.
13. **Order.** Sections are in-progress (live, or delayed/suspended with a
    period) → upcoming (`scheduled`, `unknown`, pre-game delays) → `final` →
    `postponed`/`canceled`. Upcoming is grouped by the provider's slate day
    (`slateKeyFor`: US Eastern for ESPN, UTC date for the mock), TBD last
    within a day, then kickoff, then game id. `anyLive` counts the in-progress
    section.

#### What Phase 2 should know

- **Shapes.** `MatchupBoardResponse` is `{ season, week, weeks, generatedAt,
  freshness, error, anyLive, notice, matchups }`. Print `weeks[].label`, never
  "Week {n}" (ESPN's postseason weeks are `1` "Bowls" and `999` "CFP"). Hide
  previous/next when `weeks` is empty. `week` is `null` only with a `notice`.
- **A row is neutral.** `home`/`away` as the provider designates; `neutralSite`
  decides "vs" against "at". Owners are sorted by display name. `sameOwner` is
  computed by `userId`, so two people with the same display name would not
  collide.
- **Group upcoming rows by the viewer's zone on the client.** The server's
  order uses Eastern days; a viewer in another zone needs `Intl` grouping and
  should keep the server's order within a group.
- **Times.** `row.scoreUpdatedAt` is the score's own "Updated" time; the
  header's "Last updated" is the oldest `row.freshness.fetchedAt` (or
  `body.freshness.fetchedAt`, which is the week document's).
- **`Cache-Control`**: `public, max-age=` the composite's remaining life (60,
  or 15 while live or degraded), `public, max-age=10` when anything is stale or
  failing, `no-store` when the week could not be read at all.
- **Records on final rows are post-game** (Pitt shows 5-0 after the win that
  made it 5-0). That is ESPN's record as of the document, shown verbatim.
- Nothing in `apps/web` was touched. `lib/api.ts` has no matchup calls yet.

#### Still open after Phase 1

- A Saturday capture with a **live matchup** in it (decision 11).
- Workerd CPU for a cold week read, on the deployed Worker (`wrangler tail`).
- README "Testing the matchup board", `docs/ops.md`, and the project-notes
  section proper are Phase 3's, as the plan says; project-notes has a short
  pointer section now (§13).
- Commit and deploy: not done, by design — the owner reviews first.

---

## Phase 2 — The matchup board, and the way into a game

**Goal:** someone opening the site on a phone on Saturday can see every
head-to-head game of the week, who has each side, the score, and, by tapping
one, who ESPN favours.

### Scope

**2.1 The page, `/matchups`**

- A lazy route chunk, like every page but home (`app/pages.ts`), prefetched
  when idle.
- A **"Matchups" link in the header**, beside "Boards". The home page gets one
  line pointing at it ("This week: 12 matchups between boards"); no data is
  fetched for that line beyond what the page already loads, or it is left out.
- The heading is the week ("Week 6 matchups"), then the season, then "Last
  updated" (the oldest row's time, as the board header does). Previous and next
  week links are real links to `?week=`, so the back button works (§47).
- **Sections:** Live now, then Upcoming (grouped by day in the viewer's time
  zone), then Final, then Postponed/canceled. An empty section is omitted.
  An empty week says so in words ("No games between boards this week").
- **A matchup card:**
  - two rows, away over home, with `@` or `vs`;
  - each row: logo, team name, rank, record, and the **owner's name** (more
    than one name sorted and wrapped);
  - the score and status where there is one: LIVE badge, period and clock, the
    score's own "Updated" time, or "Final" (only when the provider says final);
    a winner marked by the existing `ResultMark` shapes, not by colour;
  - the kickoff time (or date plus "TBD") and TV for upcoming games;
  - a same-owner game says "Both Wilson's" in words, not with an icon alone.
- **One link per card**: the matchup, stretched over the card with `::after`
  as `TeamCard` does. Owner names and team names are not separate links inside
  it; nested links inside a stretched link break keyboard order. The game page
  links on to the boards and team pages.
- **Polling:** `matchupBoardPollInterval` in `lib/poll.ts`. 15 s while
  `anyLive`; 60 s when a kickoff is within 12 h or a row is stale or failed;
  otherwise 5 min. Hidden tabs stop, and focus refetches once. These are the
  same rules and constants as the board, so the two screens agree.
- **States:** a skeleton on first load only; data kept during refetch with
  "Refreshing…"; a failed row keeps both teams' identity and says "Score
  temporarily unavailable"; a failed page is an `ErrorState` with **Try
  again** and the reference; a 429 says to wait. No raw value
  (`undefined`, `NaN`, `null`, `Invalid Date`) in seen or spoken text.

**2.2 The first game page, `/matchups/:gameId`**

Built now so that every card goes somewhere real. Phase 3 fills it out.

- **Header:** both teams (logo, name, rank, record, linked to their team
  pages), the owners (each linked to their board), the status, score, period
  and clock, kickoff, venue, and TV. One `<h1>`: "Ohio State at Iowa".
- **"Who's favoured": the pregame win probability.** It reuses
  `GET /api/games/:gameId/prediction` and the existing `PredictionPanel` and
  `lib/prediction.ts`, so the rules come for free and are already tested:
  - labelled "Source: ESPN matchup predictor";
  - `Prediction unavailable` plus a reason when there is none;
  - during a live game, "Pregame prediction, made before kickoff. It does not
    change during the game.";
  - **never shown for a final game** (plan Phase 4, decision 1).

  The one change: the panel must take a game view where neither team is "the
  viewed team". Home and away order on this page replaces "this team first".
- **Polling** as the team page does for its snapshot (15 s live), prediction
  at `POLL.predictionMs`.
- A link back to the matchup board for the game's week, not to `/matchups`,
  so returning from a week-4 game lands on week 4.

### Exit criteria

- Home → Matchups → a game → back works in a fresh private window with no
  session, and makes no request to Supabase.
- At 320, 768, and 1440 px, in light and dark: no horizontal scroll, with the
  longest team name and a two-owner side (mock) on the same card.
- Every state renders and is asserted in component tests: loading, a failed
  request, a 429, a stale row, a failed row, an empty week, the offseason, a
  live game with no score, a TBD kickoff, a postponed game, a same-owner game,
  and a two-owner side.
- Keyboard only: the header link, the week links, then every card in order,
  with a visible focus ring; Enter opens the game.
- Axe clean on both pages at 320 and 1280 px in both themes. One `<h1>` per
  page. The live score region is `aria-live="polite"`; the rest of the card is
  not, or a Saturday board would announce itself every 15 s.
- The hidden-tab test drives the real `QueryClient` with a fake clock, as Phase
  4's did, including the mutation check (setting
  `refetchIntervalInBackground: true` must make it fail).
- With the slate blocked (a live row stale) and with the matchups request
  blocked (the page `ErrorState`), the page says so in words.

### Watch out for

- **The prediction panel assumes a viewed team** (`lib/prediction.ts` orders by
  "the viewed team first"). Make the order a parameter. Do not fork the
  component, or the pregame and live labels will drift between the team page
  and this one.
- **Owner names are now on a third kind of page.** It is no new exposure (every
  board is public), but say it in the docs, as the search feature did
  (project-notes §9).
- **Real spaces between inline pieces.** Flex gaps looked right, but screen
  readers heard "vs LSUW 31–24" and "LIVE4:32" (plan Phase 4, decision 7).
  Assert with `spokenText`.
- **Do not show a predictor on every card.** Twelve prediction reads per load
  is twelve more cache keys and up to twelve more KV writes every two hours.
  The predictor belongs on the game page. If the owner wants a favourite on
  the card, it is an Open question with a cost attached.

### Phase 2 — Completion notes

Written 2026-10-03, at the end of the phase, for whoever builds Phase 3.
**Phase 1 is committed (`1380a99`); Phase 2 is not committed and nothing is
deployed.** The working tree on `main` holds the whole of Phase 2, all of it
in `apps/web` — **the API, `packages/shared`, and the database were not
touched.** `npm run verify` is green — **1230 tests in 50 files, up 113 from
1117** — and `npm run format:check`, `check:season`, and `check:bundle` are
green.

#### What exists now

| File | What it is |
| --- | --- |
| `apps/web/src/lib/matchup.ts` | **New.** Every rule the screens apply to a row, pure and unit-tested: `isInProgress`, `sectionOf` (`live`/`upcoming`/`final`/`off`), `groupMatchups` (upcoming regrouped by the viewer's day), `matchupTitle`, `sharedOwners`, `sameOwnerNote`, `resultOf`, `scoreState`, `summarizeMatchupFreshness`, `rankingPollOfMatchups`, `weekLabel`, `adjacentWeeks`, `weekPath`, `matchupPath`, `teamPath` |
| `apps/web/src/lib/format.ts` | `gameDayKey(game, {timeZone})` (sortable `YYYY-MM-DD`; a TBD kickoff's day read in Eastern) and `formatGameDay(key)` ("Saturday, October 10") |
| `apps/web/src/lib/poll.ts` | `matchupBoardPollInterval(board, now)` and `matchupPollInterval(row, now)`; `nearKickoff` now takes any `{kickoffTbd, status, kickoffUtc}` |
| `apps/web/src/lib/prediction.ts` | **Changed signature**: `predictionView(prediction, providerGameId, order)`, with `PredictionOrder = {kind:'viewed_team', team, opponent} \| {kind:'away_home', away, home}`, `NamedTeam`, and `viewedTeamOrder(team, game)` |
| `apps/web/src/lib/api.ts` | `api.matchups(week \| null)`, `api.matchup(id)`; keys `queryKeys.matchups` (prefix), `matchupBoard(week)` = `['matchups','week', week ?? 'current']`, `matchup(id)` = `['matchups','game', id]`; `'/api/matchups'` added to `PUBLIC_INDEX_PATHS` |
| `apps/web/src/features/matchups/useMatchups.ts` | **New.** `matchupBoardQuery(week)` (exported `queryOptions`, so the polling test drives exactly what the page uses), `useMatchupBoard`, `useMatchup` (with `placeholderData` from any loaded board, so board → game paints at once, as board → team does) |
| `apps/web/src/features/matchups/parts.tsx` + `.module.css` | **New.** What both screens print: `MatchupStatus` (`context: 'card' \| 'page'`), `OwnerNames`, `SideScore`, `failureCopy`, `requestIdOf` |
| `apps/web/src/features/matchups/MatchupCard.tsx` + `.module.css` | **New.** One card, and `MatchupCardFallback` for its error boundary |
| `apps/web/src/features/matchups/MatchupBoardPage.tsx` + `.module.css` | **New.** `/matchups?week=` |
| `apps/web/src/features/matchups/MatchupPage.tsx` + `.module.css` | **New.** `/matchups/:gameId` |
| `apps/web/src/features/team/PredictionPanel.tsx` | Now `PredictionPanel({ subject, title })`, `subject: PredictionSubject \| null` = `{ game, order, label? }`. `.neutralFill` in its CSS for a page that views neither team |
| `apps/web/src/features/team/TeamPage.tsx` | Builds its subject with `viewedTeamOrder` and `label: <Opponent/>` — renders exactly as before (all 56 team-page tests unchanged) |
| `apps/web/src/app/pages.ts`, `routes.tsx` | Two lazy routes, both prefetched when idle (`prefetchViewerPages`) |
| `apps/web/src/components/AppHeader.tsx` | "Matchups" `NavLink` after "Boards" (no `end`, so a game page keeps it active) |
| `apps/web/src/features/home/HomePage.tsx` | `MatchupsLine` under the h1 |
| `apps/web/src/features/admin/useAdminWrite.ts` | Invalidates the `['matchups']` prefix after every admin write |
| `apps/web/src/components/Standing.tsx` | `RankBadge`/`RecordBadge` gained `size="sm"` (text size, for a card's team row) |
| `apps/web/src/styles/global.css` | `h4` added to the margin reset and the display-font rule (see decision 12) |
| `apps/web/src/features/board/BoardPage.tsx` | A real space between the season and "Rankings:" (decision 13) |
| `apps/web/src/test/fixtures.ts` | `makeMatchup` (Ohio State, Wilson's, at Iowa, Steph's; Sat 19:30Z on FOX), `liveMatchup` (2nd qtr, 14–7), `finalMatchup` (31–24), `makeMatchupSide`, `makeMatchupOwner`, `WILSON`/`STEPH`/`JORDAN`, `LONGEST_NAME`, `matchupBoardResponse` (weeks 5–7), `matchupResponse` |
| Tests | **New:** `lib/matchup.test.ts` (26), `features/matchups/MatchupBoardPage.test.tsx` (37), `MatchupPage.test.tsx` (28), `useMatchups.test.ts` (3, the real `QueryClient` with a fake clock). **Extended:** `poll.test.ts`, `prediction.test.ts` (away_home order), `api.test.ts`, `HomePage.test.tsx`, `AppHeader.test.tsx`, `useAdminWrite.test.tsx`, `routes.test.tsx` |

#### Exit criteria, one by one

| Criterion | Result | Where |
| --- | --- | --- |
| Home → Matchups → a game → back, fresh window, no session, no Supabase request | **Met** in headless Edge on the production build (`vite preview` → local mock Worker): every step, back link (history back), forward/back, then home; zero requests matching `supabase`, zero console errors | browser run, "Journey" |
| 320 / 768 / 1440 px, light and dark, no horizontal scroll, longest name + multi-owner side on one card | **Met**, 12 combinations, board and game page. The run rewrites the first real row to `LONGEST_NAME` and **three** owners. "No sideways" checks every element in `<main>` against the viewport, not only `scrollWidth`, because `body` clips `overflow-x` and would hide a poking element | browser run, "Layout" |
| Every state asserted in component tests: loading, failed request, 429, stale row, failed row, empty week, offseason, live with no score, TBD kickoff, postponed, same-owner, two-owner side | **Met**, plus `week_unknown`, a week the provider could not read, an invalid `?week=` (400), halftime, a mid-game delay, Final/OT, neutral site, postseason labels, a canceled game, a side on no board, a failed prediction | `MatchupBoardPage.test.tsx`, `MatchupPage.test.tsx` |
| Keyboard only: header link, week links, then every card in order, visible focus ring, Enter opens | **Met** on the board: Matchups link → (search box, Refresh) → previous/next week → all 14 cards, one Tab stop each, in reading order; the card's computed outline is `solid 3px` while its link is focused; Enter navigates. **The game page was not walked by keyboard** | browser run, "Keyboard" |
| Axe clean on both pages at 320 and 1280 in both themes; one `<h1>`; live score region `polite`, rest of card not | **Met**: axe (wcag2a/aa, 21a/aa) zero violations at 320, 1280, and 1440, both themes, both pages. Exactly one polite region per live card, inside the card, holding the two team rows only (no LIVE, clock, Updated, or TV) | browser run, "Layout" and "Live regions"; component tests |
| Hidden-tab test with the real `QueryClient` and a fake clock, including the mutation check | **Met.** `useMatchups.test.ts` runs `matchupBoardQuery` under `createQueryClient()`: 15 s polling while live, nothing for five hidden minutes, one refetch on return; the idle pace on a quiet week; no storm on tab flicking. **Mutation run by hand**: `refetchIntervalInBackground: true` in `lib/queryClient.ts` fails the first test; file restored (no diff) | `useMatchups.test.ts` |
| Slate blocked (a live row stale) and matchups request blocked (page `ErrorState`), said in words | **Met.** Slate: a second, cold mock Worker on 8788 with `--var SPORTS_PROVIDER_FAULT:slate` behind a second preview on 4174 — the API answered every live row `stale` with the week document's `fetchedAt` and the board `stale`; every live card said "May be out of date. Last updated: …" and so did the header. Request blocked: `page.route(...).abort()` → "Unable to load the matchups … Try again", one h1; the game page likewise; the prediction request blocked → the header stays and "Prediction unavailable" | browser run, "Blocked" and "stale" |

The browser run is **84 checks + 3 for the slate drill, all passing**. Its
script is `matchups-browser.mjs` in this session's scratchpad
(`%TEMP%\claude\c--Users-wilso-django-College-Football-Bets\0abb35ac-…\scratchpad\`,
with `playwright-core` and `axe-core` copied into its `node_modules`); like
every earlier browser script it is outside the repo because CI has no browser.
Usage: `node matchups-browser.mjs <site> [journey|layout|keyboard|live|blocked|stale|all]`.
**Everything in Phase 2 was checked against the mock provider only**, never
against real ESPN data; the local Worker read the real Supabase through
`.dev.vars`, so the real nine names were on screen.

#### Decisions and departures — each one a localized change if reversed

1. **"Who's favored", not "Who's favoured".** The app's copy is US English
   throughout ("Canceled", `en-US` formatters). The panel title is a prop, so
   it is one string in `MatchupPage.tsx`.
2. **`PredictionPanel` takes a `subject`, not a `Game` and a team.** `subject`
   carries the game (only `providerGameId`, `status`, `kickoffUtc`,
   `kickoffTbd` are read), the `PredictionOrder`, and an optional `label` (the
   team page passes `<Opponent/>`; the matchup page passes none, because its
   h1 already names both teams). Every sentence the panel says — the source
   line, the pregame caveat, each "unavailable" reason — is still written once.
   With `away_home`, sides are matched to the page's away team **by provider
   id** (never by the prediction's own home/away); neither is "ours", and the
   bar's first segment is `--color-ink-muted` instead of the accent, so the
   bar does not seem to favour whichever side the accent lands on.
3. **No prediction at all for a final or canceled game** — the panel is not
   rendered, so it is not fetched either. A postponed game keeps it, as on the
   team page (`predictionTarget` keeps postponed games too).
4. **The home line fetches nothing.** It reads the current week's board from
   the query cache (`getQueryData(queryKeys.matchupBoard(null))`) and says
   "This week: 12 matchups between boards" only when this visit has already
   loaded it (and it has a week and no error); otherwise "This week's games
   between boards". It never says "0 matchups" for a failed or offseason read.
5. **"current" and a numbered week are separate cache entries.** The server
   decides what the current week is; the client never guesses it. `/matchups`
   and `/matchups?week=6` therefore make two requests even when they are the
   same week.
6. **Admin writes**: the client re-fetches `/api/matchups` from the network
   (`PUBLIC_INDEX_PATHS`) and invalidates the whole `['matchups']` prefix.
   Other weeks and single games are not network-primed: their `max-age` is at
   most 60 s, and the server's `forgetMatchups` already drops its composites.
7. **The card.** Its one link is the matchup's name ("Ohio State at Iowa") in
   an `h3` (Live, Final, Postponed sections) or an `h4` (under an upcoming
   day's `h3`), stretched over the card with `::after`; the focus ring moves to
   the card with `:has()`, as `TeamCard`. Away row over home row; the home row
   starts with `HomeAwayMark` (`@`, or `vs` at a neutral site). Logos are
   decorative (the name is beside them). Owners are plain text with a hidden
   "Picked by " and commas between names (on the game page they are
   `PickedBy` links instead). The live region is the two team rows plus the
   "Score unavailable" line, `aria-atomic`, and only on in-progress rows.
8. **Status words** (`MatchupStatus`). Live: LIVE badge + `liveSituation`
   (provider wording, never "Final" while live). Delayed/suspended mid-game:
   a status tag ("Delayed") + the provider's detail, **no LIVE badge**, but
   still in "Live now" (the server's `inProgress` rule, mirrored as
   `isInProgress`). Upcoming on a card: the time alone ("3:30 PM" or "Time
   TBD"), since the day heading carries the date; on the game page,
   `formatKickoff`. Final: `scheduleStatus` ("Final", "Final/OT") + the date.
   Postponed/canceled: tag + date.
9. **Upcoming days are the viewer's days.** `gameDayKey` in the viewer's zone
   (a TBD kickoff's day in Eastern, because its time is a midnight-Eastern
   placeholder); days sorted by key, the server's order kept within a day (so
   TBD stays last); a kickoff that is not a date goes in a last group, "Date to
   be announced". Tested in New York, Los Angeles, Chicago, London, Honolulu.
10. **Results.** `W`/`L` (`ResultMark`, shapes not colour) only when the status
    is final and the **other** side's `winner` is `true` for the `L`. Two
    `false` winners are a data gap: no mark at all, never an inferred tie.
11. **The header.** "Week 6 matchups" (`weekLabel`: the calendar's label, so
    "CFP matchups", "Bowls"), then the season without the week (`2026 season`),
    the poll once, "Last updated" = the oldest row's `fetchedAt` (in practice
    the week document's, since upcoming rows carry it), stale if the board or
    any row is. A **Refresh** button and a "Couldn't refresh" status line, as
    the board has (not in the plan). Week links come after Refresh in Tab
    order and before the cards. A `?week=` the calendar lacks (the API's 400)
    is "No such week" with a link to `/matchups`. A 429 is "Too many requests —
    Wait a moment, then try again." (`failureCopy`).
12. **The first `<h4>` in the app exposed a gap in the global reset.**
    `global.css` reset margins and set the display font for `h1`–`h3` only, so
    every upcoming card's head was 69 px tall with browser-default margins.
    **No test caught it; a screenshot did.** `h4` is now in both rules.
13. **"2026 seasonRankings" — found here, fixed on the board page too.** The
    season and the poll were two spans separated only by a flex gap, so the
    line read and copied as one word. Both headers now put a real space
    between them, and the matchup test asserts `2026 season Rankings: AP Top 25`.
14. **The game page's way back.** From router state when the page was opened
    from a board (history back). Otherwise the game's own week:
    `/matchups?week=N` labelled "Week N matchups" in the regular season, or
    "Postseason matchups" — the single-game response carries no calendar, so a
    postseason week has no label to print, and "Week 999" would be wrong.
    Team links use our uuid, else the provider id (`teamPath`), with this game
    as their `from`. A side nobody has says "Not on any board". The footer
    says "Score updated <time>" while live and not stale, else the
    `FreshnessLabel` (which says "May be out of date" when stale).
15. **`lib/matchup.ts` is in the main bundle**, because `lib/poll.ts` (used by
    the board) imports `isInProgress` from it. A couple of KB; the pages
    themselves are their own chunks (`MatchupBoardPage` 9 KB, `MatchupPage`
    4.8 KB, shared `useMatchups` 3.2 KB, before gzip).
16. **No API change was needed.** Phase 1's contract was sufficient for every
    state. One oddity seen in mock data: a live row can carry
    `kickoffTbd: true` (Notre Dame at Texas); the live section never reads
    TBD, so it renders correctly.

#### What Phase 3 should know

- **Where the game page grows.** `MatchupPage.tsx`: `GameHeader` (the hero
  card; its `.titleRow` holds the h1 and `MatchupStatus` — the situation line
  goes there; its `.sides` div is the live region), then the
  `PredictionPanel`. §51 order puts line score, then win probability (the
  live ESPN bar above the pregame panel), then stats, leaders, drive, scoring
  plays. Each new section should be its own request and its own `Panel`
  (`features/team/Panel.tsx`), so a failed detail leaves the header and the
  prediction.
- **Polling.** `matchupPollInterval` idles a final game at 5 min; Phase 3's
  rule is "a final game does not poll at all" — return `false` from
  `useMatchup`'s `refetchInterval` for `status === 'final'` once the detail
  read exists, and give the detail its own `gameDetailPollInterval`.
- **The labels the Phase 3 real-payload test must assert where rendered**:
  "Source: ESPN matchup predictor" and the pregame caveat already render in
  `PredictionPanel` (tested with mock labels and with `makePrediction`'s
  ESPN label); "ESPN win probability (live)" is Phase 3's.
- **Test helpers.** Seed the cache with `queryKeys.matchup(id)` and
  `queryKeys.prediction(id)`; `renderAt(path, '/matchups/:gameId', <MatchupPage/>,
  client, state)`. `spokenText` only strips `<span aria-hidden="true">` with
  no other attribute first, so `ResultMark`'s letter (which has a class)
  stays in spoken text — assert with `W?Won`.
- **The leftover-process trap, again.** `TaskStop` (or killing `npx`)
  stopped the wrapper but left `workerd` **and** wrangler's `node` parent
  listening on 8787/8788. They were found with `Get-NetTCPConnection`,
  checked by command line and start time, and stopped by PID. All drill
  ports were free at the end of the phase.

#### Still open after Phase 2

- A browser run against **real ESPN data** (local `wrangler dev` with the ESPN
  provider), and against the deployed site — Phase 3.
- A keyboard walk of the **game page** (only the board was walked), and a
  real screen-reader pass (never done in this project).
- README "Testing the matchup board", `docs/ops.md`, and the note that owner
  names now appear on a third kind of page (no new exposure: every board is
  public) — the plan puts docs in Phase 3.
- Commit and deploy: not done, by design — the owner reviews first.

---

## Phase 3 — Inside the game, live; docs, drills, and the deploy

**Goal:** during a game, the game page shows the game as it happens: score by
quarter, the stats, the leaders, the drive, the scoring plays, and ESPN's live
win probability. It updates by itself, with nothing on screen claiming to be
newer than it is. Then ship it.

### Scope

**3.1 The game detail, normalized**

- New provider method `getGameDetail(providerGameId): Promise<GameDetail>` over
  the `summary` payload, validated and normalized inside `providers/espn/`
  like everything else (total readers, never a throw on damaged input; it joins
  the damage test). `GameDetail`:
  - `lineScores`: per-quarter points per side, including overtime periods.
    `null` before kickoff.
  - `teamStats`: a fixed list of rows, `{ key, label, home, away }`, with
    values as **display strings** from the provider (`"5-14"`, `"31:12"`) and
    a numeric value only where one exists. Read by `name`, never by position:
    the FPI lesson (project-notes §5) applies to any array of stats.
  - `statsKind`: **`'game'` or `'season_average'`**. Before kickoff, the
    summary's box score holds season per-game averages under different names.
    They are shown under "Season averages", never in the game column. Two
    numbers from one publisher that look alike measuring different things is
    exactly the trap project-notes §12 records.
  - `leaders`: passing, rushing, and receiving per side (name, display line,
    e.g. "18/24, 231 YDS, 2 TD").
  - `scoringPlays`: period, clock, team, the provider's text, and the score
    after.
  - `currentDrive`: the team with the ball and the drive's own description
    ("4 plays, 26 yards, 1:30"). Live only.
  - `winProbability`: ESPN's in-game series and its latest value, as home and
    away probabilities 0–1, **divided by 100 in normalization if needed, never
    later**. `null` when the series is empty (upcoming, postponed) and **not
    returned at all for a final game**.
- **Down, distance, and possession come from the slate**, not the summary
  (measured above). Add `situation: { possessionTeamId, downDistance,
  lastPlay } | null` to the slate's normalized games. The live overlay already
  fetches that slate, so this costs no request. It is `null` on every other
  read.
- Mock: a deterministic detail for every game state, labelled mock, with a live
  game whose stats and series move with the clock so polling can be seen
  working on a Tuesday.
- `faults.ts` gains `detail`.

**3.2 The endpoint**

- `GET /api/games/:gameId/detail` → `Envelope<GameDetail>`. Its own request,
  so a failing box score leaves the header and the prediction standing (§42),
  as the team page's three reads do.
- Cache by game status, using the existing game categories' rules: live 25 s,
  L1 only, **no KV**; upcoming 10 min with KV at most hourly; final 7 days.
  Key `game_detail|<id>`.
- **Accepted cost:** while someone watches a live game, the header's `getGame`
  read and this one each fetch the same ESPN summary every 25 s per isolate.
  For nine people that is fine. If Akamai starts answering 403 on Saturdays,
  the remedy is to move the header onto this entry, one read serving both,
  not to slow the poll.

**3.3 The game page, filled out**

Sections in §51 order, so what is happening now comes first:

1. **Header** (Phase 2), now with the **situation line** while live: "MIA ball,
   2nd & 7 at MIA 34", and possession marked in words beside the team, not
   with a dot alone.
2. **Line score**: a small `<table>` (`<caption>`, `<th scope>`), quarters
   across, a total column, OT columns only when played.
3. **Win probability:**
   - Before kickoff: the pregame predictor (Phase 2).
   - Live: **"ESPN win probability (live)"**, the latest value as a split bar
     with both percentages in text, "Updated <time>", and the pregame predictor
     below it with its "made before kickoff" label. Two different ESPN models,
     two different labels, and the test asserts both labels where they are
     rendered (project-notes §12: "a label is only tested when something reads
     it").
   - An optional small trend line of the series, `aria-hidden`, with the
     numbers in text beside it. Built only if it fits at 320 px without
     sideways scroll.
   - Final: neither.
4. **Team stats**: a two-column comparison table, the provider's labels and
   strings verbatim, `—` for a missing value. Before kickoff, the same
   table titled "Season averages" from `statsKind`.
5. **Leaders**: passing, rushing, receiving, one row per side.
6. **Current drive** (live only) and **Scoring plays** (live and final,
   newest first while live, in game order once final).

**Live behaviour:**

- `gameDetailPollInterval`: 15 s while the game is live; 60 s within 12 h of
  kickoff or when stale or failed; a final game does not poll at all, since
  its data is cached for a week.
- `aria-live="polite"` on the score and the situation line only. Stats tables
  update silently.
- The stats block shows its own "Updated <time>" from its envelope. The header
  shows the score's. They can differ by a poll, and each says so honestly.
- Nothing says "Final" until the provider does. Provider wording containing
  "Final" while the status is live is not repeated (`liveSituation`, Phase 4).
- **Halftime, delayed, and suspended** are live-window states with no running
  clock. They show the provider's own `statusDetail` verbatim.

**3.4 Docs, drills, and the deploy**

- **Docs:** a "Matchup board" section in `project-notes.md` (what it is, the
  endpoints, the cache rows, what was learned), updates to the §2 route list
  and the §4 TTL table, `docs/espn-notes.md` (the week scoreboard, the summary's
  box score, leaders and win-probability fields, the slate's `situation`),
  `docs/ops.md` (the release record), and README "Testing the matchup board",
  levels A–C, as every feature has.
- **Fault drills on the real runtime**, against real ESPN, each one leading to
  the log line its reference names (project-notes §12: "test a reference by
  following it"):
  - `week`: the board is `unavailable`, or `stale` if warm;
  - `slate`: live rows `stale` with their original time, and no situation line;
  - `detail`: the header and prediction stay, the stats say "unavailable";
  - `prediction`: `Prediction unavailable`, everything else intact;
  - `rankings`: every rank `—`;
  - `all`.

  Name every combination you run. A drill tests the combination it names and
  nothing else.
- **A real Saturday.** The first live test on real data is a Saturday with a
  matchup on. Week 6, 2026-10-10, has twelve. Record what the page looked like
  and what the KV ledger said at the end of the day.
- **Deploy** the Worker, then the site, by hand as before (project-notes §11).
  The day after, read the KV counter: expect `week_games` at a few dozen
  writes, `game_detail` only for upcoming and final games, and nothing for
  `matchup_composite` or live detail.

### Exit criteria

- On a live mock game: the score, line score, stats, situation line, and live
  win probability change across polls, each with its own "Updated" time, and
  nothing says "Final".
- On a final game: stats and scoring plays shown, no win probability of either
  kind, no polling (the network panel shows none after the first load).
- Before kickoff: "Season averages" is labelled as such and never appears in a
  game column. The pregame predictor is shown.
- With the detail request blocked or faulted, the header and prediction
  render, and the stats section offers **Try again**.
- Every value the page prints comes from the API's display strings. There is
  no `undefined`, `NaN`, `0–0`, or `0%` for a missing value, in seen or spoken
  text, in every state.
- The real-payload test drives the captured live week, live summary, and slate
  through both routes and asserts the three labels where they are rendered:
  "ESPN matchup predictor", "ESPN win probability (live)", and the pregame
  caveat during a live game.
- Axe clean, keyboard walkthrough, 320 px with every section open, and both
  themes, on the deployed site.
- `npm run verify`, `format:check`, `check:bundle` green. Deployed, with the
  smoke script extended to the three new routes.

### Watch out for

- **The summary's betting keys sit right beside the stats.** `odds`,
  `pickcenter`, and `againstTheSpread` are siblings of `boxscore` in the
  payload. The validator should not read them at all. Add a test asserting
  that nothing in a normalized `GameDetail` carries a field from those keys.
- **`winprobability` is a series, and its last entry can lag the score by a
  play.** Date it by the read, label it "updated", and never call it current to
  the second.
- **ESPN's stat values are mixed types.** `fourthDownEff` was the string `"-"`
  in the live fixture where a number was expected. Carry the display string
  and treat the numeric value as optional, or the first odd value will either
  throw or print `NaN`.
- **The leftover-process trap** (project-notes §12). Before trusting any
  drill, check `/api/health`'s `provider` and what is answering on the port,
  not just what is listening. Stop drill Workers by exact PID, excluding the
  stop script's own ancestry.
- **Live is where production differs from local.** Six boards racing over a
  real network found the stale-slate bug that no local run could (project-notes
  §7). The matchup board now races twelve live rows and a summary against the
  same slate. The real Saturday is a required step, not a nice-to-have.


### Phase 3 — Completion notes

Written 2026-10-04, at the end of the phase. **All three phases are committed
and deployed** (release record:
[ops.md](../docs/ops.md#the-matchup-board-release-2026-10-04)). `npm run verify`
is green — **1313 tests in 53 files, up 83 from 1230** — and `format:check`,
`check:season`, and `check:bundle` are green.

#### What exists now

| File | What it is |
| --- | --- |
| `packages/shared/src/domain/detail.ts` | **New.** `GameDetail`, `GameSituation`, `LineScore`, `TeamStatRow`/`StatValue`, `GameStatsKind`, `LeaderRow`, `ScoringPlay`, `CurrentDrive`, `WinProbability` |
| `packages/shared/src/domain/matchup.ts` | `Matchup.situation: GameSituation \| null` |
| `packages/shared/src/api/responses.ts` | `GameDetailResponse` (`{ detail: Envelope<GameDetail> }`) |
| `apps/api/src/providers/types.ts` | `getGameDetail(id)`; `ProviderGame.situation?` (slate reads only) |
| `apps/api/src/providers/espn/` | `readGameDetail` + `toGameDetail` over the summary (line score, stats by name in two lists, leaders, scoring plays, drive, win probability); `readSituation` + `toSituation` over `competitions[0].situation`; `getGameDetail` |
| `apps/api/src/providers/mock/detail.ts` | **New.** `mockGameDetail(game, now)` and `mockSituation(game, now)`: synthetic, labelled mock, built on the mock score's own arithmetic so a live line score sums to the header's score at the same instant |
| `apps/api/src/providers/faults.ts` | The `detail` token |
| `apps/api/src/cache/policy.ts` | `game_detail` category and resource; `detailState` context (`live` → the live row, `final` → the completed row) |
| `apps/api/src/services/games.ts` | `getGameDetail`, `detailState` (live from 15 min before kickoff) |
| `apps/api/src/services/live.ts`, `matchups.ts` | `overlay()` copies the slate's situation; `rowOf` sets `situation` only from a slate laid over the row |
| `apps/api/src/routes/games.ts` | `GET /api/games/:gameId/detail` |
| `apps/api/test/detail.test.ts` | **New.** 30 tests: ESPN normalization of the live, upcoming, final, and postponed summaries; by-name reading; 0–100 scaling; the betting-key test; situation only from the slate; cache rules; the route in mock mode in every state; faults; the KV budget; the captured Saturday through the routes; and the file snapshot for the web |
| `apps/api/test/fixtures/espn/` | **New captures, 2026-10-03T23:07Z, during the games:** `scoreboard-week-5-live`, `scoreboard-20261003-live`, `game-live-matchup` (California at UNLV, 4th quarter), `game-upcoming-matchup` (Miami at Clemson). Added to the manifest; the damage test runs over them, and over the detail's own parts specifically |
| `apps/web/src/lib/detail.ts` | **New.** `situationLine`, `possessionSide`, `statText`, `pointsText`, `probabilityText`, `statsTitle`, `leadersTitle`, `periodShort`/`periodSpoken`, `scoreAfter`, `orderedScoringPlays`, `liveWinProbability`, `trendSummary`, `trendPoints` |
| `apps/web/src/lib/poll.ts` | `gameDetailPollInterval`, `isSettled` |
| `apps/web/src/lib/api.ts` | `api.gameDetail`, `queryKeys.gameDetail` (outside the `['matchups']` prefix: provider data, not picks) |
| `apps/web/src/features/matchups/GameDetail.tsx` + `.module.css` | **New.** `LineScorePanel`, `LiveWinProbabilityPanel` (split bar, a decorative trend line with its numbers in words), `StatsPanel`, `LeadersPanel`, `DrivePanel`, `ScoringPlaysPanel`, `DetailLoading`, `DetailFailed` |
| `apps/web/src/features/matchups/MatchupPage.tsx` | The situation line and "Has the ball"; the sections in §51 order; the detail's failure states |
| `apps/web/src/features/matchups/useMatchups.ts` | `gameDetailQuery`/`useGameDetail`; `useMatchup` stops polling a final or canceled game |
| `apps/web/src/test/real-saturday.json` | **Generated** by `detail.test.ts` (file snapshot); prettier-ignored |
| Tests | **New:** `lib/detail.test.ts` (13), `GameDetail.test.tsx` (27). **Extended:** `poll.test.ts`, `useMatchups.test.ts` (the detail on the real `QueryClient`), `MatchupPage.test.tsx` (two live regions, the loading detail panel), `validate.test.ts` |
| `scripts/smoke.mjs` | The three new routes: the board, one game, and its detail, with the final/no-probability and season-average checks |
| Docs | README "Testing the matchup board"; `docs/espn-notes.md` §14; `docs/ops.md` release record and usage notes; project-notes §2, §4, §10, §13 |

#### Exit criteria, one by one

| Criterion | Result | Where |
| --- | --- | --- |
| Live mock game: score, line score, stats, situation, live probability change across polls, each with its own Updated time; nothing says Final | Met. API: ten minutes apart, stats, series length, and `fetchedAt` all move, and the situation moves in five; browser: the detail and header each polled twice in 40 s and the stats' Updated time moved | `detail.test.ts`; browser "Live" |
| Final game: stats and plays, no probability of either kind, no polling | Met. Real ESPN (Pitt at Virginia Tech): 15 stat rows, 11 plays, no probability; **no request at all in 25 s** after the first load; the real `QueryClient` makes one request in half an hour | `useMatchups.test.ts`; browser "Final", on mock and real |
| Before kickoff: "Season averages", never in a game column; pregame predictor shown | Met, mock and real ESPN (week 6) | `detail.test.ts`, `GameDetail.test.tsx`; browser "Upcoming" |
| Detail blocked or faulted: header and prediction render, stats offer Try again | Met: request aborted in the browser, `detail` faulted on the real runtime, and an `unavailable` envelope in component tests, each with its reference | all three |
| No `undefined`, `NaN`, `0–0`, `0%` for a missing value, seen or spoken, in every state | Met; `expectClean` in every component state, including a live game with no score | `GameDetail.test.tsx` |
| Real-payload test through both routes, the three labels where rendered | Met: the captured live game through `/api/matchups/:id`, `/detail`, and `/prediction`, rendered by the web test from the generated file | `detail.test.ts` → `real-saturday.json` → `GameDetail.test.tsx` |
| Axe, keyboard, 320 px with every section open, both themes, on the deployed site | Met: on the deployed site, 38 checks on Sunday's real games and 15 on the captured live game served to the production bundle; locally on mock and real ESPN as well. Worker CPU under `wrangler tail`: cold week 12–21 ms, cold detail 6–9 ms, all `ok` | release record |
| verify, format:check, check:bundle green; deployed; smoke extended to the three routes | Met | release record |

The browser scripts are in this session's scratchpad (`game-browser.mjs`,
`real-live.mjs`, `drill.mjs`, with `playwright-core` and `axe-core` copied
beside them), outside the repo as before because CI has no browser.

#### Decisions and departures — each one a localized change if reversed

1. **`statsKind` labels the leaders too.** Before kickoff ESPN's leaders are
   season leaders ("94/106, 1,211 YDS, 14 TD"), so the panel is "Season
   leaders". The plan only named the stats.
2. **`GameDetail` carries `status`, `kickoffUtc`, and `kickoffTbd`**, so the
   cache can choose a lifetime from the detail alone, and so the page can see
   when the detail lags the header.
3. **A detail is cached as live from 15 minutes before kickoff** (L1 only, no
   KV), so a pregame copy is never kept 10 minutes into the game.
4. **`awayWinProbability` is `1 − home − tie`** of ESPN's own series point —
   the series publishes home and tie only. It is the remainder of a published
   figure, not a second estimate, and the type says so.
5. **No live probability beside a "Final" header**, even when the detail is a
   poll behind (`liveWinProbability` checks both). Likewise the drive.
6. **One panel for a failed detail** ("Game details" → "Stats unavailable",
   reference, Try again), placed where the stats would be. The line score and
   live probability come from the same read, so they are simply absent.
7. **Each detail panel prints its own "Updated" time** from the detail's
   envelope (or "May be out of date" when stale); the header keeps the score's.
8. **The trend line was built**: an `aria-hidden` SVG that fills its panel's
   width at any size, with the first and latest values in a sentence beside
   it. It passed the 320 px check.
9. **An empty stats or leaders list is not drawn as a table of dashes**: the
   normalizer returns `[]` when nothing at all was published, and the page says
   "No team stats have been published for this game."
10. **The situation is optional on `ProviderGame`** and present only on slate
    reads, so every existing constructor and cached copy is untouched and no
    cache key version was bumped.
11. **The real-payload web test reads a generated file** rather than importing
    API code into the web workspace (see project-notes §13).
12. **A real space between the status and the situation line, and between the
    season and "Score updated"** in the game header — found by the real-payload
    render ("4th QuarterUNLV ball").

#### Still open after Phase 3

- **The first real Saturday on the deployed site**: week 6, 2026-10-10. Record
  what the page looked like and what the KV ledger said at the end of the day.
- **The KV counter the day after the deploy** (`week_games` a few dozen,
  `game_detail` small, nothing for `matchup_composite` or a live detail).
- **Worker CPU on a Saturday** under `wrangler tail` (measured on a Sunday:
  cold week 12–21 ms, all `ok`).
- A real screen-reader pass (never done in this project).

---

## Risks and costs

| Risk | Likelihood | What happens | Mitigation |
| --- | --- | --- | --- |
| A cold week-document parse exceeds the 10 ms CPU limit | Medium | Not enforced so far; if it is, a 1102 on the matchup board | Cron warm, a normalized cache, measure in Phase 1. If it is enforced, build the week from the day slates instead |
| `groups=80` omits a game an owned team plays | Low | A matchup missing with no error | Phase 1's cross-check against every owned team's schedule |
| ESPN throttles the doubled summary read on a busy Saturday | Low | Stats or header 403 → `provider_unavailable`, labelled | Merge the two reads onto one entry (Phase 3.2) |
| KV budget | Low | Ledger warns at 700 | ~24 writes a day for the current week; composites and live detail write nothing |
| ESPN renames a stat or leader category | Medium over a season | That row reads `—` | Read by name; the damage test; display strings verbatim |
| The owner later wants betting lines | — | A second exception to "never invent / never betting" | Not built without an explicit decision (Open questions) |

## Open questions for the owner

1. **Betting lines.** The default is no: ESPN's predictor and live win
   probability only. If you want the spread or moneyline as well, it would be
   labelled "Betting line (source)" and kept visibly apart from the
   predictions, and it needs your explicit go-ahead, because it reverses a
   standing project rule.
2. **One-sided games.** Should the page also have a collapsed "Also playing"
   list of the ~22 games where only one side is owned? The default is no.
3. **A weekly head-to-head tally** ("Eli 2–0 this week"), counted from finals
   only. It is cheap to compute from data Phase 1 already has, but it is a new
   kind of number on screen. The default is no.
4. **A favourite on each card.** It costs a prediction read per card (see
   Phase 2's watch-out). The default is the game page only.
5. **Projected points on the game page** (each team's §12 projection). The
   endpoint exists. The default is to leave it out of this feature.
