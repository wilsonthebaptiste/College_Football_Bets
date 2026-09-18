# @cfb/shared

The wire contract. Everything in here is imported by **both** the Cloudflare
Worker and the browser, so the two sides of the wire cannot drift.

## Rules

1. **Zero runtime dependencies.** `dependencies` is `{}` and stays `{}`.
2. **No environment assumptions.** No `fetch`, no `process`, no `caches`, no
   DOM. Pure types plus a handful of pure functions.
3. **No provider knowledge.** Nothing in here has heard of ESPN. Provider
   response shapes live in `apps/api/src/providers/espn/raw.ts` (§26, §41).
4. **One place for the season.** Every year-dependent decision goes through
   `season.ts` (§21). `npm run check:season` fails the build if a four-digit
   year literal appears anywhere else in application source.

## Layout

| Path              | Holds                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------- |
| `src/envelope.ts` | `Envelope<T>`, `Freshness`, `AppError`, and the constructors for each                                   |
| `src/season.ts`   | `Season`, the resolution precedence chain, the date heuristic                                           |
| `src/domain/`     | The normalized sports model: `Team`, `Game`, `RankingState`, `TeamRecord`, `Prediction`, `TeamSnapshot` |
| `src/api/`        | Request/response types for every route in the §8 contract                                               |
