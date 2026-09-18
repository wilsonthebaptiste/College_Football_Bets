import type { Game, NextGameSlot } from './game';
import type { RankingState } from './ranking';
import type { TeamRecord } from './record';
import type { TeamIdentity } from './team';

/**
 * Everything a team card needs (§6, §13), fetched as one unit.
 *
 * Note that `record` is `TeamRecord | null` while `ranking` is a `RankingState`:
 * a missing record has only one meaning, whereas a missing ranking has two
 * (§7). The asymmetry is intentional.
 */
export interface TeamSnapshot {
  identity: TeamIdentity;
  record: TeamRecord | null;
  ranking: RankingState;
  /** §9 — the latest *final* game. A live game is never the previous game. */
  previousGame: Game | null;
  nextGame: NextGameSlot;
  /** §11 — set only while a game is actually in progress; drives the LIVE block. */
  liveGame: Game | null;
}
