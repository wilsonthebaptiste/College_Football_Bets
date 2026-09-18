# College Football Team Board — Implementation Plan

## Phase Checklist

- [x] **Phase 1 — Foundation & Contracts** — ✅ **Complete, 2026-09-18.** Monorepo, strict TS, normalized domain types, season logic, Supabase schema + RLS + seed, admin-only auth, Worker skeleton, ESPN fixture spike. Details, departures from this plan, and ESPN findings are in [Phase 1 — Completion Notes](#phase-1--completion-notes).
  - *Owner follow-ups (not blocking Phase 2):* run `npm run verify:rls` with the two test accounts in `.env`, and the live 403/201 token test (README, Level 3c). Both behaviours are already proven by the automated tests and the Postgres run. These two checks repeat them against the live project.
- [ ] **Phase 2 — Sports Data Layer**: provider interface, ESPN adapter + validators, three-tier cache with centralized TTL policy, board/team/schedule/game/prediction endpoints, error isolation
- [ ] **Phase 3 — Frontend Core**: app shell (no login required), design tokens, home user picker, board page, team cards, loading/error/freshness states, responsive
- [ ] **Phase 4 — Detail & Live**: team detail page, full-season schedule, prediction panel, polling strategy, live game treatment, bye/offseason states
- [ ] **Phase 5 — Admin & Ship**: admin UI (users, team search, add/remove/reorder), server-side authorization tests, a11y + perf pass, deploy, cron warmers, docs

Phases are sequential; each ends at a verifiable state. Phase 3 depends on Phase 2's API contract but not its ESPN accuracy (mock mode covers that). Phase 5's admin UI is deliberately last — seeded data (Phase 1) makes boards real long before an admin screen exists.

---

Derived from [spec.md](spec.md). Section references like `§23` point back to that spec.

---

## 0. How To Use This Plan

Each phase has **Scope**, **Tasks**, **Exit criteria**, and **Watch out for**. Exit criteria are testable — do not advance until they pass. Sections 1–9 are the reference material the phases build against; read them once, then work from the phase sections.

---

## 1. Architecture At A Glance

```
   Browser (React + Vite + TS)
     │  viewers: no token, no session               ┌─── admin only ───┐
     │  admin:   Authorization: Bearer <token>      ▼                  │
     ▼                                         Supabase Auth ─────────┘
   Cloudflare Worker  (/api/*)                 (admin login/session)
     │
     ├─ read routes   → public, no auth, no JWKS hop
     ├─ /api/admin/*  → JWT verify (JWKS, cached) + is_admin() check
     │
     ├─ App-owned data ──► Supabase Postgres
     │                      RLS: public read · admin-only write
     │                      app_users · teams · user_team_selections · admins
     │
     └─ Sports data ─────► Cache tier L1 isolate memory
                           Cache tier L2 Cache API      (skipped on workers.dev)
                           Cache tier L3 Workers KV     (long-TTL only)
                                │  miss / expired
                                ▼
                           ESPN provider adapter ──► ESPN public endpoints
```

Two data planes, deliberately separate (§45):

| Plane | Owner | Storage | Auth model |
|---|---|---|---|
| Users, team identities, selections, ordering | This app | Supabase Postgres | RLS: read = public (`anon`), write = admin only |
| Records, rankings, games, scores, schedules, predictions | ESPN | Cache only, never a table | Read-through, freshness-tagged |

The frontend never sees an ESPN URL or an ESPN JSON shape (§26).

---

## 2. Repo Layout

```
College_Football_Bets/
├── context/
│   ├── spec.md
│   └── plan.md
├── packages/
│   └── shared/                     # zero-dependency, runs in both Worker and browser
│       ├── src/
│       │   ├── domain/             # Team, Game, Ranking, Record, Prediction, Freshness…
│       │   ├── api/                # request/response contract types
│       │   ├── season.ts           # centralized season resolution (§21)
│       │   ├── envelope.ts         # Envelope<T>, Freshness, FieldError
│       │   └── index.ts
│       └── package.json
├── apps/
│   ├── api/                        # Cloudflare Worker
│   │   ├── src/
│   │   │   ├── index.ts            # router + middleware
│   │   │   ├── routes/             # health, users, board, teams, games, admin, meta
│   │   │   ├── middleware/         # requireAdmin (JWKS), cors, errors, request-id
│   │   │   ├── db/                 # supabase client factory, queries
│   │   │   ├── cache/              # policy.ts (TTL table), tiers.ts, swr.ts
│   │   │   ├── providers/
│   │   │   │   ├── types.ts        # SportsDataProvider interface
│   │   │   │   ├── registry.ts     # provider selection by env
│   │   │   │   ├── espn/           # ── ALL ESPN knowledge lives here ──
│   │   │   │   │   ├── client.ts       endpoints + fetch + timeout
│   │   │   │   │   ├── raw.ts          provider-shaped types (§41)
│   │   │   │   │   ├── normalize.ts    raw → domain
│   │   │   │   │   ├── validate.ts     untrusted-input guards (§40)
│   │   │   │   │   └── status-map.ts   ESPN status → app GameStatus (§18)
│   │   │   │   └── mock/           # fixture-backed provider for dev/tests
│   │   │   └── services/           # boardService, teamService (orchestration)
│   │   ├── test/fixtures/espn/     # captured real payloads, incl. edge cases
│   │   └── wrangler.toml
│   └── web/                        # React + Vite + TS
│       ├── src/
│       │   ├── main.tsx, App.tsx, routes.tsx
│       │   ├── lib/                # apiClient, supabase, queryClient, formatters
│       │   ├── auth/               # AdminSessionProvider, RequireAdmin (admin routes only)
│       │   ├── features/
│       │   │   ├── home/           # user picker
│       │   │   ├── board/          # board page + TeamCard
│       │   │   ├── team/           # detail page, schedule, prediction
│       │   │   └── admin/
│       │   ├── components/         # RankBadge, RecordBadge, GameLine, LiveBadge,
│       │   │                       # FreshnessLabel, TeamLogo, Skeleton, ErrorBoundary
│       │   └── styles/             # tokens.css, global.css, *.module.css
│       └── vite.config.ts
├── supabase/
│   ├── migrations/                 # 0001_schema.sql, 0002_rls.sql, 0003_rpc.sql
│   └── seed.sql                    # 9 board users, 54 selections, no auth identities
├── scripts/
│   └── capture-espn-fixtures.ts    # one-off, writes to test/fixtures
├── .github/workflows/ci.yml
├── package.json                    # npm workspaces
└── tsconfig.base.json              # strict: true, noUncheckedIndexedAccess: true
```

---

## 3. Key Decisions & Rationale

| Decision | Choice | Why |
|---|---|---|
| Monorepo | npm workspaces | Domain types must be identical on both sides of the wire. No extra tooling. |
| Router (API) | Hono | ~14 kB, Workers-native, gives routing + middleware + typed context. Hand-rolling this is ~200 lines of worse code. Justified against §33. |
| Client data layer | TanStack Query | §24 *explicitly* requires request dedupe, per-category intervals, faster live polling, and pausing work when the page is hidden. That is precisely this library's job; hand-rolling it is a bug farm. Justified against §33. |
| Styling | Plain CSS + CSS Modules + design tokens | Spec says CSS (§33). No utility framework needed for three screens. |
| Validation | Hand-written type guards in `validate.ts` | Only one untrusted boundary (ESPN). A schema library would be the 4th dependency for ~150 lines of guards. Revisit if guards exceed ~400 lines. |
| Routing (web) | React Router | Required for real URLs + working back button (§47). |
| Live updates | Interval polling, no WebSocket | §24 states this preference outright. |
| Sports data persistence | Cache only, never tables | §45. A `games` table would immediately become a stale second source of truth. |
| Viewer access | **No login.** Read routes are public | Owner's decision (2026-09-17): only the administrator signs in; everyone else opens the URL. See §11.1 — recorded there so it is not "corrected" back to the spec's authenticated-read wording. |
| Supabase access from Worker | Anon key for reads; anon key **+ the admin's JWT** for writes | Reads run as PostgREST role `anon`, which RLS grants. Writes carry the admin bearer token so `is_admin()` can see an identity. The service-role key would silently bypass every policy and reduce §31 to theater, so it appears **nowhere in this repo**. |
| Team detail URL | `/teams/:teamId` | A team is global, not board-owned; shareable and cacheable. Board context comes from back navigation. |

### The three dependency rules

1. Every dependency must map to a named spec requirement (see table above).
2. No UI component library, no state manager, no date library (`Intl.DateTimeFormat` covers §20), no ORM.
3. `packages/shared` stays at **zero** runtime dependencies.

---

## 4. Data Model & Security

### Tables (`supabase/migrations/0001_schema.sql`)

```sql
-- Board participants. NO auth identity and NO admin flag — viewers never sign
-- in (§11.1), so a "user" here is purely a display profile that owns a board.
create table app_users (
  id            uuid primary key default gen_random_uuid(),
  display_name  text not null check (length(trim(display_name)) between 1 and 60),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- The only auth identities in the system. Keeping them in their own table
-- satisfies §29's separation more cleanly than a flag on app_users, and means
-- an administrator need not be one of the nine board participants.
create table admins (
  auth_user_id uuid primary key references auth.users(id) on delete cascade,
  label        text,
  created_at   timestamptz not null default now()
);

-- Team identity only. No records, ranks, or scores here (§45).
create table teams (
  id                uuid primary key default gen_random_uuid(),
  provider          text not null default 'espn',
  provider_team_id  text not null,
  name              text not null,
  display_name      text,
  abbreviation      text,
  logo_url          text,
  conference        text,
  primary_color     text,
  alt_color         text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (provider, provider_team_id)          -- §43: identity keyed to provider id
);

create table user_team_selections (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references app_users(id) on delete cascade,
  team_id         uuid not null references teams(id) on delete restrict,
  selection_order smallint not null check (selection_order between 1 and 24),
  created_at      timestamptz not null default now(),
  unique (user_id, team_id),                                        -- §3: no dupes per board
  constraint uq_user_order unique (user_id, selection_order)
    deferrable initially deferred                                   -- §44: enables atomic reorder
);
create index on user_team_selections (user_id, selection_order);
```

`selection_order` allows up to 24, not exactly 6 — §52 wants headroom without restructuring. The *UI* enforces six.

### RLS (`0002_rls.sql`)

> **Phase 1 note.** The shipped migrations harden this sketch in four ways, each explained in the [completion notes](#phase-1--completion-notes):
> 1. RLS is enabled in `0001`, right after each `CREATE TABLE`, so no table is ever exposed. `0002` repeats it, which does nothing.
> 2. `is_admin()` uses `search_path = ''` and `(select auth.uid())`.
> 3. `anon` is explicitly revoked from table writes and from `reorder_selections`.
> 4. `0001` uses `create or replace trigger` instead of drop + create.
>
> The SQL below is the design intent. The files in `supabase/migrations/` are authoritative.

```sql
alter table app_users            enable row level security;
alter table teams                enable row level security;
alter table user_team_selections enable row level security;
alter table admins               enable row level security;  -- zero policies → unreadable via the API

-- SECURITY DEFINER so it can read `admins`, which deliberately has no policies.
create function is_admin() returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (select 1 from admins a where a.auth_user_id = auth.uid());
$$;

-- Read: public. Viewers do not sign in, so `anon` must be granted (§11.1).
create policy read_users on app_users            for select to anon, authenticated using (true);
create policy read_teams on teams                for select to anon, authenticated using (true);
create policy read_sel   on user_team_selections for select to anon, authenticated using (true);

-- Write: admin only, every table, every verb (§2.2, §31). `anon` gets no write
-- policy at all, so an unauthenticated write is refused by the database itself.
create policy admin_users on app_users            for all to authenticated
  using (is_admin()) with check (is_admin());
create policy admin_teams on teams                for all to authenticated
  using (is_admin()) with check (is_admin());
create policy admin_sel   on user_team_selections for all to authenticated
  using (is_admin()) with check (is_admin());
```

### Reorder RPC (`0003_rpc.sql`)

Reordering must be one transaction, or the deferred unique constraint is the only thing standing between you and a half-swapped board.

```sql
create function reorder_selections(p_user_id uuid, p_ordered_ids uuid[])
returns void language plpgsql security invoker as $$   -- invoker: RLS still applies
begin
  if not is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  update user_team_selections s
     set selection_order = t.ord
    from (select unnest(p_ordered_ids) as id, generate_subscripts(p_ordered_ids, 1) as ord) t
   where s.id = t.id and s.user_id = p_user_id;
end $$;
```

### Seed (`seed.sql`)

9 `app_users` with display names and 6 teams each, using real ESPN team ids. No auth identities are seeded; the single `admins` row is inserted once the administrator's account exists (one line of SQL, documented in ops). This makes Phases 2–4 fully testable with no admin UI and no login.

---

## 5. Normalized Domain Model (`packages/shared/src/domain`)

Strict TS, no `any` (§41). The two non-obvious types carry most of the spec's weight:

```ts
// §23, §39 — freshness is never optional metadata; it travels with the data.
export type FreshnessState = 'fresh' | 'cached' | 'stale' | 'unavailable';
export interface Freshness {
  state: FreshnessState;
  fetchedAt: string | null;     // ISO UTC; null only when unavailable
  ttlSeconds: number;
  expiresAt: string | null;
  source: 'provider' | 'cache' | 'none';
  provider: 'espn' | 'mock';
}

// §38, §42 — a section can fail without failing its siblings.
export interface Envelope<T> {
  data: T | null;
  freshness: Freshness;
  error: AppError | null;
}
export type AppErrorKind =
  | 'provider_unavailable' | 'provider_invalid_response'
  | 'not_found' | 'unauthorized' | 'forbidden' | 'internal';
```

> **Phase 1 note.** The shipped `AppErrorKind` adds `'invalid_request'`, which maps to HTTP 400. Without it, a malformed request body could only be reported as `internal` (500). That blames the server for the caller's mistake and hides genuine 500s in the logs. See `packages/shared/src/envelope.ts`.

Explicit absence beats `null | undefined` guesswork:

```ts
export type RankingState =
  | { kind: 'ranked'; rank: number; poll: string; week: number | null }
  | { kind: 'unranked' }                 // render "NR" (§7)
  | { kind: 'unavailable' };             // render "—", never "NR"

export type GameStatus =
  | 'scheduled' | 'live' | 'final'
  | 'postponed' | 'canceled' | 'delayed' | 'suspended'
  | 'unknown';                           // §40: unrecognized provider codes land here

export type NextGameSlot =
  | { kind: 'game'; game: Game }
  | { kind: 'bye'; week: number | null }        // §10
  | { kind: 'none'; reason: 'season_complete' | 'no_upcoming' };

export interface TeamRecord {                   // §8 — preserve ties if supplied
  wins: number; losses: number; ties: number | null;
  summary: string;                              // provider's own string, displayed verbatim
  conference: { wins: number; losses: number } | null;
}

export interface Game {
  providerGameId: string;
  season: Season; week: number | null;
  kickoffUtc: string;                           // §20 — ISO 8601 UTC, never a display string
  status: GameStatus;
  statusDetail: string | null;                  // "3rd Quarter", "Final/OT"
  period: number | null; clock: string | null;  // §11
  homeAway: 'home' | 'away' | 'neutral';        // §19 — from provider, never inferred
  opponent: TeamRef;
  teamScore: number | null; opponentScore: number | null;
  result: 'W' | 'L' | 'T' | null;               // only when status === 'final'
  venue: string | null; broadcast: string | null;
}

export interface Prediction {                   // §12, §46
  source: 'espn_matchup_predictor';             // label the UI shows verbatim
  sourceLabel: string;
  homeWinPct: number; awayWinPct: number;
  retrievedAt: string;
}
```

**Invariant enforced in code:** `result` is non-null only for `status === 'final'` (§11 — live is never shown as final; §9 — previous game is never the live game).

### Season logic (`season.ts`, §21)

```ts
export interface Season { year: number; type: 'preseason' | 'regular' | 'postseason'; week: number | null }
export function resolveSeasonFromDate(now: Date): Season;  // month >= July → this year, else prior year
export function resolveCurrentSeason(deps): Promise<Season>; // provider calendar (cached 6h) → date fallback
```

Order of precedence: `SEASON_OVERRIDE` env var → provider calendar → date heuristic. One module, one call site. No year literal anywhere else in the codebase — CI greps for `20\d\d` outside this file and fixtures.

---

## 6. Provider Abstraction (§5)

```ts
export interface SportsDataProvider {
  readonly name: 'espn' | 'mock';
  resolveSeason(): Promise<Season>;
  searchTeams(query: string): Promise<TeamIdentity[]>;
  getTeamSnapshot(providerTeamId: string, season: Season): Promise<TeamSnapshot>; // meta+record+rank
  getTeamSchedule(providerTeamId: string, season: Season): Promise<ScheduleResult>;
  getGame(providerGameId: string): Promise<Game>;
  getPrediction(providerGameId: string): Promise<Prediction | null>;  // null = genuinely unavailable
  getRankings(season: Season): Promise<RankingsSnapshot>;
}
```

Methods **throw** `ProviderError` on failure and return `null` for legitimate absence. The cache wrapper converts throws into `stale` or `unavailable` envelopes — so the provider never needs to know about caching or freshness.

### ESPN endpoints — ✅ confirmed in the Phase 1 spike (2026-09-18)

> **Phase 1 note.** Every endpoint below responded, and real payloads are saved in `apps/api/test/fixtures/espn/`. **[docs/espn-notes.md](../docs/espn-notes.md) is now the authoritative reference** for URLs, field paths, and status vocabulary. It supersedes this table. Two additions the table lacks:
> - Conference *names* need two hops through the core API: `…/seasons/{year}/types/2/groups/{id}`.
> - Upcoming games carry an inline `predictor` in the `summary` payload.
>
> The team list needs `?limit=900` (762 teams across all divisions), not `?limit=400`.

ESPN's public JSON is undocumented, unversioned, and can change without notice. Treat these as leads, not contracts:

| Need | Candidate endpoint |
|---|---|
| Team meta + record + rank | `site.api.espn.com/apis/site/v2/sports/football/college-football/teams/{id}` |
| Schedule | `.../college-football/teams/{id}/schedule?season={year}` |
| Live slate | `.../college-football/scoreboard?dates={YYYYMMDD}&groups=80` |
| Rankings | `.../college-football/rankings` |
| Game summary | `.../college-football/summary?event={gameId}` |
| Predictor | `sports.core.api.espn.com/v2/sports/football/leagues/college-football/events/{id}/competitions/{id}/predictor` |
| Team search | `.../college-football/teams?limit=400` (fetch once, cache 24h, filter locally) |

Rules for this directory:
- Nothing outside `providers/espn/` may reference an ESPN field name, URL, or status code.
- Every fetch: 6 s timeout via `AbortSignal.timeout`, explicit `User-Agent`, non-2xx → `ProviderError`.
- `validate.ts` narrows unknown JSON before `normalize.ts` runs. A shape change produces an `unavailable` envelope, never a thrown render (§40).
- Unrecognized status codes → `'unknown'` + log once, never a crash (§18).

Swapping providers later means adding a sibling directory and one registry line. That is the acceptance test for §5.

---

## 7. Cache Policy & Free-Tier Budget (§23, §24, §25)

### Three tiers, because the free tier forces it

| Tier | Mechanism | Lifetime | Use for |
|---|---|---|---|
| **L1** | Worker isolate module-scope `Map` | seconds–minutes, per isolate | Live scores, in-flight dedupe. Zero quota cost. |
| **L2** | `caches.default` (Cache API) | minutes | Everything. **No-op on `workers.dev`** — code must not depend on it. |
| **L3** | Workers KV | hours–days | Long-TTL only: team meta, schedules, completed games, rankings, team list. |

**The constraint that drives this design:** Workers KV's free tier allows roughly **1,000 writes/day** (verify current limits at implementation time). Live polling at 25 s against KV would consume ~144 writes/hour/key and exhaust the daily budget during a single Saturday slate. Therefore:

- `cache/tiers.ts` exposes `put()` that **refuses L3 writes when `ttlSeconds < 300`**. Short-TTL data lives in L1 + HTTP cache headers only.
- A KV write counter in L1 logs a warning past a soft daily cap.
- Worker responses set `Cache-Control: public, max-age=<ttl>` so the browser and edge absorb repeat reads (§24 "avoid duplicate requests").

### TTL table (`cache/policy.ts`) — single source of truth (§24)

| Category | TTL | Stale-serve window | Tier |
|---|---|---|---|
| `team_meta` | 24 h | 7 d | L3 |
| `team_list` (search source) | 24 h | 7 d | L3 |
| `rankings` | 1 h (6 h offseason) | 24 h | L3 |
| `schedule` | 15 m | 6 h | L3 |
| `completed_game` | 7 d | 30 d | L3 |
| `upcoming_game` | 10 m | 2 h | L3 |
| `live_game` | 25 s | 2 m | L1 only |
| `prediction` | 30 m | 12 h | L3 |
| `board_composite` | 60 s (15 s if any team live) | 5 m | L1 only |

### Stale-while-revalidate contract (`cache/swr.ts`, §39)

```
hit && fresh          → data, state: 'fresh'  (source: 'cache')
miss || expired       → fetch provider
  fetch ok            → data, state: 'fresh', write back
  fetch fails + stale → stale data, state: 'stale', KEEP original fetchedAt
  fetch fails + none  → null,       state: 'unavailable'
```

The `fetchedAt` of stale data is never refreshed on a failed revalidate — that timestamp is the user's only defense against believing old data is current (§39). This is a hard rule, not an optimization.

---

## 8. API Contract (§28)

All routes under `/api`.

- **Read routes are public** — no token, no session (§11.1).
- **`/api/admin/*` requires `Authorization: Bearer <supabase_access_token>`** from an account present in `admins`. JWT verification is mounted on this branch only, so the public path never pays for a JWKS lookup.

| Method | Path | Returns |
|---|---|---|
| GET | `/api/health` | `{ status, version, provider, season, cache: {l2Available} }` |
| GET | `/api/meta/season` | resolved `Season` + freshness |
| GET | `/api/users` | `[{ id, displayName, teamCount }]` |
| GET | `/api/users/:userId` | user + ordered selections (identity only) |
| GET | `/api/users/:userId/board` | **consolidated board** (§27) |
| GET | `/api/teams/:teamId` | identity + snapshot + prev + next + rank + record |
| GET | `/api/teams/:teamId/schedule` | full current-season schedule (§17) |
| GET | `/api/games/:gameId` | single game |
| GET | `/api/games/:gameId/prediction` | `Envelope<Prediction \| null>` (§12) |
| GET | `/api/admin/teams/search?q=` | candidate team identities (§43) |
| POST | `/api/admin/users` | create user |
| PATCH | `/api/admin/users/:id` | rename |
| POST | `/api/admin/users/:userId/selections` | add team (body: `providerTeamId`) |
| DELETE | `/api/admin/selections/:id` | remove team |
| PUT | `/api/admin/users/:userId/selections/order` | reorder (body: `orderedIds[]`) |

### The board response — the core payload (§13, §27)

```jsonc
{
  "user": { "id": "...", "displayName": "Wilson" },
  "season": { "year": 2025, "type": "regular", "week": 5 },
  "generatedAt": "2025-10-01T19:42:00Z",
  "freshness": { "state": "fresh", "fetchedAt": "...", "ttlSeconds": 60, "...": "..." },
  "anyLive": true,                      // drives the client's polling interval
  "teams": [
    {
      "selectionId": "...", "order": 1,
      "team": { "id": "...", "name": "Alabama", "abbreviation": "ALA",
                "logoUrl": "...", "conference": "SEC", "primaryColor": "9E1B32" },
      "snapshot": {                      // Envelope — may be null with sibling teams fine
        "data": {
          "record": { "wins": 4, "losses": 0, "ties": null, "summary": "4-0" },
          "ranking": { "kind": "ranked", "rank": 4, "poll": "AP Top 25", "week": 5 },
          "previousGame": { "opponent": {...}, "result": "W", "teamScore": 31, "...": "..." },
          "nextGame": { "kind": "game", "game": { "...": "..." } },
          "liveGame": null
        },
        "freshness": { "state": "fresh", "...": "..." },
        "error": null
      }
    }
    // …5 more. A failed team yields snapshot.data=null + snapshot.error, never a 500 (§38)
  ]
}
```

**Server-side fan-out:** one browser request → six parallel provider reads inside the Worker via `Promise.allSettled`, deduped by cache key so shared teams across boards are fetched once (§27). The browser never issues six requests.

**Response conventions:** `X-Request-Id` on every response; `Cache-Control` from the TTL policy; error bodies are `{ error: { kind, message, requestId } }` with the kind drawn from `AppErrorKind` (§38 requires distinguishing provider failure / missing / invalid / authorization / application error).

---

## 9. Frontend Structure

### Routes (§47)

| Path | Page | Guard |
|---|---|---|
| `/` | User picker (§15) | **public** |
| `/u/:userId` | Board (§13) | **public** |
| `/teams/:teamId` | Team detail (§16) | **public** |
| `/login` | Admin sign-in | public; redirects to `/admin` when a session exists |
| `/admin` | Admin console | requires an admin session |

Real URLs, real back button, no modal-as-page. The three viewer routes must render in a fresh private window with no network call to Supabase Auth.

### Polling (§24)

One `useBoard(userId)` hook; interval derived from the response, not hard-coded in components:

```ts
refetchInterval: (q) => q.state.data?.anyLive ? 15_000 : 60_000,
refetchIntervalInBackground: false,   // §24 — stop work when hidden
refetchOnWindowFocus: true,
staleTime: 10_000,                    // dedupe bursts
```

Intervals live in one `POLL` constant object (§24 "centralized and configurable"). When the schedule shows no games today, the board falls back to a 5-minute interval — "avoid aggressive refreshes when no games are occurring."

### Visual system (§35)

- `tokens.css`: neutral surface ramp, one accent, semantic status colors (live / win / loss / stale / unavailable), 4 px spacing scale, two font sizes for numerals (rank and score get tabular figures).
- Team color used as a **single 4 px left border** on the card, nothing more. Six loud brands on one screen is the failure mode §35 names explicitly; the card chrome stays neutral.
- `FreshnessLabel` renders `Last updated: 3:42 PM` and visibly changes appearance for `stale` (§23, §39).
- `TeamLogo`: `onError` → initials in a neutral circle. `alt="{Team} logo"` (§36).

### Accessibility (§48)

- Team card is a single `<a>` wrapping the whole card (keyboard + focus + middle-click for free), not `div + onClick`.
- Live score region: `aria-live="polite"` so updates are announced once, not on every poll tick.
- `LiveBadge` conveys state through text, not color alone; `:focus-visible` ring on every interactive element; one `<h1>` per page.

### States (§37, §38, §42)

Every async region has four renders: skeleton, data, empty/unavailable, error. `ErrorBoundary` wraps each team card individually so one bad card cannot blank a board.

---

## Phase 1 — Foundation & Contracts

**Goal:** every contract fixed, the database secure and seeded, and ESPN's real payloads captured — before a single normalizer is written.

### Scope

**1.1 Monorepo**
- npm workspaces; `tsconfig.base.json` with `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`.
- ESLint (`no-explicit-any` as error, §41) + Prettier; Vitest at root.
- `.env.example` for both apps; real `.env` gitignored.
- GitHub repo, `main` branch, CI running typecheck + lint + test (§33).

**1.2 `packages/shared`**
- All of §5's domain types; all of §8's API contract types.
- `season.ts` with the precedence chain and unit tests (Jan bowl game → prior season year; August → new season).
- `envelope.ts` helpers: `fresh()`, `stale()`, `unavailable()`, `failed()`.
- Zero runtime dependencies.

**1.3 Supabase**
- Project created; migrations `0001`–`0003` applied (§4 verbatim).
- `seed.sql`: 9 board users and 54 selections with real ESPN team ids. No auth identities.
- One administrator account created by hand in the Supabase Auth dashboard, then its uuid inserted into `admins`.
- **Disable public sign-ups** in Supabase Auth settings. Viewers never register, so self-service signup serves no purpose and only invites auth-table spam. (It is not a privilege escalation either way — a self-registered `authenticated` user gets exactly the read access `anon` already has and no writes — but leaving it open is pointless exposure.)
- RLS verified by hand in three contexts: `anon` (read yes, write no), a non-admin authenticated token (read yes, write no), admin (read and write yes).
- No service-role key anywhere — not in a script, not in `.env`, not in CI. With no accounts to provision, nothing legitimately needs it.

**1.4 Worker skeleton**
- `wrangler.toml` with KV binding `SPORTS_KV`, vars `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SPORTS_PROVIDER`, `ALLOWED_ORIGINS`, optional `SEASON_OVERRIDE`.
- Hono router; middleware: CORS allowlist, request id, error → `AppError` mapper.
- `requireAdmin` middleware mounted on `/api/admin/*` **only**: verify the JWT against the Supabase JWKS (key set cached in L1 + KV), then confirm `is_admin()`. Reject `alg:none` and unexpected algorithms explicitly.
- `db/client.ts` exposes exactly two factories: `supabasePublic()` (anon key, no token → PostgREST role `anon`) and `supabaseAsAdmin(token)` (anon key + `Authorization` passthrough so RLS sees the identity). Add a comment stating why no third, service-role factory exists, so nobody "fixes" it later.
- Live routes: `/api/health`, `/api/users`, `/api/users/:userId`, `/api/meta/season` — all reachable with no token.

**1.5 ESPN spike (do not skip)**
- `scripts/capture-espn-fixtures.ts` saves raw payloads to `apps/api/test/fixtures/espn/` for: a ranked team, an unranked team, a team on a bye, a completed game, an upcoming game, a **live** game, a postponed/canceled game, a game with a predictor, a game without one, the rankings feed, and the full team list.
- Write `docs/espn-notes.md`: confirmed URLs, the exact field paths for rank/record/homeAway/status/clock, observed status code vocabulary, and anything ambiguous.
- Capture live and bye fixtures during an actual game week; if the calendar doesn't allow it, hand-author them from observed shapes and mark them synthetic.

### Exit criteria
- `npm run typecheck && npm run lint && npm run test` green at root.
- `GET /api/health` returns a resolved season; `GET /api/users` returns 9 users **with no token at all**.
- `POST /api/admin/users` returns **401** with no token and **403** with a non-admin token.
- `insert` into `user_team_selections` via raw PostgREST is **rejected by the database** (not by the Worker) as both `anon` and a non-admin token.
- Fixture directory covers all eleven cases above; `espn-notes.md` written.
- `grep -rn '20[0-9][0-9]'` finds no season literal outside `season.ts`, tests, and fixtures.

### Watch out for
- `is_admin()` must be `security definer`, or it cannot read the deliberately policy-less `admins` table and every admin write fails silently with an empty result rather than an error.
- Granting `anon` read is a policy change, not a `grant` — confirm the `anon` role also has table-level `select` privilege, which Supabase sets up by default but which a hand-written migration can strip.
- Test the deferred unique constraint on `selection_order` *now* with a manual swap; discovering it in Phase 5 is expensive.
- Supabase free projects pause after ~7 days of inactivity — Phase 5's cron ping addresses this; don't debug it as a bug.

### Phase 1 — Completion Notes

**Completed 2026-09-18.** This records what was built, how it was verified, where it departs from the plan above and why, and what Phase 2 needs to know. Where these notes and the plan disagree, the code and these notes win.

#### Exit criteria

| Exit criterion | Result | How it was verified |
|---|---|---|
| `typecheck && lint && test` green | ✅ | `npm run verify`: 101 tests across 4 files, strict TS, ESLint with `no-explicit-any` as an error |
| `/api/health` returns a resolved season | ✅ | Automated test, plus a live `wrangler dev` run in workerd: `{"year":2026,"type":"regular"}`, source `date` |
| `/api/users` returns 9 users with no token | ✅ | Automated test, plus **against the live Supabase project**: 9 users, 6 teams each |
| `POST /api/admin/users` → 401 with no token | ✅ | Automated test, plus live in workerd |
| `POST /api/admin/users` → 403 with a non-admin token | ✅ automated · ⏳ live | Test signs a real ES256 token and verifies it through the full JWKS path. The live run with a real Supabase token is owner follow-up (README Level 3c) |
| Raw PostgREST insert rejected **by the database** as `anon` and as a non-admin | ✅ on Postgres · ⏳ live | The actual migration files, run on real Postgres (PGlite) with Supabase's roles, `auth.uid()`, and default privileges simulated. The live repeat is `npm run verify:rls` (owner follow-up) |
| Fixtures cover all 11 cases; `espn-notes.md` written | ✅ | 18 fixtures in `apps/api/test/fixtures/espn/`, 17 real and 1 synthetic (see below). `docs/espn-notes.md` written |
| No season literal outside `season.ts` | ✅ | `npm run check:season`, also enforced in CI |

#### What was built

| Area | Where | Notes |
|---|---|---|
| Monorepo and tooling | root | npm workspaces; `tsconfig.base.json` with `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`; ESLint 9 flat config; Prettier; Vitest at the root |
| Shared contracts | `packages/shared` | Zero runtime dependencies. Domain types (§5), API request/response types (§8), `Envelope`/`Freshness` plus constructors `fresh`/`cached`/`stale`/`unavailable`/`failed`, and season resolution with its precedence chain |
| Worker | `apps/api` | Hono. Public reads: `/api/health`, `/api/meta/season`, `/api/users`, `/api/users/:userId`. Admin: `POST /api/admin/users` only (see departure 10). Middleware: request id, CORS allowlist, and a single error mapper |
| Database | `supabase/` | `0001_schema.sql`, `0002_rls.sql`, `0003_rpc.sql`, and an idempotent `seed.sql`: 9 users, 50 distinct real ESPN teams, 54 selections |
| Scripts | `scripts/` | `capture-espn-fixtures.ts`; `verify-rls.mjs`, which attacks PostgREST directly in three identities; `check-season-literals.mjs` |
| CI | `.github/workflows/ci.yml` | typecheck, lint, format check, test, season check, and a Worker bundle dry-run. No secrets |
| Docs | `README.md`, `docs/` | Three-level local testing guide, click-by-click Supabase setup, ESPN spike notes |

#### Departures from the plan, and why

1. **The Worker uses a hand-written PostgREST client, not `supabase-js`.** It's about 100 lines in `db/postgrest.ts`. The one decision that matters is which `Authorization` header goes on the wire, because that selects the Postgres role RLS evaluates against. Here that decision is one visible line. `supabase-js` remains planned for the web app's admin session (Phase 3). The factory names follow the plan: `supabasePublic()` and `supabaseAsAdmin(token)`. There is still no service-role factory, and a comment explains why.
2. **JWT verification is hand-written on WebCrypto** (`auth/jwt.ts`), with no `jose` dependency.
   - Only `ES256` and `RS256` are accepted, from our own allowlist. The token's header never chooses the algorithm, so `alg:none` and HS256 key-confusion forgeries fail.
   - The signature is checked before any claim is read.
   - `exp` is required, `iss` must match the project, and `aud` must be `authenticated`.
   - The key set is cached in memory (L1, 10 min) and in KV (L3, 24 h), with one forced refresh when a token's `kid` is unknown, to handle key rotation.
   - Tested with real generated keys, and checked against the live project's published ES256 keys.
3. **`AppErrorKind` gains `invalid_request` (400)** (see the §5 note).
4. **Anonymous reads send no `Authorization` header** (the plan implied `Bearer <anon key>`). Supabase's newer `sb_publishable_…` keys are not JWTs and are refused as a bearer token. `apikey` alone maps to the `anon` role for both key formats. Verified live with this project's publishable key.
5. **RLS is enabled in `0001`, immediately after each `CREATE TABLE`.** Supabase grants `anon` full privileges on new tables by default. With RLS enabled only in `0002`, the tables would have been writable by anyone holding the public key between the two runs. The Supabase SQL editor flagged exactly this. Now the gap fails closed, which was verified: after `0001` alone, RLS is on for all 4 tables and an `anon` insert is refused.
6. **`revoke execute on reorder_selections from public, anon`.** Supabase's default privileges grant EXECUTE to `anon` *directly*, and revoking from `public` alone does not remove a direct grant. The Postgres run caught this: `anon` could call the function and was stopped only by the `is_admin()` check inside it. It is now refused at the grant as well.
7. **`is_admin()` uses `set search_path = ''` and fully qualified names.** This closes the search-path hijacking hole that SECURITY DEFINER otherwise opens. It also uses `(select auth.uid())` so the value is computed once per statement.
8. **`create or replace trigger` replaces drop + create.** Re-runs stay safe, and the SQL editor's "destructive operation" warning goes away. `0002` still uses `drop policy if exists`, because Postgres has no `create or replace policy`. That warning is expected and documented in `docs/supabase-setup.md` step 5.
9. **Repo layout additions to §2.**
   - `src/app.ts`: the router factory, so tests build a fresh app per case.
   - `src/auth/jwt.ts` and `src/auth/jwks.ts`.
   - `src/http/errors.ts`: the one mapping from error kind to HTTP status.
   - `src/season/resolve.ts`: the Worker's single entry into season logic.
   - `src/db/rows.ts` and `src/db/queries.ts`: row shapes kept separate from domain types, per §41.
10. **Admin surface is limited to `POST /api/admin/users`.** The 401/403 exit criteria need a real admin route. The rest of the §8 admin routes arrive with the admin UI in Phase 5 and inherit the same middleware by being mounted under `/api/admin`.
11. **Seed choices.**
    - Only "Wilson" is a real name. The other eight (Avery through Jordan) are placeholders. Renaming is one `update`, and boards key on uuid.
    - Wilson's board is exactly §56's example.
    - Jordan's board re-uses 4 teams from other boards, to exercise the shared-team path in §27.
    - Southern Miss is included as the longest display name, for the Phase 3 layout check.
12. **Config error handling.** A missing `SUPABASE_URL` or `SUPABASE_ANON_KEY` produces a clear log line naming the file to create. A malformed user id is a 404 before any database client is built.

#### ESPN spike findings Phase 2 must act on

Full detail is in [docs/espn-notes.md](../docs/espn-notes.md). The ones that change code:

- **Akamai returns a bare `403` under burst traffic.** It is throttling, not authorization. Treat it as retryable, surface it as `provider_unavailable`, and never as `forbidden`.
- **A postponed game reports `state: "post"` with `completed: false` and a 0–0 score.** Decide finality from `status.type.completed`, never from `state`, or a postponed game renders as "Final 0–0", which is fabricated data (§4).
- **There are three score shapes.** `{value, displayValue}` in the schedule, a string in the scoreboard and summary, and the key is absent entirely for upcoming games.
- **Unranked has two sentinels.** In `teams/{id}`, `team.rank` is simply *missing*. In the scoreboard, `curatedRank.current` is `99`. A failed call is still `unavailable`, not `unranked` (§7).
- **Bye weeks are gaps in the week numbers**, not rows. The real fixtures show Texas with a bye in week 5 and Pitt in week 10.
- **There is no CFP poll in early season.** It appears around week 10. Select the poll by `type`, fall back to `ap`, and show the poll's own name (assumption §11.4).
- **The predictor is `statistics[name="gameProjection"].value`.** A missing predictor comes back as a 404 JSON body, which must become `null`. The `summary` payload also contains `odds` and `pickcenter`. Those are betting data and must never be shown as a prediction (§46).
- **Timestamps have no seconds** (`2026-09-05T19:30Z`). Normalize with `new Date(x).toISOString()`.
- **`game-live.json` is synthetic.** No game was live during capture, so it was derived from a real final game, and it is marked `_synthetic`. Re-run `npm run capture:fixtures` during a live Saturday game and the real capture overwrites it.

#### Verification performed

- **Automated.** 101 Vitest tests. They cover the season heuristic and precedence chain, the §39 stale-timestamp rule, and JWT forgery, tamper, expiry, issuer, and audience cases with real keys. The route tests assert *which* token reaches PostgREST: none for reads, the admin's own for writes, never a service key.
- **Database.** The repo's migration and seed files were run verbatim on real Postgres (PGlite), with Supabase's roles, `auth.uid()`, and default privileges simulated. All 44 checks pass:
  - the anon, stranger, and admin permission matrices;
  - the atomic reorder, with a cross-board id rejected;
  - the deferred-constraint swap succeeding, and a true duplicate rejected at COMMIT;
  - FK restrict and the CHECK constraints;
  - the `updated_at` trigger;
  - the seed and all migrations being safe to re-run.

  The harness lives outside the repo, in a scratch directory. Porting it into CI is a candidate for Phase 5's §5.2 authorization tests.
- **Runtime.** The Worker bundles to 94 KiB (24 KiB gzipped) and runs in workerd via `wrangler dev`. Every README Level 1 and Level 2 command was run exactly as written.
- **Live project, read-only.** Counts are 9/50/54. `admins` is refused to anon with `42501`. The publishable key works as `apikey`-only. The JWKS publishes two ES256 keys, and both import into the verifier. `/api/users` through the Worker returns 9 users.

#### Known limitations carried forward

- `/api/health`'s `cache.l2Available` reports whether the Cache API **exists**, not whether it **works**. On `workers.dev` it exists and does nothing. Phase 2's `tiers.ts` should replace it with a write-then-read probe.
- Season resolution wires the override and the date heuristic only. Phase 2 passes `fetchProviderSeason` from the bare `scoreboard` calendar (`season.type` 1/2/3, `week.number`).
- `/api/meta/season` wraps a season computed on the spot in `fresh()`, labeled `source: 'provider'`, with the real origin shown in the sibling `source: 'date'`. Revisit when the calendar is cached, so the envelope's source is literally accurate.
- `wrangler.toml` still has placeholder KV namespace ids. `wrangler dev` does not need real ones. Create them before the first deploy (Phase 5).

#### Owner follow-ups

- [ ] Fill in the four `VERIFY_*` lines in `.env` and run `npm run verify:rls`.
- [ ] README Level 3c: the live 403 (stranger) and 201 (admin) token test.
- [ ] Rename the eight placeholder users when convenient.
- [ ] Create the GitHub remote and push `main`.

---

## Phase 2 — Sports Data Layer

**Goal:** the API returns normalized, freshness-tagged, error-isolated sports data. This is the phase the spec really cares about.

### Scope

**2.1 Provider layer**
- `providers/types.ts`: the §6 interface. `ProviderError` with `cause` and `retryable`.
- `providers/espn/`: `client.ts` (timeouts, single retry on 5xx/network with jitter), `raw.ts` (provider-shaped types, §41), `validate.ts` (guards for every field read), `normalize.ts` (raw → domain), `status-map.ts` (§18).
- `providers/mock/`: fixture-backed, selected by `SPORTS_PROVIDER=mock`. This unblocks Phase 3 entirely and makes CI deterministic.

**2.2 Normalization rules — the details that matter**
- `homeAway` from the provider's own designation; never "first listed team is home" (§19).
- Previous game = latest **final** game strictly before now. A live game is excluded (§9).
- Next game = earliest non-final game at/after now. None → `{kind:'none', reason:'season_complete'|'no_upcoming'}`. A gap in the week sequence → `{kind:'bye'}` (§10, §22).
- `kickoffUtc` stored as ISO UTC; no formatted string enters the data model (§20).
- Ranking: present → `ranked`; explicitly unranked → `unranked`; field absent or unparseable → `unavailable`. These render differently (§7).
- Record: preserve the provider's `summary` string verbatim *and* the parsed parts, so ties survive (§8).
- Prediction: provider value only. Absent → `null` → UI shows `Prediction unavailable`. No fallback computation, ever (§12, §46).

**2.3 Cache layer**
- `policy.ts`: the §7 TTL table as typed constants + `cacheKey(category, ...parts)` including provider and season.
- `tiers.ts`: L1/L2/L3 with graceful L2 absence (probe once, remember) and the `ttl < 300s` L3 write refusal.
- `swr.ts`: the §7 state machine, including "never refresh `fetchedAt` on failed revalidate."
- In-flight request map in L1 so 6 concurrent board reads of a shared team hit ESPN once.

**2.4 Services & routes**
- `boardService`: selections from Postgres → parallel snapshots via `Promise.allSettled` → per-team envelopes → `anyLive` flag.
- `teamService`: snapshot, schedule, game, prediction.
- Routes: board, team, schedule, game, prediction, admin team search.
- `Cache-Control` per category; `X-Request-Id`; `X-Cache: hit|miss|stale`.

**2.5 Tests (the highest-value tests in the project)**
Normalizer tests against every Phase 1 fixture, asserting: unranked → `NR` state not a crash; bye → `bye` slot; postponed → correct status with null scores; live → `liveGame` set and `previousGame` untouched; missing predictor → `null`; **truncated/garbage JSON → `unavailable` envelope, no throw**; unknown status string → `'unknown'`.
Route tests with `@cloudflare/vitest-pool-workers`: every read route returns 200 **with no token**; board with one team forced to fail returns 200 with five populated and one errored; provider down + warm cache returns `state:'stale'` with the original `fetchedAt`.

### Exit criteria
- `GET /api/users/:id/board` returns six teams with rank, record, previous, next, and live where applicable.
- Killing the provider (env flag forcing failure) still returns a 200 board from cache, flagged `stale`, with unchanged timestamps.
- Forcing one team to fail leaves the other five intact (§42).
- Feeding each fixture through `validate.ts` after random field deletion never throws (property-style test).
- KV write counter shows zero writes attributed to `live_game` or `board_composite`.
- `SPORTS_PROVIDER=mock` serves a full board offline.

### Watch out for
- Workers' 10 ms CPU limit on the free tier is CPU time, not wall-clock — six parallel `fetch`es are fine, but don't do heavy synchronous work over full schedules on the board path.
- ESPN may return HTTP 200 with an error body; check payload shape, not just status.
- Timezones: do all comparisons in UTC. "Today's games" for the scoreboard endpoint needs a deliberate date choice — document it.

---

## Phase 3 — Frontend Core

**Goal:** sign in, pick a user, see a working board on a phone.

### Scope

**3.1 Shell & auth**
- Vite + React + TS; `supabase-js` for the **admin session only** (never for direct table reads — all data flows through the Worker, §26).
- The app renders fully with no session: home, board, and team pages mount without touching auth at all. `supabase-js` is code-split so viewers never download it.
- `AdminSessionProvider`: session from `onAuthStateChange`, persisted (§29), logout. `RequireAdmin` guards `/admin` only — and it is UX, not the boundary; the database is (§30).
- `apiClient`: attaches a bearer token **only when an admin session exists**; on 401 refreshes once, then clears the session and redirects to `/login`. Maps error bodies to `AppError`.
- Header shows an Admin link only when a session exists; `/login` stays directly reachable by URL.
- `queryClient` with global defaults and the centralized `POLL` constants.

**3.2 Design system**
- `tokens.css` + `global.css`: box-sizing reset, fluid type, `prefers-reduced-motion` honored (§35 "minimal unnecessary animation").
- Components: `Card`, `RankBadge` (`#4` / `NR` / `—`), `RecordBadge`, `GameLine`, `LiveBadge`, `TeamLogo` (with initials fallback), `FreshnessLabel`, `Skeleton`, `EmptyState`, `ErrorState`, `ErrorBoundary`.

**3.3 Home (§15)**
- Responsive grid of nine user cards: display name, initials avatar, team count. One tap to a board. No intermediate menu.

**3.4 Board (§13, §14)**
- Header: user name, season, `FreshnessLabel`, manual refresh.
- Six `TeamCard`s: logo, name, rank · record, previous opponent + result, next opponent + date/time, live block when applicable.
- Each card is a link to `/teams/:teamId`, individually error-bounded.
- Grid: 1 column < 640 px, 2 up to 1024 px, 3 above. Verified with no horizontal overflow at 320 px (§34).
- `Intl.DateTimeFormat` for display in the viewer's local zone (§20).

**3.5 States**
- Skeleton cards on first load; existing data stays visible during refetch with a subtle refreshing indicator — never a flash back to skeleton (§37).
- A card whose snapshot errored shows `Sports data temporarily unavailable.` and still renders the team's identity (§42).

### Exit criteria
- Home → board → team works end-to-end against the real Worker **in a fresh private window with no session and no login step**.
- Board renders correctly at 320 px, 768 px, and 1440 px with no horizontal scroll.
- With the provider forced to fail, the board shows cached values plus a visible stale indicator; with no cache, clean unavailable states. No `undefined` or `NaN` anywhere (§37).
- Keyboard-only: tab from the header to all six cards, visible focus, Enter opens a team (§48).
- Blocking a logo URL in devtools shows initials and leaves the card intact (§36).

### Watch out for
- Long team names ("Southern Mississippi") and three-digit-free layouts break card grids — test the longest real name in the seed.
- Don't let `refetchOnWindowFocus` plus a 15 s interval produce a request storm on tab switching; `staleTime` guards this.

---

## Phase 4 — Detail, Prediction & Live

**Goal:** the team page is complete, and live games update themselves correctly.

### Scope

**4.1 Team detail (§16)**
- Hero: logo, name, conference, `#rank · record`, subtle team-color accent.
- Previous game and next game panels, reusing `GameLine`.
- Sections load independently: schedule failing must not blank the hero (§42).

**4.2 Full season schedule (§17)**
- Desktop: semantic `<table>` with `<caption>` and `<th scope>` — week, date, opponent, H/A, status, score.
- Mobile (< 720 px): stacked game cards, same data, no horizontal scroll.
- Win/loss/tie styled with text and shape, not color alone. Bye weeks shown as rows. Empty schedule → explicit empty state, not a blank table.
- Lazy-loaded on team-page mount, not with the board (§27, §49).

**4.3 Prediction (§12, §46)**
- Two-bar split with percentages, labeled with `sourceLabel` ("ESPN matchup predictor") so the source is identifiable.
- `null` → `Prediction unavailable`. No computed fallback, no odds substituted for a prediction.
- Applies to the next/current game only.

**4.4 Live behavior (§11)**
- Board and detail prioritize live over next-game info: `LIVE` badge, current score, opponent, period, clock.
- 15 s polling while `anyLive`; `aria-live="polite"` on the score region.
- Nothing labeled Final until the provider says `final` — enforced by the `result`/`status` invariant from §5.
- Hidden tab stops polling; focus resumes it with an immediate refetch.

**4.5 Offseason & edge states (§22, §18)**
- No upcoming games → `Season complete`, schedule and record still fully visible.
- Bye week → `Bye week` in the next-game slot.
- Postponed / canceled / delayed → explicit status with no fabricated score.
- Verify with a fixture-driven offseason mode: nothing renders `undefined`, nothing crashes.

### Exit criteria
- Team page shows identity, rank, record, conference, previous, next, prediction, and the complete schedule.
- With prediction removed from fixtures, the page renders fully with `Prediction unavailable`.
- With schedule forced to fail, the hero and game panels still render.
- A live fixture shows the live block on both board and detail, with period and clock, and no "Final" wording.
- Mock offseason season: no upcoming games, zero crashes, `Season complete` shown.
- Hidden-tab check: network panel shows polling stopped, then a single refetch on focus.

### Watch out for
- ESPN's clock/period fields differ between the scoreboard and summary payloads — normalize both in `normalize.ts`, not in components.
- Overtime finals and vacated/forfeited games produce odd `summary` strings; display the provider's string rather than reformatting.

---

## Phase 5 — Admin, Hardening & Ship

**Goal:** the administrator can manage boards, authorization is proven server-side, and the app is deployed and free to run.

### Scope

**5.1 Admin console (§2.2, §43, §44)**
- User list: create user, rename, delete. No admin toggle — administrators live in `admins` and are managed with one line of SQL.
- Board editor per user: current six selections with remove; team search (debounced, against the cached team list) showing logo + conference before selection; add stores `provider_team_id` + normalized identity (§43).
- Reorder via up/down buttons — keyboard-accessible by construction, and the ordering is what matters, not the gesture. Sends one `PUT …/order` call hitting `reorder_selections` (§44). Drag-and-drop is explicitly out of scope (it would add a dependency and an a11y problem for zero functional gain).
- Guardrails: warn above six selections, block duplicates (the DB constraint is the real enforcement), confirm before removal.

**5.2 Authorization hardening (§30, §31)**
Negative tests as first-class deliverables. With reads public, write enforcement is the *only* security boundary in the application, so these tests carry the whole weight of §30 and §31:
- No token → every `/api/admin/*` route returns 401.
- Non-admin bearer token → every `/api/admin/*` route returns 403.
- `anon` **and** non-admin tokens → direct PostgREST insert/update/delete denied by RLS on all three tables, for every verb. Test each verb separately; `for all` policies are easy to get subtly wrong.
- Direct PostgREST `select` on `admins` returns nothing for both roles, while `is_admin()` still resolves correctly.
- Calling the `reorder_selections` RPC directly as `anon` and as a non-admin raises `42501`.
- Tampered, expired, and `alg:none` JWTs → 401 at the Worker.
- Grep the deployed Worker bundle to confirm no service-role key is present.
- Confirm sign-ups are still disabled in Supabase Auth.

**5.3 Quality pass**
- A11y: axe clean on all four pages; full keyboard walkthrough; heading hierarchy; contrast on every badge including live and stale; screenreader check of the live region (§48).
- Perf: production bundle reviewed and code-split by route; logos width/height set with `loading="lazy"`; board payload measured; Lighthouse mobile pass (§49).
- Resilience matrix — walk every row of §50 and confirm graceful behavior: provider fails, incomplete data, missing prediction, missing ranking, no upcoming game, postponed, canceled, bye, live, season complete, logo unavailable.
- **Open-API abuse budget** — a new consequence of public reads (§11.1). Confirm `Cache-Control` is set on every read route so repeat traffic is absorbed by the edge and browser before it reaches the Worker; add a best-effort per-IP token bucket in L1 on read routes (cheap, imperfect across isolates, adequate for this threat model); set a Cloudflare usage alert so a crawl surfaces before it exhausts the daily request budget. Do not build IP allowlisting or a shared site password — neither was asked for.

**5.4 Deploy (§32)**
- Frontend → Cloudflare Pages; API → Cloudflare Workers via `wrangler deploy`. Secrets via `wrangler secret put`.
- CORS allowlist set to the Pages origin. Confirm whether the Cache API (L2) is active on the deployed hostname and record the answer in `docs/ops.md` — on `workers.dev` expect it to be inert, which the tier code already tolerates.
- GitHub Actions: typecheck + lint + test on PR; deploy on `main`.
- Cron trigger (free): every 10 minutes on autumn weekends, hourly otherwise — warm rankings and the team list, and touch Supabase so the free project doesn't pause. Keep it well inside the KV write budget.
- `docs/ops.md`: env vars, secret rotation, how to add a user, how to change providers, how to bump the season, free-tier limits with dates checked.

**5.5 Verification against the spec**
Walk §54's end-to-end flow as a user, and §55's principles as a reviewer. Confirm §53's non-requirements were not built.

### Exit criteria
- Admin adds, removes, and reorders teams; the board reflects it on reload with the intended order.
- All negative authorization tests pass, including direct-to-database attempts.
- axe reports no violations; keyboard-only operation of the admin console works end-to-end.
- Deployed URLs serve the app with real ESPN data on a phone.
- 24 h of normal use stays inside free-tier limits (verify Workers requests and KV writes in the dashboard).
- Every §50 row confirmed graceful.

### Watch out for
- Creating a user in `app_users` creates no login, and that is intentional (§11.1). If viewer accounts are ever added, `app_users` needs an auth link *and* the read policies need narrowing — two deliberate changes, not one incidental one.
- Deleting a team referenced by a selection is blocked by `on delete restrict` — surface that as a clear message, not a 500.

---

## 10. Risk Register

| Risk | Impact | Mitigation |
|---|---|---|
| ESPN changes response shapes or blocks the Worker | Sports data stops | Isolated provider dir; guards degrade to `unavailable`; stale cache absorbs outages; fixtures make a fix a one-file change. Mock provider keeps the app demoable. |
| KV free-tier write limit exceeded | Writes fail, cache degrades | L3 refuses short-TTL writes; live data is L1-only; write counter warns; cron kept infrequent. |
| Cache API inert on `workers.dev` | Fewer cache hits | Tier probe; L1 + KV + HTTP `Cache-Control` carry the load. Custom domain is an upgrade, never a dependency. |
| Predictor endpoint unavailable or restricted | No win probability | `Prediction unavailable` is a designed state (§12). Never substitute a computed number (§46). |
| Supabase free project pauses after inactivity | Cold-start failures | Cron keep-alive; documented in ops. |
| Live-state edge cases (OT, suspended, weather) | Confusing UI | Unknown statuses normalize to `'unknown'` with a neutral render; `result` only on `final`. |
| Worker 10 ms CPU limit | 5xx on the board path | Keep board work I/O-bound; move heavy schedule processing to the team route; measure in Phase 2. |
| Public read API scraped or crawled | Free-tier request and KV-read budget burned | Cache headers plus three cache tiers mean most repeat traffic never reaches ESPN or KV; best-effort per-IP limit; usage alert. Exposure is a quota concern, not a data one — the content is nine display names and otherwise-public sports data. |
| Someone assumes viewer reads are authenticated | A future change re-adds a login gate, or worse, relaxes a write policy to match | §11.1 records the decision and its date; the read policies name `anon` explicitly with a comment. |
| Scope creep from §52 | Delays | §52 is architecture-only. §53 is the do-not-build list. |

---

## 11. Assumptions & Open Questions

Items 1–3 are settled decisions. The rest are working assumptions; each is cheap to revise. Flag now if any is wrong.

1. **CONFIRMED 2026-09-17 — no viewer logins.** Only the administrator has an account; everyone else opens the URL and reads. This **overrides the spec's expectation of authenticated viewer access** (§29's protected pages, §30's "read access to the data they are permitted to view", §54's opening "A user authenticates") *for reads only*. Write authorization remains database-enforced exactly as §30 and §31 require, and the admin retains login, logout, and persistent sessions per §29. Consequences: RLS read policies name `anon`; JWT middleware runs only on `/api/admin/*`; the app must render with no session; §5.3's abuse budget exists because the API is open.
2. **CONFIRMED 2026-09-17 — all writes are admin-only.** §2.2 grants selection management to the administrator. Self-service board editing is a future extension: one RLS policy plus one route.
3. **Anyone who can reach the site can read all nine boards.** Follows directly from 1. There is no per-board visibility model, and adding one later would require viewer identities, i.e. reversing 1.
4. **Ranking poll:** prefer the CFP poll when published, otherwise AP Top 25, and always display the poll name (§7 wants the ranking labeled, not inferred).
5. **Prediction source:** ESPN's matchup predictor only. Betting markets are never presented as a prediction (§46).
6. **Times render in the viewer's local timezone** via `Intl.DateTimeFormat`, with UTC stored throughout (§20).
7. **No custom domain initially** — hence the Cache API tolerance. A domain is a later optimization (§32).
8. **Six teams is a UI convention, not a schema constraint** (§52 headroom, §13 presentation).

---

## 12. Configuration

**Worker** (`wrangler.toml` vars + secrets): `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SPORTS_PROVIDER` (`espn` | `mock`), `ALLOWED_ORIGINS`, `SEASON_OVERRIDE` (optional), `LOG_LEVEL`; KV binding `SPORTS_KV`.

**Web** (`.env`): `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_API_BASE_URL`.

**Deliberately unused:** `SUPABASE_SERVICE_ROLE_KEY`. There is no provisioning script and no privileged code path, so the key never enters the repo, CI, or the Worker. If a future task appears to need it, that is a signal the RLS model is being worked around rather than used.

---

## 13. Definition Of Done

The application is complete when §54's end-to-end flow works on a phone and a desktop — minus its opening "A user authenticates" step, per §11.1 — and each of these holds:

| Requirement | Spec | Verified by |
|---|---|---|
| No fabricated sports data anywhere | §4, §12, §46 | No computed ranks/predictions in code; `unavailable` states exist for every field |
| Provider swappable without touching frontend or domain model | §5 | Only `providers/espn/` mentions ESPN; mock provider serves a full app |
| Freshness always distinguishable | §23, §39 | Every sports value carries `Freshness`; stale is visibly different; `fetchedAt` never falsely refreshed |
| Backend-tier caching by category | §25 | TTL table; `X-Cache` header; provider request count stays low under polling |
| Error isolation | §38, §42 | One-team-fails test; section-independent team page |
| DB-enforced write authorization | §30, §31 | Direct PostgREST writes denied for both `anon` and non-admin tokens, per verb; `/api/admin/*` returns 401/403 correctly; `reorder_selections` raises `42501` |
| Viewers reach boards with no login | §11.1 | Fresh private window loads home, board, and team with zero auth calls |
| All game states handled | §18, §22 | Fixture coverage for each status plus bye and season-complete |
| Mobile-first responsive | §34 | No horizontal overflow at 320 px; stacked schedule |
| Accessible | §48 | axe clean; keyboard-only operation; live region announced |
| Free to operate | §32 | Cloudflare + Supabase free tiers; usage measured over 24 h |
| Strict types, no stray `any` | §41 | Lint rule as error; separate raw vs. normalized types |
| Nothing from the non-requirements list built | §53 | Review at Phase 5 close |
