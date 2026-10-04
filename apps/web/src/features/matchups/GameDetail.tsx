import type { Envelope, GameDetail, Matchup, MatchupSide, WinProbability } from '@cfb/shared';
import type { ReactNode } from 'react';
import { FreshnessLabel } from '../../components/FreshnessLabel';
import { LiveBadge } from '../../components/LiveBadge';
import { Skeleton } from '../../components/Skeleton';
import { ErrorState } from '../../components/States';
import { cssVars, cx } from '../../lib/cx';
import {
  leadersTitle,
  liveWinProbability,
  MISSING,
  orderedScoringPlays,
  periodShort,
  periodSpoken,
  pointsText,
  probabilityText,
  scoreAfter,
  sideOfTeam,
  sideShortName,
  statsTitle,
  statText,
  trendPoints,
  trendSummary,
} from '../../lib/detail';
import { formatUpdatedAt } from '../../lib/format';
import { isInProgress } from '../../lib/matchup';
import { Panel } from '../team/Panel';
import styles from './GameDetail.module.css';

/**
 * Inside the game (plan-matchup-board, Phase 3), from one request:
 * `GET /api/games/:gameId/detail`. Every section is its own panel, and the
 * request failing leaves the header and the prediction standing (§42).
 *
 * The page lays the sections out in §51's order — what is happening now
 * first — with the pregame prediction between the live win probability and
 * the stats (`MatchupPage`), so these are exported one by one.
 *
 * Nothing here is a live region: the score and the situation line in the
 * header are, and a stats table that re-announced itself every 15 s would
 * drown them out.
 */

export interface DetailProps {
  row: Matchup;
  detail: GameDetail;
  envelope: Envelope<GameDetail>;
}

/** When this section's numbers were read: their own time, which can differ from the score's. */
function Updated({ envelope }: { envelope: Envelope<GameDetail> }) {
  const { fetchedAt, state } = envelope.freshness;
  if (state === 'stale') return <FreshnessLabel fetchedAt={fetchedAt} stale />;
  const updated = formatUpdatedAt(fetchedAt);
  if (updated === null || fetchedAt === null) return null;
  return (
    <p className={styles.updated}>
      Updated <time dateTime={fetchedAt}>{updated}</time>
    </p>
  );
}

// ─── Line score ──────────────────────────────────────────────────────────────

export function LineScorePanel({ row, detail, envelope }: DetailProps) {
  const line = detail.lineScore;
  if (line === null) return null;
  const sides: ['away' | 'home', MatchupSide][] = [
    ['away', row.away],
    ['home', row.home],
  ];
  return (
    <Panel title="Score by quarter" stale={envelope.freshness.state === 'stale'}>
      <table className={styles.lineScore}>
        <caption className="visually-hidden">Score by quarter, then the total</caption>
        <thead>
          <tr>
            <th scope="col">
              <span className="visually-hidden">Team</span>
            </th>
            {line.periods.map((period) => (
              <th scope="col" key={period.number}>
                <span aria-hidden="true">{period.label}</span>
                <span className="visually-hidden">{periodSpoken(period.number)}</span>
              </th>
            ))}
            <th scope="col" className={styles.total}>
              Total
            </th>
          </tr>
        </thead>
        <tbody>
          {sides.map(([key, side]) => (
            <tr key={key}>
              <th scope="row">{sideShortName(side)}</th>
              {line.periods.map((period) => (
                <td key={period.number}>{pointsText(period[key])}</td>
              ))}
              <td className={styles.total}>
                {pointsText(key === 'home' ? line.homeTotal : line.awayTotal)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Updated envelope={envelope} />
    </Panel>
  );
}

// ─── Win probability (live only) ─────────────────────────────────────────────

/**
 * ESPN's in-game win probability: a different model from the pregame
 * predictor below it, labelled differently (§46). Both percentages are in
 * text; the bar and the trend line only repeat them.
 */
export function LiveWinProbabilityPanel({ row, detail, envelope }: DetailProps) {
  const probability = liveWinProbability(row, detail);
  if (probability === null) return null;
  return (
    <Panel
      title="Win probability"
      aside={<LiveBadge />}
      stale={envelope.freshness.state === 'stale'}
      className={styles.probability}
    >
      <ProbabilitySplit row={row} probability={probability} />
      <Trend row={row} probability={probability} />
      <p className={styles.note}>
        Recalculated after each play, so it can trail the score by a play.
      </p>
      <p className={styles.source}>Source: {probability.sourceLabel} (live)</p>
      <Updated envelope={envelope} />
    </Panel>
  );
}

function ProbabilitySplit({ row, probability }: { row: Matchup; probability: WinProbability }) {
  const sides = [
    { key: 'away', name: sideShortName(row.away), value: probability.awayWinProbability },
    { key: 'home', name: sideShortName(row.home), value: probability.homeWinProbability },
  ];
  const share = Math.round(probability.awayWinProbability * 1000) / 10;
  return (
    <div className={styles.split}>
      <ul className={styles.splitSides} role="list">
        {sides.map((side) => (
          <li key={side.key} className={styles.splitSide}>
            <span className={styles.splitName}>{side.name}</span>{' '}
            <span className={styles.splitPct}>{probabilityText(side.value)}</span>
            <span className="visually-hidden"> chance to win</span>
          </li>
        ))}
      </ul>
      <div
        className={styles.bar}
        aria-hidden="true"
        style={cssVars({ '--first': `${String(share)}%` })}
      >
        <span className={cx(styles.segment, styles.awayFill)} />
        <span className={cx(styles.segment, styles.homeFill)} />
      </div>
      {probability.tieProbability !== null && probability.tieProbability > 0 && (
        <p className={styles.note}>Tie: {probabilityText(probability.tieProbability)}</p>
      )}
    </div>
  );
}

/** The series as a line, decorative, with the numbers it draws in words beside it. */
function Trend({ row, probability }: { row: Matchup; probability: WinProbability }) {
  const summary = trendSummary(row, probability);
  if (summary === null) return null;
  return (
    <div className={styles.trend}>
      <svg
        className={styles.trendLine}
        viewBox="0 0 100 40"
        preserveAspectRatio="none"
        aria-hidden="true"
        focusable="false"
      >
        <line x1="0" y1="20" x2="100" y2="20" className={styles.trendMid} />
        <polyline points={trendPoints(probability.homeSeries)} className={styles.trendPath} />
      </svg>
      <p className={styles.trendText}>{summary}</p>
    </div>
  );
}

// ─── Stats ───────────────────────────────────────────────────────────────────

/**
 * The two-column comparison, the provider's labels and strings verbatim.
 * Before kickoff the same table is "Season averages" and says so twice — in
 * its title and in a sentence — because those are not this game's numbers.
 */
export function StatsPanel({ row, detail, envelope }: DetailProps) {
  const title = statsTitle(detail.statsKind);
  return (
    <Panel title={title} stale={envelope.freshness.state === 'stale'}>
      {detail.statsKind === 'season_average' && (
        <p className={styles.note}>
          Each team’s per-game averages this season, before kickoff. Not this game’s numbers.
        </p>
      )}
      {detail.teamStats.length === 0 ? (
        <p className={styles.empty}>No team stats have been published for this game.</p>
      ) : (
        <table className={styles.stats}>
          <caption className="visually-hidden">{title}</caption>
          <thead>
            <tr>
              <th scope="col">
                <span className="visually-hidden">Stat</span>
              </th>
              <th scope="col">{sideShortName(row.away)}</th>
              <th scope="col">{sideShortName(row.home)}</th>
            </tr>
          </thead>
          <tbody>
            {detail.teamStats.map((stat) => (
              <tr key={stat.key}>
                <th scope="row">{stat.label}</th>
                <td>{statText(stat.away)}</td>
                <td>{statText(stat.home)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Updated envelope={envelope} />
    </Panel>
  );
}

// ─── Leaders ─────────────────────────────────────────────────────────────────

export function LeadersPanel({ row, detail, envelope }: DetailProps) {
  if (detail.leaders.length === 0) return null;
  return (
    <Panel title={leadersTitle(detail.statsKind)} stale={envelope.freshness.state === 'stale'}>
      <div className={styles.leaders}>
        {detail.leaders.map((category) => (
          <section key={category.category} className={styles.leaderGroup}>
            <h3 className={styles.leaderTitle}>{category.label}</h3>
            <ul className={styles.leaderList} role="list">
              {(['away', 'home'] as const).map((key) => {
                const leader = category[key];
                return (
                  <li key={key} className={styles.leader}>
                    <span className={styles.leaderTeam}>{sideShortName(row[key])}</span>{' '}
                    {leader === null ? (
                      <span className={styles.leaderNone}>
                        {MISSING}
                        <span className="visually-hidden"> none listed</span>
                      </span>
                    ) : (
                      <>
                        <span className={styles.leaderName}>{leader.name}</span>
                        {', '}
                        <span className={styles.leaderLine}>{leader.line}</span>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </Panel>
  );
}

// ─── Drive and scoring plays ─────────────────────────────────────────────────

export function DrivePanel({ row, detail, envelope }: DetailProps) {
  const drive = detail.currentDrive;
  if (drive === null || !isInProgress(row)) return null;
  const side = sideOfTeam(row, drive.teamId);
  return (
    <Panel title="Current drive" stale={envelope.freshness.state === 'stale'}>
      <p className={styles.drive}>
        {side !== null && <span className={styles.driveTeam}>{sideShortName(side)} ball: </span>}
        {drive.description}
      </p>
      <Updated envelope={envelope} />
    </Panel>
  );
}

export function ScoringPlaysPanel({ row, detail, envelope }: DetailProps) {
  if (detail.statsKind === 'season_average') return null;
  const live = isInProgress(row);
  const plays = orderedScoringPlays(detail.scoringPlays, row);
  return (
    <Panel
      title="Scoring plays"
      aside={live && plays.length > 1 ? <span className={styles.aside}>Newest first</span> : null}
      stale={envelope.freshness.state === 'stale'}
    >
      {plays.length === 0 ? (
        <p className={styles.empty}>No points scored yet.</p>
      ) : (
        <ol className={styles.plays} role="list">
          {plays.map((play) => {
            const side = sideOfTeam(row, play.teamId);
            const when = [periodShort(play.period), play.clock].filter(Boolean).join(' ');
            const spoken = [periodSpoken(play.period), play.clock].filter(Boolean).join(', ');
            const score = scoreAfter(row, play);
            return (
              <li key={play.id} className={styles.play}>
                <p className={styles.playHead}>
                  {when !== '' && (
                    <>
                      <span className={styles.playWhen}>
                        <span aria-hidden="true">{when}</span>
                        <span className="visually-hidden">{spoken}</span>
                      </span>{' '}
                    </>
                  )}
                  <span className={styles.playTeam}>
                    {[side === null ? null : sideShortName(side), play.kind]
                      .filter(Boolean)
                      .join(' ')}
                  </span>
                  {score !== null && (
                    <>
                      {' '}
                      <span className={styles.playScore}>{score}</span>
                    </>
                  )}
                </p>
                {play.text !== null && <p className={styles.playText}>{play.text}</p>}
              </li>
            );
          })}
        </ol>
      )}
      <Updated envelope={envelope} />
    </Panel>
  );
}

// ─── Loading and failure ─────────────────────────────────────────────────────

export function DetailLoading() {
  return (
    <Panel title="Game details">
      <div role="status" className={styles.loading}>
        <span className="visually-hidden">Loading game details…</span>
        <Skeleton height="1rem" width="60%" />
        <Skeleton height="6rem" />
      </div>
    </Panel>
  );
}

interface DetailFailedProps {
  requestId: string | null;
  onRetry: () => void;
  /** A rate limit asks for patience, not a retry loop. */
  message?: ReactNode;
}

/**
 * The detail request failed, or answered "unavailable". The header and the
 * prediction are separate reads and stay; this one section says so, with
 * the reference, and offers to try again.
 */
export function DetailFailed({ requestId, onRetry, message }: DetailFailedProps) {
  return (
    <Panel title="Game details">
      <ErrorState
        headingLevel={3}
        title="Stats unavailable"
        message={
          message ??
          'The box score, leaders, and scoring plays could not be loaded. The score above is unaffected.'
        }
        requestId={requestId}
        action={
          <button type="button" className="button" onClick={onRetry}>
            Try again
          </button>
        }
      />
    </Panel>
  );
}
