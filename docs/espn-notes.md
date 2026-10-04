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

Three different ESPN API families are in play, and they do not share conventions.

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
| Football Power Index      | `site.web.api.espn.com/apis/fitt/v3/sports/football/college-football/powerindex?limit=200`                     | ✅ 138 teams, see §12       |

`site.api.espn.com` returns the browser-facing shapes; `sports.core.api.espn.com`
returns a hypermedia API where related objects are `$ref` URLs you must resolve
or parse; `site.web.api.espn.com` returns the shapes behind ESPN's own stats
tables, where figures arrive in parallel `names`/`values` arrays rather than as
named fields. All three are needed.

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

### Phase 2: the 403 is also a client check, not only throttling

When the Worker first ran against ESPN under `wrangler dev` (2026-09-18,
local workerd), **every request got 403**, starting with the very first one.
Probing from the same machine, one request per combination:

| Client             | User-Agent                                                                            | Result |
| ------------------ | ------------------------------------------------------------------------------------- | ------ |
| Node 22 `fetch`    | any value tried, including none and our own                                           | 200    |
| curl               | curl's default (`curl/8.x`)                                                           | 200    |
| curl               | our default, none, `node`, `Mozilla/5.0`, `Wget/…`                                    | 403    |
| curl               | `python-requests/…`, `okhttp/…`                                                       | 200    |
| workerd (a Worker) | our default, none, `node`, `Mozilla/5.0`                                              | 403    |
| workerd (a Worker) | `curl/8.9.1`, `curl/8.9.1 college-football-bets/0.2`, `python-requests/…`, `okhttp/…` | 200    |
| workerd (a Worker) | `college-football-bets/0.2 curl/8.9.1` (the curl token second)                        | 403    |

The pattern is consistent with Akamai judging the User-Agent **together with
the TLS fingerprint**. Node's fingerprint passes whatever it claims to be. For
curl-like fingerprints, which include workerd's, only User-Agents that
_begin_ with a known HTTP-library name pass. The Phase 1 spike never saw this
because it ran in Node.

Consequences:

- `ESPN_USER_AGENT` (a Worker var) overrides the User-Agent. Unset, the
  descriptive default in `client.ts` is sent, and local workerd gets a 403.
- Choosing a User-Agent that begins with another client's name is a decision
  for the owner, not something the code makes silently. ESPN's site API is
  undocumented and unofficial either way.

### Phase 5: the deployed Worker behaves like local workerd

Measured on the first deploy (2026-09-19, a Saturday, from `cfb-api` on
`workers.dev`):

| User-Agent sent                                             | Result                                                              |
| ----------------------------------------------------------- | ------------------------------------------------------------------- |
| The default (`college-football-bets/0.2 (…)`)               | **403 on every request**: calendar, rankings, and all six schedules |
| `curl/8.9.1 college-football-bets/0.5` (the owner's choice) | 200. All nine boards filled, 6 of 6 cards each, 11 live games       |

The app degraded as designed during the 403s: the board answered 200 with six
cards labelled "Sports data temporarily unavailable", and the season came from
the date. Production now sets `ESPN_USER_AGENT` in `wrangler.toml`
`[env.production.vars]`.

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

| File                              | Covers                                                  | Real?        |
| --------------------------------- | ------------------------------------------------------- | ------------ |
| `team-list.json`                  | 762 teams, admin search source (§43)                    | ✅           |
| `team-ranked.json`                | Texas — `rank` present, record parts (§7, §8)           | ✅           |
| `team-unranked.json`              | Pittsburgh — `rank` key absent (§7)                     | ✅           |
| `schedule-ranked.json`            | Full season, **bye at week 5** (§10, §17)               | ✅           |
| `schedule-unranked.json`          | Full season, **bye at week 10**                         | ✅           |
| `scoreboard-20260917.json`        | A day's slate, all final                                | ✅           |
| `scoreboard-20260918.json`        | A day's slate of scheduled (`pre`) games                | ✅           |
| `scoreboard-postponed-slate.json` | 2020-11-21 — 7 postponed alongside 34 final             | ✅           |
| `calendar.json`                   | Season/week calendar (§21)                              | ✅           |
| `fpi.json`                        | 138 rated teams, projection probabilities (§12)         | ✅           |
| `rankings.json`                   | 5 polls, no CFP in week 3 (§7)                          | ✅           |
| `game-final.json`                 | Completed game, `winner` present (§9)                   | ✅           |
| `game-upcoming.json`              | Scheduled, **no `score` key**, inline `predictor` (§10) | ✅           |
| `game-postponed.json`             | `state:"post"` + `completed:false` + `0–0` (§18, §50)   | ✅           |
| `game-live.json`                  | Miami at Wake Forest, 1st quarter 12:33, 0–0 (§11)      | ✅ (Phase 2) |
| `scoreboard-live.json`            | Friday slate: one game live beside two scheduled (§24)  | ✅ (Phase 2) |
| `prediction-present.json`         | `gameProjection` 82.45 / 17.55 (§12)                    | ✅           |
| `prediction-absent.json`          | The 404 body (§12, §46)                                 | ✅           |
| `conferences-index.json`          | 11 FBS conference `$ref`s                               | ✅           |
| `conference-single.json`          | Group 8 → "Southeastern Conference"                     | ✅           |

### About the live fixtures

All nineteen fixtures are genuine captures. Phase 1's `game-live.json` was
synthetic: no game was live during that capture, so it was derived from a final
game. It was replaced during Phase 2 by a real capture, taken at
2026-09-18T23:40Z during event 401858226. `scoreboard-live.json` came from the
same minute, with the `groups=80&limit=300` query the live overlay uses.
`_manifest.json` records both.

---

## 10. Open questions from Phase 1, and what Phase 2 found

1. **Does the throttle apply per-IP or per-ASN?** _Partly answered._ The 403 is
   not only rate-based. There is also a client check that local workerd fails
   with the default User-Agent (§1, "Phase 2"). A deployed Worker fails it the
   same way, and passes with a curl-style User-Agent (§1, "Phase 5"). The retry
   policy is unchanged: one retry after 250–750 ms, then `provider_unavailable`.
2. **Is the inline `summary.predictor` always present for upcoming games?**
   _Answered for the cases that matter._ It is present in the upcoming-game
   capture and **absent once a game is live** (`game-live.json` has none) and
   when final. The standalone core predictor still answered for a live game
   (Texas Tech–Houston, 2026-09-18). The adapter therefore reads the inline
   predictor first and falls back to the core endpoint, where a 404 means
   "no prediction", not an error.
3. **Does `curatedRank` ever disagree with the `rankings` feed?** _Made moot._
   Ranks come only from the rankings feed, so a card can never show two
   different ranks. `curatedRank` is validated but unused.
4. **Conference realignment.** _Deferred with conferences._ Conference names
   stay application-owned (the `teams` table) in Phase 2. The two-hop lookup
   (§7) arrives with the admin UI in Phase 5, and its cache key must include
   the season.

---

## 11. Phase 2 findings

Found while building and running the adapter against live ESPN:

- **`timeValid: false` means the kickoff time is TBD.** `date` then holds a
  placeholder, usually midnight Eastern. Six of Texas's twelve games had it at
  capture time. It is exposed as `Game.kickoffTbd`, so the UI can say "TBD"
  instead of showing a made-up 12:00 AM.
- **The schedule's root `season` is ESPN's current season, whatever was
  asked.** `requestedSeason` says which season the events belong to. The
  adapter checks it and refuses a mismatched schedule as `invalid_response`,
  rather than caching last year's games under this year's key.
- **The schedule endpoint carries no score for a game in progress.** In the
  live run it listed Texas Tech–Houston as in progress, with a clock but no
  `score`, while the scoreboard had 7–10. The schedule is also cached for 15
  minutes. Live state therefore comes from the day's scoreboard, which is
  cached for 25 s and laid over the schedule for games near kickoff. When the scoreboard can't be
  fetched, the card is marked `stale` rather than showing the schedule's
  out-of-date status as current.
- **`scoreboard?dates=` is a US Eastern calendar day.** The 2026-09-18
  scoreboard includes a game at `2026-09-19T02:30Z`, which is 10:30 PM ET on
  Friday. Slate keys are computed in `America/New_York`. `limit=300` keeps a
  full Saturday on one page.
- **Parse cost is small but not zero.** Measured in Node on real payloads:
  - a full Saturday scoreboard, about 7 ms;
  - the 1.9 MB team list, about 6.6 ms;
  - a summary, about 2 ms;
  - a schedule, about 1 ms.

  Only normalized results are cached, so each payload is parsed once per
  refresh, not on every request. The scoreboard is the one to watch against the
  free tier's 10 ms CPU limit.

- **Record entries come in three shapes**, one per payload family: `record[]`
  with `displayValue`, `record[]` with `summary`, and `records[]` with
  `summary`. **Summary payloads carry `location` but no `shortDisplayName`.**
  `validate.ts` reads whichever of these is present.

---

## 12. The Football Power Index (projected points)

Added for projected points (context/predicting_score.md). This is the source of
every national probability in the rubric, and it is the one ESPN endpoint whose
shape makes a silent wrong answer easy.

`GET site.web.api.espn.com/apis/fitt/v3/sports/football/college-football/powerindex?region=us&lang=en&contentorigin=espn&limit=200`

- **A third host family.** `site.web.api.espn.com` with an `/apis/fitt/v3`
  prefix, nothing like the other two. `ESPN_FITT_API` is beside them in
  `providers/espn/client.ts`, and it is reached with the same client and the
  same `ESPN_USER_AGENT` — §1's User-Agent rule applies here too, so this call
  must not be given headers of its own.
- **One page, all of it.** `pagination: { count: 138, pages: 1 }` at
  `limit=200`, about 830 KB. 138 of the provider's ~762 teams are rated, so
  **an FCS team has no projection at all** — an `unavailable`, never a zero,
  the same asymmetry search already accepted for conferences and schedules.
  `pages > 1` is refused outright: a partial table would silently give every
  team past the cut no projection.
- **`lastUpdated` is a daily morning recompute** (observed `08:00Z` two days
  running). It is carried verbatim to the screen; a projection is never called
  "live", because its inputs move about once a day.
- **The deployed Worker reads it too**, with production's `ESPN_USER_AGENT` and
  no headers of its own: the first cron run after the projected-points release
  (2026-10-02) reported "138 teams rated", and production's totals matched a
  local run to the cent. Parsing it costs ~5.8 ms in Node, almost all of it
  `JSON.parse` on 830 KB, which is why the cron, not a viewer, refreshes it.

### The columns are positional, and that is the trap

Each team carries `categories[].name === 'fpi'` with a bare `values` array.
What each slot means comes from the **`names`** array on the _document's_ own
`categories` entry — not from the team's. The order observed was:

```
fpi, fpirank, rankchange7days, projectedw, projectedl, probwinout, prob6wins,
probwindiv, probmakeplayoffs, probmaketitlegame, probwintitle, probwinconf,
numwins, numlosses, numties
```

So `probwintitle` is the **eleventh** column, with projected wins and losses
sitting a few places away. Three consequences, all of them enforced in
`validate.ts`:

- **Read by name, resolved once per payload.** The sibling `labels` array has
  nulls in it and the order is ESPN's to change. An off-by-one here does not
  crash: it puts "projected losses" where a probability belongs, and 1.6 is a
  perfectly plausible-looking probability once divided by 100.
- **A renamed column fails validation** rather than reading its old index.
- **Values are percentages, with float noise** (`27.500000000000004`). They are
  divided by 100 in `normalize.ts` and nowhere else.

### Four field sums, which cost nothing and catch a broken read

One champion, two finalists, twelve playoff places, ten FBS conference titles.
Summed across every rated team:

| Sum of              | Should be | 2026-10-01 | 2026-10-02 |
| ------------------- | --------- | ---------- | ---------- |
| `probwintitle`      | 100       | 99.8       | 99.8       |
| `probmaketitlegame` | 200       | 200.1      | 199.9      |
| `probmakeplayoffs`  | 1200      | 1200.4     | 1200.0     |
| `probwinconf`       | 1000      | 1000.9     | 999.9      |

They are a **warning**, not an error: a publisher's rounding drift must not take
the feature down, and a sum that is wildly wrong will have broken the per-team
figures too. Tolerances are about 1% of each expected value.

**Which of the four actually catches a truncation is not the obvious one.** The
payload arrives sorted by FPI, so dropping the tail loses almost no title
probability — the top half of the league holds ~100% of it between them — and
`probwintitle` sails through. Measured on a deliberately halved payload:
`probwintitle` and `probmaketitlegame` stayed in tolerance while
`probmakeplayoffs` (1185 of 1200) and `probwinconf` (710 of 1000) broke. That
is the reason for four checks rather than one.

### `fpirank` is not a playoff probability, and need not agree with one

`fpirank` is ESPN's ordering of every rated team by strength. It carries the
Top-25 finish estimate for a team the poll does not list, which is the only
evidence such a team has.

It is worth saying plainly that a high `fpirank` and low playoff odds are not a
contradiction: measured on the same payload, Texas A&M was **FPI rank 16 with
3.2% playoff odds**, unranked in the AP poll. FPI rank is how good a team is;
playoff odds are the path in front of it. A strong team that has already lost
is both. Phase 1 of projected points recorded this pair as an inconsistency in
the plan's worked table, and the captured payload settled it the other way.

## 13. A whole week in one request (the matchup board)

Observed 2026-10-03 for the matchup board (context/plan-matchup-board.md,
Phase 1). Fixtures: `scoreboard-week-5.json` and `scoreboard-week-6.json`.

```
GET site.api.espn.com/…/college-football/scoreboard?week=6&seasontype=2&groups=80&limit=300
```

- **The same shape as a day's slate.** `events[]` with `competitions[0]` exactly
  as `scoreboard?dates=` returns them, so `readScoreboard` and `toProviderGame`
  read it unchanged. No new parser.
- **The root says what was answered.** `season.year`, `season.type`, and
  `week.number` are at the root, as on the bare scoreboard. `getWeekGames`
  refuses a payload whose root disagrees with what it asked for, the same way a
  schedule for the wrong season is refused.
- **It is large because of how much each game carries.** Week 5 was 1.07 MB
  and week 6 0.80 MB, for 59 and 58 games. Measured on week 6: the
  `competitors` blocks (full team objects, links, logos, records) are about
  455 KB, `leaders` 102 KB, and **`odds` 74 KB** — betting lines sit inside
  every event, and nothing reads them (§6; the validator never touches the
  key). The calendar is only 4 KB. Normalized, a week is about **46 KB**, and
  that is what the cache stores.
- **Parse cost, measured in Node 22** (JSON.parse + validate + normalize, 30
  runs): week 5 median **8.3 ms**, first run 16.5 ms; week 6 median 5.6 ms,
  first run 19.3 ms. Against the documented 10 ms CPU limit, a cold isolate's
  first read is over it, the same order as the cold board (project-notes §9).
  The cron warms the current week so a viewer's request rarely pays it.
- **`groups=80` includes FBS-against-FCS games.** LSU against McNeese was in the
  week-5 document. Cross-checked against every owned team's own schedule: see
  below.
- **Days.** The four week-6 games stamped `2026-10-11` in UTC are Saturday-night
  Eastern kickoffs, and Iowa at Washington (`2026-10-10T01:00Z`) is a Friday
  night game. Group by `easternSlateKey`, never by `kickoffUtc.slice(0, 10)`.
- **TBD kickoffs** are `timeValid: false` with a `04:00Z` (midnight Eastern)
  placeholder, as everywhere else. Four in week 6.
- **A live row carries `competitions[0].situation`** — `downDistanceText`,
  `possession`, `possessionText`, `lastPlay`, `isRedZone`, timeouts. Read since
  Phase 3 of the matchup board: see §14.

### The calendar's weeks

`leagues[0].calendar[]` (the same block §8 shows) is read by
`readCalendarWeeks` / `toSeasonWeeks` for the week list. One phase per ESPN
season type (`value` "1"…"4"); each phase's `entries[]` carry `value` (the week
number), `label`, `startDate`, `endDate`. The postseason is not weekly:
**"Bowls" is week `1` and "CFP" is week `999`, and their windows overlap.** A
client must print `label`, never "Week {n}". A calendar whose
`leagues[0].season.year` is not the season asked about yields no weeks.

### Cross-check: does `groups=80` miss any owned team's game?

Run 2026-10-03 against the live pick index (54 teams) and each team's own
`teams/{id}/schedule?season=2026&seasontype=2`: **108 team-weeks, 90 games, 18
byes, and every one of the 90 games was in the week document** (weeks 5 and 6).
The one owned team with an FCS opponent that week (LSU–McNeese, week 5) was
included. Re-run it at the start of each season: a team moving to or from FBS
is the case that could change the answer.

## 14. Inside a game: the summary's box score, and the slate's situation

Observed 2026-10-03 for the matchup board's game page
(context/plan-matchup-board.md, Phase 3). Fixtures, captured **during** the
games of that Saturday at 23:07Z: `game-live-matchup.json` (California at UNLV,
4th quarter), `game-upcoming-matchup.json` (Miami at Clemson, before kickoff),
`scoreboard-week-5-live.json` (the week document with 12 games in progress),
and `scoreboard-20261003-live.json` (the day's slate, seconds later). The older
`game-live.json`, `game-final.json`, and `game-postponed.json` agree with
everything below.

```
GET site.api.espn.com/…/college-football/summary?event={id}
```

The same request `getGame` and `getPrediction` make; `getGameDetail` reads
different keys of it, through `readGameDetail` / `toGameDetail`, and caches it
under its own key (`game_detail`), because its lifetime follows the box score.

| What                        | Where                                                                                                                     | Notes                                                                                                                                                                                                                                                                                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Points per quarter          | `header.competitions[0].competitors[].linescores[].displayValue` (`"7"`)                                                  | By `homeAway`, never by order. Absent before kickoff. Overtime periods are simply more entries; the app labels 5 as "OT", 6 as "2OT"                                                                                                                                                                                                                 |
| Team stats                  | `boxscore.teams[].statistics[]`: `{ name, label, displayValue, value }`                                                   | **Read by `name`.** `value` is a number, the string `"-"`, or missing (`totalYards` is `"-"` in every capture; `fourthDownEff` `"-"` when 0-0), so the app carries `displayValue` and a number only when `value` is one. `possessionTime` is padded (`" 2:27"`). The team is `team.id`, matched to the header's home and away                        |
| **Season averages**         | The **same** `boxscore.teams[].statistics[]`, before kickoff                                                              | Different names: `totalPointsPerGame`, `yardsPerGame`, `passingYardsPerGame`, `rushingYardsPerGame` and the four `…Allowed`. No `value` at all, only `displayValue`. A different measurement in the same place — the app reads a separate name list and labels the table "Season averages" (`statsKind: 'season_average'`)                           |
| Leaders                     | `leaders[]` per team → `leaders[]` per category (`name`) → `leaders[0]`                                                   | Categories `passingYards`, `rushingYards`, `receivingYards` (also `sacks`, `totalTackles`, not shown). The line is `displayValue` ("11/22, 177 YDS, 3 TD"); the name `athlete.displayName`. **Before kickoff these are season leaders** ("94/106, 1,211 YDS, 14 TD"). A category with no one in it has no `leaders` array                            |
| Scoring plays               | `scoringPlays[]`: `period.number`, `clock.displayValue`, `team.id`, `type.abbreviation`, `text`, `homeScore`, `awayScore` | In game order. `homeScore`/`awayScore` are the score after the play. Absent before kickoff                                                                                                                                                                                                                                                           |
| Current drive               | `drives.current.description` ("4 plays, 5 yards, 1:41"), `drives.current.team.id`                                         | Live only; a final has `drives.previous` alone                                                                                                                                                                                                                                                                                                       |
| **In-game win probability** | `winprobability[]`: `{ homeWinPercentage, tiePercentage, playId }`                                                        | **0–1 despite the name** (0.9229, not 92.29). One entry per play: 167 in the live capture, 177 in the final one. **A final game still carries the whole series**; the app returns none for a final. Empty before kickoff and for a postponement. A different model from the pregame predictor (§6), labelled "ESPN win probability (live)" on screen |
| Betting                     | `odds`, `pickcenter`, `againstTheSpread`                                                                                  | **Siblings of `boxscore`.** Never read; a test asserts no string found only under these keys reaches a normalized `GameDetail`                                                                                                                                                                                                                       |

### Down, distance, and possession are not in the summary

They are in the scoreboard: `events[].competitions[0].situation`, on the day
slate (and the week document) while a game is in progress:

```json
{ "possession": "2439", "downDistanceText": "1st & 10 at UNLV 48",
  "shortDownDistanceText": "1st & 10", "possessionText": "UNLV 48",
  "lastPlay": { "text": "(07:40) Shotgun #11 J.Brousseau pass incomplete …",
                "probability": { "homeWinPercentage": 0.9229, … } } }
```

- `possession` is **absent** around a score or a kickoff (4 of the 12 live
  games in the capture had a last play and nothing else). The app then says no
  more than it has.
- "End of 3rd Quarter" carries the last situation of the quarter; the status
  detail says what is happening.
- The app reads it only from the 25-second live slate the overlay already
  fetches, so it costs no request and is exactly as old as the score beside it.
  A row whose slate could not be read shows no situation, never an old one.
