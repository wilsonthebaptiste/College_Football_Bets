# Operations

How to deploy, run, and change the College Football Team Board. Written for
the owner. Everything here is on free tiers; nothing needs a card on file.

- [What runs where](#what-runs-where)
- [Free-tier limits](#free-tier-limits) · [What team search costs](#what-team-search-costs) · [What "who has this team" costs](#what-who-has-this-team-costs)
- [Configuration reference](#configuration-reference)
- [Deploying (the first time)](#deploying-the-first-time)
- [Continuous deployment](#continuous-deployment)
- [Cron warmers](#cron-warmers)
- [Day-to-day tasks](#day-to-day-tasks)
- [Rotating secrets](#rotating-secrets)
- [Watching usage](#watching-usage)
- [Troubleshooting a deployment](#troubleshooting-a-deployment)

---

**Live since 2026-09-19:**

- The site: <https://cfb-board-pfc.pages.dev> (Pages project `cfb-board`).
- The API: <https://cfb-api.cfb-api.workers.dev> (Worker `cfb-api`). Viewers
  never see this URL.
- Cloudflare account `4bb72f432f1b9521a2310ba2bccf01eb`. KV namespace
  `production-SPORTS_KV`, id `5777a3ec40164cc283c45de25f685ed3`.

## What runs where

| Piece    | Service                         | What it holds                                                  |
| -------- | ------------------------------- | -------------------------------------------------------------- |
| Website  | Cloudflare Pages                | The built React app (`apps/web/dist`). Static files only       |
| API      | Cloudflare Workers              | `apps/api`. Public reads, admin writes, the cron warmers       |
| Cache    | Workers KV (`SPORTS_KV`)        | The durable copy of sports data, and the Supabase signing keys |
| Database | Supabase Postgres               | People, teams, and board selections. Nothing from ESPN (§45)   |
| Sign-in  | Supabase Auth                   | The administrator's account, and nobody else's (plan §11.1)    |
| Sports   | ESPN's public JSON, or the mock | Read through the Worker only. The browser never calls ESPN     |

The website calls the Worker directly (`VITE_API_BASE_URL`). The Worker calls
Supabase with the public key: as `anon` for reads, and with the
administrator's own token for writes. **There is no service-role key anywhere**,
by design (`apps/api/src/db/client.ts`). Row Level Security is the security
boundary, and `npm run verify:rls` proves it against the live project.

---

## Free-tier limits

Checked 2026-09-19 against the providers' own documentation. Recheck them if
this page is more than a few months old.

| Service          | Limit that matters here                                        | How this app stays inside it                                                                                                                                                                                                                                                                        |
| ---------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workers          | 100,000 requests a day (resets 00:00 UTC; over it: error 1027) | Browsers cache every read for its `max-age`. Boards poll every 15 s only while a team is live, otherwise every 60 s or 5 min                                                                                                                                                                        |
| Workers          | 10 ms CPU per request                                          | Only normalized data is cached, so ESPN payloads are parsed once per refresh. The cron does the heaviest refreshes. **Measured:** a warm read uses about 1 ms, but a cold board on a Saturday used up to 44 ms, and Cloudflare let it through (see [Recorded measurements](#recorded-measurements)) |
| Workers          | 50 subrequests per request                                     | The largest request is the conference map: 23 ESPN calls, done by the cron                                                                                                                                                                                                                          |
| Workers          | 5 cron triggers per account                                    | This Worker uses 2                                                                                                                                                                                                                                                                                  |
| Workers KV       | 100,000 reads and 1,000 writes a day; 1 GB                     | Short-lived data never reaches KV. Each key is written at most once per interval (`cache/policy.ts`). A ledger stops at 900                                                                                                                                                                         |
| Supabase         | 500 MB database, 5 GB egress, 2 free projects                  | Nine people, about fifty teams                                                                                                                                                                                                                                                                      |
| Supabase         | Paused after 7 days without database activity                  | The cron runs one `select` every hour                                                                                                                                                                                                                                                               |
| Cloudflare Pages | 500 builds a month, 20,000 files, 25 MiB per file              | One build per deploy, about 30 files                                                                                                                                                                                                                                                                |

The measured numbers from Phase 5: a board response is about 14 KB (2.2 KB
gzipped). A cold board with six real teams costs about ten ESPN requests (the
calendar, the poll, six schedules, and the day's scoreboard) and eight KV
writes; a warm one costs none of either.

### What team search costs

Live since 2026-09-24. `GET /api/search/teams?q=` is public, like every other read,
and `/teams/:teamId` now accepts the provider's team id as well as our uuid, so
a visitor can reach **any** of the ~762 teams the provider lists.

|                                        |                                                                                                                                                                         |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A search                               | ~2 ms of CPU (a fold and a sort over ~762 names), and the number of matches does not change it. `public, max-age=300`, so repeat keystrokes are absorbed by the browser |
| KV writes from searching               | Effectively none. Twelve searches wrote three keys once each: `team_list`, `season_calendar`, `conferences` — all of which the cron already warms daily                 |
| KV writes from what searching leads to | One `schedule` write per team page, at most hourly per team. **This is the cost, not the search**                                                                       |
| A provider-id team page                | _Cheaper_ than the uuid page: it skips Postgres entirely                                                                                                                |

**The crawler note.** Before search, a crawler could reach about 65 team pages
— the 54 on boards plus a few stragglers. It can now reach ~762, and each one
is a schedule read that lands in KV, against roughly 1,000 writes a day. Three
things bound it, and none of them is new code: the write ledger (warns at 700,
refuses at 900), the per-key minimum write interval in `cache/policy.ts`
(`schedule` is written at most hourly per team), and the per-address read
budget. Nothing is expected to go wrong; **check the KV write counter the day
after the search is deployed** (below), and watch the `schedule` category
rather than `team_list`. If it does climb, `READ_RATE_LIMIT_PER_MINUTE` is
configuration, not code.

### What "who has this team" costs

`GET /api/selections` returns every board's picks, inverted to provider team id
→ who has that team. It is public like every other read.

|                                   |                                                                                                                                                                                                                                             |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A read                            | One ~54-row Postgres `select`, `public, max-age=300`. No provider call, and **no KV write of any kind** — measured: a dozen searches and a dozen index reads left the ledger unchanged                                                      |
| How often it is asked for         | Once per document, not once per keystroke, and only by the pages that show the names. The home page and a board ask for nothing; a search and a team page in one document share one request                                                 |
| What a deep-linked team page adds | One of these reads where before it made none. Arriving from a search adds nothing, because the answer is already in the browser's query cache                                                                                               |
| Server-side cache                 | **None, deliberately.** App-owned data carries no freshness envelope (§45), and KV is for provider data. If this becomes the constraint, the pattern is an L1 entry plus `evictL1` on the admin write, as the board composite does — not KV |
| Row ceiling                       | No pagination: nine boards of six is 54 rows, and the schema's ceiling is 24 a board. Past roughly 150 boards this route needs a limit                                                                                                      |

**It fails silently, and that is the design.** A broken index renders no names,
which is indistinguishable from "nobody picked this team" — the names are
garnish, so no page waits for them or reports them failing. Nothing on the site
will ever tell you the index is down. The signals are the Worker's logs and
`/api/health`; if somebody reports that the names have vanished, check
`/api/selections` directly before looking anywhere else.

**One thing the freshness envelope does not cover.** On `/teams/<uuid>` the
team's name, logo, and conference come from Postgres; on
`/teams/<providerTeamId>` they come from the provider's team list, which is
cached for a day. The response's `Cache-Control` and its `Freshness` describe
the _sports_ data on the page (a 15-minute schedule), not the name it is shown
under. That is defensible — a team's name is not a fact that changes hourly —
but it is a gap between what §23 promises and what this path delivers, and it
is better written down here than discovered. The same asymmetry means a
conference curated by hand on a stored row does not appear on the provider-id
URL.

---

## Configuration reference

### The Worker (`apps/api/wrangler.toml`, `[env.production]`)

| Name                         | Kind   | Value                                                                                                                |
| ---------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------- |
| `SUPABASE_URL`               | secret | The project URL, `https://<ref>.supabase.co`, with no `/rest/v1`                                                     |
| `SUPABASE_ANON_KEY`          | secret | The anon or publishable key. Public by design, but kept out of git with the URL                                      |
| `SPORTS_PROVIDER`            | var    | `espn` in production, `mock` locally                                                                                 |
| `ESPN_USER_AGENT`            | var    | The User-Agent sent to ESPN: `curl/8.9.1 college-football-bets/0.5`. See [The ESPN User-Agent](#the-espn-user-agent) |
| `ALLOWED_ORIGINS`            | var    | The Pages origin, `https://cfb-board-pfc.pages.dev`. Nothing else                                                    |
| `READ_RATE_LIMIT_PER_MINUTE` | var    | Optional. Public reads per address per minute per isolate. Default 120; `off` disables                               |
| `SEASON_OVERRIDE`            | var    | Optional. Pins the season, e.g. `2026:regular:5`. Leave unset                                                        |
| `LOG_LEVEL`                  | var    | `info`                                                                                                               |
| `SPORTS_PROVIDER_FAULT`      | var    | Development only. **Never set it in production**                                                                     |
| `SPORTS_KV`                  | KV     | The namespace id, from `wrangler kv namespace create`                                                                |

Top-level `[vars]` are **not** inherited by `[env.production]`, which is why
the production block restates each one. Secrets are per environment too.

### The website (build time)

| Name                     | Value                                                            |
| ------------------------ | ---------------------------------------------------------------- |
| `VITE_API_BASE_URL`      | The Worker's URL, e.g. `https://cfb-api.<subdomain>.workers.dev` |
| `VITE_SUPABASE_URL`      | Same as the Worker's `SUPABASE_URL`                              |
| `VITE_SUPABASE_ANON_KEY` | Same as the Worker's `SUPABASE_ANON_KEY`                         |

They are baked into the JavaScript at build time. Changing one means
rebuilding and redeploying the site.

### Scripts (root `.env`)

`SUPABASE_URL`, `SUPABASE_ANON_KEY`, and the two `VERIFY_*` accounts, used by
`npm run verify:rls` only. See `.env.example`.

---

## Deploying (the first time)

About 30 minutes, in PowerShell. Steps 1–4 run in `apps/api`, because
`wrangler` reads `wrangler.toml` from there. From step 5 on, go back to the
repo root (`cd ../..`).

### 1. Sign in to Cloudflare

```powershell
cd apps/api
npx wrangler login
npx wrangler whoami
```

`whoami` shows your account name and id. Note the **account id**.

A new Cloudflare account must have a **verified email address** before it can
deploy a Worker: until then, step 5 fails with error `10034`. Verify it from the
dashboard banner first.

### 2. Create the KV namespace

```powershell
npx wrangler kv namespace create SPORTS_KV --env production
```

Copy the `id` it prints into `apps/api/wrangler.toml`, under
`[[env.production.kv_namespaces]]`, replacing `REPLACE_WITH_KV_NAMESPACE_ID`.

### 3. Set the two secrets

```powershell
npx wrangler secret put SUPABASE_URL --env production
npx wrangler secret put SUPABASE_ANON_KEY --env production
```

Paste the same values as in `apps/api/.dev.vars`. The first `secret put` may
offer to create the Worker; say yes.

### 4. Decide the ESPN User-Agent

<a id="the-espn-user-agent"></a>

ESPN's CDN refuses the Worker's default User-Agent, from local workerd (Phase 2)
**and from the deployed Worker** (measured on the first deploy, 2026-09-19:
403 on every request). A value that starts with a common HTTP-library name gets
through. The owner chose to try the default first and fall back, so production
now sends:

```toml
ESPN_USER_AGENT = "curl/8.9.1 college-football-bets/0.5"
```

in `[env.production.vars]`. The details are in `docs/espn-notes.md` §1.

If ESPN ever refuses that too, step 6 shows it (cards say
`provider_unavailable`). Meanwhile `SPORTS_PROVIDER = "mock"` in the production
block keeps the site working, labelled as mock data.

### 5. Deploy the Worker

```powershell
npm run bundle --workspace @cfb/api                    # a dry run: prints the bindings it will use
node scripts/check-bundle-secrets.mjs apps/api/dist    # no privileged key in what ships
npm run deploy --workspace @cfb/api                    # wrangler deploy --env production
```

The deploy prints the Worker's URL, `https://cfb-api.<subdomain>.workers.dev`.
That is `VITE_API_BASE_URL` from now on.

On an account with no `workers.dev` subdomain yet, the first deploy registers
one. Run without a terminal prompt, wrangler names it after the Worker, which is
why the API is `cfb-api.cfb-api.workers.dev`. It can be renamed in the
dashboard (**Workers & Pages → Settings → Subdomain**), but the site must then
be rebuilt with the new `VITE_API_BASE_URL`.

### 6. Check the Worker

```powershell
npm run smoke -- https://cfb-api.<subdomain>.workers.dev
```

Every line should pass. Look at three things in particular:

- **Every card has sports data.** If cards say `provider_unavailable`, ESPN is
  refusing the Worker: revisit step 4.
- **`L2 inert` or `L2 working`.** The plan expected inert on `workers.dev`, but
  the first deploy measured **working**. Either is fine: the cache tiers carry
  on without it (plan §7). See [Recorded measurements](#recorded-measurements).
- **The board's time.** A cold board takes a second or two; the next read is
  fast.

### 7. Create the Pages project and deploy the site

```powershell
$env:VITE_API_BASE_URL = "https://cfb-api.<subdomain>.workers.dev"
$env:VITE_SUPABASE_URL = "<same as SUPABASE_URL>"
$env:VITE_SUPABASE_ANON_KEY = "<same as SUPABASE_ANON_KEY>"
npm run build:web
npm run check:bundle
npx wrangler pages project create cfb-board --production-branch main --force
npx wrangler pages deploy apps/web/dist --project-name cfb-board --branch main
```

(`apps/web/.env` holds the Supabase pair already; the build reads it too.)

`--force` is needed **once**, on `project create`, with wrangler 4.13x. Without
it, wrangler tries to create the project on the newer Workers-based Pages,
which fails at a workspace root and deploys nothing. `--force` creates a
classic Pages project, which is what `_headers` and the single-page-app
behaviour below are written for. Later commands, including CI's
`pages deploy`, need no flag.

`project create` prints the site's URL. A name that is taken on `pages.dev`
gets a suffix: this project is `https://cfb-board-pfc.pages.dev`. That is the
**site origin**.

### 8. Allow the site's origin, and redeploy the Worker

In `apps/api/wrangler.toml`, set `ALLOWED_ORIGINS` under
`[env.production.vars]` to the site origin exactly (no trailing slash), then:

```powershell
npm run deploy --workspace @cfb/api
npm run smoke -- https://cfb-api.<subdomain>.workers.dev https://cfb-board-pfc.pages.dev
```

The last two smoke lines check CORS.

### 9. Check the site on a phone

Open the site origin on your phone:

1. The home page lists every board. A board shows six cards with real ranks,
   records, and games. A team page shows the schedule and the prediction.
2. **Deep links.** Open a board, copy its URL, and open it in a new tab. Then
   reload a team page. Both load: Pages serves the app for any path when there
   is no `404.html` (it is a single-page app).
3. **Admin.** Open `/login` (it is never linked) and sign in. The header gains
   an **Admin** link. Change something small on a board, open that board, and
   check it.

### 10. Turn on the cron, and the usage alert

The cron triggers deploy with the Worker (step 5). In the dashboard, **Workers
& Pages → cfb-api → Settings → Triggers** lists the two schedules. **Logs**
(Workers observability) shows a `cron_warm` line every run. See
[Watching usage](#watching-usage) for the alert.

### Recorded measurements

Recorded on the first deploy (plan §5.4):

| Question                                  | Answer                                                                                                                                                                                                                                                                                                                                                       | Date       |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| Does the deployed Worker get ESPN data?   | **Yes, with a curl-style User-Agent.** With the default, every ESPN request got 403. With the value below, all nine boards filled (54 of 54 cards), with 11 live games, real schedules, and ESPN's Matchup Predictor                                                                                                                                         | 2026-09-19 |
| Which `ESPN_USER_AGENT` is in production? | `curl/8.9.1 college-football-bets/0.5`                                                                                                                                                                                                                                                                                                                       | 2026-09-19 |
| `/api/health` `cache.l2Available`         | **`true` on `workers.dev`**, which the plan did not expect. The probe writes a value to the Cache API and reads it back, so L2 really stores data here                                                                                                                                                                                                       | 2026-09-19 |
| Worker CPU time on a Saturday             | From `wrangler tail`, 82 requests over 11 minutes during a live slate: median 1 ms, maximum **44 ms** (a board read cold: six schedules and the day's scoreboard parsed). Schedules at most 16 ms. Every request finished `ok`, none `exceededCpu`, although 44 ms is above the documented 10 ms. The dashboard's p99 over a whole Saturday is still to read | 2026-09-19 |
| Requests and KV writes over 24 hours      | _Owner: read after 24 hours ([Watching usage](#watching-usage))_                                                                                                                                                                                                                                                                                             |            |

The first cron runs were `ok` for all five warmers (season from the provider,
rankings, 762 teams, 138 FBS teams mapped to conferences, and the database
keep-alive).

### The team search release (2026-09-24)

The second deploy: Worker version `051f9871-5347-4127-a82b-33647958e06e`, and a
Pages deployment to the same project. Nothing in the configuration changed —
same origin, same KV namespace, same `ESPN_USER_AGENT` — so it was steps 5 and
7 only, with no step 8.

| Question                                      | Answer                                                                                                                                                                                                         |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Did the two new public paths arrive?          | Yes. `/api/search/teams?q=` and `/api/teams/<providerTeamId>` were 404 before the deploy and 200 after                                                                                                         |
| `npm run smoke` against the API and the site  | **20 passed, 0 failed**, including the four search checks and both CORS checks. All 54 of 54 board cards had sports data                                                                                       |
| `npm run verify:rls` after the release        | **44 passed, 0 failed, 0 skipped**, probe rows cleaned up. Worth repeating on any release that adds a public route                                                                                             |
| A warm search, from this side of the Atlantic | **~110–120 ms** end to end for `?q=texas` (12 matches) and `?q=state`, including the network. The match count does not move it                                                                                 |
| KV writes during the whole verification       | **9 in that isolate**: `schedule` 7, `rankings` 1, `prediction` 1. **Zero** from `team_list` or `conferences` — the cron had already warmed them. Searching wrote nothing; the team pages did all of it        |
| Real FCS data                                 | Mercer: `Conference unknown · MER`, **NR**, a real 2-2 record and a full schedule. North Dakota State: **Mountain West**, because ESPN's FBS groups list it there — the provider's own answer, unaltered (§46) |
| The browser, against the deployed site        | 54 of 54 checks in headless Edge, plus 6 axe scans clean in light and dark at 390 px, and no sideways scroll at 320 px                                                                                         |
| Requests and KV writes over 24 hours          | _Owner: read after 24 hours ([Watching usage](#watching-usage)). Watch `schedule`, not `team_list`_                                                                                                            |

### The "who has this team" release (2026-09-25)

The third deploy: Worker version `4365c923-a39f-4405-9c90-5a180e13bf6d`, and a
Pages deployment to the same project. One new public route,
`GET /api/selections`, and the line it feeds on the search results and in the
team page's hero. **Nothing in the configuration changed** — same origin, same
KV namespace, same `ESPN_USER_AGENT`, no new secret and no new binding, which
wrangler's own binding table confirmed at the dry run — so it was steps 5 and 7
only, with no step 8.

It is the first release deployed from a pushed tree. The remote
(<https://github.com/wilsonthebaptiste/College_Football_Bets>) has existed since
2026-09-20, but the whole search feature had been sitting unpushed: `main` was
seven commits ahead, Phases 1–7, and all seven went up together. CI's `verify`
job passed on them. The `deploy` job did **not** run and this deploy was by
hand, because `DEPLOY_ENABLED` is still unset (see
[Continuous deployment](#continuous-deployment)).

Verified before deploying, so that "it works" afterwards cannot be a false
positive:

| Question                                     | Answer                                                                                                                                                                                                   |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run verify`                             | **821 tests in 37 files**, green                                                                                                                                                                         |
| `npm run build:web` + `npm run check:bundle` | Clean; only the publishable key, public by design                                                                                                                                                        |
| The browser, against the production build    | **43 of 43** checks in headless Edge against a local Worker, including 6 axe scans (WCAG 2.0/2.1 A and AA) clean in light and dark at 320, 390 and 1280 px                                               |
| `npm run smoke` against the local Worker     | 21 passed, 1 failed — the recorded local-only mismatch ("every card has sports data — 3 of 6": the repo's mock roster meeting the live database's real boards), present at `HEAD`                        |
| KV writes from this feature                  | **None.** The ledger read `{season_calendar 1, team_list 1, conferences 1, rankings 1, schedule 9, prediction 3}` before and after a dozen searches and a dozen index reads — identical. No new category |
| The index blocked in the browser             | Team page and search results both whole, no owner line, **no alert**, no reference number, no raw value — the designed silence, drilled rather than trusted                                              |
| Postgres blocked                             | `/api/selections` is a clean 500 with a reference number and **no** `Cache-Control`; `/api/search/teams` still answers 200, so typing survives a database outage                                         |

And afterwards, on real ESPN data:

| Question                                     | Answer                                                                                                                                                                                                                                                    |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Did the new public path arrive?              | Yes. `/api/selections` was **404 on the live Worker before** the deploy and **200 after**, returning 54 teams picked by the nine real people, `public, max-age=300`, in ~205 ms                                                                           |
| `npm run smoke` against the API and the site | **24 passed, 0 failed** — every line, including the four the index added and both CORS checks, with 6 of 6 cards on the sampled board carrying sports data                                                                                                |
| `npm run verify:rls` after the release       | **44 passed, 0 failed, 0 skipped**, probe rows cleaned up. Worth repeating on any release that adds a public route, which is exactly what this was                                                                                                        |
| The browser, against the **deployed** site   | **42 of 42** in headless Edge, plus 6 axe scans clean in light and dark at 320, 390 and 1280 px. The 43rd, the live-game ordering check, was skipped and said so: no game was in progress                                                                 |
| Real data, end to end                        | Texas reads **"Picked by Axel"** and the name opens Axel's board; `?q=texas` returns 12 matches against the mock's 3; Mercer — a real FCS team nobody picked — shows **NR**, a 2-2 record, and **no line at all**                                         |
| KV writes from this feature                  | **None, confirmed in production.** That isolate's ledger read `{schedule 11, prediction 5}` and was unchanged by a dozen live searches. Zero from `team_list`, `conferences` or `season_calendar` — the cron had already warmed them. **No new category** |
| Requests and KV writes over 24 hours         | _Owner: read after 24 hours ([Watching usage](#watching-usage)). Watch `schedule`, as with the search release_                                                                                                                                            |

---

## Continuous deployment

`.github/workflows/ci.yml` has a `deploy` job that runs after the checks pass
on every push to `main`. It is **off** until you turn it on, and it needs a
GitHub remote, which does not exist yet.

1. Create the repository on GitHub and push `main`.
2. In Cloudflare, **My Profile → API Tokens → Create Token**, template **Edit
   Cloudflare Workers**, and add **Account → Cloudflare Pages → Edit**. Scope
   it to your account.
3. In GitHub, **Settings → Secrets and variables → Actions**:
   - Secret `CLOUDFLARE_API_TOKEN`: the token.
   - Variables: `CLOUDFLARE_ACCOUNT_ID`, `VITE_API_BASE_URL`,
     `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `PAGES_PROJECT`
     (`cfb-board`), `SITE_ORIGIN` (the Pages origin), and finally
     `DEPLOY_ENABLED` = `true`.

The job deploys the Worker, builds the site, checks it for privileged keys,
deploys it, and runs the smoke test against the live API. The Supabase URL and
publishable key are variables, not secrets: they are public by design.

---

## Cron warmers

Two schedules in `wrangler.toml` (plan §5.4, `src/cron/warm.ts`):

| Schedule                      | When                                                   |
| ----------------------------- | ------------------------------------------------------ |
| `*/10 * * 8-12,1 FRI,SAT,SUN` | Every 10 minutes, Friday to Sunday UTC, August–January |
| `0 * * * *`                   | Hourly; skipped when the first is also firing          |

Each run refreshes, through the normal cache, whatever has expired of: the
season calendar, the rankings, the team list, and the conference map. The fresh
copies land in KV, where every isolate finds them, so a viewer's request rarely
has to fetch and parse ESPN. It also runs one `select` against Supabase, which
is what keeps the free project from pausing.

It deliberately does **not** warm schedules (fifty teams hourly would be about
1,200 KV writes a day, over the limit) or live scores (those live in one
isolate's memory, so a cron run would warm only itself).

To run one by hand locally: `npx wrangler dev --test-scheduled` in `apps/api`,
then open `http://127.0.0.1:8787/__scheduled?cron=0+*+*+*+*`.

---

## Day-to-day tasks

### Add a person, or change a board

Use the admin console: `/login`, then **Admin**.

- **Add a person**: type the name, **Add**. It creates no login; boards need
  no account (plan §11.1).
- **Edit board**: search for a team (two letters or more), **Add**. Reorder
  with **Up** and **Down**. **Remove** asks first. A board is designed for six
  teams; more is allowed, and the editor says so.
- **Rename** and **Delete** are on each person's row. Delete removes the board
  with them and asks first.

A change shows at once in the console and on the admin's own board page.
Other people's open pages catch up within about a minute: the Worker caches a
board for up to 60 seconds per isolate, and a browser may keep a copy for its
`max-age`.

### Add another administrator

Administrators are managed in SQL, not in the app (plan §5.1):

1. In Supabase, **Authentication → Users → Add user**, with **Auto Confirm
   User** ticked.
2. Copy the new user's **UID**, then in the **SQL Editor**:

   ```sql
   insert into public.admins (auth_user_id, label) values ('<uid>', 'who this is');
   ```

To remove one: `delete from public.admins where auth_user_id = '<uid>';`.

**Keep public sign-ups off** (Authentication → Sign In / Providers → "Allow new
users to sign up"). `npm run verify:rls` checks it.

### Change the sports-data provider

Set `SPORTS_PROVIDER` in `[env.production.vars]` to `espn` or `mock`, and
redeploy the Worker. Cache keys include the provider, so neither ever serves
the other's data. A new provider is a sibling of `apps/api/src/providers/espn/`
plus one line in `providers/registry.ts`; nothing in the website changes (§5).

### Pin or bump the season

Normally nothing to do: the season comes from ESPN's calendar, then from the
date (July onwards is the new season). To pin it, set `SEASON_OVERRIDE`, e.g.
`2026:postseason` or `2027:regular:1`, and redeploy. Remove it afterwards.

### When ESPN changes something

A shape change degrades a section to "unavailable" instead of breaking a page,
and stale data is served, labelled, meanwhile. Fixing it is a change in
`apps/api/src/providers/espn/` only. `npm run capture:fixtures` re-downloads
real payloads to test against.

---

## Rotating secrets

| Secret                              | How to rotate                                                                                                                                                                                                                                                              |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The Supabase anon / publishable key | Create a new key in Supabase (API Keys), then `wrangler secret put SUPABASE_ANON_KEY --env production`, update `VITE_SUPABASE_ANON_KEY` (and the GitHub variable), rebuild and redeploy the site. Update `.dev.vars`, `apps/web/.env`, and `.env`. Then revoke the old key |
| Supabase JWT signing keys           | Nothing to do in the app. The Worker reads the project's published keys, and fetches them again once when it sees a key id it doesn't know                                                                                                                                 |
| The administrator's password        | Supabase, Authentication → Users. The admin's other signed-in devices stay signed in until their session ends; sign them out there too if needed                                                                                                                           |
| The Cloudflare API token (CI)       | Create a new token, replace the GitHub secret, delete the old token                                                                                                                                                                                                        |
| The service-role key                | Not used anywhere, on purpose. If it ever leaked, rotate it in Supabase: the app is unaffected                                                                                                                                                                             |

`npm run check:bundle` (also in CI) fails if a service-role or secret key ever
lands in a built bundle.

---

## Watching usage

Plan §5 asks for 24 hours of normal use measured against the free tiers.

- **Workers & Pages → cfb-api → Metrics**: requests per day (limit 100,000),
  errors, and CPU time. Watch the CPU time on a Saturday: a cold board parses
  six schedules and the Saturday scoreboard, measured at up to 44 ms against a
  documented 10 ms. Cloudflare let every such request through on the first
  Saturday. If errors with the `exceededCpu` outcome (error 1102) ever appear,
  that is the path to fix: see the plan's risk register.
- **Storage & Databases → KV → SPORTS_KV → Metrics**: writes per day (limit
  1,000) and reads (limit 100,000). After team search is deployed this is the
  number most worth a look, and the category to watch is `schedule`: see
  [What team search costs](#what-team-search-costs).
- `GET /api/health` shows this isolate's KV writes today, by category. It is a
  floor, not the total: each isolate counts only its own.
- **Usage alert.** In **Notifications → Add**, look for a Workers usage or
  daily-limit notification and point it at your email. If your plan offers
  none, check the metrics above weekly during the season: a crawl shows up as
  a jump in requests with no matching jump in viewers.

The public API has a per-address budget (120 reads a minute per isolate, then
429 with `Retry-After`). It stops one noisy client, not a distributed one. IP
allowlists and a site password were deliberately not built (plan §5.3).

---

## Troubleshooting a deployment

| Symptom                                                    | Cause and fix                                                                                                                                                                                                                  |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The site loads but every board says "Unable to load"       | `VITE_API_BASE_URL` is wrong, or `ALLOWED_ORIGINS` doesn't match the site origin exactly. The browser console shows a CORS error. Fix, redeploy, rerun smoke                                                                   |
| Every card says "Sports data temporarily unavailable"      | ESPN is refusing the Worker. See [The ESPN User-Agent](#the-espn-user-agent). Meanwhile, `SPORTS_PROVIDER = "mock"` keeps the site working                                                                                     |
| `/api/users` is a 500                                      | The secrets are missing: `wrangler secret list --env production`. The Worker's log names the missing one                                                                                                                       |
| Admin sign-in says "isn't set up"                          | The site was built without `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`. Rebuild with them and redeploy                                                                                                                      |
| `wrangler deploy` complains about the KV namespace         | `REPLACE_WITH_KV_NAMESPACE_ID` is still in `wrangler.toml` (step 2)                                                                                                                                                            |
| `wrangler deploy` fails with error 10034                   | The Cloudflare account's email address isn't verified. Verify it from the dashboard banner, then deploy again                                                                                                                  |
| `pages project create` fails at the workspace root         | wrangler tried the newer Workers-based Pages. Add `--force` to `project create`, once (step 7)                                                                                                                                 |
| Worker errors with outcome `exceededCpu` (error 1102)      | A request went over the CPU limit. On a Saturday that is a cold board parsing six schedules and the scoreboard. See the plan's risk register                                                                                   |
| Error 1027 from the Worker                                 | The daily request limit. It resets at 00:00 UTC. Check the metrics for a crawler                                                                                                                                               |
| KV writes climbing after the search deploy                 | Look at the category in `/api/health`. `schedule` means team pages, not searching: see [What team search costs](#what-team-search-costs). Lower `READ_RATE_LIMIT_PER_MINUTE` if it does not settle                             |
| Search says "Team information is temporarily unavailable." | ESPN's team list could not be read. It is the same read the admin console's search and the cron warmer use, so check `/api/health` and the User-Agent. A board team still shows its identity, because that comes from Postgres |
| Everything failed after a quiet week                       | Supabase paused the project. Restore it in the dashboard, then check the cron is running (its hourly `select` should prevent this)                                                                                             |
| A reload of `/u/…` shows a Pages 404                       | A `404.html` has appeared in `apps/web/dist`, which turns off Pages' single-page-app behaviour. Remove it                                                                                                                      |
