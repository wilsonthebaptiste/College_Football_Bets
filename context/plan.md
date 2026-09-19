# College Football Team Board — Implementation Plan

## Phase Checklist

- [x] **Phase 1 — Foundation & Contracts** — ✅ **Complete, 2026-09-18.** Monorepo, strict TS, normalized domain types, season logic, Supabase schema + RLS + seed, admin-only auth, Worker skeleton, ESPN fixture spike. Details, departures from this plan, and ESPN findings are in [Phase 1 — Completion Notes](#phase-1--completion-notes).
  - *Owner follow-ups (not blocking Phase 2):* run `npm run verify:rls` with the two test accounts in `.env`, and the live 403/201 token test (README, Level 3c). Both behaviours are already proven by the automated tests and the Postgres run. These two checks repeat them against the live project.
- [x] **Phase 2 — Sports Data Layer** — ✅ **Complete, 2026-09-18. Committed as `10c6425` on `main`.** Provider interface, ESPN adapter and validators, a generated mock season, a three-tier cache with a centralized TTL policy, board/team/schedule/game/prediction and admin team-search endpoints, error isolation, and fault injection. 287 tests. The README's Phase 2 test plan was run end to end, first by the owner, then again in full against mock and live ESPN. Details, departures, findings, and recommendations for later phases are in [Phase 2 — Completion Notes](#phase-2--completion-notes).
  - *Owner decision before the first deploy:* what `ESPN_USER_AGENT` production sends. ESPN's CDN refused the default from local workerd (see the notes). **Decided at the Phase 5 deploy:** try the default, fall back. It was refused from Cloudflare too, so production sends `curl/8.9.1 college-football-bets/0.5`.
  - *Owner follow-ups:* see [Phase 2 owner follow-ups](#phase-2-owner-follow-ups). The main one left is creating a GitHub remote and pushing `main`. There is still no remote.
- [x] **Phase 3 — Frontend Core** — ✅ **Complete, 2026-09-18.** The website in `apps/web` includes:
  - an app shell that needs no login, with the admin session loaded only for the administrator;
  - design tokens (light and dark), a home board picker, a board of six team cards, and a basic team page;
  - loading, error, stale, and unavailable states, and responsive layouts from 320 px up.

  One small API addition: `GET /api/admin/session`. The suite is now 387 tests. Every exit criterion was checked in a real browser against a real Worker before handover, and again by the owner (README "Testing Phase 3", Levels A, B, B2, and B3). Level C, admin sign-in with the owner's real admin and non-admin accounts, passed all six steps in headless Edge. Details, departures, and findings are in [Phase 3 — Completion Notes](#phase-3--completion-notes).
  - *Two small sign-in findings from Level C* are carried to Phase 5 (see "Known limitations" in the [completion notes](#phase-3--completion-notes)): the header shows an Admin link to a signed-in non-admin, and an unconfirmed account is told its password is wrong.
- [x] **Phase 4 — Detail & Live** — ✅ **Built and verified 2026-09-19. Committed as `3ee11b8` on `main`.** The team page now has:
  - the matchup prediction, labeled with its source, and never shown for a finished game;
  - the full-season schedule, a table on wide screens and stacked entries on phones, with bye weeks as rows;
  - live treatment with the score's own update time, and offseason and bye states.

  One contract addition: `TeamSnapshot.liveUpdatedAt`. The suite is now 473 tests. Every exit criterion was checked in headless Edge against real Workers (57 checks). Details are in [Phase 4 — Completion Notes](#phase-4--completion-notes).
- [ ] **Phase 5 — Admin & Ship** — 🟢 **Built, verified, and deployed 2026-09-19. Not yet committed.** Live at <https://cfb-board-pfc.pages.dev> (API: <https://cfb-api.cfb-api.workers.dev>), on real ESPN data. What was built:
  - the admin console (people: add, rename, delete; boards: search with logo and conference, add, remove with confirmation, reorder with Up/Down);
  - authorization proven route by route (131 API tests), verb by verb on real Postgres (44 PGlite tests), and against the live project (`verify:rls`, 44/44, run before and after the deploy);
  - a per-address read budget, cron warmers, API-sized logos, route code splitting, self-hosted fonts;
  - deploy configuration (`[env.production]`, a gated CI deploy job), a smoke script, a bundle secret scan, and [docs/ops.md](../docs/ops.md).

  The suite is 704 tests in 31 files. Browser runs in headless Edge: 116/116 locally (console, keyboard only, real accounts, axe everywhere), 26/26 on real ESPN data, and 48/48 against the **deployed** site at phone width. The deploy found two things: ESPN refuses the default User-Agent from Cloudflare too (production sends the owner's curl-style fallback), and a live-overlay bug that marked live cards stale (fixed, with a test). Details: [Phase 5 — Completion Notes](#phase-5--completion-notes), "Deploy".
  - *Left for the owner:* approve the commit message, 24 h of usage numbers (the one exit criterion that needs time), and a look on a real phone. The box gets its tick once the usage numbers are in.

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

> **Phase 2 note: the interface as built** (`apps/api/src/providers/types.ts`). It is narrower than the sketch above. Providers return raw facts, and snapshots are derived from them in `services/`, so the derivation rules live in one place and are shared by every provider:
>
> ```ts
> getCurrentSeason(): Promise<Season | null>;                        // calendar; null = no opinion
> listTeams(): Promise<TeamIdentity[]>;                              // admin search source
> getTeamSchedule(providerTeamId, season): Promise<ProviderSchedule>;
> getRankings(season): Promise<RankingsSnapshot | null>;             // CFP, else AP
> slateKeyFor(kickoffUtc): string;                                   // ESPN: the US Eastern date
> getSlate(slateKey): Promise<ProviderGame[]>;                       // live scores for one day
> getGame(providerGameId): Promise<ProviderGame>;
> getPrediction(providerGameId): Promise<Prediction | null>;
> ```
>
> - `resolveSeason` became `getCurrentSeason` plus `season/resolve.ts`.
> - `searchTeams` became `listTeams`, filtered in `services/search.ts`.
> - `getTeamSnapshot` is derived from the schedule plus rankings in `services/snapshot.ts`.
> - The slate pair is new and powers the live overlay.
> - `ProviderError.kind` is `unavailable`, `invalid_response`, or `not_found`, and the error handler maps each to an `AppErrorKind`.
> - A second provider, `mock`, and a fault wrapper, `faults.ts`, already implement this interface. That is the §5 acceptance test, passed in practice.

> **Phase 5 note: two additions to the interface.** Details are in the [Phase 5 completion notes](#phase-5--completion-notes).
> - `teamNamespace`: whose id space `teams.provider` records. The mock says `espn`, because its roster borrows ESPN's ids.
> - `getConferences(season)`: provider team id → conference short name. ESPN reads it from the core API, FBS only, all or nothing.

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

> **Phase 2 note on endpoints.**
> - The live slate is `scoreboard?dates={Eastern YYYYMMDD}&groups=80&limit=300`.
> - The schedule's `requestedSeason` is checked, because its root `season` is always ESPN's current season.
> - The predictor is read from the `summary` first. The core endpoint is the fallback, and there a 404 means "no prediction".
> - ESPN's CDN refused the Worker's default User-Agent from local workerd, hence `ESPN_USER_AGENT` (see [docs/espn-notes.md](../docs/espn-notes.md) §1 and §11).

Rules for this directory:
- Nothing outside `providers/espn/` may reference an ESPN field name, URL, or status code.
- Every fetch: 6 s timeout via `AbortSignal.timeout`, explicit `User-Agent` (configurable since Phase 2), non-2xx → `ProviderError`.
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

> **Phase 2 note: the table as built** (`apps/api/src/cache/policy.ts`, still the single source of truth):
>
> | Category | TTL | Stale window | Tiers | KV write at most every |
> |---|---|---|---|---|
> | `team_list` | 1 d | 7 d | L1+L2+L3 | 1 d |
> | `season_calendar` *(new)* | 6 h | 7 d | L1+L2+L3 | 6 h |
> | `rankings` | 1 h (6 h outside the regular season) | 1 d | L1+L2+L3 | 1 h |
> | `schedule` | 15 min | 6 h | L1+L2+L3 | **1 h** |
> | `completed_game` | 7 d | 30 d | L1+L2+L3 | 7 d |
> | `upcoming_game` | 10 min | 2 h | L1+L2+L3 | 1 h |
> | `live_game` | 25 s | 2 min | L1 only | never |
> | `prediction` | 30 min | 12 h | L1+L2+L3 | 2 h |
> | `board_composite` | 60 s (15 s while any team is live **or any card is failing or stale**) | 5 min | L1 only | never |
>
> - `team_meta` was dropped: identity comes from the `teams` table, and record and rank come from the schedule and rankings.
> - Durable categories use all three tiers, not only L3, so L1 answers the hot path.
> - The last column is new. KV holds the durable copy, not the hot one, and it is refreshed at most this often. That is what keeps a Saturday inside roughly 1,000 writes a day.
> - The write counter in `tiers.ts` is a daily per-isolate ledger: warn at 700, refuse at 900. It is reported by `/api/health`.
> - Keys are `v2|<provider>|<resource>|<parts>`, so switching `SPORTS_PROVIDER` never serves one provider's data as the other's.

### Stale-while-revalidate contract (`cache/swr.ts`, §39)

```
hit && fresh          → data, state: 'fresh'  (source: 'cache')
miss || expired       → fetch provider
  fetch ok            → data, state: 'fresh', write back
  fetch fails + stale → stale data, state: 'stale', KEEP original fetchedAt
  fetch fails + none  → null,       state: 'unavailable'
```

The `fetchedAt` of stale data is never refreshed on a failed revalidate — that timestamp is the user's only defense against believing old data is current (§39). This is a hard rule, not an optimization.

> **Phase 2 note on labels.**
> - A fresh cache hit is labeled `cached` (source `cache`), not `fresh`. `fresh` means "fetched from the provider during this request".
> - The contract is otherwise as written, and the `fetchedAt` rule is tested at every level: `swr.ts`, the board routes, and a live fault drill in workerd.
> - Data assembled from several reads (a card is a schedule plus a live slate plus rankings) is composed by `services/live.ts` `composeFreshness`:
>   - The state is the worst of the parts that are *on* the card.
>   - Rankings can only make a card `stale`, never `cached`.
>   - `fetchedAt` is the oldest of those parts.
> - Concurrent reads of one key share one load (in-flight coalescing, per isolate).

> **Phase 5 note.**
> - A new category, `conferences`: 1 day TTL, 30 days stale, all three tiers, a KV write at most daily.
> - `swr.read` re-checks L1 just before loading. Without it, a read whose KV lookup was still in flight when a sibling finished loading would load and write KV again. That was seen in workerd as three calendar writes in one cron run.
> - `tiers.evictL1` lets an admin write drop the board composite in its own isolate.
> - Cron warmers (`src/cron/warm.ts`) keep the calendar, rankings, team list, and conferences refreshed into KV off the request path. They never warm schedules or live data; the reasons are in the file.

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

> **Phase 2 note: the API contract as built** (types in `packages/shared/src/api/responses.ts`).
> - **Built:** every GET route above. **Still to come in Phase 5:** the admin writes other than `POST /api/admin/users`.
> - `/api/health` `cache` is now `{ l2Available, kvWrites: { day, total, byCategory, refused } }`, and `l2Available` comes from a real write-then-read probe.
> - `GET /api/games/:gameId` takes an optional `?team=<providerTeamId>` and scores the game from that team's side (home by default). A team that isn't in the game is a 400.
> - `GET /api/admin/teams/search?q=` takes 2–60 characters, ignores accents and case, returns at most 20 results, and is sent `private, no-store`.
> - `Cache-Control`:
>   - normally `public, max-age=<seconds until the data's own expiry>`;
>   - `max-age=10` when anything in the response is `stale`, or when a board has a failing card;
>   - `no-store` when the response has nothing to show.
> - `X-Cache` is `hit`, `miss`, or `stale`.

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

> **Phase 2 note on the board payload.** The shape above holds, with three additions:
> - Every `Game` has `kickoffTbd: boolean`.
> - A bye is `nextGame: { kind: 'bye', week, following }`, where `following` is the game after the bye.
> - `nextGame: { kind: 'none', reason }` has reason `season_complete` or `no_upcoming`.
>
> The board-level `freshness` describes when the *board* was assembled. The age of the data is each card's `snapshot.freshness.fetchedAt`. The UI should show the latter (see Notes for Phase 3 below).

**Response conventions:** `X-Request-Id` on every response; `Cache-Control` from the TTL policy; error bodies are `{ error: { kind, message, requestId } }` with the kind drawn from `AppErrorKind` (§38 requires distinguishing provider failure / missing / invalid / authorization / application error).

> **Phase 3 note: one new route.** `GET /api/admin/session` returns `AdminSessionResponse` (`{ admin: { authUserId } }`), with `Cache-Control: private, no-store`.
> - It sits behind `requireAdmin` like every admin route: 401 with no token or a bad one, 403 for a valid token that is not in `admins`.
> - It writes nothing. Its only database call is the `is_admin()` check.
> - The web app's `RequireAdmin` uses it to tell "not signed in" apart from "signed in, but not an administrator".

> **Phase 5 note: the admin surface as built** (`apps/api/src/routes/admin.ts`). All `private, no-store`, all behind `requireAdmin`:
>
> | Method | Path | Returns |
> |---|---|---|
> | GET | `/api/admin/session` | `AdminSessionResponse` |
> | GET | `/api/admin/users` | `AdminUsersResponse` (the public list, uncached) |
> | POST | `/api/admin/users` | 201 `CreateUserResponse` |
> | GET | `/api/admin/users/:userId` | `AdminBoardResponse` (one board, uncached) |
> | PATCH | `/api/admin/users/:userId` | `RenameUserResponse` |
> | DELETE | `/api/admin/users/:userId` | 204, and the board goes with the user |
> | POST | `/api/admin/users/:userId/selections` | 201 `AddSelectionResponse` (the whole board, plus the new selection) |
> | DELETE | `/api/admin/selections/:selectionId` | `SelectionsResponse`, renumbered 1…n |
> | PUT | `/api/admin/users/:userId/selections/order` | `SelectionsResponse`. The list must be exactly the board's set, or it is a 409 |
> | GET | `/api/admin/teams/search?q=` | `TeamSearchResponse`, now with conferences and sized logos |
>
> - New error kinds: `conflict` (409: a duplicate team, or a board that changed underneath the editor) and `rate_limited` (429).
> - Public reads have a best-effort per-address budget (`middleware/rate-limit.ts`).
> - Logo URLs in every response are resized copies (`providers/logos.ts`); stored URLs stay canonical.

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

> **Phase 3 note: this section as built** (`apps/web`). Details are in the [Phase 3 completion notes](#phase-3--completion-notes).
> - **Routes:** all five exist, plus a not-found page. `/login` and `/admin` are lazy-loaded chunks. The Supabase library is a separate chunk that only those two routes load, and only when this browser has a stored admin session.
> - **Polling:** `POLL` in `src/lib/poll.ts`:
>   - `liveMs` 15 s, `activeMs` 60 s, `idleMs` 5 min, `staleTimeMs` 10 s.
>   - The board uses 15 s when `anyLive` is true. It uses 60 s when a non-TBD kickoff is within 12 hours or already past, or when any card is failing or stale. Otherwise it uses 5 min.
>   - "No games today" is implemented as "no kickoff within 12 hours", which avoids midnight edge cases.
>   - The team page applies the same rule to its one snapshot.
> - **Visual system:** Barlow Condensed (numerals, names, headings) and Barlow (body). The palette is chalk and turf green, with one accent. The team colour is still only the 4 px left rule. Stale cards get a dashed amber outline and a note in words.
> - **Accessibility, one change:** the card's single link is the team name, stretched over the whole card with `::after`, rather than an `<a>` wrapping the card. Keyboard, middle-click, and "open in new tab" behave the same, and a screen reader hears "Alabama, link" instead of the whole card. The focus ring is drawn on the card via `:has()`.

> **Phase 4 note: the team page.** Details are in the [Phase 4 completion notes](#phase-4--completion-notes).
> - **Three independent reads:** team, schedule, and prediction. The schedule starts on mount, alongside the team request.
> - **Polling:** `POLL` gains `predictionMs` (5 min), and `schedulePollInterval` applies the board's rule to the schedule's rows.
> - **Schedule:** a `<table>` from 720 px, stacked entries below. Results are marked by letter, word, and shape.

> **Phase 5 note: the admin console and the performance pass.** Details are in the [Phase 5 completion notes](#phase-5--completion-notes).
> - **Routes:** `/admin` (people) and `/admin/u/:userId` (one board), both inside `RequireAdmin`.
> - **Code splitting:** every page but home is a lazy chunk (`app/pages.ts`), under one `<Suspense>` in `RootLayout`. The board and team chunks are prefetched when idle.
> - **Header:** the Admin link now waits for the server to confirm an administrator (`auth/useAdminCheck.ts`).
> - **Fonts:** self-hosted from `public/fonts` (`styles/fonts.css`). Google Fonts is no longer used.
> - **Pages headers:** `public/_headers` sets caching and security headers.

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

### Phase 2 — Completion Notes

**Completed 2026-09-18.** As with Phase 1: where these notes and the plan above disagree, the code and these notes win.

#### Exit criteria

| Exit criterion | Result | How it was verified |
|---|---|---|
| The board returns six teams with rank, record, previous, next, and live where applicable | ✅ | Route tests over mock and over the Phase 1 ESPN captures, then **live ESPN** in workerd (Friday of week 3): all 12 cards on two boards filled, Texas Tech live against Houston with score and clock |
| Provider killed → 200 board from cache, `stale`, timestamps unchanged | ✅ | Route test with `SPORTS_PROVIDER_FAULT=all` after a warm read. Repeated live in workerd with `SPORTS_PROVIDER_FAULT=slate`: the live card went `stale` with its original `fetchedAt`, `X-Cache: stale`, `max-age=10` |
| One team forced to fail leaves the other five intact | ✅ | Route test with `team:251`. Also seen unplanned: with ESPN answering 403 to everything, both boards were still 200s with six error cards each |
| Every fixture survives random field deletion in `validate.ts` without throwing | ✅ | A property-style test: for every fixture, seeded random deletion, nulling, and type-swapping at random depths. 40–200 rounds per fixture, depending on size, with every failure reproducible from its seed |
| KV write counter shows zero writes for `live_game` or `board_composite` | ✅ | Route test reads `/api/health` `cache.kvWrites.byCategory` after live boards. Structurally, both categories are L1-only in `policy.ts`, and `tiers.ts` refuses any KV write under 300 s |
| `SPORTS_PROVIDER=mock` serves a full board offline | ✅ | Route tests, and a workerd run. The mock provider makes no network calls. Only Supabase, for users and selections, is remote |

#### What was built

| Area | Where | Notes |
|---|---|---|
| Provider interface | `providers/types.ts` | §6 plus `slateKeyFor`/`getSlate` for the live overlay. `ProviderError` has kind `unavailable`, `invalid_response`, or `not_found`, plus `retryable`, `status`, and `cause` |
| ESPN adapter | `providers/espn/` | `client.ts`: 6 s timeout, one jittered retry on network error, 403, 429, or 5xx, error-body detection, and a configurable User-Agent. `validate.ts`: total readers into `raw.ts` shapes, with ids restricted to `[A-Za-z0-9_-]{1,40}`. `normalize.ts`: raw → domain. `status-map.ts`: §18, where final requires `completed === true` |
| Mock provider | `providers/mock/` | A generated, deterministic season for the 50 seeded teams, with round-robin pairings (the circle method) and one bye per team. It has live games at any hour, postponed and canceled games, predictions labeled `mock_predictor`, polls labeled "Mock Top 25", and a postseason mode where the season is complete. Game ids are 13 digits and self-describing |
| Fault injection | `providers/faults.ts` | `SPORTS_PROVIDER_FAULT`: `all`, `team:<id>`, `schedule`, `rankings`, `slate`, `game`, `prediction`, `calendar`, `teams`. Wraps either provider |
| Cache | `cache/` | `policy.ts` is the TTL table and key builder (`v2\|provider\|resource\|…`). `tiers.ts`: L1 isolate `Map` (1,000 entries), L2 Cache API behind a write-then-read probe, L3 KV with a 300 s floor, a per-key write interval, and a daily per-isolate ledger (soft cap 700, hard cap 900). `swr.ts`: the §7 state machine plus in-flight coalescing |
| Services | `services/` | `board.ts` uses `Promise.allSettled` and one shared rankings read per board. `derive.ts` works out previous, next, live, and bye. `live.ts` does the schedule + slate overlay and freshness composition. `team.ts`, `games.ts`, `search.ts` |
| Routes | `routes/` | `GET /api/users/:id/board`, `/api/teams/:id`, `/api/teams/:id/schedule`, `/api/games/:id?team=`, `/api/games/:id/prediction`, and `GET /api/admin/teams/search?q=` (admin only, `private, no-store`). `Cache-Control` follows each response's own expiry. `X-Cache` is `hit`, `miss`, or `stale` |
| Season | `season/resolve.ts` | Resolution order: override, then the provider calendar (cached 6 h), then the date heuristic. `/api/health` uses a peek mode that never calls the provider |
| Fixtures | `test/fixtures/espn/` | `game-live.json` is now a **real** capture, taken during Miami at Wake Forest. `scoreboard-live.json` is new. All 19 fixtures are real |

#### Departures from the plan, and why

1. **Live data is a schedule plus scoreboard overlay, not a per-game fetch.**
   - ESPN's schedule endpoint has no score for a game in progress, and it is cached for 15 min.
   - So a game that is live, or that kicked off less than 6 h ago and isn't final, is looked up in that day's scoreboard. One call covers every game that day, cached 25 s in L1.
   - A scoreboard older than the schedule is never applied.
   - When the scoreboard can't be fetched, the card is marked `stale` rather than shown as current.
2. **The mock is generated, not fixture-backed.** The fixtures cover two teams. The generated season covers all 50 seeded teams, and it produces live games at any hour of the day, so Phase 3 can build live UI on a Tuesday. CI stays deterministic.
3. **KV writes have their own budget.** There is a `kvWriteIntervalSeconds` column in `policy.ts`: the schedule's KV copy is refreshed at most hourly, though L1 refreshes every 15 min. A daily ledger refuses writes past its hard cap. The free tier's roughly 1,000 writes a day would not survive a Saturday otherwise.
4. **The board's own TTL drops to 15 s when any card is failing or stale**, the same as while a team is live. The response also gets `max-age=10`. This was found in the live run: a board of six error cards had been cached for 60 s, and was publicly cacheable for 60 s too.
5. **"Next game" keeps a grace period.**
   - A scheduled game stays "next" for 6 h past kickoff, and a delayed or suspended one for 3 days, so a game whose status lags doesn't vanish at kickoff.
   - A postponed game counts only if its date is still ahead.
   - Byes come from the calendar week, or from a week gap with the next game more than 7 days out. They are regular season only, and are decided only when the schedule parsed completely.
6. **Rankings pick CFP, falling back to AP**, and show the poll's own name. A poll with any bad entry is dropped whole: a partial poll would turn a ranked team into "NR". A poll from another season is refused.
7. **The route tests run in Node Vitest, not `@cloudflare/vitest-pool-workers`.** Phase 1's setup was kept. The Worker is driven through `app.request()` with a fake KV and a stubbed `fetch`. Runtime parity was checked by hand in workerd: mock mode, ESPN mode, and a fault drill. Moving to pool-workers is a Phase 5 candidate.
8. **Conferences are deferred to Phase 5.** Card conference names come from the `teams` table. The two-hop ESPN lookup (espn-notes §7) arrives with the admin UI.
9. **`ESPN_USER_AGENT` exists** because of the 403 finding below.
10. **Health.** `/api/health` `cache` is now `{ l2Available, kvWrites }`. `l2Available` comes from a real write-then-read probe, and `kvWrites` is the ledger. This closes Phase 1's first known limitation.

#### Contract changes Phase 3 must know (`packages/shared`)

- `Game.kickoffTbd: boolean`: the time is not set yet, and `kickoffUtc` holds a midnight-Eastern placeholder. Show "TBD", never "12:00 AM".
- `NextGameSlot` bye: `{ kind: 'bye'; week: number | null; following: Game | null }`, so the card can say "Bye week, then @ Colorado".
- `PredictionSource` adds `'mock_predictor'`. Always show `sourceLabel` (§46).
- `HealthResponse.cache` is `{ l2Available; kvWrites: KvWriteReport }`.
- An error card still has `team`: only `snapshot` is `{ data: null, error }`. `anyLive` drives the polling interval. Each card's `freshness.fetchedAt` is the "updated at" to display.

#### ESPN findings from Phase 2

Full detail is in [docs/espn-notes.md](../docs/espn-notes.md) §1 and §11.

- **ESPN's CDN refused every request from local workerd with our User-Agent.** Node's `fetch` passes with any User-Agent. From workerd and curl, only User-Agents that *begin* with a known HTTP-library name pass (`curl/…`, `python-requests/…`, `okhttp/…`). This fits Akamai checking the User-Agent against the TLS fingerprint. **What deployed Workers get is unmeasured.** It needs measuring on the first deploy, together with the owner's decision on `ESPN_USER_AGENT`.
- The inline predictor disappears once a game is live, but the core predictor endpoint still answers. The schedule's root `season` is ESPN's current season, and `requestedSeason` is the one to check. `timeValid: false` means the kickoff is TBD. `scoreboard?dates=` is a US Eastern day.
- **The core predictor still answers for a final game, with the pregame numbers.** Texas Tech at Oregon State, which Texas Tech won, returned 6% home / 94% away. The API passes it through unchanged. Whether the team page shows a pregame prediction beside a final score is a Phase 4 decision (see Notes for Phase 4).

#### Verification performed

- **Automated.** 287 tests across 13 files, all passing. Phase 2 added 186 of them:
  - ESPN normalize, validate, client, and provider: 84.
  - Cache: 22.
  - Derivation and live overlay: 33.
  - Routes: 33.
  - Mock: 14.
  - Plus `npm run verify` (typecheck, lint, tests, season check) and `format:check`.
- **Bundle.** 185.4 KiB, 47.3 KiB gzipped (`wrangler deploy --dry-run`).
- **Mock in workerd.**
  - `/api/health` answered with `l2Available: true` (true locally; on `workers.dev` the probe will report false).
  - Wilson's board returned 200 with `anyLive: true` and a 15 s TTL.
  - `X-Cache` went from `miss` to `hit`.
- **Real ESPN in workerd (2026-09-18, Friday night of week 3).**
  - With the default User-Agent, every call got 403, and both boards degraded to six error cards with a 200 status, as designed.
  - With `ESPN_USER_AGENT` set, all 12 cards filled: AP ranks, records, previous and next games, and Texas Tech live at 7–10.
  - Texas Tech's schedule had 13 rows, including the week-6 bye and TBD kickoffs.
  - The prediction endpoint answered for an upcoming game, and for a live one, which by then can only come from the core endpoint.
  - 14 KV writes (1 calendar, 12 schedules, 1 rankings) for two cold boards.
  - The fault drill is under Exit criteria.
- **Bugs the live run caught, now fixed and tested.**
  - The degraded-board caching described in departure 4.
  - `composeFreshness` let a rankings read served from cache label a just-fetched card `cached`. Reference parts now only make a card `stale`.
- **The README's Phase 2 test plan, run end to end** (2026-09-18/19), after the owner's own pass.
  - Every step used a second `wrangler dev` on port 8798 with its own `--persist-to` folder, so the owner's server and cache were untouched. Faults were passed with `--var` rather than by editing `.dev.vars`.

  | README level | Result |
  |---|---|
  | A: `npm run verify`, `format:check` | ✅ 287/287; typecheck, lint, season check, formatting |
  | B: mock board | ✅ Six cards `fresh`, then `cached` on the next read. `X-Cache: hit`, and `max-age` counted down from 15 (a team was live) |
  | B: team, schedule, game, prediction, health | ✅ 12-row schedule with the week-5 bye and a live game. The game endpoint scored from the requested team's side. The prediction was labeled `mock_predictor`. The KV ledger showed no `live_game` or board writes |
  | B: admin search | ✅ 401 with no token. ⏳ The admin-token half needs the owner's login (see follow-ups); the automated route tests cover it with real ES256 tokens |
  | B2: `team:251`, cold cache | ✅ Texas unavailable, five cards `fresh`, `max-age=10` |
  | B2: `rankings`, cold cache | ✅ Every rank `{"kind":"unavailable"}`, records intact |
  | B2: `all`, warm cache past its TTL | ✅ Six cards `stale`, each with its original `fetchedAt` (from 87 minutes earlier), `X-Cache: stale`, `max-age=10` |
  | B2: `all`, cold cache | ✅ A 200 with six `provider_unavailable` cards, each carrying the response's `X-Request-Id` |
  | C: real ESPN | ✅ All 12 cards on two boards. Texas Tech live at 28–20 with 4:31 left in the 4th. Texas Tech's schedule had 13 rows (week-6 bye, TBD kickoffs, the live row with the overlay score). The live game had a 25 s TTL. Predictions came back for an upcoming, a live, and a final game. 18 KV writes |

- **One test-plan defect found and fixed.** Faults fire only when the API actually calls the provider. Straight after Level B, the local KV cache held every schedule and the rankings, so restarting with `team:251` or `rankings` changed nothing: the cards came back `cached`. README Level B2 now says for each drill whether to start with a cold cache (with the command to clear it) or with a warm one past its TTL. Behaviour was correct; only the instructions were incomplete.

#### Known limitations carried forward

- **CPU.** Measured in Node, a Saturday scoreboard parses in about 7 ms and the team list in about 6.6 ms, against the free tier's 10 ms CPU limit. Both are parsed once per refresh, not per request, but a cold refresh on the request path is the risk (§10 risk register). Check Workers CPU time in observability after deploy. A Phase 5 cron warmer would move these refreshes off the request path.
- **The KV ledger is per isolate.** It is an early-warning brake, not a global count. The authoritative number is in the Cloudflare dashboard.
- **L2 is inert on `workers.dev`.** The probe reports it honestly, and L1 plus L3 carry the load.
- **Coalescing is per isolate.** Two isolates can each fetch the same key once.
- **A live card with no scoreboard.** If the scoreboard fails for a game the schedule shows as in progress, the card shows the live status with a null score, flagged `stale`. Phase 4's live treatment should render that as "score unavailable".
- `wrangler.toml` KV ids are still placeholders, as in Phase 1. Phase 5 creates them.
- **Faults act only on provider calls.** They are a tool for drilling the degraded paths, not a way to fake a board. Anything still inside its TTL is served from cache regardless.

#### Housekeeping at close

- **Commit `10c6425` on `main`**, 64 files, message approved by the owner, no Co-Authored-By trailer. It is not pushed, because the repository has no remote yet.
- **`apps/api/.dev.vars.example`** had two uncommented lines, `SPORTS_PROVIDER=espn` and `ESPN_USER_AGENT=...`. They were removed before the commit, with the owner's agreement. A fresh copy starts in mock mode, and the commented ESPN lines further down explain when to switch.
- **`.env.example` was left out of the commit.** The working copy holds the real Supabase URL (with a stray `/rest/v1/` suffix) and the publishable key. Those belong in the gitignored `.env`.
- Dev servers started during the phase were stopped. The owner's own `npm run dev` on port 8787 was never touched.

#### Phase 2 owner follow-ups

- [ ] **Decide what `ESPN_USER_AGENT` production sends**, before the first deploy. For ESPN mode locally, put `SPORTS_PROVIDER=espn` and the chosen value in `apps/api/.dev.vars`, not in the example file.
- [x] **Clean `.env.example`**: move the real values into `.env`, restore the placeholders, and drop `/rest/v1/` from the URL. Done at the Phase 3 close.
- [ ] **Admin team search with a real admin token** (README Level B, using `$ADMIN` from Phase 1's Level 3c). The 401 half was run.
- [ ] **Create the GitHub remote and push `main`.** It holds two commits now. This was also a Phase 1 follow-up.
- [ ] Phase 1's other follow-ups (`verify:rls`, the live 403/201 check, renaming users) are listed in its notes. Tick them there when they're done.

#### Notes for Phase 3 and beyond

**Phase 3 (frontend core)**

- **Build against mock mode,** the default. It needs no ESPN, gives the same results every run, and always has live games, byes, and postponed and canceled games somewhere. Switch to ESPN only to spot-check.
- **Use `SPORTS_PROVIDER_FAULT` for the error and stale states.** The exit criterion "with the provider forced to fail" is README Level B2. Mind the cold-versus-warm-cache rule above.
- **Show each card's own `snapshot.freshness.fetchedAt` as "last updated".**
  - The board-level `freshness` only records when the board was assembled.
  - For the board header, show the *oldest* card's `fetchedAt`, and a stale marker if any card is `stale`.
- **Render every state the API can return.** No field should ever show `undefined` or `NaN`:
  - Ranking: `ranked` → `#4`, `unranked` → `NR`, `unavailable` → `—`.
  - `record: null` → `—`.
  - `kickoffTbd` → the date plus "TBD", never "12:00 AM".
  - `nextGame.kind: 'bye'` → "Bye week, then …". `'none'` → "Season complete" or "No upcoming games".
  - An error card still has `team` for its header.
- **Polling is already aligned.** The board's server TTL (15 s live, 60 s otherwise) matches §9's `POLL` intervals. `Cache-Control` lets the browser absorb repeats, so a refetch inside `max-age` may never reach the Worker, and that is by design. A degraded board comes back with `max-age=10`, so it recovers on the next poll.
- **Test layout with the longest seeded name,** Southern Miss.

**Phase 4 (detail and live)**

- **Decide on predictions for final games.** ESPN still returns the pregame numbers after the game ends. Either hide the prediction once a game is final, or label it "Pregame prediction". Never show it as if it were current.
- **Render a null live score on a `stale` card as "score unavailable"** (see the limitations above).
- **Where live data comes from.**
  - `GET /api/games/:id` refreshes live games every 25 s, and the board every 15 s.
  - The live overlay checks games up to 6 h after kickoff. A game still unresolved after that falls back to schedule data.
  - Delayed and suspended games remain "next" for 3 days.

**Phase 5 (admin and ship)**

- **Measure ESPN from the deployed Worker first.** Once `ESPN_USER_AGENT` is decided, check that a board fills before flipping production to `SPORTS_PROVIDER=espn`. Then look at CPU time in Workers observability, since the Saturday scoreboard parse is the known risk.
- **Cron warmers are the CPU fix and the KV-budget ally.** Refreshing the calendar, rankings, and team list, plus the scoreboard on game days, keeps parsing off the request path. Their KV writes follow the same per-key intervals.
- **Deploy-time settings.** Create the KV namespaces. Narrow `ALLOWED_ORIGINS` to the deployed origin. Leave `SPORTS_PROVIDER_FAULT` unset.
- **Candidates to finish in Phase 5.**
  - Move the route tests to `@cloudflare/vitest-pool-workers`.
  - Turn the README Level B2 drills into a smoke script to run against the deployed Worker.
  - Build the conference two-hop lookup, keyed by season.

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

### Phase 3 — Completion Notes

**Complete, 2026-09-18.** Built and browser-tested before handover. The owner then ran README "Testing Phase 3", Levels A, B, B2, and B3. Level C (admin sign-in) was run in headless Edge with the owner's real admin and non-admin accounts, and all six steps passed (see Verification performed). As with Phases 1 and 2: where these notes and the plan above disagree, the code and these notes win.

#### Exit criteria

"Automated" means the criterion was checked in headless Microsoft Edge driven by `playwright-core`. The run used a fresh browser context each time, which is a private window with no storage. It ran against a real `wrangler dev` Worker in mock mode and the live Supabase project, in light and dark mode. The script lives outside the repo (see departure 12).

| Exit criterion | Result | How it was verified |
|---|---|---|
| Home → board → team works against the real Worker in a private window, with no login step | ✅ automated · ✅ owner | Home listed 9 boards. Clicking Wilson showed 6 cards, and a card opened its team page. The back link and browser back/forward returned correctly. There were **zero requests to `supabase.co`** and the auth chunk was **never downloaded**. No console errors. README Level B |
| The board renders at 320, 768, and 1440 px with no horizontal scroll | ✅ automated · ✅ owner | `scrollWidth − clientWidth = 0` for home, board, and team at all three widths, in both themes. Checked on Wilson's board and on Emerson's, which has Southern Miss, the longest seeded name. README Level B2 |
| With the provider forced to fail: cached values plus a visible stale indicator; with no cache, clean unavailable states | ✅ automated · ✅ owner | With `SPORTS_PROVIDER_FAULT=slate,team:251`, the two live cards got a dashed amber outline and "May be out of date. Last updated: …". The board header was marked stale. Texas kept its logo and name above "Sports data temporarily unavailable." With `all` on a cold cache: six unavailable cards, no rank, no "Last updated". README Level B3 |
| No `undefined` or `NaN` anywhere (§37) | ✅ | 29 card tests render every state the API can return and assert on the text. In every browser run and drill, each page's full text was checked for `undefined`, `NaN`, `null`, `[object Object]`, and `Invalid Date` |
| Keyboard only: tab from the header to all six cards, visible focus, Enter opens a team (§48) | ✅ automated · ✅ owner | The recorded tab order was Skip to content, CFB Board, Boards, All boards, Refresh, then the six cards, each drawing a 3 px focus ring. Enter on the focused card opened that team |
| A blocked logo shows initials and leaves the card intact (§36) | ✅ automated · ✅ owner | With every image request aborted: 6 labelled initials placeholders (`role="img"`, `aria-label="<Team> logo"`), 0 `<img>` elements, and all 6 cards intact |

#### What was built

| Area | Where | Notes |
|---|---|---|
| Shell | `apps/web/src/app/` | Vite, React 19, and strict TypeScript. `createBrowserRouter` with a root layout containing a skip link, the header, and one `<main>` that takes focus after each navigation (not on first load). Also a page-level `ErrorBoundary` keyed by path, and `ScrollRestoration`. Routes: `/`, `/u/:userId`, `/teams/:teamId`, `/login`, `/admin`, and a not-found page |
| Data layer | `src/lib/` | `apiClient.ts`: `getPublic` (never sends a token) and `requestAdmin` (a bearer token; on a 401, one refresh and one retry, then sign out and go to `/login`). Every failure becomes an `ApiError` carrying the server's `AppError`, and a dropped connection has `status: null`. `api.ts`: endpoints and query keys. `queryClient.ts`: defaults, plus a retry policy (never retry a 4xx; otherwise twice, with backoff). `poll.ts`, `format.ts`, `freshness.ts`, `teamColor.ts`, `config.ts` |
| Admin session | `src/auth/` | `adminAuth.ts` decides from localStorage alone whether to load anything, then lazy-loads the client. `supabaseClient.ts` is the only file that imports `supabase-js`: password sign-in, a persisted session, auto-refresh, and local sign-out. `AdminSessionProvider` exposes status, email, and per-request auth hooks. `RequireAdmin` checks for a session, then asks the Worker (`/api/admin/session`) |
| Design system | `src/styles/`, `src/components/` | `tokens.css` and `global.css`. Components: `Card`, `RankBadge` and `RecordBadge` (in `Standing.tsx`), `GameLine` (opponent, home/away mark, result, status tag, previous and next lines, game facts), `LiveBadge`, `LiveScore`, `TeamLogo`, `FreshnessLabel`, `Skeleton`, `EmptyState`/`ErrorState`/`LoadingNote` (in `States.tsx`), `ErrorBoundary`, `BackLink`, `AppHeader`, and inline SVG icons |
| Home (§15) | `features/home/` | One tile per board: monogram, name, team count. One tap opens the board |
| Board (§13, §14) | `features/board/` | The header shows the name (the page's one bold typographic element), the season and week, the ranking poll's name, "Last updated" (the oldest card's time), a Refresh button, and a notice if a refresh failed. Six `TeamCard`s, each inside its own `ErrorBoundary`. A skeleton on the first load only; after that the data stays on screen with a quiet "Refreshing…" |
| Team (Phase 3 scope) | `features/team/` | The hero (logo, name, full name, conference, rank, record, season, freshness), the live score, and previous and next game panels with date, venue, and TV. It opens instantly by borrowing the card's data from the loaded board, then replaces it with the real response |
| Admin (shell only) | `features/admin/` | `/login`: an email and password form with plain error messages; after sign-in it goes to `next`, which must be an in-app path. `/admin`: shows who is signed in, that the server confirmed the account is an admin, and a sign-out button. Managing boards is Phase 5 |
| API | `apps/api/src/routes/admin.ts` | `GET /api/admin/session` (see the §8 note), plus 3 route tests |
| Tooling | root | Vitest runs `*.test.tsx` with React's automatic JSX runtime. ESLint covers `.tsx` and adds `react-hooks/rules-of-hooks` and `exhaustive-deps`, both as errors. The season check allows `.test.tsx`. New scripts `dev:web` and `build:web`. CI gains a web build step |
| Docs | `README.md`, `apps/web/.env.example` | "Testing Phase 3", Levels A–C, with an exit-criteria table and new troubleshooting rows |

**Dependencies added:**
- `apps/web`: `react` and `react-dom` 19.3, `react-router` 7.18, `@tanstack/react-query` 5.103, and `@supabase/supabase-js` 2.116. The last three are the ones §3 names.
- Dev: `vite` 7.3, `@vitejs/plugin-react` 5.2, and the React types.
- Root dev: `eslint-plugin-react-hooks` 5.2.

Vite 7 matches the version Vitest 3.2 already uses. Vite 8 and React Router 8 exist, but taking them would have meant two Vite majors in one tree and an unfamiliar router API, for no gain here.

#### Design as built (§35)

- **Palette.** "Chalk and turf":
  - Light: page `#f2f5f1`, cards white, ink `#13201a`, one green accent `#1a6639`.
  - Dark: page `#0e1511`, card `#16201a`, accent `#74d198`.
  - Semantic colours for live, win, loss, and stale.
  - Every text pairing was measured at WCAG AA or better in both themes. The lowest is muted text on the sunken surface in light mode, at 4.91:1.
- **Type.** Barlow Condensed for names, ranks, records, and scores, with tabular figures. Barlow for body text. The board owner's name is set large, like a game-program cover.
- **Team colour.** Only the card's 4 px left rule. Each theme picks its own colour: the primary if it shows up against that card, else the alternate, else neutral. So a white primary never disappears on a light card, and Michigan's navy switches to maize on a dark one.
- **Stale.** A dashed amber outline plus the words "May be out of date. Last updated: …". It is a shape and words, not colour alone.
- **Motion.** The LIVE dot pulses. Skeletons breathe on the first load. The Refresh icon spins while fetching. All of it is removed under `prefers-reduced-motion`.

#### Departures from the plan, and why

1. **The card link is the team name, stretched over the card**, not an `<a>` wrapping the card (§9). Clicking anywhere, the keyboard, middle-click, and "open in new tab" all behave the same. A screen reader hears "Alabama, link" rather than the whole card read out as one link name. The focus ring is drawn around the card with `:has()`. Where `:has()` isn't supported, the name itself shows the ring.
2. **Public reads never carry a token, even while the admin is signed in** (plan §3.1 said "attaches a bearer token only when an admin session exists"). Reads are public. A token would add a CORS preflight and change how the response caches, and it would buy nothing. The auth hooks are passed to each admin call explicitly: there is no global token a request could pick up by accident.
3. **A new API route, `GET /api/admin/session`,** so `RequireAdmin` can show "Not an administrator" to a valid non-admin login instead of a console whose every action fails. It is UX only; RLS remains the boundary.
4. **The auth library is loaded based on localStorage.** The session is stored under the fixed key `cfb-admin-session`. When that key is absent, which is every viewer, nothing loads and nothing touches the network. `/login` and `/admin` load the chunk on demand. This is what makes "zero auth calls" measurable.
5. **Per-card freshness is shown only when a card is stale.** The board header shows `Last updated:` from the oldest card, plus a stale marker if any card is stale (the Phase 2 guidance). Repeating the same time on six cards added clutter without adding information.
6. **"No games today" means "no kickoff within 12 hours".** A calendar-day rule would flip at midnight, in the middle of a late game. A card that is failing or stale also keeps the 60 s pace, so the board recovers quickly.
7. **TBD dates are formatted in US Eastern.** The placeholder time is midnight Eastern, so formatting it in Pacific would move the game to the previous day. College football game days are Eastern days, so this is domain knowledge, not ESPN knowledge.
8. **The dev server proxies `/api` to the Worker**, so local work needs no CORS setup and no `.env`. Production (Pages plus a Worker on another origin) sets `VITE_API_BASE_URL` and uses the existing CORS allowlist. The direct, cross-origin path is still supported for development.
9. **Layout additions to §2.**
   - `src/app/` holds `App.tsx`, `routes.tsx`, `RootLayout`, and `NotFoundPage`; the plan had `App.tsx` and `routes.tsx` directly under `src/`.
   - Two component files each hold a small family: `Standing.tsx` has the rank and record badges, and `States.tsx` has the empty, error, and loading states.
   - `src/test/` holds fixture builders and render helpers.
10. **Component tests render to static markup with `react-dom/server`.** This avoided adding jsdom or Testing Library as dependencies. They exercise the real components, router, and query cache. Static rendering never runs error boundaries, so `ErrorBoundary` is tested through its static state methods.
11. **Fonts come from Google Fonts** (`Barlow`, `Barlow Condensed`, with `display=swap`). If they are blocked, the system fallbacks keep everything readable. Self-hosting them is a Phase 5 option (see the limitations below).
12. **The browser end-to-end script is not in the repo.** It needs a browser binary, which CI does not have, and adding Playwright would be a new dependency. The README gives the owner the same checks to run by hand.

#### Contract changes (`packages/shared`)

- `AdminSessionResponse { admin: { authUserId: string } }`, for `GET /api/admin/session`. Nothing else changed. The web app consumes the Phase 2 contract exactly as it was.

#### Verification performed

- **Automated.** 387 tests across 20 files, all passing. Phase 3 added 100:
  - Team card states: 29.
  - Board and team pages, plus `ErrorBoundary`: 14.
  - API client and configuration: 18.
  - Date formatting: 16 (including a DST "Tomorrow" case, and TBD dates for a Pacific viewer).
  - Polling: 11. Freshness summary: 6. Team colours: 3.
  - The API's admin-session route: 3.
- **Other checks.** `npm run verify` (typecheck, lint, tests, and the season check), `format:check`, and `npm run build:web` all pass.
- **Bundle.**
  - Main JS: 389 KB (123.5 KB gzipped), mostly `react-dom` and `react-router`. CSS: 15.8 KB (4 KB gzipped).
  - The login and admin page chunks are about 1–2 KB each. The auth chunk is 225 KB (59 KB gzipped) and viewers never download it.
- **Browser runs** (see "automated" under Exit criteria).
  - 29 checks, run in light mode, in dark mode, and on Emerson's board. All passed.
  - The `slate,team:251` drill and the cold `all` drill.
  - The admin path: `/admin` redirected to `/login?next=%2Fadmin`, and the header had no Admin link. Opening `/login` loaded the auth chunk but made no auth call. A wrong password reached Supabase Auth and showed "Email or password is incorrect."
- **Owner test pass.** The owner ran README Levels A, B, B2, and B3 by hand.
- **Level C, with real accounts.** 31 checks in headless Edge (`playwright-core` driving the installed Edge), against the owner's own `npm run dev` and `npm run dev:web` and the live Supabase project. The accounts were read from the root `.env` (`VERIFY_ADMIN_*`, `VERIFY_NONADMIN_*`) and never printed. All passed:
  1. No page (home, board, or team) links to `/login` or `/admin`. The header has no Admin link, and a viewer makes zero requests to `supabase.co`. `/admin` with no session lands on "Admin sign-in" at `/login?next=%2Fadmin`.
  2. A wrong password for the admin's email reaches Supabase Auth (`POST /auth/v1/token`) and shows "Email or password is incorrect.". Focus moves to the message and nothing is stored.
  3. The admin signs in and lands on `/admin`, which shows the email and "The server confirmed this account is an administrator". `GET /api/admin/session` answered **200**, and the Admin link appeared in the header.
  4. After a reload the admin is still signed in, the session is stored under `cfb-admin-session`, and the Worker confirmed it again with 200. A new tab opened on `/admin` was signed in too.
  5. Sign out lands on `/`, the Admin link disappears, and the stored session is removed. `/admin` then asks for sign-in again.
  6. The non-admin signs in and sees "Not an administrator", naming the account, with a Sign out button. `GET /api/admin/session` answered **403**. Sign out returns to Admin sign-in and clears the session.

  The only console errors were the expected 400 (wrong password) and 403 (non-admin). The first non-admin account in `.env` was refused by Supabase with `invalid_credentials`: that account was missing from the project or had a different password. The owner recreated it and the re-run passed. The README troubleshooting table now covers this.
- **Visual review.** Screenshots of every page at 320, 768, and 1440 px in both themes. Three fixes came out of it:
  - a stray gap inside "Last updated:";
  - "(neutral site)" and results wrapping badly on phones;
  - the team page's live score spreading across the full width, and plain panels showing a grey team-colour rule they didn't need.

#### Known limitations carried forward

- **"Last updated" during a live game can look old.** A card's `fetchedAt` is the oldest part of the card (Phase 2's `composeFreshness`). While a team is live, the 15-minute schedule is usually the oldest part, so the header can say 9:22 PM while the live score is seconds old. This was seen in the run. It is honest, but Phase 4 may want the live block to show its own age. That would need the API to expose the overlay's `fetchedAt` separately.
- **Logos are ESPN's 500 px images, shown at 48–72 px** (§49, "reasonable image sizes"). Resizing them would mean ESPN URL knowledge in the frontend, which §26 forbids. The fix belongs in the API or at seed time, in Phase 5.
- **The main bundle is 123.5 KB gzipped.** Review it in Phase 5's performance pass. React Router's data router is the largest piece after `react-dom`.
- **A render crash inside a card has not been seen in a browser.** It can't be triggered without malformed data. The boundary's logic is unit-tested, and the fallback shows the team's identity plus "Unable to display this team."
- **The header shows an Admin link to a signed-in non-admin.** `AppHeader` shows the link whenever the session status is `signed-in`, before and regardless of the Worker's `/api/admin/session` answer. It was seen in Level C step 6. Nothing is exposed: the link leads to "Not an administrator", and RLS refuses the writes anyway. Phase 5 can show the link only once that check returns 200.
- **An unconfirmed account is told its password is wrong.** `describeSignInError` in `apps/web/src/auth/supabaseClient.ts` maps every 400 from Supabase to "Email or password is incorrect.". That includes `email_not_confirmed`, which is what an account created without **Auto Confirm User** gets. Phase 5 can map that code to its own message ("This account's email hasn't been confirmed").
- **`npm audit` reports a moderate advisory in `vitest`** (the `@vitest/mocker` path traversal). It was already there before Phase 3 and affects development only. The fix is Vitest's next major version, which is a separate change.
- **Google Fonts is a third-party request** on every first visit. Self-hosting the two families would remove it.

#### Housekeeping at close

- **Committed together with these notes, once the owner approved the message** (the owner's standing rule; no Co-Authored-By trailer). Not pushed: there is still no remote.
- **`.env.example` was restored** to its committed placeholders (`git checkout -- .env.example`, at the owner's request). The working copy had held the real Supabase URL, with a stray `/rest/v1/` suffix, and the publishable key. This closes that Phase 2 follow-up. The real values live in the gitignored `.env`, which now also holds the two `VERIFY_*` test accounts.
- **Level C tooling stayed outside the repo.** `playwright-core` was installed into a scratch folder, not the workspace, and drove the Edge already installed on the machine. The run used the owner's running servers on 8787 and 5173. It started and stopped no servers.
- **`apps/web/.env` was created** from `apps/api/.dev.vars` (the Supabase URL and publishable key, both public by design) so `/login` works locally. It is gitignored, as `git check-ignore` confirmed.
- **Test servers.** The browser runs used separate `wrangler dev` instances on ports 8798 and 8799, each with its own `--persist-to` folder in a scratch directory, and Vite on 5180 and 5181. All were stopped afterwards.
  - Two lessons, for anyone repeating this on Windows. First, stopping the background task did not stop wrangler's child `workerd` processes, which then respawned onto the same port. Second, the pattern-based cleanup that followed also stopped **the owner's own `npm run dev` on port 8787** by mistake. No data was lost, but it has to be restarted.
  - Next time, match processes by exact PID, never by a command-line pattern.
- `apps/web/dist` (build output, gitignored) was removed after the size check.

#### Phase 3 owner follow-ups

- [x] Restart `npm run dev`. The Phase 3 cleanup stopped it (see Housekeeping).
- [x] Run README "Testing Phase 3", Levels A, B, B2, and B3.
- [x] README Level C with real accounts. All six steps passed (see Verification performed):
  - the admin signs in and lands on **Admin**;
  - the session survives a reload;
  - signing out removes the Admin link;
  - the non-admin account gets **Not an administrator**.
- [x] Approve the Phase 3 commit, and tick the checklist at the top of this file.
- [ ] Earlier follow-ups still open: Phase 1 (`verify:rls`, the live 403/201 test, renaming users) and Phase 2 (the `ESPN_USER_AGENT` decision, the admin team search with a real token, and creating the GitHub remote). Both test accounts are now in `.env`, so `npm run verify:rls` is ready to run.

#### Notes for Phase 4 and beyond

**Phase 4 (detail and live)**

- **Build on the existing team page.** It already has the hero, the live block, and the previous and next panels. Add the schedule and the prediction as sections with their own `useQuery` calls, so a failing schedule cannot blank the hero (§42). Reuse `GameLine`'s pieces (`Opponent`, `GameResultText`, `StatusTag`, `GameFacts`) for schedule rows.
- **Polling is already centralized.** Add any new intervals to `POLL` in `src/lib/poll.ts`. Hidden-tab pausing and the single refetch on focus are already global defaults.
- **Done early:** Phase 2 asked Phase 4 to render a live game with no score as "score unavailable". `LiveScore` already does this and never shows 0–0.
- **Still open from Phase 2:** hide the prediction, or label it "Pregame prediction", once a game is final.
- **Worth considering:** the live block's own freshness (see the first limitation above).

**Phase 5 (admin and ship)**

- **The admin console goes inside `RequireAdmin`** at `/admin`. Call the API with `requestAdmin(session.authHooks, …)` and put query keys under `['admin', …]`: sign-out clears that prefix.
- **Two sign-in fixes from Level C** (see Known limitations): show the header's Admin link only after `/api/admin/session` returns 200, and give `email_not_confirmed` its own message.
- **Deploying to Cloudflare Pages.**
  - Build with `VITE_API_BASE_URL` set to the Worker's URL, and with `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` set.
  - Add the Pages origin to `ALLOWED_ORIGINS`.
  - Confirm that deep links (`/u/…`, `/teams/…`) reload correctly. Pages serves a single-page app when there is no `404.html`, but check it on the real deployment.
- **Performance pass:** review the bundle, size the logos through the API, and consider self-hosting the fonts.
- **Accessibility pass:** axe on all four pages, and a screen-reader check of the live score region.

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

### Phase 4 — Completion Notes

**Built and verified 2026-09-19. Waiting for the owner's test pass (README "Testing Phase 4") and commit approval.** As with the earlier phases: where these notes and the plan above disagree, the code and these notes win.

#### Exit criteria

"Automated browser run" means headless Microsoft Edge driven by `playwright-core`, against two real `wrangler dev` Workers in mock mode (one in season, one with `SEASON_OVERRIDE=<year>:postseason`) and the live Supabase project. Each check used a fresh browser context, like a private window. The script lives outside the repo, as in Phase 3.

| Exit criterion | Result | How it was verified |
|---|---|---|
| The team page shows identity, rank, record, conference, previous, next, prediction, and the complete schedule | ✅ | 5 page tests (sections in §16 order under one `h1`, the poll named, every schedule state). In the browser at 320, 768, and 1440 px in both themes: every section present, no horizontal scroll, no raw values, no Supabase traffic, no console errors, and axe clean at 320 and 1440 px in both themes |
| With the prediction removed, the page renders fully with `Prediction unavailable` | ✅ | 5 page tests: none published, provider failure, request failure, numbers that aren't percentages, and loading. In the browser, a mock game with no prediction (Oregon's next game) showed `Prediction unavailable` with the rest of the page complete |
| With the schedule forced to fail, the hero and game panels still render | ✅ | 6 page tests: request failure, provider failure, stale, empty, loading, and the reverse (snapshot failed, schedule fine). In the browser the schedule request was blocked: `Schedule unavailable` with **Try again**, and the hero, both game panels, and the prediction stayed. Unblocking and pressing **Try again** brought the schedule back |
| A live fixture shows the live block on both board and detail, with period and clock, and no "Final" wording | ✅ | 6 page tests and 3 new card tests. In the browser, Tennessee live at Tulane: the card and the team page showed `LIVE`, `0:26 - 3rd Quarter`, the score, and `Updated <time>`. The schedule's live row showed `31–20` with no verdict. The prediction was labeled pregame. No "Final" on either page |
| Mock offseason season: no upcoming games, zero crashes, `Season complete` shown | ✅ | 4 page tests, 3 API route tests, and 2 mock tests. In the browser at 320 and 1440 px: all six cards on Wilson's board said `Season complete`, and the team page kept its record, its full final schedule with bye weeks, and `There's no upcoming game to predict.` |
| Hidden tab: polling stopped, then a single refetch on focus | ✅ | 3 tests drive the app's real `QueryClient` with a fake clock. A mutation check (setting `refetchIntervalInBackground: true`) makes them fail. In the browser, on a live team's page: requests at 0, 16, and 31 s while visible, none in 45 s hidden, and exactly one on return |

#### What was built

| Area | Where | Notes |
|---|---|---|
| Team page | `features/team/TeamPage.tsx` | Three independent reads. The schedule query starts on mount, alongside the team request rather than after it. Panels: previous, next, prediction (stacked on phones, two across with the prediction below on tablets, three across on desktops), then the schedule. The hero now names the poll and gets the dashed stale outline, like a card |
| Schedule | `features/team/ScheduleSection.tsx` | §17. From 720 px, a `<table>` with a hidden `<caption>`, `<th scope="col">`, and the opponent as each row's `<th scope="row">`. Below 720 px, an ordered list of stacked entries. Both are rendered and CSS shows one; the hidden one is out of the accessibility tree. Bye weeks are rows. The next game is marked **Next** and the live row carries a LIVE badge, and both also get an inset rule. Loading, error with **Try again**, empty, stale, and "couldn't refresh" states |
| Result marks | `components/ResultMark.tsx` | W is a solid tile, L outlined, T dashed and neutral, each with its word for screen readers. It reads correctly in greyscale |
| Prediction | `features/team/PredictionPanel.tsx`, `lib/prediction.ts` | §12, §46. It names the game it is about. The viewed team comes first, matched by provider team id. Both percentages are shown as text; one split bar repeats them and is `aria-hidden`. `Source: <sourceLabel>` always. Every way of having no prediction says `Prediction unavailable` plus a reason |
| Live | `components/LiveScore.tsx`, `lib/format.ts` | The live block shows `Updated <time>` from the new `liveUpdatedAt`. `liveSituation` never repeats provider wording that says "Final" while the status is live |
| Polling | `lib/poll.ts` | `schedulePollInterval` (live row → 15 s; kickoff within 12 h, stale, or failed → 60 s; else 5 min) and `POLL.predictionMs` (5 min) |
| API | `services/live.ts`, `services/snapshot.ts` | `TeamSnapshot.liveUpdatedAt`: the fetch time of the slate that supplied the live game's score |
| Mock | `providers/mock/generate.ts` | Every mock game is a regular-season game whatever phase the timeline is built around, as ESPN's are. This keeps bye weeks in the offseason schedule |
| Shared pieces | `features/team/Panel.tsx`, `TeamLogo`, `States` | A titled section panel. `TeamLogo` gains `decorative` for logos printed beside the name. `EmptyState` and `ErrorState` take `headingLevel` 1–3 |
| Docs | `README.md` | "Testing Phase 4", Levels A, B, B2, and B3, an exit-criteria table, and two troubleshooting rows |

No dependencies were added.

#### Decisions and departures, and why

1. **Predictions for final games: never shown** (the open item from Phases 2 and 3). The panel's game is the live game, else the next one (after a bye, the game that follows it), and never a final or canceled game. During a live game the numbers are labeled "Pregame prediction, made before kickoff. It does not change during the game." The API still passes through whatever the provider returns; the page simply never asks about a finished game.
2. **`TeamSnapshot.liveUpdatedAt` (contract change).** This fixes Phase 3's first known limitation: a card's `fetchedAt` is its oldest part, often a schedule up to 15 minutes old, which made a live score seconds old look stale. The composed freshness is unchanged, and so is the §39 rule. The live block now also says how old its own score is. It is `null` when there is no live game, or when the live status comes from the schedule alone.
3. **"Schedule forced to fail" is a request-level drill, not a provider fault.** The schedule route and the team snapshot share one provider read, so `SPORTS_PROVIDER_FAULT=schedule` fails both, by design. What §42 requires of the page is that one *request* failing leaves the others standing. The README drill blocks the request in DevTools; the automated run blocked it with Playwright.
4. **Two renderings of the schedule, switched by CSS at 720 px**, rather than one table restyled into cards. Changing a table's `display` drops its table semantics in some browsers, and a `matchMedia` hook would flash on load. Only one rendering is ever in the accessibility tree.
5. **The schedule polls on its own rule.** A live row updates at the live pace, so the table agrees with the live block within one poll.
6. **Mock games are always `regular` season type.** Before, in postseason mode every mock game was labeled postseason, so the offseason schedule lost its bye weeks and every week label read "Postseason". The game id still encodes the phase, so `getGame` rebuilds the same timeline.
7. **Real spaces between inline pieces, including in Phase 3 components.** Flex gaps looked right on screen, but the text ran together for screen readers ("vs LSUW 31–24", "LIVE4:32", "#44-0"). There are now spaces in `GameLine`, `LiveScore`, the card's rank and record, and every new component.
8. **Test helper changes.** `visibleText` now removes any visually hidden element, not only spans, and treats table cells and list items as blocks. Two Phase 3 tests changed accordingly: loading text is read with `spokenText`, because it is screen-reader-only, and board order is found by each card's link, because "LSU " now also matches a spaced previous-game line.

The watch-out items needed no new code. Scoreboard and summary clock and period were already normalized in Phase 2, and tested against both captures (`normalize.test.ts`). Overtime finals show the provider's own wording (`Final/OT`), verbatim.

#### Verification performed

- **Automated.** 473 tests across 24 files, all passing. Phase 4 added 86:
  - Team page: 30. Schedule: 17. Prediction: 11. Hidden tab: 3.
  - Formatting: 7. Polling: 6. Cards: 3.
  - API: 9 (routes 5, live overlay 2, mock 2).
- **Other checks.** `npm run verify` (typecheck, lint, tests, season check), `format:check`, and `npm run build:web` all pass.
- **Bundle.** Main JS 403.6 KB (127.5 KB gzipped), up 4 KB gzipped from Phase 3. CSS 22.1 KB (5.0 KB gzipped).
- **Browser run.** 57 checks, all passing, in light and dark at 320, 768, and 1440 px. It found three script defects and no app defects. Two checks read the page before the schedule had arrived. The third was the hidden-tab simulation: a synthetic `visibilitychange` must be dispatched with `bubbles: true`, as the browser's own is, or the return refetch never fires.
- **Visual review.** Screenshots of the full, live, schedule-failed, and offseason pages. Three fixes came out of it:
  - the Result column header was left-aligned over right-aligned scores;
  - an in-panel error heading was larger than its panel's title;
  - on phones, the marked schedule entries' rule sat too close to the text.

#### Known limitations carried forward

- **Only mock data was used in Phase 4.** No real-ESPN spot check was made. The shapes are the same as Phase 2's, which was checked live, but the first real Saturday on the new page is a Phase 5 item.
- **In development, the team request fires twice on mount.** React's StrictMode mounts twice, and the first fetch is cancelled. Production mounts once.
- **The offseason drill's mock dates are in the summer.** The mock timeline is anchored to today. The data is labeled mock throughout.
- **If a prediction's teams match neither side of the game** (a provider error), both halves of the bar are grey. The numbers and names are still shown, away team first.
- The board header's "Last updated" is still the oldest card part, as designed. The live block now carries its own time.

#### Housekeeping at close

- **Not committed.** It waits for the owner's approval of the message (standing rule).
- **Test servers.** `wrangler dev` ran on 8798 and 8799, each with its own `--persist-to` folder in the session scratchpad, and Vite on 5180 and 5181. All four were stopped by exact PID with `taskkill /T`, after confirming each command line, so their `workerd` children went too. The owner's own servers on 8787 and 5173 were never touched and are still running.
- `playwright-core` and `axe-core` were installed in the scratchpad, not the workspace. `apps/web/dist` was removed after the size check.

#### Phase 4 owner follow-ups

- [ ] Run README "Testing Phase 4", Levels A, B, B2, and B3. Remove `SEASON_OVERRIDE` and `SPORTS_PROVIDER_FAULT` from `apps/api/.dev.vars` afterwards.
- [ ] Approve the Phase 4 commit, and tick the checklist at the top of this file.
- [ ] Earlier follow-ups are still open: Phase 1 (`verify:rls`, the live 403/201 test, renaming users) and Phase 2 (the `ESPN_USER_AGENT` decision, the admin team search with a real token, and creating the GitHub remote).

#### Notes for Phase 5

- **Accessibility pass.** Axe is already clean on the team page at 320 and 1440 px in both themes. What remains: home, board, and admin; the keyboard walkthrough; and a real screen-reader check of the live score region and the schedule table.
- **The first real-ESPN look at the team page** belongs with the deploy measurement. Check that a real schedule's postseason rows read "Postseason", and that a live game's prediction shows the pregame label.
- **Performance.** The main bundle is 127.5 KB gzipped. The schedule adds up to about 15 small opponent logos per team page. They are lazy-loaded, but they are ESPN's 500 px images, so sizing logos through the API (a Phase 3 limitation) matters more now.

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

### Phase 5 — Completion Notes

**Built and verified locally, then deployed and verified live, 2026-09-19. Not committed.** As with the earlier phases: where these notes and the plan above disagree, the code and these notes win. These notes are written so that another engineer, or another model, can pick the work up cold.

#### Handoff: where to pick up

**State of the repository.**

- Branch `main`. The last commit is `3ee11b8` (Phase 4). **All of Phase 5 is uncommitted in the working tree**: about 60 modified files and 30 new ones (`git status`). No GitHub remote exists yet.
- `npm run verify` passes: typecheck, lint, 704 tests in 31 files, and the season check. `npm run format:check` passes.
- Build outputs `apps/api/dist` and `apps/web/dist` are on disk, from the production deploy. Both are gitignored.
- The live Supabase project is exactly as seeded: 9 users, 50 teams, 54 selections. Every probe row was removed (the deployed-site browser run cleans up through the API in a `finally`, and `verify:rls` cleans up its own). **No migration changed in Phase 5**, so the database needs nothing.

**What is deployed** (details under "Deploy" below):

| Piece | Where | Version |
| --- | --- | --- |
| Site | Pages project `cfb-board`, <https://cfb-board-pfc.pages.dev> | Built from this working tree with `VITE_API_BASE_URL=https://cfb-api.cfb-api.workers.dev` |
| API | Worker `cfb-api` (`--env production`), <https://cfb-api.cfb-api.workers.dev> | Version `6b0ccb56-9d82-46f9-9eb2-aa969211334d`, including the live-overlay fix |
| Cache | KV `production-SPORTS_KV`, id `5777a3ec40164cc283c45de25f685ed3` | |
| Secrets | `SUPABASE_URL`, `SUPABASE_ANON_KEY` on `cfb-api` (production) | Same values as `apps/api/.dev.vars` |

Cloudflare account `4bb72f432f1b9521a2310ba2bccf01eb`, signed in with `wrangler login` (OAuth) on this machine.

**The owner's standing rules** (from their global CLAUDE.md). Never commit or push without asking immediately beforehand. Show a drafted commit message and wait for approval. Never add a `Co-Authored-By` trailer.

**What is left, in order.**

1. **Commit.** Draft a message, show it, and wait for approval. A suggested subject: `Phase 5: admin console, authorization, hardening, and deploy`.
2. **24 hours of usage** (from 2026-09-20): Workers requests, KV writes, and CPU time in the dashboard, into docs/ops.md "Recorded measurements". This is the only exit criterion still open. `wrangler`'s OAuth token has no analytics scope, so it has to be read in the dashboard.
3. **The owner on a real phone:** README "Testing Phase 5", Level C. Phone width was checked in headless Edge, not on a device.
4. **Optional.** Create the GitHub remote and set the CI deploy variables (docs/ops.md, "Continuous deployment"). With `SITE_ORIGIN=https://cfb-board-pfc.pages.dev` and `PAGES_PROJECT=cfb-board`. A real screen-reader pass of the live region, the schedule table, and the confirm dialog: only axe and accessible names were checked.

#### Exit criteria

| Exit criterion | Result | How it was verified |
| --- | --- | --- |
| Admin adds, removes, and reorders teams; the board reflects it on reload with the intended order | ✅ | 41 API tests (`apps/api/test/admin.test.ts`), including "the public board reflects an admin change on the next read". Browser run with the owner's real admin account: a probe person was created, three teams added, one reordered twice, one removed; the public board read Texas, Alabama, and the same after a reload. The probe was deleted afterwards |
| All negative authorization tests pass, including direct-to-database attempts | ✅ | 90 matrix tests (10 admin routes × 9 attacks), 44 PGlite tests (`supabase/test/rls.test.ts`), and `npm run verify:rls` against the live project: 44/44, including "public sign-ups are disabled" |
| axe reports no violations; keyboard-only operation of the admin console works end to end | ✅ | Browser run: axe clean on home, board, team, and login (320 and 1440 px, both themes), the console and editor (320 px, both themes, and 1440 px with search results), the confirm dialog, and a probe board. The whole admin flow was driven with Tab, Enter, and Escape only, with focus checked after every change. Lighthouse accessibility: 100 on every page measured |
| Deployed URLs serve the app with real ESPN data on a phone | ✅ (⏳ a real device) | Deployed 2026-09-19. `npm run smoke` against the live API: 15/15 with CORS. Headless Edge against the live site at 390 px (mobile, touch) and 320 px: 48/48. All nine boards filled from ESPN (54 of 54 cards, AP Top 25, 11 live games), team pages with schedule and ESPN's Matchup Predictor, deep links, axe clean, and the admin and non-admin flows with the owner's real accounts. The owner has yet to open it on a physical phone |
| 24 h of normal use stays inside free-tier limits | ⏳ owner | Deployed 2026-09-19 around 19:15 UTC; read the dashboard from 2026-09-20 (docs/ops.md "Watching usage"). First signs: a whole-site load (9 boards, 50 schedules) cost no errors, and the cron ran on schedule. The per-request CPU finding is under "Deploy" |
| Every §50 row confirmed graceful | ✅ | Earlier phases' tests (provider failure, incomplete data, missing prediction and ranking, no upcoming game, postponed, canceled, bye, live, season complete, logo unavailable), plus a live fault drill in workerd with `rankings,team:251,prediction` on a cold cache: board 200, Texas unavailable, every rank "—" with records intact, prediction `unavailable` sent `no-store`, Texas's team route 200. And an unplanned one in production: while ESPN refused the default User-Agent, every board still answered 200 with six labelled "unavailable" cards and a date-derived season |

#### What was built

| Area | Where | Notes |
| --- | --- | --- |
| Admin API | `apps/api/src/routes/admin.ts` | New: `GET /users`, `GET /users/:userId`, `PATCH /users/:userId`, `DELETE /users/:userId`, `POST /users/:userId/selections`, `DELETE /selections/:selectionId`, `PUT /users/:userId/selections/order`. Kept: `GET /session`, `POST /users`, `GET /teams/search`. Every answer is `private, no-store`. Every write goes to PostgREST with the admin's own token (`supabaseAsAdmin`). After each write the board's L1 composite is evicted (`evictL1`) |
| DB layer | `db/queries.ts`, `db/rows.ts`, `db/postgrest.ts` | `renameUser`, `deleteUser`, `findTeamByProviderId`, `insertTeam`, `insertSelection`, `deleteSelection`, `reorderSelections`. `DbError` now carries the SQLSTATE (`code`), Postgres's message (`dbMessage`), and `violates(constraint)`. PostgREST 400 maps to `invalid_request`, 409 to `conflict` |
| Contract | `packages/shared/src/api/requests.ts`, `envelope.ts` | Types: `AdminUsersResponse`, `AdminBoardResponse`, `RenameUserResponse`, `SelectionsResponse`, and `AddSelectionResponse` (which adds `selection`). Constants: `BOARD_TEAM_COUNT` (6), `MAX_SELECTIONS` (24), `DISPLAY_NAME_MAX_LENGTH` (60). `AppErrorKind` gains `conflict` (409) and `rate_limited` (429) |
| Conferences | `providers/espn/provider.ts` `getConferences`, `validate.ts` `readRefPage`/`readGroup`, `services/search.ts` | ESPN's core API: `groups/80/children`, then `groups/{id}` and `groups/{id}/teams` for each FBS conference, three at a time. All or nothing. Cached as its own category (`conferences`: 1 day TTL, 30 days stale, a KV write at most daily). Merged into search results at read time, and stored with a team when it is first added. The mock returns its roster's conferences. New fault token: `conferences` |
| Team identity | `providers/types.ts` `teamNamespace` | Which provider's id space `teams.provider` records. ESPN says `espn`; so does the mock, because its roster borrows ESPN ids. So a team added in mock mode reuses ESPN's row instead of creating a duplicate |
| Logo sizing | `providers/logos.ts`, `providers/espn/logos.ts` | ESPN's image combiner (`/combiner/i?img=…&w=&h=`). Team logos 144 px (drawn at up to 72), opponents 48 px (drawn at 24). Applied in `db/rows.ts` `toTeam`, `services/perspective.ts` (opponents), and search results. Stored URLs stay canonical. On a real board, six logos weighed 28 KB instead of about 180 KB |
| Read budget | `middleware/rate-limit.ts`, mounted in `app.ts` after CORS | A per-isolate token bucket keyed by `CF-Connecting-IP`: burst 120, refill 2/s, `READ_RATE_LIMIT_PER_MINUTE` (`off` disables). GETs and HEADs only, admin routes excluded. 429 with `Retry-After` and the standard error body. It applies under `wrangler dev` too: a 200-request parallel burst got 39 × 200 and 161 × 429 |
| Cron warmers | `cron/warm.ts`, `index.ts` `scheduled`, `wrangler.toml` `[triggers]` | Game days: `*/10 * * 8-12,1 FRI,SAT,SUN`. Otherwise hourly, `0 * * * *`, which skips itself when both fire. Each run refreshes the season calendar, rankings, team list, and conferences through the normal cache, and runs one Postgres `select` (the Supabase keep-alive). Deliberately not schedules or live scores; see the file's header. `services/context.ts` gained `createServices(env, …)` for use outside a request |
| Cache fix | `cache/swr.ts`, `cache/tiers.ts` `freshInL1` | Found in workerd: when a load finished while a sibling read was still waiting on KV, the sibling loaded and wrote KV again (three calendar writes in one cron run). `read()` now re-checks L1 just before loading. The regression test fails without the fix |
| Deploy config | `wrangler.toml` `[env.production]`, `apps/api/package.json` | Top-level config is local development (mock). `[env.production]` is the deployed Worker, named `cfb-api`, with `SPORTS_PROVIDER = "espn"`, both crons, and the KV binding. Two placeholders make an unconfigured `wrangler deploy` fail rather than ship. `npm run deploy` is now `wrangler deploy --env production`; `npm run bundle` is its dry run into `dist`. `APP_VERSION` is 0.5.0 |
| Admin console | `apps/web/src/features/admin/` | `AdminPage.tsx` (people), `BoardEditorPage.tsx`, `TeamSearch.tsx` (250 ms debounce, 2-letter minimum), `ProblemNote.tsx`, `boardEdit.ts` (pure helpers), `useAdminWrite.ts` (`useAfterAdminWrite`, `problemOf`, `useAnnouncer`). Routes: `/admin` and `/admin/u/:userId`, both inside `RequireAdmin` |
| Shared UI | `components/ConfirmDialog.tsx`, `icons.tsx` `ArrowIcon`, `tokens.css` `--color-on-danger` | A native modal `<dialog>`. Focus starts on Cancel, Escape cancels, and `returnFocus` is asked for its target in the effect cleanup, once the page is no longer inert |
| Sign-in fixes (Phase 3 findings) | `auth/useAdminCheck.ts`, `components/AppHeader.tsx`, `auth/signInError.ts` | The header's Admin link waits for `GET /api/admin/session` to return 200, sharing one query with `RequireAdmin`. That check never redirects (`redirectOnUnauthorized: false`). `email_not_confirmed` gets its own message |
| Web data layer | `lib/api.ts`, `lib/apiClient.ts` | `adminApi`, `publicPathsFor`, and admin query keys under `['admin', …]`. `refreshPublic(paths)` re-fetches public reads with `cache: 'reload'`, so the admin's browser cache holds the changed board. `parse` handles 204. `onUnauthorized(redirect?)` |
| Code splitting | `app/pages.ts`, `app/routes.tsx`, `app/RootLayout.tsx` | Every page but home is a `React.lazy` chunk. One `<Suspense>` in `RootLayout` is already on screen, so navigation shows the old page until the new code arrives. The board and team chunks are prefetched when the browser is idle; the admin chunks never are |
| Fonts and headers | `apps/web/public/fonts/` (6 woff2 files and `OFL.txt`), `src/styles/fonts.css`, `index.html`, `public/_headers` | Barlow and Barlow Condensed, self-hosted, Latin subset, `font-display: swap`, two faces preloaded. Google Fonts is gone. `_headers` gives `/assets/*` a year's immutable cache, `/fonts/*` 30 days, and every page four security headers |
| Scripts | `scripts/verify-rls.mjs`, `check-bundle-secrets.mjs`, `smoke.mjs` | `verify-rls` now creates probe rows in all three tables as the admin and attacks each verb on each as `anon` and as the non-admin. It calls `reorder_selections` with real ids and checks `disable_signup` through `/auth/v1/settings`. `check:bundle` fails on `sb_secret_…`, a `service_role` JWT, or the variable name in shipped code. `smoke` is 15 read-only checks against a running Worker |
| CI | `.github/workflows/ci.yml` | The Worker bundle now uses the production environment, and `check:bundle` runs after the web build. A new `deploy` job needs `verify`, and runs only on a push to `main` when the repository variable `DEPLOY_ENABLED` is `true`. It deploys the Worker, builds and scans the site, deploys it to Pages, and runs the smoke test |
| Docs | `docs/ops.md` (new), `README.md`, `apps/api/.dev.vars.example` | ops.md covers: what runs where, free-tier limits checked 2026-09-19, the configuration reference, the first deploy in 10 steps, continuous deployment, the crons, day-to-day tasks, rotating secrets, watching usage, and deployment troubleshooting. README gains "Testing Phase 5" |
| Fixture | `apps/api/test/fixtures/espn/conference-teams.json` | A real capture of `groups/8/teams` (the SEC), added to `_manifest.json` and `capture-espn-fixtures.ts`. `espn-stub.ts` serves the real SEC and ten empty conferences |

**Dependencies added:** `@electric-sql/pglite` ^0.5.8, root devDependency only, for the database tests (§30, §31). Nothing added to either app.

#### Decisions and departures, and why

1. **Two new error kinds, `conflict` (409) and `rate_limited` (429).** Without them a duplicate team or a spent read budget could only be reported as `internal` (500), which blames the server.
2. **Two admin reads beyond §8's table:** `GET /api/admin/users` and `GET /api/admin/users/:userId`. The console must not read through public caches (`max-age` up to 300 s on `/api/users`).
3. **`DELETE /api/admin/users/:userId`** was added: scope 5.1 asks for delete, though §8's table omits it. The board goes with the user (`on delete cascade`); team rows stay, because other boards may hold them.
4. **Every selection write returns the whole board** (`SelectionsResponse`), numbered 1…n, so the editor never has to guess what the server did.
5. **A reorder must list exactly the board's current selections**, or it is a 409 "This board changed since it was loaded". The RPC alone refuses another board's ids, but a subset would have hit the deferred constraint at COMMIT.
6. **Removal renumbers the board** by calling `reorder_selections` with the remaining ids, best effort. Adding renumbers only when the last slot is 24. Gaps would otherwise eventually hit the CHECK (1–24) with fewer than 24 teams.
7. **No new migration.** Every admin write uses the Phase 1 tables and RPC. The owner has nothing to apply in Supabase.
8. **A team row is reused as stored.** It is created from the provider's identity only the first time any board takes it. A seeded row's curated conference is never overwritten by the provider's.
9. **Conferences are FBS only, and all or nothing.** FCS teams show "Conference unknown" in search and are stored with `conference = null`. All or nothing, because a partial map would sit in the cache for a day.
10. **Board propagation.** The writing isolate evicts its L1 board, and the admin's browser primes its HTTP cache (`refreshPublic`). Other isolates' copies expire within 60 s (15 s while live), and viewers' browsers within their `max-age`. A version check on every board read would have cost a Postgres round trip per poll.
11. **Reordering is a save queue, not one mutation per press.** Each press moves the row at once. The newest order is saved, and presses made during a save are sent together once it lands. Found in the browser run: a second Up press during the first save was being dropped. Add and remove wait for the queue (`orderSaved`) instead of refusing.
12. **Confirmation is a native `<dialog>`**, with focus returned from its cleanup. Found in the browser run: focusing the heading while the modal was open failed silently, because the page behind a modal is inert.
13. **Code splitting uses `React.lazy`, not React Router's route `lazy`.** It needs no hydrate fallback and keeps the component tests unchanged.
14. **Fonts are self-hosted.** Lighthouse measured the Google Fonts stylesheet as about 0.9 s of render blocking on a phone.
15. **wrangler environments:** top level for local development, `[env.production]` for deploys. Local development stays in mock mode with no `.dev.vars` changes.
16. **The CI deploy job is off until `DEPLOY_ENABLED` is set.** The owner does the first deploy by hand.
17. **PGlite reports `on delete restrict` as 23001 (restrict_violation), not 23503.** How PostgREST maps 23001 to an HTTP status was not checked, because nothing in the app deletes teams.
18. **The browser scripts are not in the repo**, as in Phases 3 and 4. They need a browser binary that CI lacks. They lived in the session scratchpad (`phase5.mjs`: 116 checks; `espn.mjs`: 26), with `playwright-core`, `axe-core`, and `lighthouse` installed there. README Level B describes the same checks by hand.

#### Verification performed

- **Automated.** 703 tests in 31 files. Phase 5 added 230:
  - `apps/api/test/admin.test.ts` 131. The authorization matrix, which checks itself against `app.routes`, and the console API over an in-memory PostgREST with real constraint errors (`test/helpers/admin-db.ts`).
  - `supabase/test/rls.test.ts` 44 (PGlite).
  - `apps/api/test/ops.test.ts` 20: the read budget, `Cache-Control`, and the crons, including that `wrangler.toml` declares exactly the handler's two schedules.
  - Web 29: `AdminConsole.test.tsx` 13, `boardEdit.test.ts` 8, `signInError.test.ts` 4, `AppHeader.test.tsx` 4.
  - ESPN provider 4, validate 1 (the new readers join the damage property test), cache 1 (the race).
- **Builds.**
  - Worker (production environment): 207.8 KiB, 53.2 KiB gzipped.
  - Web main JS: 376 KB, 119.9 KB gzipped (was 127.5). Main CSS: 2.5 KB gzipped (was 5.0).
  - Page chunks, gzipped: TeamPage 5.6 KB, TeamCard (shared) 3.3, BoardEditorPage 3.3, AdminPage 2.1, BoardPage 1.8.
  - `check:bundle`: no privileged key in 33 files.
- **Live database.** `npm run verify:rls`: 44 passed, 0 failed, 0 skipped. The rows it creates are removed at the end.
- **Browser, mock data.** A production build (`vite preview`) against `wrangler dev` in mock mode and the live Supabase project, in headless Edge. 116/116, repeated to be sure after each fix.
  - Viewers: no Supabase traffic, the auth library and admin chunks never downloaded, the board and team chunks load separately, and no console errors.
  - The admin: signed in with the keyboard, then the full flow described under exit criteria.
  - The non-admin: "Not an administrator", and no Admin link.
- **Browser, real ESPN** (Saturday 2026-09-19, about 18:40 UTC), with `--var ESPN_USER_AGENT:curl/8.4.0` on the command line only. Nothing committed carries a User-Agent. 26/26:
  - six filled cards with AP ranks, and Georgia live at Arkansas (31–3, 4th quarter);
  - the team page with the live block and "Pregame prediction, made before kickoff" from the ESPN Matchup Predictor, and the 2026 schedule with its week-8 bye;
  - only resized logos requested;
  - search: Vanderbilt with SEC, and Montana State with "Conference unknown";
  - axe clean.
  - The cron mapped 138 FBS teams to conferences.
- **Cron in workerd.** The game-day schedule ran all five warmers `ok` in mock and in ESPN mode. The hourly schedule skipped itself on the Saturday.
- **Smoke script** against the ESPN Worker: 15/15, including CORS.
- **Lighthouse, mobile** (Edge, simulated throttling, against the ESPN preview). Before self-hosting the fonts: home 86 and board 88 for performance. After: home 98, board 93, team 89. Accessibility 100 and best practices 100 on all three. What remains is LCP of about 3 s on board and team pages: main bundle, then the page chunk, then the API.
- **Board payload** (real data): about 14 KB, 2.2 KB gzipped.
- **Visual review** of screenshots at 320 and 1440 px in both themes. One fix came out of it: at 320 px each row's buttons wrapped onto a second line. They now share the line (`Admin.module.css`, below 30rem).

#### Deploy (2026-09-19)

Run in a later session, with the owner's go-ahead. The owner approved `wrangler login` in their browser, verified the account's email when Cloudflare asked, and chose the User-Agent policy: "try the default, fall back to curl-style". The steps are docs/ops.md 1–10, which now record what happened at each one.

1. **Login.** A new Cloudflare account, with no Workers, KV, or Pages yet.
2. **KV.** `production-SPORTS_KV` was created, and its id is in `wrangler.toml`.
3. **Worker.** The first deploy failed with error 10034: the account's email was unverified. The owner verified it. That same run registered the account's `workers.dev` subdomain. Run without a terminal prompt, wrangler named it after the Worker, hence `cfb-api.cfb-api.workers.dev`. The Worker deployed with both crons.
4. **Secrets.** `wrangler secret bulk`, from a scratchpad file that was deleted in a `finally`. The values were never printed.
5. **Smoke test with the default User-Agent: 9 passed, 3 failed.** `wrangler tail` showed ESPN answering **403** to every request: calendar, rankings, and all six schedules. The board still answered 200, with six cards labelled unavailable.
6. **`ESPN_USER_AGENT = "curl/8.9.1 college-football-bets/0.5"`** went into `[env.production.vars]`, then a redeploy. Smoke: 13/13, 6 of 6 cards.
7. **Site.**
   - Built with `VITE_API_BASE_URL`. `check:bundle` found no privileged key in 33 files.
   - `pages project create` failed. wrangler 4.134 now hands it to the Workers-based Pages, which refuses to run at a workspace root and deploys nothing. `--force` created a classic Pages project, which is what `_headers` and the single-page-app fallback assume.
   - `cfb-board.pages.dev` was taken, so the origin is `cfb-board-pfc.pages.dev`.
   - 38 files uploaded, including `_headers`.
8. **CORS.** `ALLOWED_ORIGINS` was set to that origin, then a redeploy. Smoke: 15/15.
9. **Browser run against the deployed site: 48/48.** Headless Edge at 390 px (mobile, touch) and 320 px (dark):
   - Viewers: home (9 boards), a board (6 cards, AP Top 25, resized logos only, no mock label), and a team page (previous, next, Matchup prediction, a 13-game schedule).
   - No `undefined`, `NaN`, or `null` on any page. No sideways scroll. axe clean on all six pages.
   - No Supabase traffic for a viewer. `_headers` security headers served.
   - Deep links, a reload, and an unknown path all work.
   - The admin, with the owner's real account: sign in; add a probe person; add Alabama and Georgia; move Georgia up; the public board reads Georgia then Alabama, and again after a reload; Escape cancels a removal; remove Alabama; delete the probe.
   - The non-admin: "Not an administrator", and no Admin link.
   - The script lived in the session scratchpad (`deployed.mjs`), as in earlier phases.
10. **Cron.** The game-day schedule ran at 19:50 UTC, with all five warmers `ok`: season from the provider, rankings, 762 teams, 138 mapped to conferences, database 9 users.

After the deploy, `npm run verify:rls` passed 44/44 against the same Supabase project production uses.

**Measurements** (also in docs/ops.md, "Recorded measurements"):

- **ESPN:** refused the default User-Agent from Cloudflare's network, exactly as from local workerd. With the curl-style value, all nine boards filled: 54 of 54 cards, 11 live games, and 50 schedules read in at most 135 ms each.
- **L2 is live on `workers.dev`: `l2Available: true`.** The plan (§7, risk register) expected it to be inert. The probe writes a value and reads it back, so the Cache API really does store data there, and the tier code uses it.
- **CPU:** `wrangler tail` for 11 minutes during a live slate, 82 invocations.
  - Median 1 ms.
  - A board read cold peaked at **44 ms**: six schedules plus the Saturday scoreboard parsed in one request.
  - Schedules at most 16 ms; the cron 1 ms.
  - Every invocation finished `ok`. 44 ms is above the documented 10 ms free-plan limit, but Cloudflare did not enforce it on these. Not changed; see "Known limitations".
- **The board payload:** about 13.6 KB with real data.

**Found and fixed during the deploy:**

1. **A false "stale" on live cards** (`services/live.ts`).
   - The code never used a slate older than the team's schedule, even one inside its 25-second TTL.
   - On the deployed Worker, six teams load in parallel. One team's read fetches the day's slate; another team's schedule then arrives from ESPN a moment later. That team's live game lost its overlay (`liveUnverified`): no live block, the card marked stale, and the board sent `X-Cache: stale` with `max-age=10`.
   - Four of nine boards did this on their first read. It repeats whenever a playing team's 15-minute schedule refreshes, and clears when the slate next refreshes.
   - **The fix:** only a slate that is itself stale (kept past its TTL after a failed refresh) *and* older than the schedule is refused. The existing test "never lets an older slate move a game backwards" still passes. The new test "uses a current slate read moments before a newer schedule" failed before the fix.
   - **The trade-off, accepted:** a current slate up to 25 s older than a newer schedule can show that game up to 25 s behind, e.g. live for a moment after the schedule says final. The score is dated by its own read (`liveUpdatedAt`), so nothing claims to be newer than it is (§39).
   - Deployed as Worker version `6b0ccb56`. Smoke 15/15 afterwards.
2. **A year in a comment** (`providers/espn/logos.ts`, "Checked 2026-09-19") failed `check:season`, so `npm run verify` was red at pickup, contrary to the handoff. Reworded to "measured in Phase 5".
3. **Not changed, recorded:** deleting a person logs two 404s in the browser console. `refreshPublic` re-reads that person's public pages so the admin's HTTP cache drops the old board: the 404, which carries no `Cache-Control`, replaces the cached 200. That is its job, and the console lines are the browser's generic log for any 4xx.

#### Verification against the spec (§5.5)

**§54, as a user, on the deployed site** (minus "A user authenticates", §11.1). Each step was checked in the browser run:

- the collection of boards;
- a board of six teams, each with name, rank, record, previous result, next date and time, and live information;
- choose a team: identity, rank, record, previous game, next game, the available prediction, and the full schedule;
- automatic updates: polling was proven in Phases 3–4, and the live API served `max-age=15` while games were on;
- the administrator managing boards;
- usable when data is missing: the production 403 episode;
- provider-specific logic isolated, on a free deployment.

**§55, as a reviewer:**

| Principle | Finding |
| --- | --- |
| Accuracy over convenience | No computed ranks or predictions. `odds` and `pickcenter` are never read: a search of the source finds them only in comments saying so. A prediction figure that isn't a percentage is refused. Mock data is labelled mock. The live site names "AP Top 25" and "ESPN Matchup Predictor" |
| Current information over duplicated storage | Postgres holds people, teams, and selections only (§45). Sports data lives in the TTL-governed cache |
| Simplicity | Pages, one Worker, and Supabase. No queue, no extra services, no stored sports data |
| Separation of concerns | Outside `apps/api/src/providers/`, `espn` appears only in the `ProviderName` and `PredictionSource` label types and in comments. The browser never calls ESPN |
| Maintainability | A provider is one directory plus one registry line. The production User-Agent change was one line of config |
| Security | Enforced by RLS: `verify:rls` 44/44 against the production database after the deploy. The live Worker answers 401 to no token and to `alg:none` (smoke) |
| Graceful degradation | Shown in production, unplanned: under ESPN's 403s every board answered 200 with labelled "unavailable" cards |
| Responsive design | 320 and 390 px on the live site: no sideways scroll on any page, including the admin console |
| Free operation | Cloudflare and Supabase free tiers. No card on file, no custom domain |

**§53, not built:** none of it. There is no native app, paid service, custom domain, betting, messaging, social features, comments, analytics or tracking, fantasy scoring, automatic team selection, or generated or custom prediction. Checked by searching the source for the obvious markers (odds, spread, betting, analytics, chat, comment, AI SDKs, tracking) and by the dependency lists. The API depends on `hono`; the site on React, React Router, React Query, and `supabase-js`; the root adds only tooling.

#### Known limitations carried forward

- **A board change reaches other isolates' caches within 60 s**, and viewers' browsers within their `max-age`. docs/ops.md says so.
- **The read budget is per isolate**, and keyed on an address that a shared Wi-Fi shares. 120 a minute was sized for nine people on one network.
- **A usage alert may not exist on the free plan.** docs/ops.md says to look under Notifications and otherwise check the metrics weekly. Not verified in a dashboard.
- **Conferences for FCS and lower divisions are unknown** (decision 9).
- **Logos depend on ESPN's combiner endpoint.** If it stops answering, cards show initials (§36).
- **The console's interactions are tested only in the browser run**, which is outside CI. The component tests render states statically.
- **Nothing deletes a `teams` row.** Removed teams stay, harmlessly, as cached identity.
- **Board and team pages on a cold phone visit** wait on main JS, then the page chunk, then the API (LCP about 3 s in Lighthouse). Prefetching board data in parallel with the chunk would help. It was not done.
- **A screen-reader pass** (NVDA or VoiceOver) of the live region, the schedule table, and the confirm dialog was not done. Only axe and accessible names were checked.
- **Placeholder names.** Eight of the nine people still have seed names (Avery…Jordan). The console can now rename them (a Phase 1 follow-up).
- **CPU on a cold board exceeds the documented free limit.** A board whose six schedules and the Saturday scoreboard are all parsed in one request measured 44 ms, against 10 ms. Cloudflare let every such request through on the first Saturday. If `exceededCpu` (error 1102) ever appears, the options are, in order:
  - warm the scoreboard from the cron on game days (one key, about 7 ms parsed off the request path);
  - stagger a cold board's schedule loads across requests;
  - Workers Paid, which is not free, so the owner's call (§32).
- **ESPN access depends on a curl-style User-Agent.** If ESPN's CDN changes its rule, every card goes "unavailable" at once, labelled. The fix is one line in `[env.production.vars]`, and docs/ops.md step 4 says how to check it.
- **A live game can lag its schedule by up to one slate TTL (25 s)** since the live-overlay fix. It is dated honestly (decision recorded under "Deploy").

#### Housekeeping at close

- **Not committed.** It waits for the owner's approval of the message (standing rule).
- **Test servers.** `wrangler dev` ran on 8795 (faults), 8796 (ESPN), and 8797 (mock), each with its own `--persist-to` folder in the scratchpad. `vite preview` ran on 5182 and 5183. All five were stopped by exact PID with `taskkill /T /F`, after checking each command line. The owner's servers on 8787 and 5173 were not touched.
- **Deploy session.** The two `wrangler tail` captures were stopped after their windows (12 s and 11 min). No local servers were started. The scratchpad holds the browser, load, and CPU scripts and the tail logs; nothing in the repo refers to them.
- **Probe data.** Each browser run created one probe person and deleted it, through the UI or through the API in the script's `finally` block. `verify:rls` removes its probe rows. After the deployed-site runs, the API reported 9 people and no probes.
- `apps/api/dist` and `apps/web/dist` hold the production build (see the handoff).

#### Phase 5 owner follow-ups

- [ ] Approve the Phase 5 commit.
- [x] Decide `ESPN_USER_AGENT` for production. Try the default, fall back: the default was refused, so production sends `curl/8.9.1 college-football-bets/0.5` (2026-09-19).
- [x] Deploy (docs/ops.md steps 1–10), and fill in its "Recorded measurements" table (2026-09-19, except the 24-hour row).
- [ ] After 24 hours, check Workers requests, KV writes, and CPU time against the free tier (docs/ops.md, "Watching usage"), and fill in the last row.
- [ ] Open <https://cfb-board-pfc.pages.dev> on a real phone (README, "Testing Phase 5", Level C).
- [ ] Optionally, repeat README "Testing Phase 5", Levels B, B2, and B3.
- [ ] Create the GitHub remote and push `main`; optionally enable CI deploys.
- [ ] Rename the eight placeholder people in the console (now on the live site).

---

## 10. Risk Register

| Risk | Impact | Mitigation |
|---|---|---|
| ESPN changes response shapes or blocks the Worker | Sports data stops | Isolated provider dir; guards degrade to `unavailable`; stale cache absorbs outages; fixtures make a fix a one-file change. Mock provider keeps the app demoable. **Phase 2:** the block half is real. ESPN's CDN refused the Worker's default User-Agent from local workerd. `ESPN_USER_AGENT` exists, and the deployed Worker must be measured before production uses ESPN. Every other mitigation here was exercised live. **Phase 5:** a local spot check with `ESPN_USER_AGENT=curl/8.4.0` filled every card during a Saturday slate. **Deploy:** the deployed Worker was refused the same way (403 on everything with the default). It passes with `curl/8.9.1 college-football-bets/0.5`, now set in production. The 403 episode showed the degradation working as designed, live. |
| KV free-tier write limit exceeded | Writes fail, cache degrades | L3 refuses short-TTL writes; live data is L1-only; write counter warns; cron kept infrequent. **Phase 2:** added per-key KV write intervals (a schedule at most hourly) and a daily ledger that warns at 700 and refuses at 900 writes per isolate. Two cold boards cost 14–18 writes. **Phase 5:** the cron adds only a handful of daily writes (it never warms schedules), and a cold-read race that duplicated KV writes was fixed in `swr.ts`. |
| Cache API inert on `workers.dev` | Fewer cache hits | Tier probe; L1 + KV + HTTP `Cache-Control` carry the load. Custom domain is an upgrade, never a dependency. **Deploy:** did not happen. The probe round-trips a value on `cfb-api.cfb-api.workers.dev` (`l2Available: true`), so L2 is active. The probe stays in case that changes. |
| Predictor endpoint unavailable or restricted | No win probability | `Prediction unavailable` is a designed state (§12). Never substitute a computed number (§46). |
| Supabase free project pauses after inactivity | Cold-start failures | Cron keep-alive; documented in ops. **Phase 5:** built. The cron runs one `select` every hour (7 days of inactivity pauses a free project, checked 2026-09-19). |
| Live-state edge cases (OT, suspended, weather) | Confusing UI | Unknown statuses normalize to `'unknown'` with a neutral render; `result` only on `final`. |
| Worker 10 ms CPU limit | 5xx on the board path | Keep board work I/O-bound; move heavy schedule processing to the team route; measure in Phase 2. **Phase 2 measurement (Node):** a Saturday scoreboard parses in about 7 ms, the team list about 6.6 ms, a summary about 2 ms, a schedule about 1 ms. Only normalized results are cached, so each payload is parsed once per refresh. The remaining risk is a cold refresh on the request path. Measure in production, and use cron warmers (Phase 5). **Phase 5:** the cron refreshes the team list, conferences, rankings, and calendar off the request path. **Deploy (Saturday, live slate):** median 1 ms, but a cold board peaked at 44 ms (six schedules plus the scoreboard). Every request finished `ok`, so Cloudflare did not enforce 10 ms on these. Watch for `exceededCpu` in the metrics; the next steps, in order, are in Phase 5's "Known limitations". |
| Public read API scraped or crawled | Free-tier request and KV-read budget burned | Cache headers plus three cache tiers mean most repeat traffic never reaches ESPN or KV; best-effort per-IP limit; usage alert. Exposure is a quota concern, not a data one — the content is nine display names and otherwise-public sports data. **Phase 5:** the per-address budget is built (120/min per isolate, 429 with `Retry-After`) and every read route sets `Cache-Control`. A usage alert is an owner step (docs/ops.md). |
| Someone assumes viewer reads are authenticated | A future change re-adds a login gate, or worse, relaxes a write policy to match | §11.1 records the decision and its date; the read policies name `anon` explicitly with a comment. |
| Scope creep from §52 | Delays | §52 is architecture-only. §53 is the do-not-build list. |

---

## 11. Assumptions & Open Questions

Items 1–3 are settled decisions. The rest are working assumptions; each is cheap to revise. Flag now if any is wrong.

1. **CONFIRMED 2026-09-17 — no viewer logins.** Only the administrator has an account; everyone else opens the URL and reads. This **overrides the spec's expectation of authenticated viewer access** (§29's protected pages, §30's "read access to the data they are permitted to view", §54's opening "A user authenticates") *for reads only*. Write authorization remains database-enforced exactly as §30 and §31 require, and the admin retains login, logout, and persistent sessions per §29. Consequences: RLS read policies name `anon`; JWT middleware runs only on `/api/admin/*`; the app must render with no session; §5.3's abuse budget exists because the API is open.
2. **CONFIRMED 2026-09-17 — all writes are admin-only.** §2.2 grants selection management to the administrator. Self-service board editing is a future extension: one RLS policy plus one route.
3. **Anyone who can reach the site can read all nine boards.** Follows directly from 1. There is no per-board visibility model, and adding one later would require viewer identities, i.e. reversing 1.
4. **Ranking poll:** prefer the CFP poll when published, otherwise AP Top 25, and always display the poll name (§7 wants the ranking labeled, not inferred). *Implemented in Phase 2. A poll with any invalid entry, or from another season, is refused whole.*
5. **Prediction source:** ESPN's matchup predictor only. Betting markets are never presented as a prediction (§46). *Implemented in Phase 2. `odds` and `pickcenter` are never read. Mock predictions are labeled `mock_predictor` and "Mock predictor (synthetic data)". Open for Phase 4: ESPN keeps returning the pregame numbers after a game is final.*
6. **Times render in the viewer's local timezone** via `Intl.DateTimeFormat`, with UTC stored throughout (§20).
7. **No custom domain initially** — hence the Cache API tolerance. A domain is a later optimization (§32).
8. **Six teams is a UI convention, not a schema constraint** (§52 headroom, §13 presentation).

---

## 12. Configuration

**Worker** (`wrangler.toml` vars + secrets): `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SPORTS_PROVIDER` (`espn` | `mock`), `ALLOWED_ORIGINS`, `SEASON_OVERRIDE` (optional), `LOG_LEVEL`; KV binding `SPORTS_KV`.

*Added in Phase 2:*
- `SPORTS_PROVIDER` defaults to `mock` in `wrangler.toml`.
- `ESPN_USER_AGENT` (optional) overrides the User-Agent sent to ESPN. Production sends `curl/8.9.1 college-football-bets/0.5` (the owner's decision, Phase 5 deploy).
- `SPORTS_PROVIDER_FAULT` (development and test only) makes chosen provider calls fail: `all`, `team:<id>`, `schedule`, `rankings`, `slate`, `game`, `prediction`, `calendar`, `teams`. Never set it in production.

All three are documented in `wrangler.toml` and `apps/api/.dev.vars.example`.

**Web** (`.env`): `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_API_BASE_URL`.

*As built in Phase 3* (`apps/web/.env.example`):
- `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are used by admin sign-in only. Viewers need no `.env` at all. A pasted `/rest/v1` suffix on the URL is tolerated.
- `VITE_API_BASE_URL` is optional. When it is unset, the app calls `/api` on its own origin, and in development Vite proxies that to the Worker. Set it for a deployed build, and add the site's origin to the Worker's `ALLOWED_ORIGINS`.
- `API_PROXY_TARGET` is for the dev server only: where the `/api` proxy points (default `http://127.0.0.1:8787`).

*Added in Phase 5* (the full reference is in [docs/ops.md](../docs/ops.md), "Configuration reference"):
- `READ_RATE_LIMIT_PER_MINUTE` (Worker, optional): public reads per address per minute, per isolate. Default 120; `off` disables it.
- `wrangler.toml` `[env.production]` is the deployed Worker. It restates every var and binding, because environments inherit neither. Filled in at the deploy (2026-09-19): the KV namespace id, `ALLOWED_ORIGINS = "https://cfb-board-pfc.pages.dev"`, and `ESPN_USER_AGENT = "curl/8.9.1 college-football-bets/0.5"`.
- CI deploy (off until the repository variable `DEPLOY_ENABLED` is `true`): secret `CLOUDFLARE_API_TOKEN`; variables `CLOUDFLARE_ACCOUNT_ID`, `VITE_API_BASE_URL`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `PAGES_PROJECT`, `SITE_ORIGIN`.

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
