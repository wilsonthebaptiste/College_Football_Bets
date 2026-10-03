# playoffstatus.com, as observed

The conference half of projected points (context/predicting_score.md) is
scraped from four pages on playoffstatus.com. It is the only source anywhere
that publishes a **runner-up** probability — the chance a team reaches its
conference championship game and loses it — which is why the owner chose it
over ESPN FPI's `probwinconf` for both conference lines of the rubric.

The site publishes no API and no documentation. Everything here was observed
from the live pages between 2026-09-30 and 2026-10-02 and is saved as fixtures
in `apps/api/test/fixtures/playoffstatus/`, with a `_manifest.json` recording
the date, sizes, row counts, column sums, and stamps of each capture. **If the
scrape breaks, this page and those fixtures are all there is.**

Only `apps/api/src/providers/playoffstatus/` knows the site exists — the mirror
of the rule that only `providers/espn/` knows ESPN does (project-notes §2).

- [The four pages](#1-the-four-pages)
- [The markup](#2-the-markup)
- [Three parsing traps](#3-three-parsing-traps-in-the-order-they-bit)
- [The integrity checks](#4-the-integrity-checks)
- [Matching names to teams](#5-matching-names-to-teams)
- [The page's own stamp](#6-the-pages-own-stamp)
- [Courtesy: robots.txt and the request budget](#7-courtesy-robotstxt-and-the-request-budget)
- [When it breaks](#8-when-it-breaks)
- [How it compares with ESPN FPI](#9-how-it-compares-with-espn-fpi)

---

## 1. The four pages

One page per power-four conference, and only those four: the rubric pays
conference points to the ACC, Big Ten, Big 12, and SEC and to nobody else.

| Conference | Path on `https://www.playoffstatus.com`           | Rows | Size   |
| ---------- | ------------------------------------------------- | ---- | ------ |
| SEC        | `/secfootball/secfootballpostseasonprob.html`     | 16   | ~25 KB |
| Big Ten    | `/big10football/big10footballpostseasonprob.html` | 18   | ~26 KB |
| Big 12     | `/big12football/big12footballpostseasonprob.html` | 16   | ~25 KB |
| ACC        | `/accfootball/accfootballpostseasonprob.html`     | 17   | ~26 KB |

- **The Big Ten path is `big10`, not `bigten`.** `bigten` is a 404.
- **67 rows, which is exactly the four conferences' membership** in ESPN's own
  conference map (ACC 17, Big 12 16, Big Ten 18, SEC 16). So no power-four team
  is missing from the scrape, and the join below can be asserted in both
  directions.
- **There is no per-season URL.** The pages show the season in progress and
  nothing else. `getConferenceOdds(season)` accepts a season because the
  interface and the cache key are season-scoped, not because it can ask for one.
- The paths live in `CONFERENCE_PAGES` in `conferences.ts`, beside
  `POWER_FOUR = ['ACC', 'Big Ten', 'Big 12', 'SEC']` — ESPN's own short names,
  pinned by a test against the captured conference map. A conference that
  renamed itself at ESPN would otherwise silently make every one of its teams
  "not eligible".

## 2. The markup

One `<table>` per page. Each team row:

```html
<tr>
  <td class="tblteam"><a href="texasstandings.html">Texas</a></td>
  <td>…W…</td>
  <td>…L…</td>
  <td><span style="color:#008000;">19%</span></td>
  <!-- "<Conf> Champions" -->
  <td><span style="color:#008000;">36%</span></td>
  <!-- "Championship Game Participate" -->
  …
</tr>
```

- Rows are recognised by their **team cell** (`td.tblteam`), not by position,
  so the parse does not care how many header rows sit above them.
- Columns are positional, left to right: team, W, L, **champions** (cell 3),
  **participate** (cell 4). There are no column ids to read by name, which is
  why the column sums in §4 are not optional.
- Values are **whole percents** (`19%`). Anything below one percent is
  published as `&lt;1%` and read as **0.5**. So the conference half of every
  projection has whole-percent granularity: ±0.02 points per line, which is why
  the plan says the last decimal of a conference term means little.
- Each page carries its own stamp in `<div class="datetime">` (§6).

## 3. Three parsing traps, in the order they bit

All three are described again where they are handled, in `parse.ts`.

1. **A single regex over the whole table silently dropped one row per page**
   (SEC 15 of 16, Big Ten 17 of 18). Nothing else looked wrong. The parse now
   walks rows, then cells, and the caller checks the row count and the column
   sums rather than trusting the walk.
2. **The team cell holds two spellings**, a wide one and a narrow one for small
   screens, so stripping the tags yields `Mississippi St.Miss. St.`. The parse
   reads `span.wide` when there is one, else the anchor's own text.
3. **Entities must be decoded before anything else**: `Texas A&amp;M`,
   `&lt;1%`, and the `&#160;` between the words of the stamp.

Every function in `parse.ts` is **total**: given a redesign, an error page, a
truncated download, or an empty string, it returns a value and never throws.
Whether the value is usable is `provider.ts`'s question. A property-style test
truncates and mangles each captured page at 300 random points and asserts that
nothing ever throws.

## 4. The integrity checks

HTML cannot be validated the way JSON can, so **these numbers are the
validation**. They are the only warning anyone will get that the site changed.

Each conference has one champion and two finalists, so each page's columns
should sum to about 100% and 200%:

| Page    | Champions | Participate |
| ------- | --------- | ----------- |
| SEC     | 100.0%    | 200.5%      |
| Big Ten | 101.0%    | 199.5%      |
| Big 12  | 102.5%    | 200.5%      |
| ACC     | 101.0%    | 202.0%      |

Measured 2026-09-30 and identical on 2026-10-01 and 10-02, with `<1%` as 0.5.

`provider.ts` refuses a page — and with it the whole document, all four pages
or none — when any of these holds:

| Check                                      | Why                                                                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Fewer than **8** rows (`MIN_ROWS`)         | The table was not read at all: a redesign, an error page served with a 200, a truncated download        |
| Any team row without two readable percents | The table's shape moved                                                                                 |
| Champions outside **100 ± 4**              | A dropped row costs several points; whole-percent rounding costs a few. One SEC row removed: 100% → 89% |
| Participate outside **200 ± 6**            | The same, for finalists                                                                                 |

A refusal is a **`provider_invalid_response`**, not an outage, and it is not
retried: a redesign will not fix itself on a second request. The client does
retry once on a 403, 429 or 5xx. A 404 is treated as a redesign (a moved page),
not as a missing team.

**Why all four or none.** A document with fifteen SEC teams in it would pay
fifteen teams from a table known to be wrong and quietly drop the sixteenth.
Refusing the lot sends every conference line to its labelled fallback (§8)
instead.

## 5. Matching names to teams

The pages name teams in the site's own spelling ("Mississippi St.",
"Texas A&M", "Pittsburgh"). They are matched against the provider's team list
(`displayName ?? name`) by a normalized key, in `services/teamNames.ts`:

1. lowercase;
2. `&` → `and`, **before** punctuation goes, or `Texas A&M` collapses to
   `texas am`;
3. punctuation **removed, not replaced with a space** — `N.C. State` must become
   `nc state` to match ESPN's `NC State`, and replacing it with a space gives
   `n c state`, which matches nothing;
4. `St` → `State`.

That resolves **66 of 67**. The one exception is an alias, and it is a nickname
rather than an abbreviation, which is why no rule reconciles it:

```ts
export const TEAM_NAME_ALIASES = { pittsburgh: 'pitt' };
```

**A growing alias table is a sign the normalization is wrong, not a sign of
thoroughness.** Getting rule 3 wrong produced a second unmatched row, which a
second alias would have "fixed".

The join is asserted in **both directions** against the fixtures: every scraped
row matches a team, and every power-four team in the conference map has a row.
At runtime both directions are logged as `projection_join_incomplete` whenever
either is non-empty — the only warning a team rename on either side will give.
A team the join cannot place gets `unavailable` conference lines, never zeros.

## 6. The page's own stamp

```html
<div class="datetime">Sat Sep&#160;26 11:30&#160;pm</div>
```

- **It has no year and no timezone.** It is kept as a verbatim string
  (`computedLabel`) and displayed verbatim. Parsing it into an instant would
  mean inventing a zone, and the reason for carrying it at all is that it is
  the publisher's statement, not ours (§39).
- **The four pages do not agree.** They are recomputed in batches: on every
  capture so far, SEC and Big 12 said `Sat Sep 26 11:30 pm` while Big Ten and
  ACC said `Sun Sep 27 2:45 am`. Nothing can order two such strings without a
  year and a zone. So the document carries a stamp **per page**, its
  document-level `computedLabel` is non-null only when all four agree (on real
  data, the exception), and a team is dated by its own conference's page.
- **The site recomputes after game days, not daily.** On 2026-10-02 both stamps
  were still the ones read on 2026-09-30 — six days old. The screens therefore
  say "as of \<this stamp\>", never our read time, and never "live".

## 7. Courtesy: robots.txt and the request budget

- `robots.txt` was `User-agent: *` / `Disallow:` — everything allowed — when
  read on 2026-09-30 and 2026-10-01.
- The client identifies the project rather than imitating a browser:
  `curl/8.9.1 college-football-bets/0.5 (personal project; +cloudflare-worker)`.
  If the site's owner ever asks us to stop, that is the string in their logs.
  It is deliberately **not** `ESPN_USER_AGENT`, which exists because ESPN's CDN
  judges it; this is a different site.
- **Four requests, about 100 KB, at most four times a day.** The document is
  cached for 6 hours (`conference_odds` in `cache/policy.ts`) in all three
  tiers, and the cron warms it, so a viewer's request is almost never the one
  that fetches. That cadence is a policy choice in one line of `policy.ts`.
- To stop scraping at once, set `CONFERENCE_ODDS_PROVIDER = "mock"` in
  `[env.production.vars]` and redeploy the Worker. Every conference line then
  says "Mock data", which is honest, and nothing else changes.

## 8. When it breaks

What a viewer sees, in order, after the site changes its pages:

| When                                    | What the projection does                                                                                                                                                                                                                                                                                                                |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Up to 6 h after the change              | Nothing visible. The cached document is still inside its TTL                                                                                                                                                                                                                                                                            |
| From the first failed refresh, ≤ 7 days | The **last good copy**, marked stale: "The conference odds may be out of date.", its own (old) page stamps, and a 10-second cache lifetime. The Worker logs `cache_refresh_failed_serving_stale` with the integrity check that failed                                                                                                   |
| After 7 days, or with nothing cached    | The document is unavailable. Each power-four team's **champion** line falls back to ESPN FPI's `probwinconf`, labelled **ESPN FPI**; its **runner-up** line becomes a quoted `0.00` that says "ESPN FPI publishes no runner-up odds, so this line counts nothing". Screens say "Couldn’t load the conference odds" and give a reference |

The fallback needs no switch: it is always offered, and only to a team whose
conference is **known** to be power four (if the conference map is down too,
the conference lines are `—`, never a Mountain West team paid for winning the
Mountain West). Drilled end to end — a redesigned page, and a page with one row
dropped — in `apps/api/test/projections.test.ts`, and on the real runtime with
`SPORTS_PROVIDER_FAULT=odds` (README, "Testing projected points").

**To fix it:**

1. `npm run capture:odds` re-downloads the four pages and ESPN's conference map
   into the fixtures, with a fresh manifest. Read the manifest's row counts and
   sums first: they say which check fails.
2. Change `parse.ts` (markup) or `conferences.ts` (paths) only. Run
   `npx vitest run apps/api/test/providers/playoffstatus.test.ts` and the
   end-to-end test in `apps/api/test/projections.test.ts`.
3. If a team stopped matching, read §5 before adding an alias.

## 9. How it compares with ESPN FPI

The two publishers disagree about conference odds, substantially:

| Team    | playoffstatus "Champions" | ESPN FPI `probwinconf` |
| ------- | ------------------------- | ---------------------- |
| Georgia | 11%                       | 36.3%                  |
| Texas   | 19%                       | 30.2%                  |
| Miami   | 22%                       | 72.7%                  |

Both are internally consistent (each conference's column sums to ~100%), and
they are different models read days apart. The gap is worth up to about **0.75
projected points per team**: on 2026-10-02, with the scrape forced down, Ohio
State's champion line went from **0.27** (playoffstatus) to **1.23** (FPI). The
two are never averaged. playoffstatus is the source; FPI is the labelled
fallback for the champion line only; and the screen names the source of every
line either way.
