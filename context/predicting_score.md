# Projected Points — Implementation Plan

## Phase Checklist

- [x] **Phase 1 — The rubric, as code.** ✅ **Complete, 2026-09-30.** The scoring
      table, the expected-points arithmetic, and the one estimator this feature
      needs, in `packages/shared`. Pure functions, no network, no UI. 879 tests
      in 38 files (from 821 in 37); `npm run verify` green. Details and the three
      departures from this plan are in
      [Phase 1 — Completion Notes](#phase-1--completion-notes).
- [x] **Phase 2 — The two probability sources.** ✅ **Complete, 2026-10-02.**
      ESPN's FPI projections through the existing provider, playoffstatus.com's
      conference odds through a new and separate one, both with real captured
      fixtures, validation, and mock equivalents. Cache rows, cron warmers, and
      the two-way name join. No routes. 958 tests in 41 files (from 879 in 38);
      `npm run verify` green and `format:check` clean. Details, the four
      departures from this plan, and what it settled are in
      [Phase 2 — Completion Notes](#phase-2--completion-notes).
- [x] **Phase 3 — The endpoints.** ✅ **Complete, 2026-10-02.**
      `GET /api/projections` (every board's total, one Postgres read and no
      per-team provider call) and `GET /api/users/:userId/projection` (one
      board, per-team breakdown), both with per-input freshness, each
      publisher's own stamp, and labelled degradation. 982 tests in 42 files
      (from 958 in 41); `npm run verify` green and `format:check` clean. Both
      routes were run against the real nine boards in workerd, and the "odds
      down" and "both down" drills with them. Details, the six departures, and
      the three labelling bugs this phase found are in
      [Phase 3 — Completion Notes](#phase-3--completion-notes).
- [x] **Phase 4 — The screens.** ✅ **Complete, 2026-10-02.** A total beside
      each name on the home page (one request for the page), a breakdown panel
      under the board's cards, and the same six lines on the team page, from a
      new `GET /api/teams/:teamId/projection`. 1068 tests in 45 files (from 982
      in 42); `npm run verify` green and `format:check` clean. 47 browser
      checks in headless Edge, axe clean in light and dark at 320 and 1280 px,
      and all three screens seen on the **real** publishers. Details, the seven
      departures, the rubric fix this phase forced, and the Phase 5 handoff are
      in [Phase 4 — Completion Notes](#phase-4--completion-notes).
- [ ] **Phase 5 — Docs, drills, ship.** README, espn-notes, ops.md, fault
      drills, the deploy, and the KV counter the day after.

Phases are sequential, each ends at a verifiable state, and `npm run verify`
must be green before the next one starts. The feature starts from **821 tests in
37 files**.

Written against [project-notes.md](project-notes.md) (how the application is
built) and the archived [spec](archive/spec.md); `§n` points at the spec's
numbered sections. Every number in the "Measured, not assumed" section below was
read from the live sources on **2026-09-30** before this plan was written.

---

## Context

Nine people, nine boards, six teams each. Nothing on the site currently says who
is *winning*. The owner's scoring rubric exists on paper but is only settled at
the end of the season, when the final poll and the playoff are done.

This feature projects it forward: each person's expected total now, and — when
you open their board — how many of those points each of their six teams is
contributing. The projection is arithmetic over probabilities that two
publishers already compute; no game is simulated here.

### Two things to be honest about before anything is built

**1. "Live" is the wrong word for it, and the UI must not use it.** The
underlying numbers move when their publishers recompute them, which is about
once a day and after each game day — not per play:

| Source | Observed update cadence |
| --- | --- |
| ESPN FPI | `lastUpdated: 2026-09-30T08:00Z` — a daily morning recompute |
| playoffstatus.com | Page stamp read on 2026-09-30 said **"Sat Sep 26 11:30 pm"** — it recomputes after game days, so its figures were four days old |

So a projected total will not tick during a Saturday afternoon the way a live
score does. It updates when its inputs do, the page already polls, and the
screen must say "as of \<the source's own stamp\>" rather than "live". This app
already has the vocabulary for exactly this problem (§23, §39); the feature
should use it rather than overclaim. **A projection whose inputs are four days
old and whose label says "live" is the §39 failure in a new costume.**

**2. This is the first computed sports number in the application,** and §4/§46
say never to invent sports information. It is still legitimate, on three
conditions, and they are requirements, not caveats:

- Every probability is **quoted** from a publisher, never derived from a game,
  a record, or a betting line.
- The arithmetic is the **owner's own rubric**, applied to those quotations.
- Exactly **one** quantity is modelled by us — the chance a team finishes in the
  final Top 25 — and it is labelled as our estimate, with its inputs named, in
  the UI and in the response.

Vocabulary, then: these are **projected points**, shown under the word
"Projection", with sources named the way `PredictionSource` already names them
(`packages/shared/src/domain/prediction.ts`: "a prediction is a quotation, not a
calculation"). Nothing here may ever be rendered in the same style as a rank, a
record, or a score.

### Decisions taken, and where they came from

| Question | Answer |
| --- | --- |
| Who sees it | Everyone, no login, like every other read (§11.1) |
| Where the totals live | Beside each name on the home page; the board page gets the per-team breakdown |
| Where the breakdown lives | On the board, one row per team, with each rubric line and its contribution |
| Playoff / title probabilities | ESPN FPI (the owner's choice) |
| Conference probabilities | playoffstatus.com (the owner's choice), which is also the only source of a *runner-up* probability |
| Top-25 finish | Modelled by us from the current poll rank, as the owner asked, with FPI's rank carrying unranked teams |
| Precision | Two decimal places, as the owner asked. See the note on the honest precision of the conference half |
| Does the board response carry it | **No.** The projection is its own request, like the team page's schedule, so a scrape failure cannot degrade a board (§42) |

---

## The rubric, and the arithmetic over it

### The rubric as given

| Outcome | Points |
| --- | --- |
| National champion | 5 |
| National championship runner-up | 4 |
| Making the playoff | 3 |
| Conference champion, power four (ACC, Big Ten, Big 12, SEC) | 3 |
| Conference runner-up, power four | 2 |
| Top 25 finish | 1 |
| Unranked finish | −1 |

Points compound, so the national champion of a power-four conference scores
5 + 3 + 3 + 1 = **12**, and a team that finishes unranked scores **−1**. Those
two are the ceiling and the floor, and they belong in a test.

### Expected points

A team's projection is the expected value of its final score: each outcome's
points times the probability it happens. With

| | |
| --- | --- |
| `a` | P(wins the national championship) — FPI `probwintitle` |
| `b` | P(plays in the national championship game) — FPI `probmaketitlegame` |
| `c` | P(makes the playoff) — FPI `probmakeplayoffs` |
| `d` | P(wins its conference) — playoffstatus "\<Conf\> Champions", power four only |
| `e` | P(plays in the conference championship game) — playoffstatus "Championship Game Participate", power four only |
| `p` | P(finishes in the final Top 25) — **our estimate** |

the projection is

```
E = 5a
  + 4·max(0, b − a)      runner-up: in the game and does not win it
  + 3c
  + 3d                   power four only; 0 for everyone else
  + 2·max(0, e − d)      power four only
  + (2p − 1)             the finish term
```

Three things in that formula are load-bearing and worth stating plainly:

- **The runner-up term is a difference, not a quotation.** `b` is the
  probability of *reaching* the title game, so `b − a` is the probability of
  losing it. Same shape for the conference pair. Both are floored at zero
  because a publisher's rounding can put the difference slightly negative, and a
  negative probability must never reach the arithmetic. When it happens, log it.
- **The finish term collapses to one number.** Top 25 is +1 and unranked is −1,
  and a team finishes in exactly one of those two states, so
  `1·p + (−1)·(1 − p) = 2p − 1`. It runs from −1 to +1 and is the only term that
  can be negative — which is correct, and the UI must show it as a negative
  contribution rather than hiding it.
- **Nothing needs a "did it compound" rule.** The outcomes are nested in the
  publishers' own numbers (`a ≤ b ≤ c`), so a champion's 5 and its playoff 3 and
  its finish +1 all land in the sum automatically.

### P(finishes in the final Top 25) — the one thing we model

The owner's instruction is to use the current Top 25 rank. Early in the season
that is weak evidence and late in the season it is nearly conclusive, so the
estimate is a blend of a rank-based model and the current fact, weighted by how
much season is left:

```
m = ranked at r      →  TOP25_AT_1 − (r − 1)·(TOP25_AT_1 − TOP25_AT_25)/24
    unranked, FPI f  →  min(TOP25_AT_25, TOP25_AT_25 · exp(−(f − 25)/FPI_DECAY))
    neither known    →  the finish term is UNAVAILABLE, never guessed

p = (1 − w)·m + w·(currently ranked ? 1 : 0)
```

with `TOP25_AT_1 = 0.95`, `TOP25_AT_25 = 0.55`, `FPI_DECAY = 18`, and `w =
seasonProgress(season)`. Every one of those is a named constant in one place,
tunable without touching the arithmetic.

`seasonProgress` is new, belongs in `packages/shared/src/season.ts` (the only
module allowed to reason about the calendar), and is a function of the `Season`
the app already resolves — never of `Date.now()`, because `npm run check:season`
fails the build on a year literal outside that file and because the season is
already resolved for every request:

| Season | `w` |
| --- | --- |
| `preseason` | 0 |
| `regular`, week `k` | `0.8 · min(k, REGULAR_WEEKS)/REGULAR_WEEKS`, `REGULAR_WEEKS = 15` |
| `regular`, week unknown (the date heuristic never knows it) | 0.4 |
| `postseason` | 0.95 |

Postseason is 0.95 and not 1.0 on purpose: the final poll comes *after* the
bowls, so a team ranked in December can still fall out of it. The residual 5% is
honest uncertainty, not a fudge factor — and the whole formula converges on the
real rubric anyway, because by the time the final poll is published FPI's
probabilities are 0 or 100 and `w` makes the finish term ±1. **At the end of the
season the projection stops being a projection and becomes the score.** That
property is the best test this feature has.

### Worked examples, from the real numbers of 2026-09-30

Week 5, so `w = 0.8 × 5/15 = 0.267`. Conference figures are from the
playoffstatus pages as they stood (stamped Sep 26); AP rank is the poll the app
already shows.

| Team | Poll | Conf | 5a | 4(b−a) | 3c | 3d | 2(e−d) | 2p−1 | **Total** |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Texas | #1 | SEC | 0.73 | 0.49 | 2.68 | 0.57 | 0.34 | +0.93 | **5.73** |
| Miami | #4 | ACC | 0.51 | 0.38 | 2.56 | 0.66 | 0.40 | +0.85 | **5.37** |
| Georgia | #2 | SEC | 0.79 | 0.48 | 2.52 | 0.33 | 0.24 | +0.90 | **5.26** |
| Notre Dame | #3 | — | 0.71 | 0.46 | 2.54 | 0 | 0 | +0.88 | **4.59** |
| Boise State | #22 | — | 0.01 | 0.02 | 1.01 | 0 | 0 | +0.41 | **1.45** |
| Nebraska | NR | Big Ten | 0.04 | 0.06 | 0.77 | 0.33 | 0.22 | −0.19 | **1.23** |
| Texas A&M | NR | SEC | 0.01 | 0.01 | 0.09 | 0.01 | 0 | −0.19 | **−0.07** |
| Kansas | NR | Big 12 | 0 | 0 | 0 | 0.01 | 0 | −0.93 | **−0.92** |

That spread is the sanity check: a near-certain playoff team lands around 5–6 of
a possible 12, a good team having a bad year sits near zero, and a team with
nothing left goes slightly negative. **These eight rows should be a fixture-based
test**, so that a change to a constant has to be argued for against real teams
rather than against invented ones.

Two edge cases are visible in that table and both are deliberate:

- **Notre Dame and Boise State score 0 on both conference terms, and that is a
  fact, not a gap.** Neither can win a power-four conference. This must be
  distinguished in the data from "a power-four team whose odds we could not
  load", exactly as `RankingState` distinguishes `unranked` from `unavailable`
  (§7). Three states, never two.
- **A board total is a sum of unrounded team values, rounded once at the end.**
  Summing six rounded numbers drifts.

---

## Measured, not assumed: the two sources

### ESPN FPI — one request, every FBS team

`GET https://site.web.api.espn.com/apis/fitt/v3/sports/football/college-football/powerindex?region=us&lang=en&contentorigin=espn&limit=200`

- **This is a third ESPN host family.** The app already knows
  `site.api.espn.com` and `sports.core.api.espn.com`
  (`providers/espn/client.ts`); `site.web.api.espn.com` is new and needs an
  `ESPN_FITT_API` constant beside the other two, plus a line in
  `docs/espn-notes.md`.
- 200 with the project's curl-style User-Agent. **138 teams, one page**
  (`pagination.count: 138`, `pages: 1`), ~26 KB, `lastUpdated: 2026-09-30T08:00Z`.
- Per team: `team.id` (the same id space the app already uses) and
  `categories[].name === 'fpi'`, whose `values` array aligns with the
  **`names`** array on the top-level `categories` entry. The fields needed are
  `probwintitle`, `probmaketitlegame`, `probmakeplayoffs`, `fpirank` — and
  `probwinconf`, which matters below.
- **Read those by name, never by index.** The sibling `labels` array contains
  nulls, the order is ESPN's to change, and a silent off-by-one would put
  "projected losses" where a probability belongs. The index is resolved from
  `names` once per payload and validated to be ≥ 0.
- Values are percentages as numbers, with float noise
  (`27.800000000000004`). Divide by 100 in normalization, never in the UI.

**Four integrity checks that cost nothing and catch a broken read.** Measured on
2026-09-30 across all 138 teams:

| Sum of | Should be | Measured |
| --- | --- | --- |
| `probwintitle` | 100 (one champion) | 100.0 |
| `probmaketitlegame` | 200 (two finalists) | 200.3 |
| `probmakeplayoffs` | 1200 (twelve places) | 1200.6 |
| `probwinconf` | 1000 (ten FBS conferences) | 1000.3 |

A dropped page, a truncated `limit`, or a misaligned column breaks all four at
once. They belong in the validation layer as a warning and in the test suite as
an assertion with a tolerance.

**Only 138 of the provider's ~762 teams have an FPI row.** An FCS team therefore
has no projection at all, which is an `unavailable`, not a zero — the same
asymmetry the search feature already accepted for conferences and schedules.

### playoffstatus.com — four pages, scraped

| Conference | URL (verified 200) | Rows |
| --- | --- | --- |
| SEC | `/secfootball/secfootballpostseasonprob.html` | 16 |
| Big Ten | `/big10football/big10footballpostseasonprob.html` | 18 |
| Big 12 | `/big12football/big12footballpostseasonprob.html` | 16 |
| ACC | `/accfootball/accfootballpostseasonprob.html` | 17 |

Note the Big Ten path is **`big10`**, not `bigten` — `bigten` is a 404.
`robots.txt` is `User-agent: * / Disallow:` — everything allowed — and the four
pages total about 100 KB, read at most four times a day. 67 rows, which is
exactly the four conferences' membership, so no power-four team is missing.

The markup, as it stands: one `<table>` per page, each team row carrying
`<td class="tblteam">` with an `<a>`, then W, L, "\<Conf\> Champions", and
"Championship Game Participate". Values are whole percents (`19%`), with
`&lt;1%` for anything below one.

**Three parsing facts found by doing it wrong first:**

1. **A single regex over the whole table silently dropped one row per page**
   (SEC 15 of 16, Big Ten 17 of 18). The parse has to walk rows and then cells.
   This is why the column-sum check below is not optional.
2. **The team cell contains two spellings,** a wide one and a narrow one for
   small screens, so stripping tags yields `Mississippi St.Miss. St.`. Read
   `span.wide` when present, else the anchor's text.
3. **Entities must be decoded** before anything else: `Texas A&amp;M`,
   `&lt;1%`.

**The column sums are the scrape's own integrity check.** Measured 2026-09-30,
with `<1%` read as 0.5:

| | Champions column | Participate column |
| --- | --- | --- |
| SEC | 100.0% | 200.5% |
| Big Ten | 101.0% | 199.5% |
| Big 12 | 102.5% | 200.5% |
| ACC | 101.0% | 202.0% |

One champion and two finalists per conference, within whole-percent rounding. A
tolerance of 100 ± 4 and 200 ± 6 passes today and fails on a dropped row.

**Name matching is the real fragility, and it is smaller than it looks.**
Normalizing (lowercase, strip punctuation, `St` → `State`, `&` → `and`) and
matching against the team list's `displayName ?? name` resolves **66 of 67**
rows. The single exception is `Pittsburgh`, which ESPN calls `Pitt`. So the
alias table starts at one entry — and the test that matters is not "the aliases
work" but **"every power-four team in the conference map resolved, and every
scraped row matched a team"**, asserted in both directions against fixtures.

**The page's own stamp must be carried, not just our read time.** `Sat Sep 26
11:30 pm` with `Week 5 of 13`, read on Sep 30. Our `fetchedAt` would say
"seconds ago" for a figure four days old, which §39 forbids in spirit. It has no
year and no timezone, so **keep it as a verbatim string** (`computedLabel`) and
display it verbatim; parsing it into an instant would mean inventing a zone.

### The two sources disagree about conference odds, substantially

| Team | playoffstatus "Champions" | ESPN FPI `probwinconf` |
| --- | --- | --- |
| Georgia | 11% | 36.3% |
| Texas | 19% | 30.2% |
| Miami | 22% | 72.7% |

Both are internally consistent (each conference's column sums to ~100%), they
are four days apart, and they are different models. The gap is worth up to about
0.75 projected points per team, so this is not a rounding question.

The owner chose playoffstatus and it is the only one of the two that publishes a
*runner-up* probability, so **playoffstatus is the source and FPI's
`probwinconf` is not averaged into it.** But FPI's figure is already in the
payload for free, so: log the two side by side (Phase 2), and use
`probwinconf` as a **labelled fallback** for the champion term if the scrape
fails, in which case the runner-up term goes `unavailable` rather than being
invented. The screen says which source each number came from either way.

---

## Phase 1 — The rubric, as code

**Goal:** a pure, fully-tested scoring module. Given the six probabilities and a
season, it returns a team's terms and total. No network, no routes, no UI.

### Scope

| File | Change |
| --- | --- |
| `packages/shared/src/domain/projection.ts` **(new)** | `ProjectionSource`, `OutcomeKind`, `ProjectionTerm`, `TeamProjection`, `BoardProjection`, `ProjectionInputs` |
| `packages/shared/src/scoring.ts` **(new)** | `RUBRIC` (the points table as data), `projectTeam()`, `top25Probability()`, the named constants |
| `packages/shared/src/season.ts` | `seasonProgress(season)` and `REGULAR_WEEKS` |
| `packages/shared/src/index.ts` | Export the above |
| `packages/shared/src/scoring.test.ts`, `season.test.ts` | The tests below |

```ts
/** Where each number in a projection came from. A closed union, like
 *  `PredictionSource`, so nothing computed can ever wear a publisher's name. */
export type ProjectionSource =
  | 'espn_fpi'
  | 'playoffstatus'
  | 'espn_poll_estimate'   // our Top-25 model, from the poll the app displays
  | 'mock_projection';

export type OutcomeKind =
  | 'national_champion' | 'national_runner_up' | 'playoff'
  | 'conference_champion' | 'conference_runner_up' | 'final_ranking';

/** One rubric line for one team. `state` mirrors §7's three-state discipline:
 *  a value, a structural zero, or "we do not know" — never two of the three
 *  collapsed together. */
export interface ProjectionTerm {
  kind: OutcomeKind;
  state: 'known' | 'not_eligible' | 'unavailable';
  /** The rubric's points if the outcome happens. Constant per kind. */
  points: number;
  /** 0–1, the publisher's own number. `null` unless `state === 'known'`. */
  probability: number | null;
  /** `points × probability`, unrounded. 0 when not eligible, null when unknown. */
  contribution: number | null;
  source: ProjectionSource | null;
}
```

`TeamProjection` holds the six terms, the team's `providerTeamId`, its unrounded
`total`, and a `complete: boolean` (no term is `unavailable`).
`BoardProjection` holds the per-team list, the unrounded total, and
`teamsCounted` / `teamsTotal` so a screen can say "5 of 6 teams" instead of
quietly treating a missing team as zero.

### Exit criteria

- **The rubric, exactly, at the end of the season.** With probabilities of 0 or
  1 and `w = 1`, every combination the rubric names produces its stated integer:
  a power-four national champion is **12.00**, a national runner-up who won its
  conference is **11.00**, an unranked team with nothing is **−1.00**.
- The ceiling is 12 and the floor is −1, asserted over randomized valid inputs.
- `max(0, b − a)` holds: `b < a` yields a zero runner-up term and a logged
  anomaly, never a negative one.
- A non-power-four team's two conference terms are `not_eligible` with
  contribution 0; a power-four team with no odds loaded is `unavailable` with
  contribution `null`; the two are never equal.
- A team with no poll rank *and* no FPI rank gets an `unavailable` finish term,
  and `complete` is false. It is not silently −1.
- `seasonProgress` is monotone across preseason → week 15 → postseason, and
  never reads the clock.
- The eight real teams in the worked table above reproduce their totals to 2 dp
  from a fixture of the measured inputs.
- A board total is the sum of unrounded team totals, differing from the sum of
  rounded ones in at least one constructed case.

### Watch out for

- **Rounding is a display concern only.** Keep every intermediate value
  unrounded; round at the edge, once, and format negatives with a real minus
  sign.
- **The conference half of every number has whole-percent granularity**, so the
  second decimal place is partly noise (±0.02). Two decimals is what the owner
  asked for and is right for the totals; the plan just should not pretend the
  last digit means anything for a single conference term.
- **`check:season` scans for four-digit literals.** The new season code and its
  tests must not introduce one outside `season.ts` and fixtures.
- Put the constants where the thing they govern lives, as
  `features/search/useTeamSearch.ts` did with `MIN_QUERY`: a constant beside its
  guard cannot drift away from it.

---

## Phase 1 — Completion Notes

Built 2026-09-30. Every exit criterion above passes. Files as planned, plus
`projectBoard` and the rounding pair, which the exit criteria need and the scope
table did not name.

### Three departures, each a decision

**1. Anomalies are returned, not logged.** `TeamProjection.anomalies` carries
the `b < a` floor, a clamped probability, and a discarded `NaN`. `packages/shared`
is pure and runs in the browser as well as the Worker, so Phase 3's route does
the logging. Testing a returned list beats spying on `console`, and nothing is
lost: every anomaly is already handled defensively where it is recorded.

**2. `total` is `number | null`, not `number`.** Null when no term is `known`.
Without it, a non-power-four team with both sources down would total a confident
`0.00` from two structural zeros — the exact lie this feature exists to avoid,
and the thing Phase 3's "it never answers 0.00" criterion is about. The same rule
gives `BoardProjection.total` its null.

**3. `projectTeamAtWeight(inputs, w)` sits beside `projectTeam(inputs, season)`.**
The end-of-season exit criterion asks for `w = 1`, and `seasonProgress` never
returns 1 — postseason is 0.95 on purpose. So the weight is an explicit
parameter, and `projectTeam` is the one-line wrapper that derives it from the
season. The limit tests assert the rubric's integers exactly: 12, 11, −1.

### An `unavailable` poll makes the finish term `unavailable`

The plan's table has three rows: ranked, unranked-with-an-FPI-rank, and neither.
A *failed* poll read is a fourth case, and it resolves to `unavailable` even when
FPI's rank is known — the blend needs to know whether the team is ranked **right
now**, and a failed poll is precisely what does not say. Tested both ways.

### What the worked examples cost, and what they are actually worth

The eight rows reproduce to 2 dp and the board totals **22.65** where the sum of
the eight rounded totals is **22.64** — so the fixture itself is the
"unrounded, rounded once at the end" test, and no constructed case was needed.

Two provenance facts matter when one of these fails, and they are in a comment
above the fixture:

- **The FPI probabilities are reconstructed.** The plan published each term
  rounded to 2 dp, not the probability behind it, so the inputs are values inside
  the published interval. The assertion is therefore "every term matches the
  table to 2 dp **and** the total matches the table's total", with a half-cent
  tolerance per term — a value of exactly 0.015 (3 × playoffstatus's `<1%`) is
  `0.01` or `0.02` depending on the rounding mode, and the plan's table prints
  `0.01`.
- **`fpiRank` for the three unranked teams is solved back from the table's
  finish term.** Kansas's is ~70. Nebraska's and Texas A&M's are only pinned to
  **25 or better** — the baseline is capped at the `TOP25_AT_25` anchor inside the
  poll, so every rank from 1 to 25 reproduces the term (checked exhaustively) and
  26 onward reproduces none of it. That is benign for Nebraska, whose 26% playoff
  odds fit a rank around 20. It is **not** benign for Texas A&M, whose same row
  carries 3% playoff odds and an unranked poll position: a team FPI ranks in its
  top 25 does not have 3% playoff odds, so either that row's finish term or its
  FPI rank is inconsistent with real data. The table is the source, so the oddity
  is recorded rather than smoothed over, and Phase 2's captured FPI payload will
  settle it.

### Worth knowing in later phases

- `seasonProgress` is monotone preseason → week 15 → postseason, and a test
  moves the system clock to prove it never reads it.
- The ceiling (12) and floor (−1) hold over 2,500 randomized inputs, including
  inputs where the publishers' nesting (`a ≤ b ≤ c`) does **not** hold.
- `roundPoints` is the only place `-0` is killed: `-0.004` formats as `0.00`,
  never `-0.00`. Phase 4's `formatPoints` should wrap this one rather than
  re-implement it, and only swap in a typographic minus sign.
- `estimateSource` on `ProjectionInputs` is how a mock projection avoids wearing
  a publisher's name: with all three sources set to `mock_projection`, every term
  in the result is labelled mock (§46), and that is tested.

---

## Phase 2 — The two probability sources

**Goal:** both documents fetchable, validated, cached, warmed, and available in
mock mode. Nothing user-visible yet.

### Scope

| File | Change |
| --- | --- |
| `apps/api/src/providers/types.ts` | `SportsDataProvider.getTeamProjections(): Promise<TeamProjectionInputs[]>`; **new** `ConferenceOddsProvider` interface |
| `apps/api/src/providers/espn/client.ts` | `ESPN_FITT_API` constant |
| `apps/api/src/providers/espn/raw.ts` | `RawFpiTeam`, `RawFpiPage` |
| `apps/api/src/providers/espn/validate.ts` | `readFpiPage()`: name-indexed column reads, every field narrowed, the four field-sum warnings |
| `apps/api/src/providers/espn/normalize.ts` | `toProjectionInputs()` |
| `apps/api/src/providers/espn/provider.ts` | `getTeamProjections()` |
| `apps/api/src/providers/playoffstatus/` **(new)** | `client.ts` (HTML fetch, same posture as `EspnClient`), `parse.ts` (rows → cells, entity decode, `span.wide`, `<1%`), `provider.ts`, `conferences.ts` (the four URLs) |
| `apps/api/src/providers/mock/` | Deterministic projections and conference odds, labelled `mock_projection` |
| `apps/api/src/providers/registry.ts` | `conferenceOddsProvider(env)`, selected by `CONFERENCE_ODDS_PROVIDER` |
| `apps/api/src/cache/policy.ts` | Two rows: `projection_inputs`, `conference_odds` |
| `apps/api/src/services/projection.ts` **(new)** | `readProjectionInputs`, `readConferenceOdds`, and the name→team-id join |
| `apps/api/src/services/teamNames.ts` **(new)** | Normalization and the alias table (one entry: `pittsburgh → pitt`) |
| `apps/api/src/cron/warm.ts` | Warm both documents |
| `apps/api/test/fixtures/` | A real FPI payload and all four conference pages, captured |
| `scripts/capture-espn-fixtures.mjs` | Capture the FPI payload too |

**playoffstatus is a separate provider, not a method on the ESPN one.**
Project rule 2 is that only `providers/espn/` knows ESPN exists; the mirror of
that rule is that only `providers/playoffstatus/` may know this site exists. It
gets its own small interface and its own registry entry, so the sports provider
and the odds provider can fail, be faulted, and be mocked independently.

```ts
/** Conference championship odds for one season, as one publisher computes them.
 *  Rows are keyed by the publisher's OWN team spelling: resolving those to
 *  provider team ids needs the team list, which is the other provider's, so the
 *  join lives in `services/projection.ts` and not in here. */
export interface ConferenceOddsProvider {
  readonly name: ProviderName;
  getConferenceOdds(season: Season): Promise<ConferenceOddsDocument>;
}

export interface ConferenceOddsDocument {
  rows: ConferenceOddsRow[];
  /** The publisher's own stamp, verbatim: "Sat Sep 26 11:30 pm". Never parsed. */
  computedLabel: string | null;
}
```

**`ProviderName` has to widen, and that needs care.** It is currently
`'espn' | 'mock'` and is used both for freshness labels *and* as the domain of
the `teams.provider` column (`db/rows.ts toProviderName`). Add
`'playoffstatus'` for the envelope's sake, and introduce
`SportsProviderName = 'espn' | 'mock'` for the places that mean "the configured
sports provider": `SportsDataProvider.name`, `teamNamespace`, `Team.provider`,
`toProviderName`, `providerName(env)`. A `teams` row must still be unable to say
`playoffstatus` — that narrowing is the point of splitting the type.

Cache rows, sized to the observed cadences:

| Category | TTL | Stale | Tiers | KV interval |
| --- | --- | --- | --- | --- |
| `projection_inputs` | 6 h | 24 h | l1+l2+l3 | 6 h |
| `conference_odds` | 6 h | 7 d | l1+l2+l3 | 6 h |

That is at most 8 KV writes a day for both, against a ledger that warns at 700
(project-notes §4). The cron warms both, so neither is ever fetched on a
viewer's request path if the cron is running.

### Exit criteria

- The real captured FPI payload yields 138 teams with the five fields, read by
  name; a payload with the `names` array reordered still reads correctly, and one
  with a renamed column fails validation rather than reading the wrong number.
- The four field-sum checks pass on the real payload and the failure is a
  warning with the measured totals, not a thrown error — a slightly-off sum must
  not take the feature down.
- All four captured pages parse to 16 / 18 / 16 / 17 rows, both column sums in
  tolerance, `&lt;1%` read as 0.5, `Texas A&M` and `Mississippi St.` read
  correctly, and `Pittsburgh` resolves to Pitt.
- Both directions of the join are asserted: every scraped row matches a team,
  and every power-four team in the conference map has a row. A page with one row
  deleted fails the second.
- The damage test (`validate.ts`'s existing property-style test, which deletes
  and corrupts random fields up to 200 rounds per fixture) covers both new
  payloads and never throws.
- A `SPORTS_PROVIDER_FAULT` value for each new call, and faults are drillable
  independently: FPI down with odds up, and the reverse.
- Mock mode needs no network for either, and labels everything
  `mock_projection`.
- The KV ledger shows at most two writes for a cold read of both documents, and
  zero on a second read inside the TTL.

### Watch out for

- **ESPN's CDN judges the User-Agent together with the TLS fingerprint**
  (project-notes §5). The new host is reached with the same client and the same
  `ESPN_USER_AGENT`; do not give the FPI call its own headers.
- **playoffstatus is HTML, so it is not JSON-validatable.** The parse's
  guardrails are the row count, the column sums, and the two-way join — those
  are the equivalent of `validate.ts` for this source, and they are the only
  warning anyone will get when the site is redesigned.
- **A fault drill needs the fault both present and reachable** (the Phase 2 and
  3 findings in the search plan): `--var` for the binding, a cold
  `--persist-to` so a warm Cache API cannot answer, and wrangler's own startup
  binding list as the proof.
- `getConferences` already returns the short names the plan's power-four set
  must match. Verified against ESPN on 2026-09-30: **`ACC`, `Big Ten`,
  `Big 12`, `SEC`** — put those four in one constant and test it against the
  captured conference map, because a renamed conference would silently zero
  every conference term.
- Captured fixtures date: a page stamped Sep 26 will be in the repo forever.
  Name the capture date in the fixture, as the ESPN fixtures do.

---

## Phase 2 — Completion Notes

Built 2026-10-01/10-02. Every exit criterion above passes, and both sources were
verified **live** as well as against fixtures — the clients reach them, the
parsers hold on today's data, and the two-way join resolves 67 of 67 rows with
live data on both sides.

Files as planned, with four additions the scope table did not name: a
`playoffstatus` capture script, a `ConferenceOddsPage` type (see departure 1), a
second `SwrCache` in `Services` (departure 2), and `conferenceStandingFor`,
which is where the labelled FPI fallback actually lives.

### What was measured, against the plan's own numbers

Both sources behaved exactly as the plan recorded, two days later.

| | Plan, 2026-09-30 | Fixture, 2026-10-01 | Live, 2026-10-02 |
| --- | --- | --- | --- |
| FPI teams / pages | 138 / 1 | 138 / 1 | 138 / 1 |
| `probwintitle` sum | 100.0 | 99.8 | 99.8 |
| `probmaketitlegame` sum | 200.3 | 200.1 | 199.9 |
| `probmakeplayoffs` sum | 1200.6 | 1200.4 | 1200.0 |
| `probwinconf` sum | 1000.3 | 1000.9 | 999.9 |
| Rows, SEC / B1G / B12 / ACC | 16 / 18 / 16 / 17 | 16 / 18 / 16 / 17 | 16 / 18 / 16 / 17 |
| Champions column sums | 100.0 / 101.0 / 102.5 / 101.0 | identical | identical |
| Rows joined to a team id | 66 of 67 + 1 alias | 67 of 67 | 67 of 67 |

The conference map captured the same day makes the join exact rather than
approximate: ESPN's power four are **ACC 17, Big 12 16, Big Ten 18, SEC 16** —
67 teams, which is precisely the 67 rows the four pages carry. Both directions
of the join are empty.

The plan's `~26 KB` for the FPI payload is the one measurement that was off: it
is **about 830 KB**, because each team also carries `resume` and `efficiencies`
categories and the document carries a `glossary`. It is one request behind a 6 h
cache, so this cost nothing; it is only worth knowing before anybody budgets for
it.

### Four departures, each a decision

**1. There is no single `computedLabel` for the document, because the four pages
do not agree on one.** The plan assumed one stamp. Measured on both captures:
SEC and Big 12 said `Sat Sep 26 11:30 pm` while Big Ten and ACC said
`Sun Sep 27 2:45 am` — the pages are recomputed in batches. Nothing picks
between two such strings, because ordering them needs a year and a timezone the
publisher does not give, and inventing either to put a confident date on screen
is the one thing this feature may not do (§39, §46).

So `ConferenceOddsDocument` carries a `pages[]` of per-conference stamps, and
its own `computedLabel` is non-null **only when all four agree**. A team's
conference term is dated by its own conference's page. **Phase 4's "as of
\<playoffstatus stamp\>" therefore needs the per-conference stamp, not one
document-level string**, and on today's data the document-level one is null.

**2. `Services` carries two `SwrCache`s over one `TieredCache`.** A `SwrCache`
stamps every envelope it builds with one provider name. Reading the conference
odds through `services.cache` would have dated playoffstatus's figures `espn` —
§46's labelling mistake, moved into the freshness envelope where nobody would
look for it. `services.oddsCache` is the same tiers, the same key space, and
the same KV ledger, with the right name on it. It costs nothing.

**3. `getTeamProjections()` returns a document, not an array.** The plan's
signature was `Promise<TeamProjectionInputs[]>`. It needs to carry FPI's
`lastUpdated` — Phase 4's vocabulary asks for "as of \<FPI date\>" — and the
four field sums, so it is a `TeamProjectionsDocument`, symmetric with
`ConferenceOddsDocument`. `probwinconf` sits beside `fpi` rather than inside it,
because it is not part of the rubric's conference term; it is the labelled
fallback, and keeping it outside the quoted block is what stops it being used as
one by accident.

**4. The field-sum warning is logged by the provider, not by `validate.ts`.**
The plan's scope table put "the four field-sum warnings" in `validate.ts`, but
every function in that file is total and silent by design — the whole point is
that it returns `null` and never does anything. `validate.ts` computes the sums,
`normalize.ts` carries them, and `provider.ts` compares them to the tolerances
and warns. Each piece stays testable on its own.

### Which field sum actually catches a truncation is not the obvious one

**The FPI payload arrives sorted by rank**, so dropping the tail loses almost no
title probability — the top half of the league holds ~100% of it between them.
On a deliberately halved payload, `probwintitle` and `probmaketitlegame` stayed
*inside* tolerance while `probmakeplayoffs` (1185 of 1200) and `probwinconf`
(710 of 1000) broke.

That is the argument for four checks rather than one, and it is why the test
asserts *which* ones fire. A single check on the champion identity — the most
obvious one to pick — would have passed a payload missing half the league.

### Two name-matching facts, one of which cost an alias

**Punctuation must be REMOVED, not replaced with a space.** `N.C. State`
normalizes to `nc state` and matches ESPN's `NC State`; replacing punctuation
with a space gives `n c state`, which matches nothing. Getting this wrong
produced **two** unmatched rows instead of the plan's one, and the second would
have been "fixed" by a second alias that was never needed.

The order matters as well: `&` becomes "and" **before** the punctuation goes, or
`Texas A&M` collapses to `texas am`.

With both right, the alias table is the single entry the plan predicted —
`pittsburgh → pitt` — and it is a nickname, not an abbreviation, which is why no
rule reconciles it. **A growing alias table would be a sign the normalization is
wrong, not a sign of thoroughness.**

### Phase 1's open question, settled: the plan's table was right

Phase 1 recorded the plan's Texas A&M row as internally inconsistent — 3%
playoff odds for a team FPI ranks inside its own top 25 — and left it for the
captured payload to settle. The payload says the row is fine: **Texas A&M is FPI
rank 16 with 3.2% playoff odds**, unranked in the AP poll, on the same day.

FPI rank is how good a team is; playoff odds are the path in front of it, and a
strong team that has already lost is plausibly both. The suspicion was wrong and
the plan's table needs no correction.

The other two solved-for ranks were close: **Nebraska 14** (Phase 1 guessed ~20,
pinned only to "≤ 25") and **Kansas 70** (Phase 1 solved ~70, exactly). All
three are now the *measured* values in `scoring.test.ts`'s fixture, and because
the baseline is capped at the `TOP25_AT_25` anchor for any rank inside the poll,
swapping them in changed no expected value. A cross-check in
`test/espn/fpi.test.ts` asserts the three against the captured payload, so a
re-capture cannot stale the shared fixture in silence.

### Things Phases 3–5 will get wrong if nobody says so

- **The conference-odds cache read resolves the season, which is a third KV
  write on a cold run.** `season_calendar` is shared with every other read in
  the application and cron-warmed every six hours, so it is not a cost this
  feature adds — but "at most two writes for a cold read of both documents" is
  three if you count it, and the test says so explicitly rather than looking
  wrong later.
- **`isCacheEntry` in `cache/tiers.ts` narrows the stored provider against a
  RUNTIME set**, which had to gain `playoffstatus` alongside the type. Miss that
  and the symptom is not a type error but a permanent cache miss: every read
  refetches and rewrites the key. Only a second isolate reading the first's KV
  copy catches it, and there is now a test that does exactly that. **Any future
  publisher needs both lines.**
- **`CONFERENCE_ODDS_PROVIDER` is still `mock` in `[env.production.vars]`.**
  Nothing reads it until Phase 3's routes exist, and leaving it mock means the
  deployed Worker is not yet scraping anybody. **Phase 3 or 5 has to flip it**,
  and that is the moment the courtesy budget becomes real.
- **The FPI fallback sets `reachConferenceGame` equal to `winConference`**, so
  `max(0, e − d)` comes out at exactly zero and the runner-up term is a quoted
  zero rather than an invention. Phase 4 must not render that as "no chance of
  finishing second" — it is "this publisher does not say". The term's `source`
  is `espn_fpi` rather than `playoffstatus`, which is the signal to use.
- **`conferenceStandingFor` treats a `null` conference as `unavailable`, not
  `not_eligible`.** Not knowing a team's conference is not the same as knowing
  it is outside the power four. If the conference map fails, every conference
  term goes `unavailable` — including for teams that genuinely are ineligible —
  and that is the correct, if pessimistic, answer.
- **Phase 5 still owes `docs/playoffstatus-notes.md`.** Its raw material is in
  three places: the three parsing traps and the stamp rule in
  `providers/playoffstatus/parse.ts`, the integrity windows and their reasoning
  in `provider.ts`, and the measured row counts, column sums, stamps and
  `robots.txt` in `test/fixtures/playoffstatus/_manifest.json`.

---

## Phase 3 — The endpoints

**Goal:** two public reads, both cheap, both degrading in labelled pieces.

### Scope

| File | Change |
| --- | --- |
| `apps/api/src/routes/projections.ts` **(new)** | `GET /api/projections`, `GET /api/users/:userId/projection` |
| `apps/api/src/app.ts` | Mount after `/api/selections`, before `/api/admin` |
| `apps/api/src/services/projection.ts` | `getBoardProjection(userId)`, `getAllProjections()` |
| `packages/shared/src/api/responses.ts` | `ProjectionsResponse`, `BoardProjectionResponse` |
| `apps/api/src/cache/policy.ts` | `projection_board`: 120 s, L1 only (it is assembled from already-cached documents) |
| `scripts/smoke.mjs` | A total for a known board, and a breakdown that sums to it |

Both answers are assembled from: the selections (one Postgres read, the same
query `/api/selections` uses), the two cached documents, the conference map, and
the rankings the board already reads. **No per-team provider call**, so a
nine-board leaderboard costs the same provider work as one board.

The response carries a `sources` array — one entry per input, each with its own
`ProjectionSource`, its own `Freshness`, and playoffstatus's verbatim
`computedLabel` — and a composite `freshness` built by the existing rule: the
**worst** state and the **oldest** timestamp of its parts (§23). Nothing on
screen may look newer than its oldest input.

`Cache-Control: public, max-age=120`, set **after** the await so an error cannot
inherit it (the finding that already has a test on the search route).

### Exit criteria

- `/api/projections` returns nine totals with no token, no JWKS fetch, and one
  PostgREST request; `/api/users/:id/projection` returns six teams whose
  contributions sum to the reported total.
- A projection for a board with a non-FBS team reports `teamsCounted: 5,
  teamsTotal: 6` and an `unavailable` team entry — never a zero.
- With the odds source down: 200, conference terms `unavailable` or (if the
  `probwinconf` fallback is enabled) `known` and labelled `espn_fpi`, every
  other term intact, and the composite freshness degraded.
- With FPI down: 200, with the finish term still computed from the poll where a
  team is ranked, and `unavailable` where the fallback to FPI rank is gone.
- With both down: 200 and an entirely `unavailable` projection carrying a
  reference number. **It is never a 500, and it never answers 0.00.**
- An unknown user is a 404; a malformed id is a 404 before any client is built
  (the `DbFactory` lesson from the search plan's Phase 1).
- The endpoints spend the per-address read budget and 429 with `Retry-After`.
- `/api/users/:userId/board` is **byte-identical** to before this phase. A test
  asserts the board response has no projection field.

### Watch out for

- **Do not put the projection on the board response.** The board is the
  application's most important read, it is cached for 60 s, and the projection's
  inputs are cached for 6 h; fusing them would either make the board depend on a
  scrape or make the projection refresh 360 times more often than its sources
  change. The team page's schedule is the precedent (§42).
- Round in the route, not in the service, and ship both: the unrounded number
  for arithmetic and the 2-dp string for display, or two clients will round
  differently.
- The leaderboard is a *derived ordering* of people. Sort by total descending,
  then by display name, so a tie is stable; and do not label anybody "winning" —
  it is a projection, and ties to 2 dp will happen.

---

## Phase 3 — Completion Notes

Built 2026-10-02. Every exit criterion above passes, and both routes were run
against the **real nine boards** through the live Supabase project in workerd,
with the "odds down" and "both down" drills on top.

Files as planned, plus four the scope table did not name: `queries.ts` gained
`listBoardsWithSelections` (see departure 2), `cache-headers.ts` gained
`cacheControlCapped` (departure 4), `routes/admin.ts` gained
`forgetProjections` (see below), and `services/search.ts` gained the two
envelope-returning reads the assembly needs (`readConferenceMap`,
`readTeamListRead`).

### Three labelling bugs, and the one that mattered

This phase is the first thing that puts a `ProjectionSource` on the wire, which
is why all three surfaced here rather than in Phase 1 or 2.

**1. The one number we model was wearing ESPN's name.** `estimateSource` was
being derived from the same helper as FPI's label, so in ESPN mode every finish
term came out `espn_fpi`. That is §46's named example of what not to do —
calling an internally calculated figure a provider's prediction — and it is the
exact condition the whole feature's licence rests on (§4: *exactly one quantity
is modelled by us and it is labelled as our estimate*). `estimateSourceFor` is
now its own function with its own comment saying why it is not FPI's, and the
`rankings` input entry carries the estimate's label too: in this response the
poll exists only as the input to our model, so a screen reading the sources
knows the number derived from it is ours. **The end-to-end test against the
captured payloads is what caught it**; nothing in mock mode could have, because
there every label is `mock_projection` and the bug was invisible.

**2. `conferenceStandingFor` hard-coded `playoffstatus` and `espn_fpi`.** So in
mock mode the conference terms of a synthetic projection claimed to come from a
real publisher. Both labels are parameters now (`oddsSource`, `fpiSource`),
derived from the configured publishers, and five Phase 2 test call sites gained
them. A route test asserts that in mock mode *every* term of *every* team is
labelled `mock_projection` and that the word `playoffstatus` appears nowhere in
the response.

**3. The FPI conference fallback leaked outside the power four.** This one is a
correctness bug, not just a label. `conferenceStandingFor` decides
`not_eligible` from the team's conference, and a `null` conference skips that
branch — so with the conference map down, a Mountain West team would have
reached the FPI fallback and been paid **3 × P(wins the Mountain West)**, which
the rubric does not pay for at all. The assembly now offers `fpiWinConference`
only for a team whose conference is *known* to be power four. With the map gone,
every conference term is `unavailable`: pessimistic, correct, and tested.

### Six departures, each a decision

**1. There are five inputs, not four.** The plan lists the selections, the two
documents, the conference map, and the rankings. The join also needs the
provider's **team list** — it is what resolves the odds publisher's own
spellings ("Mississippi St.") to provider team ids. So `ProjectionInputName` has
five members and the response names all five. It costs nothing (24 h TTL,
cron-warmed) but it is a fifth independent way the conference half can degrade,
and one that looks nothing like the scrape being down: the scrape is fine and
its rows cannot be attached to anybody. A test drills it on its own.

**2. The leaderboard reads from the `app_users` end, not from
`user_team_selections`.** The plan says "the same query `/api/selections`
uses". That query cannot see a board with **no** selections, so a person with an
empty board would have vanished from the leaderboard rather than appearing at
"0 of 0" with no total. `listBoardsWithSelections` is still exactly one
PostgREST request, and a test asserts both the count and that an empty board
survives.

**3. The composite freshness needed two refinements over `composeFreshness`.**
Only the two publishers are `primary`; the rankings, conference map, and team
list are `reference`, or a 24-hour conference map would date every projection a
day old (the rule rankings already get on a card). And `composeFreshness`
deliberately *ignores* an `unavailable` part, because on a board a failed card
carries its own error — here a dead publisher is half the rubric, so one down
forces `stale` and both down is `unavailable`. Without that, a response that
could say nothing would have been labelled `fresh` with a null `fetchedAt` and
cached for two minutes.

**4. `Cache-Control` cannot be derived from the inputs' expiry.**
`setCacheHeaders` computes `max-age` from the data's own expiry, which here is
**six hours** — long enough to outlast an admin's board change and a
publisher's recompute. `cacheControlCapped` caps it at the composite's own 120 s
and keeps the existing treatment for the degraded cases: 10 s when stale,
`no-store` when there is nothing to show. All three are asserted.

**5. Anomalies are logged at assembly, not in the route.** Phase 1's notes say
the route logs them. But the composite is cached for 120 s, so a route would
re-log the same anomaly on every read of the same cached answer — noise, not
signal. They are logged where the arithmetic runs, once per refresh, together
with the join's two-way diagnostics (`projection_join_incomplete`), which are
the only warning a publisher's rename will ever give.

**6. `/api/users/:userId/projection` is mounted from `routes/projections.ts`,
not from `userRoutes`.** The whole feature is one file and one mount, and
nothing in the board's own routes knows it exists. Hono merges a sub-app's
routes into the parent router path by path, so `/api` is a safe mount: the board
response is unchanged, and a test asserts its exact key set and that the strings
`projection` and `projected` appear nowhere in it.

### An admin write had to learn about a second cache

`routes/admin.ts` already drops the board composite from its own isolate after a
write (`forgetBoard`), so an administrator sees their change at once rather than
a minute later. The projection is a **second derivation of the same selections**
with its own 120 s cache, so without the same treatment an admin would have
added a team, watched the board change, and watched the projected total not
change — and reasonably concluded the feature was broken.

`forgetProjections` drops two keys, and the second one is the easy one to miss:
a single board's change moves the **leaderboard** as well, because it is an
ordering of everybody. It is called from every write that already forgot a board
(rename, delete, add, remove, reorder) and from one that did not — creating a
person, who is a new line on the leaderboard at "0 of 0 teams". Both are tested
in `admin.test.ts` beside the board's own equivalent.

### What the real boards actually look like

Run in workerd against the live Supabase project with mock sports data, which is
the combination that exercises the response's states without touching a
publisher:

| | |
| --- | --- |
| Boards | 9, sorted 13.44 down to 0.17, no ties |
| Teams counted | 3 of 6 to 6 of 6 — the real boards hold teams the 50-team mock roster does not |
| `not_eligible` on screen | Navy: two conference terms at `0.00` with no source |
| `unavailable` on screen | UCLA: six terms at `—`, no total, excluded from the count |
| Partial | Texas Tech: no FPI row, conference terms known, a total anyway |
| Arithmetic | the six team totals summed to the board total to every decimal place |

That spread is worth knowing before Phase 4 designs anything: **every state the
panel has to render is already on the first board you open**, and one of the nine
boards has only three of six teams counted.

### Two drills, on the real runtime

`wrangler dev --var SPORTS_PROVIDER_FAULT:<token> --persist-to <cold dir>`, the
posture the search plan's Phase 2 finding prescribes.

| Drill | Projection | The board route |
| --- | --- | --- |
| `odds` | 200, `max-age=10`, freshness `stale`, champion term falls back to FPI's figure, runner-up a quoted `0.00` | **untouched**: 200, `fresh` |
| `all` | 200, `no-store`, every term `—`, nine boards with no totals, a reference number | 0 of 6 cards (`all` kills schedules too) |

The `odds` row is §42 proven rather than asserted: a scrape failure degrades the
projection and leaves the application's most important read alone. It also shows
the two publishers' disagreement in the flesh — Oregon's conference champion term
went from `0.29` (the scrape) to `1.61` (FPI's `probwinconf`), which is the
documented ~0.75-point gap doing exactly what the plan said it would.

### Things Phase 4 and 5 will get wrong if nobody says so

- **"The panel's team rows sum to its total on screen" cannot hold in general**,
  and Phase 4's exit criterion asks for it. The response sums *unrounded* team
  totals and rounds once, which is the whole point — the plan's own eight worked
  teams board **22.65** where their rounded totals sum to **22.64**. Phase 4 has
  to pick: render the rounded-once board total (and not promise the visible rows
  add up to it), or render the sum of the displayed rows (and disagree with the
  API). Rendering `total.display` and not claiming the column adds up is the
  honest one. The same applies to a team's six lines against its own total.
- **`total: null` must not be coalesced to zero anywhere**, and
  `teamsCounted` / `teamsTotal` must both be rendered. A board at "3 of 6" is
  not comparable to one at "6 of 6", and nine boards sorted by total will put a
  half-covered board wherever its three teams land.
- **Only `fpi` and `conference_odds` carry a publisher's stamp**, and
  `conference_odds.computedLabel` is **null on real data** because the four pages
  disagree. Phase 4's "as of \<playoffstatus stamp\>" has to come from
  `pages[]`, matched to the team's own conference.
- **Poll this at minutes, not seconds.** The route is `max-age=120` and its
  inputs move every six hours. `poll.ts`'s live cadence applied here would be
  7,000 pointless requests a day.
- **`not_eligible` and `unavailable` are both on screen on real data** (Navy and
  UCLA above), so the §7 guard is not hypothetical: `0.00` with a reason, versus
  `—`. Collapsing them is visible on the first board.
- **The projection composite is L1-only and writes no KV**, so this phase adds
  nothing to the write budget: the feature's cost is still Phase 2's at most
  eight writes a day. Phase 5's KV reading should expect exactly that.
- **`CONFERENCE_ODDS_PROVIDER` is still `mock` in `[env.production.vars]`.** The
  routes exist now, so this is the setting that decides whether the deployed
  Worker is projecting from a real publisher or from synthetic data — and
  nothing on screen distinguishes the two except the labels, which do say
  `mock_projection`. **Phase 5 has to flip it**, and that is the moment the
  courtesy budget becomes real.

---

## Phase 4 — The screens

**Goal:** the total where the names already are, and the breakdown one tap
deeper.

### Scope

| File | Change |
| --- | --- |
| `apps/web/src/lib/api.ts` | `api.projections()`, `api.boardProjection(userId)`, `queryKeys.projections`, `queryKeys.boardProjection(id)` — not under the `admin` prefix |
| `apps/web/src/features/home/HomePage.tsx` | A projected total on each tile, from one shared query |
| `apps/web/src/features/board/BoardPage.tsx` | A `ProjectionPanel`: the board's total and one row per team |
| `apps/web/src/features/board/ProjectionPanel.tsx` + `.module.css` **(new)** | The breakdown: per team, its total, and the six rubric lines with probability and contribution |
| `apps/web/src/features/team/TeamPage.tsx` | The same breakdown for one team, beside the matchup prediction |
| `apps/web/src/components/` | A small `Points` formatter component, or `lib/format.ts` gains `formatPoints` |
| `apps/web/src/features/.../*.test.tsx` | Every state below |

The vocabulary, fixed here so all three screens agree:

- The heading is **"Projected points"**, never "score" and never "live".
- Each screen carries **"Projection · as of \<playoffstatus stamp\> and \<FPI
  date\>"** and names the two publishers.
- A sentence, once per screen, says what it is: *"Expected points from the
  published odds, using the board's scoring rules. Not a result."*
- The finish term is shown with its own note: *"Top-25 finish estimated from
  the current poll."* — it is the one number that is ours.
- An unavailable term renders **"—"**, a not-eligible one renders **"0.00"**
  with a reason ("not a power-four conference"). These must look different;
  collapsing them is this app's oldest guard (§7).
- A negative contribution is shown as a negative number, with the unranked rule
  named.

### Exit criteria

- Home: nine tiles each with a total, the whole page costing **one** projection
  request; a failed projection leaves the tiles and the names intact (the
  §42/`PickedBy` precedent: a broken index costs the page nothing).
- Board: the panel's team rows sum to its total on screen, and each team's six
  lines sum to that team's total.
- Every state renders with no `undefined`, `NaN`, `null`, or `-0.00`: loading,
  both sources down, one source down, a non-FBS team on the board, a board with
  no teams, and a 429.
- One `<h1>` per page in every one of those states, including the waits — the
  rule the search plan's Phase 4 had to go and fix in five places.
- No sideways scroll at 320 px with a six-row breakdown; 44 px touch targets;
  axe clean in light and dark at 320 and 1280 px.
- A screen-reader-sensible reading order: the number, then what it means, then
  the source — not a bare table of decimals.
- `npm run check:bundle` clean, and the breakdown panel does not pull Supabase
  auth into any viewer chunk.

### Watch out for

- **The home page must not become slower or more fragile.** It currently needs
  one request. The projection is a second, independent one, and the tiles render
  without it.
- **Polling.** The existing `poll.ts` cadence is built for live scores. A
  projection whose inputs move every six hours must not be polled at 15 s; give
  the query a `staleTime` in the minutes and let the page's existing refresh
  pick it up.
- **Do not show a projected total next to a live score in the same visual
  weight.** One is a fact about a game in progress; the other is arithmetic over
  day-old probabilities.
- A six-team breakdown with six rubric lines each is 36 numbers. Design it as
  "team total, expandable to lines" rather than a 36-cell grid at phone width.

---

## Phase 4 — Completion Notes

Built 2026-10-02. Every exit criterion passes except one, which cannot hold on
the plan's own data and was replaced by its honest version (departure 2). The
screens were checked three ways: static-markup component tests for every state,
47 browser checks in headless Edge against the local Worker and the real nine
boards, and one run against the **real publishers** (ESPN FPI plus the four
playoffstatus pages, read once each).

### What was built

| File | What it is |
| --- | --- |
| `apps/web/src/lib/projection.ts` **(new)** | The vocabulary, fixed once: `PROJECTION_MEANING`, `ESTIMATE_NOTE`, `ROUNDING_NOTE`, outcome and source names, `lineView` (one rubric line → number, meaning, source, tone), `provenance` (the "as of" line and the problems list), `coverageNote`, `formatChance` |
| `apps/web/src/lib/format.ts` | `formatPoints` (prints the server's `display`, typographic minus, optional sign; never re-rounds) and `formatStamp` (FPI's instant as a date; playoffstatus's stamp verbatim) |
| `apps/web/src/components/Projection.tsx` **(new)** | `ProjectionLines` (the six lines) and `ProjectionNote` (meaning, estimate note, as-of, problems), shared by board and team |
| `apps/web/src/features/home/HomePage.tsx` | One `['projections']` query; a total on every tile; the note once under the grid |
| `apps/web/src/features/board/ProjectionPanel.tsx`, `useBoardProjection.ts` **(new)** | Board total, then one `<details>` row per team opening to its six lines |
| `apps/web/src/features/team/ProjectionPanel.tsx`, `useTeamProjection.ts` **(new)** | The team's total and six lines, beside the matchup prediction |
| `apps/web/src/lib/api.ts`, `poll.ts`, `features/admin/useAdminWrite.ts` | Three calls, three keys under one `'projections'` prefix, `POLL.projectionMs` (5 min), and admin-write priming |
| `packages/shared/src/api/responses.ts` | `TeamProjectionResponse` |
| `apps/api/src/services/projection.ts`, `routes/projections.ts` | `getTeamProjection` and `GET /api/teams/:teamId/projection` |
| `packages/shared/src/scoring.ts` | The one-line rubric fix below |

### Seven departures, each a decision

**1. A third route: `GET /api/teams/:teamId/projection`.** The plan's scope for
this phase was screens only, but Phase 3 shipped no per-team read and the team
page had nothing to call. Fetching an owner's whole board to show one team would
not work for the ~700 teams nobody has picked, and would tie the team page to
the pick index, which is garnish there by design. The route accepts either of a
team's two addresses through the existing `resolveTeam`, so a provider-id page
makes **no** PostgREST request (asserted). It has **no composite cache**: the
board reads cache because they cost a Postgres round trip, and this one's five
reads are already cached documents whose envelopes carry the right freshness. It
depends on nobody's selections, so `forgetProjections` needs no line for it.

**2. "The panel's team rows sum to its total on screen" was replaced, as Phase 3
predicted.** On the plan's eight worked teams the printed rows sum to **22.64**
and the board total, summed unrounded and rounded once, is **22.65**. Texas's own
six lines print as 5.74 against a 5.73 total. The panel prints the API's
`total.display` and says, in a small line under the rows: *"Totals are added up
before rounding, so the figures above can differ from them by a cent."* The tests
pin both halves: the rows sum to 22.64, the total says 22.65, and every team's
six printed lines are within three cents of its total.

**3. The home tiles keep the people list's order, not the leaderboard's.** The
tiles render before the projection arrives; reordering them when it lands would
move every tile under the reader's finger, and would present someone as
"winning", which the plan forbids. The leaderboard's sort is still the API's,
for any later screen that wants it.

**4. The board panel sits below the six cards, not between the header and
them.** §51 puts what a team is doing now ahead of everything; on a phone, six
rows of totals above the cards would push the live information down by a
screen. The rows are native `<details>`/`<summary>`, so opening one needs no
script, works from the keyboard (Enter tested in the browser), and every summary
is ≥ 44 px tall.

**5. An admin write now primes and invalidates the projections too.** Not in the
plan's scope. `/api/projections` joined `PUBLIC_INDEX_PATHS` (a rename or a new
person moves the leaderboard, which names everybody) and
`/api/users/:id/projection` joined `publicPathsFor`. `useAfterAdminWrite`
invalidates the whole `'projections'` prefix. It is the browser-side twin of
Phase 3's `forgetProjections`: without it the administrator would add a team,
watch the board change, and watch the projected total sit still for the route's
two minutes.

**6. The board's Refresh button refetches the projection as well.** "Let the
page's existing refresh pick it up" read literally. Otherwise the projection is
reread every five minutes (`POLL.projectionMs`), whatever the board is doing: a
live game moves the board every 15 s and the projection not at all.

**7. The home tile's accessible name had no spaces between its parts.** It was
announced "Casey6 teams", a pre-existing bug the new tests exposed. Real spaces
now separate the parts (a grid ignores them on screen).

### The rubric fix this phase forced

**With both publishers down and the poll up, every board got a total made of
nothing but our own estimate.** The finish line needs only the poll, so it stays
`known` when FPI and the scrape are both gone. `projectTeamAtWeight`'s
`anyKnown` counted it, so each team "had" a total, `teamsCounted` read 6 of 6,
and the home page would have shown nine confident totals during a double outage.
Phase 3's "both down" drill never saw it because `SPORTS_PROVIDER_FAULT=all`
also takes the poll down. It surfaced in this phase's first team-route test.

The code's own comment already said *"a total needs at least one quoted number
behind it"*. The check now requires a known line **other than** `final_ranking`,
which matches the comment and §4's licence: nothing computed by us alone may be
a projection. Two new tests in `scoring.test.ts` pin it, and one API test asserts
no board is "covered" under `SPORTS_PROVIDER_FAULT=projections,odds`. No existing
test relied on the old behaviour, and the eight worked rows are unaffected.

### What the real publishers looked like on screen, 2026-10-02

| | |
| --- | --- |
| Boards | 9, **all 6 of 6** on real data (mock mode shows 3 to 6 of 6, because the mock roster lacks real teams) |
| Range | Jeremiah 11.78 down to Jon **−1.96**; two boards negative |
| FPI stamp | `Oct 2` (its `lastUpdated` of the same morning) |
| playoffstatus stamps | Still **Sat Sep 26 11:30 pm** (SEC, Big 12) and **Sun Sep 27 2:45 am** (ACC, Big Ten) on Oct 2: six days old, two pages behind the other two, exactly as Phase 2 described |
| Labels | `ESPN FPI` on the national half, `playoffstatus.com` on the conference half, `Our estimate, from the current poll` on every finish line |
| Texas | 5.77 (the plan's worked row said 5.73 three days earlier) |

The home page's as-of line on real data reads: *"Projection · as of Oct 2 (ESPN
FPI) and Sun Sep 27 2:45 am for ACC and Big Ten, Sat Sep 26 11:30 pm for Big 12
and SEC (playoffstatus.com)"*. It is long, but it is true, and on a team page it
shrinks to that team's own conference's stamp.

### Exit criteria, as checked

| Criterion | How it was checked |
| --- | --- |
| Home: a total on every tile, **one** projection request, a failure costs nothing | Component tests (one `['projections']` key; failed, 429 and loading leave all tiles and names); browser: one `/api/projections` request per load, and every projection route aborted leaves 9 tiles and a quiet line, no alert |
| Board: rows sum to total | Replaced, see departure 2 |
| Every state clean: loading, both down, one down, non-FBS team, no teams, 429 | Component tests for each, asserting no `undefined`/`NaN`/`null`/`-0.00` in seen **and** spoken text |
| One `<h1>` in every state, including the waits | Component tests per state; browser on all three pages |
| 320 px, 44 px targets, axe light/dark at 320/1280 | Browser: no sideways scroll at 320 px with **every** breakdown open; summaries 44–56 px; axe (WCAG 2.0/2.1 A, AA) clean on `/`, a board, and a team page in both schemes at both widths, breakdowns open |
| Reading order: number, meaning, source | Spoken-text order asserted for the board total, a team row ("5.73 points: Texas") and a line ("0.73 National champion 14.6% chance × 5 pts ESPN FPI") |
| `check:bundle` clean, no auth in viewer chunks | `check:bundle` clean on a fresh build; the only reference to the auth chunk is the existing lazy `import()` behind admin sign-in |

The browser script is `phase4.mjs` in this session's scratchpad. Like every
earlier browser run, it is outside the repo because it needs Edge, which CI does
not have.

### Things Phase 5 will get wrong if nobody says so

- **A 200 that knows nothing carries no reference number the screen can show.**
  The plan's Phase 5 exit criterion says every drill produces *"a labelled,
  200-level degradation with a reference number"*. The request id travels only
  in the `X-Request-Id` header, and `getPublic` does not expose headers on
  success, so the "both down" panel names the dead publishers but cannot quote
  a reference. Either add `requestId` to the three projection bodies (set per
  response, **outside** the cached composite, or every cached read repeats the
  builder's id) or accept "the header has it" and say so in `ops.md`.
- **Use a free port for drills, and check it is free.** This phase lost time to
  a workerd left over from **an earlier session** still holding 8788. Every
  "`--var` doesn't work" symptom was that old process answering, and stopping
  the `npx wrangler` wrapper from a tool does **not** always stop its workerd
  child. Before trusting a drill, read `/api/health`'s `provider` and
  `Get-NetTCPConnection -LocalPort <port> -State Listen`.
  `--var SPORTS_PROVIDER:espn CONFERENCE_ODDS_PROVIDER:playoffstatus "ESPN_USER_AGENT:…"`
  works; put the publishers in one `--var` list.
- **Drill `projections,odds` as well as `all`.** `all` takes the poll down too
  and hides the case the rubric fix above exists for. The four drills that
  matter are `odds`, `projections`, `projections,odds` and `all`, and they
  produce four different screens.
- **`CONFERENCE_ODDS_PROVIDER` is still `mock` in `[env.production.vars]`.**
  With production's current settings (real FPI, mock odds) the screens say
  *"Projection · as of Oct 2 (ESPN FPI) and mock data (conference odds)"*, and
  every conference line is labelled `Mock data`. That mixed case was found while
  writing these notes; it is handled and tested, and it is honest. But it is
  not the feature, so flip the setting in the same deploy as the site.
- **The as-of line on the home page is long on real data**, because the four
  pages carry two stamps. It wraps cleanly at 320 px (checked), but if the owner
  finds it noisy, the per-conference list could move behind a `<details>`. The
  team page already shows only its own conference's stamp.
- **Prettier needed two passes on two of the new test files.** The first
  `--write` left them failing `format:check`. Run `format:check` after
  `format`, not instead of it.
- **`docs/playoffstatus-notes.md` is still owed** (Phase 2's handoff), and
  `ops.md` needs the third route, `POLL.projectionMs`, and the new
  `PUBLIC_INDEX_PATHS` entry.

---

## Phase 5 — Docs, drills, and the deploy

**Goal:** the feature is documented, drilled, deployed, and its cost measured.

### Scope

- **`README.md`** — "Testing projected points on your machine", in the existing
  Level A/B/B2/C convention, including how to drill each source's failure.
- **`docs/espn-notes.md`** — a section on the FPI endpoint: the third host, the
  name-indexed columns, the four field sums, the 138-team coverage, the daily
  `lastUpdated`.
- **`docs/playoffstatus-notes.md` (new)** — the four URLs, the markup, the three
  parsing traps, the column sums, the one alias, the verbatim stamp, and
  `robots.txt`. Whoever fixes this scrape in a year will have nothing else.
- **`docs/ops.md`** — the two new cache categories and their KV cost, the new
  env var, the new routes, what to watch after the release, and what to do when
  the scrape breaks (the labelled FPI fallback, and how to turn it on).
- **`context/project-notes.md`** — the routes, the new source, and the honest
  limitations: the cadence, the modelled Top-25 term, the two sources
  disagreeing, the scrape.
- **Drills**: FPI down, odds down, both down, a redesigned page (feed the parser
  a mangled fixture), a renamed FPI column, a dropped conference row.
- **The deploy**, per `docs/ops.md`, then `npm run smoke`, then
  `npm run verify:rls` — it is a new public route, which is when that script
  earns its keep.
- **Read the KV counter the day after**, and expect the new categories to be
  small: `projection_inputs` and `conference_odds` at about four writes each.

### Exit criteria

- `npm run verify` green; smoke green against the deployed Worker; `verify:rls`
  44/44.
- Every drill produces a labelled, 200-level degradation with a reference
  number, and none produces a 0.00.
- The owner opens the live site on a phone, reads a total, taps into a board,
  and can tell from the screen alone where each number came from and how old it
  is.
- `docs/ops.md` records the measured KV writes and CPU for the new reads.

---

## Risks and costs

| Risk | Size | What holds it |
| --- | --- | --- |
| **playoffstatus redesigns its pages** | Likely eventually; the whole conference half of the rubric | The parse fails loudly (row count + column sums + two-way join), the terms go `unavailable` with a label, and FPI's `probwinconf` is a documented fallback for the champion term |
| **ESPN reorders or renames FPI columns** | Moderate | Columns read by name, validated, field sums asserted |
| **The two sources disagree by up to ~0.75 points per team** | Real today | Neither is averaged; the screen names the source; both are logged for comparison |
| **Our Top-25 estimate is the one invented number** | Inherent | One named constant per knob, labelled on screen, and it converges to the fact as the season ends |
| **Reading a projection as a result** | The main product risk | Vocabulary fixed in Phase 4: "Projection", "Not a result", source and stamp on every screen |
| **KV budget** | Small | 6 h TTLs, cron-warmed, ~8 writes a day against a 700-write warning |
| **CPU** | Small but watch it | A cold board already peaked at 44 ms (project-notes §7). The projection parses two documents, so it must be warm: the cron is what makes that true, and the 138-row FPI parse should be measured in Phase 2 the way the 762-name search fold was |
| **Scraping someone's site on a schedule** | Courtesy | Four requests, at most four times a day, `robots.txt` permits it, the project's User-Agent identifies it. If the owner would rather ask permission first, that is a one-line change of cadence |

---

## Open questions for the owner

None of these block Phase 1, which is why the rubric goes first.

1. **Conference runner-up when there is no championship game.** The rubric pays
   2 for a conference runner-up; playoffstatus answers "plays in the
   championship game and loses it". If a conference ever decides its title
   without a game, that term has no source. Accepted reading for now: runner-up
   means losing the championship game.
2. **A board team that is not FBS** has no projection at all. The plan shows
   "5 of 6 teams" rather than a total that silently omits one. Is that the
   wanted behaviour, or should such a board show no total?
3. **Independents.** Notre Dame can score the national-championship and playoff
   points but no conference points. The plan treats that as a structural zero
   and says so on screen.
4. **The Top-25 constants** (0.95 at #1, 0.55 at #25, decay 18) are a
   judgement. The worked table above is what they produce on real teams; they
   are one line to change if the owner wants a flatter or steeper curve.
5. **Whether to show the FPI conference figure beside the playoffstatus one**
   on the breakdown, as a second opinion. Cheap to do, and honest — but it is
   two numbers where the rubric has one.
