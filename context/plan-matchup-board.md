# Matchup Board — Implementation Plan

## Phase Checklist

- [ ] **Phase 1 — The week's matchups, as data.** A week of games in one
  provider read, joined to the boards' picks, served as
  `GET /api/matchups?week=` and `GET /api/matchups/:gameId`. API only.
- [ ] **Phase 2 — The matchup board, and the way into a game.** The `/matchups`
  page, a header link, week navigation, and a first `/matchups/:gameId` page
  showing who has each side and the pregame win probability.
- [ ] **Phase 3 — Inside the game, live; docs, drills, and the deploy.** Box
  score, leaders, line score, scoring plays, down and distance, and ESPN's live
  win probability, all updating while the game is on. Then the release.

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
