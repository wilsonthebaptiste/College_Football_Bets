# ESPN Provider Notes

**Captured 2026-09-18 (UTC), season 2026 regular, week 3.**
Everything here was observed in the payloads under `apps/api/test/fixtures/espn/`,
not read in documentation — ESPN publishes none. Treat it as a snapshot of
observed behaviour with an expiry date, and re-run the capture when something
stops making sense:

```
node --experimental-strip-types scripts/capture-espn-fixtures.ts
node --experimental-strip-types scripts/capture-espn-fixtures.ts --date 20261003
```

Everything in this document is confined to `apps/api/src/providers/espn/` when it
becomes code. Nothing outside that directory may reference an ESPN field name,
URL, or status string (§26, §5).

---

## 1. Confirmed endpoints

Two different ESPN API families are in play, and they do not share conventions.

| Need                      | Endpoint                                                                                                       | Verified                    |
| ------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------- |
| Team list (search source) | `site.api.espn.com/apis/site/v2/sports/football/college-football/teams?limit=900`                              | ✅ 762 teams, all divisions |
| Team meta + record + rank | `…/college-football/teams/{teamId}`                                                                            | ✅                          |
| Team schedule             | `…/college-football/teams/{teamId}/schedule`                                                                   | ✅ full season, 12 events   |
| Day's slate               | `…/college-football/scoreboard?dates=YYYYMMDD&groups=80`                                                       | ✅ `groups=80` = FBS        |
| Season/week calendar      | `…/college-football/scoreboard` (no params)                                                                    | ✅                          |
| Rankings                  | `…/college-football/rankings`                                                                                  | ✅ 5 polls                  |
| Game detail               | `…/college-football/summary?event={gameId}`                                                                    | ✅                          |
| Predictor (standalone)    | `sports.core.api.espn.com/v2/sports/football/leagues/college-football/events/{id}/competitions/{id}/predictor` | ✅                          |
| Conference name           | `sports.core.api.espn.com/v2/…/seasons/{year}/types/2/groups/{groupId}`                                        | ✅ two-hop, see §7          |

`site.api.espn.com` returns the browser-facing shapes; `sports.core.api.espn.com`
returns a hypermedia API where related objects are `$ref` URLs you must resolve
or parse. Both are needed.

### Rate limiting — plan for it

ESPN sits behind Akamai. During this spike, **rapid successive requests returned
bare `403 Forbidden` with an empty body and `Server: AkamaiGHost`** — no
`Retry-After`, no JSON error. The same URLs returned 200 moments later at a
slower pace.

Consequences for `providers/espn/client.ts`:

- A 403 is **not** an authorization failure. Treat it as throttling: retryable,
  backed off, and surfaced as `provider_unavailable`, never as `forbidden`.
- The capture script uses a 700 ms floor between requests and exponential
  backoff over four attempts. That was sufficient.
- This is a second, independent argument for the cache tiers in §7 of the plan:
  the board's six-team fan-out must be served from cache most of the time, or it
  will trip the throttle on a busy Saturday.

An explicit `User-Agent` was sent throughout. Whether it helps is unproven, but
sending one costs nothing and anonymous clients are the first thing a CDN sheds.

---

## 2. Field paths — team snapshot

From `teams/{teamId}` → root key `team` (fixtures `team-ranked.json`, `team-unranked.json`):

| Domain field                      | ESPN path                                                         | Notes                                    |
| --------------------------------- | ----------------------------------------------------------------- | ---------------------------------------- |
| `providerTeamId`                  | `team.id`                                                         | String, e.g. `"251"`                     |
| `name`                            | `team.displayName`                                                | `"Texas Longhorns"`                      |
| `abbreviation`                    | `team.abbreviation`                                               | `"TEX"`                                  |
| `logoUrl`                         | `team.logos[0].href`                                              | `rel` distinguishes `default` / `dark`   |
| `primaryColor`                    | `team.color`                                                      | Hex **without** `#`, e.g. `"af5c37"`     |
| `altColor`                        | `team.alternateColor`                                             |                                          |
| `record.summary`                  | `team.record.items[type="total"].summary`                         | `"2-0"` — display verbatim (§8)          |
| `record.wins` / `losses` / `ties` | `…items[type="total"].stats[name="wins"\|"losses"\|"ties"].value` | Numbers                                  |
| `record.conference`               | `…items[type="vsconf"]`                                           | Absent early in the season               |
| `ranking.rank`                    | `team.rank`                                                       | **Key is absent entirely when unranked** |
| conference (name)                 | _not present_                                                     | See §7                                   |
| conference (hint)                 | `team.standingSummary`                                            | `"2nd in SEC"` — text, not a field       |
| conference (id)                   | `team.groups.id`                                                  | `"8"` = SEC, `"1"` = ACC                 |

### `record.items[]` has more than one entry

`type` values observed: `total`, `vsconf`, `home`, `away`. Select by `type`, never
by index — `items[0]` is `total` today and that is luck, not a contract.

### Ranking: three states, and the absent key is the trap (§7)

`team.rank` is **missing** for an unranked team, not `null` and not `0`. That is
indistinguishable from "the field went away in a schema change", which is exactly
the ambiguity `RankingState` exists to resolve. The rule:

```
team.rank is a number      → { kind: 'ranked', rank, poll: <from rankings feed> }
the teams/{id} call SUCCEEDED and rank is absent
                           → { kind: 'unranked' }        renders "NR"
the call FAILED or the payload did not validate
                           → { kind: 'unavailable' }     renders "—"
```

A successful response with no `rank` is positive evidence of being unranked. A
failed response is not evidence of anything — that distinction is the whole
point of §7, and it is easy to lose.

### A second, sneakier unranked sentinel

In scoreboard payloads, `competitors[].curatedRank.current` is **`99`** for an
unranked team. Ninety-nine is not a rank. Anything `> 25` from `curatedRank` must
normalize to `unranked`.

---

## 3. Field paths — games

Games arrive in **three different payload shapes** with three different score
representations. This is the single largest normalization hazard in the project.

| Source                                                           | Score shape                                | Rank on competitor    |
| ---------------------------------------------------------------- | ------------------------------------------ | --------------------- |
| `teams/{id}/schedule` → `events[].competitions[0].competitors[]` | `score: { value: 59, displayValue: "59" }` | —                     |
| `scoreboard` → `events[].competitions[0].competitors[]`          | `score: "27"` (string)                     | `curatedRank.current` |
| `summary` → `header.competitions[0].competitors[]`               | `score: "27"` (string)                     | `rank: 5`             |

`normalize.ts` must accept all three and produce `number | null`. For an upcoming
game the `score` key is **absent entirely** — not `null`, not `"0"`.

Shared paths (relative to the competition object):

| Domain field       | ESPN path                                                           |
| ------------------ | ------------------------------------------------------------------- |
| `providerGameId`   | `events[].id` / `header.id`                                         |
| `kickoffUtc`       | `events[].date` / `competition.date`                                |
| `week`             | `events[].week.number` / `header.week` (a bare number in `summary`) |
| season year / type | `events[].season.year`, `seasonType.type`                           |
| `homeAway`         | `competitors[].homeAway` — `"home"` \| `"away"` (§19)               |
| neutral site       | `competition.neutralSite` (boolean) → overrides to `'neutral'`      |
| `opponent`         | the competitor whose `team.id` ≠ ours                               |
| `venue`            | `competition.venue.fullName` / `gameInfo.venue.fullName`            |
| `broadcast`        | `competition.broadcasts[0].media.shortName`                         |
| winner             | `competitors[].winner` (boolean, **absent unless final**)           |

### Timestamps have no seconds

ESPN emits `"2026-09-05T19:30Z"` — minute precision, no seconds field. This
parses correctly with `Date.parse`, but it is not the ISO 8601 form the rest of
the application uses. Normalize to a full ISO UTC string (§20):

```
new Date(raw).toISOString()   // "2026-09-05T19:30:00.000Z"
```

### Status vocabulary (§18)

`competition.status`:

```jsonc
{
  "clock": 272, // seconds remaining in the period, 0 when not live
  "displayClock": "4:32", // this is what §11 wants to show
  "period": 3, // 0 for scheduled and postponed games
  "type": {
    "id": "3",
    "name": "STATUS_FINAL",
    "state": "post",
    "completed": true,
    "description": "Final",
    "detail": "Final",
    "shortDetail": "Final",
  },
}
```

Observed `type.name` values, and the mapping `status-map.ts` must implement:

| ESPN `type.name`     | `type.state` | `type.completed` | → `GameStatus`       |
| -------------------- | ------------ | ---------------- | -------------------- |
| `STATUS_SCHEDULED`   | `pre`        | `false`          | `scheduled`          |
| `STATUS_IN_PROGRESS` | `in`         | `false`          | `live`               |
| `STATUS_FINAL`       | `post`       | `true`           | `final`              |
| `STATUS_POSTPONED`   | `post`       | **`false`**      | `postponed`          |
| anything else        | —            | —                | `unknown` + log once |

> ### ⚠ The trap: `state: "post"` does not mean the game was played
>
> A postponed game reports `state: "post"` with `completed: false` and
> `score: "0"` for both teams. Any normalizer that keys off `state === 'post'`
> will render **"Final 0–0"** for a game that never kicked off — a fabricated
> result, which §4 forbids outright.
>
> **Key off `type.completed === true` for finality, and off `type.name` for the
> specific status.** Never off `state` alone.
>
> Real fixture: `game-postponed.json` (Clemson at Florida State, 2020-11-21).

Statuses not observed in captured data but present in ESPN's vocabulary and
plausible for college football: `STATUS_CANCELED`, `STATUS_DELAYED`,
`STATUS_SUSPENDED`, `STATUS_RAIN_DELAY`, `STATUS_HALFTIME`, `STATUS_END_PERIOD`,
`STATUS_FORFEIT`. Map the ones §18 names; let the rest fall to `unknown`. The
`unknown` branch is not a placeholder — it is the designed behaviour, and the
fact that this list is guesswork is precisely why it exists.

### The `result` invariant

`competitors[].winner` is present **only** on completed games. Combined with the
above, the domain invariant `result !== null ⟺ status === 'final'` holds
naturally — derive `result` from `winner` and gate it on
`type.completed === true`. Do not derive it from comparing scores: a postponed
0–0 would come out as a tie.

---

## 4. Bye weeks (§10, §22)

**There is no bye row.** A bye is a _gap in the week numbers_ of the schedule
payload. From the captured fixtures:

```
schedule-ranked   (Texas)      weeks 1,2,3,4,  6,7,8,9,10,11,12,13   → bye = week 5
schedule-unranked (Pittsburgh) weeks 1,2,3,4,5,6,7,8,9,   11,12,13   → bye = week 10
```

Both real captures already cover the case, so no synthetic bye fixture is needed.

Detection: collect `events[].week.number`, take the maximum, and treat any
missing number in `1..max` as a bye. Do not extrapolate past the maximum — that
is the end of the schedule, not a run of byes.

---

## 5. Rankings (§7)

`rankings` returns several polls at once. Observed in week 3:

| `type` | `name`                                       |
| ------ | -------------------------------------------- |
| `ap`   | AP Top 25                                    |
| `usa`  | AFCA Coaches Poll                            |
| `fcs`  | FCS Coaches Poll                             |
| `afca` | AFCA Division II Coaches Poll / Division III |

**No CFP poll exists in week 3** — the CFP committee does not publish until
roughly week 10. Plan assumption §11.4 ("prefer CFP, else AP") is therefore
correct but must degrade quietly: select by `type`/`name`, and if no CFP entry is
present, use `ap` and display _its_ name. Never label an AP rank as CFP (§46).

Entry shape: `rankings[].ranks[]` with `current` (the rank), `previous`,
`points`, `recordSummary`, and `team.id`. `rankings[].occurrence.displayValue`
gives `"Week 3"`; `latestWeek.number` gives `3`.

Also present per poll: `others[]` and `droppedOut[]`. Teams there are **receiving
votes but unranked** — they must map to `unranked`, not to a rank.

---

## 6. Prediction / win probability (§12, §46)

Two routes, and the cheaper one is not always available.

**A. Inline, from `summary`.** The `summary` payload for an _upcoming_ game has a
top-level `predictor` key. The completed-game payload (`game-final.json`) does
**not**. So the inline route works for exactly the case §12 cares about — the
next game — and costs no extra request.

**B. Standalone, from the core API.** Confirmed working:

```
sports.core.api.espn.com/v2/sports/football/leagues/college-football
  /events/{id}/competitions/{id}/predictor
```

```jsonc
{
  "homeTeam": {
    "team": { "$ref": "…/seasons/2026/teams/221?lang=en&region=us" },
    "statistics": [
      { "name": "gameProjection", "value": 82.45, "displayValue": "82.5" },
      { "name": "matchupQuality", "value": 66.881 },
    ],
  },
  "awayTeam": { "…": "…" },
}
```

- The win probability is **`statistics[name="gameProjection"].value`**, a number
  0–100. Select it by `name`; the array order is not a contract.
- The team is a **`$ref` URL, not an id**. Parse the trailing `teams/{id}`
  segment — or, better, do not: the home/away designation on the predictor
  object itself is enough to attach the percentages to the game's own
  competitors, which avoids depending on URL shape.
- `matchupQuality` is _not_ a win probability. Do not display it as one.

**Absence.** A game with no predictor returns HTTP 404 with a JSON body:

```json
{ "error": { "message": "No event found for eventId: 1", "code": 404 } }
```

Captured as `prediction-absent.json`. This must normalize to `null` →
`Prediction unavailable`. It must **never** become `0%`, and nothing may
substitute `odds` or `pickcenter` (both present in the summary payload) for a
prediction — those are betting markets, which §46 explicitly forbids presenting
as a provider prediction.

---

## 7. Conference names need two hops

Neither the team list nor `teams/{id}` carries a conference **name**:

- `teams?limit=900` → no conference field at all
- `teams/{id}` → `team.groups.id = "8"` and `team.standingSummary = "2nd in SEC"`
- `scoreboard` → `competitors[].team.conferenceId`
- `site/…/groups` → returns 25 sample teams per division; **not usable**

The working route is the core API:

```
hop 1  …/seasons/{year}/types/2/groups/80/children?limit=100   → 11 $refs (FBS conferences)
hop 2  …/seasons/{year}/types/2/groups/{groupId}               → { id, name, shortName, abbreviation }
```

Example: group `8` → `{ name: "Southeastern Conference", shortName: "SEC" }`.

Twelve requests total, and conference membership changes at most once a year, so
this belongs in the 24 h L3 cache alongside the team list. Build the map once,
resolve `team.groups.id` against it.

If the map is unavailable, `conference` is `null` and the UI omits it. Parsing
`standingSummary` with a `/ in (.+)$/` regex is a tempting fallback and should be
resisted: it is a sentence, not a field.

---

## 8. Season and week (§21)

The bare `scoreboard` call carries the authoritative calendar:

```jsonc
{
  "season": { "type": 2, "year": 2026 },
  "week": { "number": 3 },
  "leagues": [
    {
      "season": {
        "year": 2026,
        "startDate": "2026-02-01T08:00Z",
        "endDate": "2027-01-28T07:59Z",
        "type": { "id": "2", "type": 2, "name": "Regular Season", "abbreviation": "reg" },
      },
      "calendar": [
        {
          "label": "Regular Season",
          "value": "2",
          "startDate": "2026-08-22T07:00Z",
          "endDate": "2026-12-13T07:59Z",
          "entries": [
            {
              "label": "Week 1",
              "value": "1",
              "startDate": "2026-08-22T07:00Z",
              "endDate": "2026-09-08T06:59Z",
            },
          ],
        },
      ],
    },
  ],
}
```

`season.type`: **1 = preseason, 2 = regular, 3 = postseason** — maps directly to
`SeasonType`. This is the provider-calendar level of the §21 precedence chain,
and it is the only source that knows the **week number**; the date heuristic in
`season.ts` deliberately returns `week: null`.

Note that `leagues[0].season.startDate` is **February 1st**. That is ESPN's
administrative season boundary, not the football season, and it does not
contradict the July rollover in `resolveSeasonFromDate` — the two answer
different questions. Use `season.year` directly; do not derive a year from
`startDate`.

---

## 9. Fixture inventory

`apps/api/test/fixtures/espn/` — regenerate with the capture script; `_manifest.json`
records the URL, purpose, HTTP status, and byte count of every entry.

| File                              | Covers                                                  | Real?           |
| --------------------------------- | ------------------------------------------------------- | --------------- |
| `team-list.json`                  | 762 teams, admin search source (§43)                    | ✅              |
| `team-ranked.json`                | Texas — `rank` present, record parts (§7, §8)           | ✅              |
| `team-unranked.json`              | Pittsburgh — `rank` key absent (§7)                     | ✅              |
| `schedule-ranked.json`            | Full season, **bye at week 5** (§10, §17)               | ✅              |
| `schedule-unranked.json`          | Full season, **bye at week 10**                         | ✅              |
| `scoreboard-20260917.json`        | A day's slate, all final                                | ✅              |
| `scoreboard-20260918.json`        | A day's slate of scheduled (`pre`) games                | ✅              |
| `scoreboard-postponed-slate.json` | 2020-11-21 — 7 postponed alongside 34 final             | ✅              |
| `calendar.json`                   | Season/week calendar (§21)                              | ✅              |
| `rankings.json`                   | 5 polls, no CFP in week 3 (§7)                          | ✅              |
| `game-final.json`                 | Completed game, `winner` present (§9)                   | ✅              |
| `game-upcoming.json`              | Scheduled, **no `score` key**, inline `predictor` (§10) | ✅              |
| `game-postponed.json`             | `state:"post"` + `completed:false` + `0–0` (§18, §50)   | ✅              |
| `game-live.json`                  | `STATUS_IN_PROGRESS`, period 3, clock 4:32 (§11)        | ⚠ **synthetic** |
| `prediction-present.json`         | `gameProjection` 82.45 / 17.55 (§12)                    | ✅              |
| `prediction-absent.json`          | The 404 body (§12, §46)                                 | ✅              |
| `conferences-index.json`          | 11 FBS conference `$ref`s                               | ✅              |
| `conference-single.json`          | Group 8 → "Southeastern Conference"                     | ✅              |

### About `game-live.json`

Seventeen of the eighteen fixtures are genuine captures. The live one is not:
a live college football game exists for about four hours a week, and this capture
did not land in one.

It is **derived from `game-final.json`** by rewinding the status block to the
`STATUS_IN_PROGRESS` vocabulary observed in ESPN's own status objects and
deleting `winner` from both competitors. The status shape is real; the scores are
a completed game's. It carries `"_synthetic": true` and a `_syntheticNote`
explaining itself.

**Replace it with a real capture at the first opportunity.** Re-running the
script during a live Saturday game overwrites it automatically — the synthetic
path only runs when no live game is found. Until then, the Phase 4 live-behaviour
exit criteria are being tested against a shape that is plausible rather than
observed, and that is worth knowing.

---

## 10. Open questions for Phase 2

1. **Does the throttle apply per-IP or per-ASN?** A Cloudflare Worker's egress IP
   is not this machine's. The 403 behaviour may differ from a Worker, better or
   worse. Measure before tuning retry policy.
2. **Is the inline `summary.predictor` always present for upcoming games,** or
   only for games ESPN considers notable? Only one upcoming game was sampled.
3. **Does `curatedRank` ever disagree with the `rankings` feed?** Both are rank
   sources; the plan uses the rankings feed so the poll can be named. Worth one
   assertion in the normalizer tests.
4. **Conference realignment mid-capture.** Group ids are season-scoped
   (`/seasons/{year}/…`). Make sure the cached conference map is keyed by season,
   or a September rollover will serve last year's conferences.
