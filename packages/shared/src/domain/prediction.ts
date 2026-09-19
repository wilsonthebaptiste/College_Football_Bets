/**
 * §12 and §46 — a prediction is a quotation, not a calculation.
 *
 * `source` is a closed union rather than a free string so that nothing can ever
 * ship a computed number wearing a provider's name. There is no code path in
 * this application that produces a `Prediction` from anything but a provider
 * payload; "unavailable" is a designed state, and the correct one.
 *
 * `mock_predictor` exists so the offline mock provider can label its synthetic
 * numbers as exactly that. Mock output must never wear ESPN's name either (§46).
 */
export type PredictionSource = 'espn_matchup_predictor' | 'mock_predictor';

export interface Prediction {
  source: PredictionSource;
  /** Shown verbatim in the UI so the source is identifiable (§12, §46). */
  sourceLabel: string;
  providerGameId: string;
  /** 0–100. Home and away are the provider's own designations (§19). */
  homeWinPct: number;
  awayWinPct: number;
  home: PredictionSide;
  away: PredictionSide;
  retrievedAt: string;
}

export interface PredictionSide {
  providerTeamId: string;
  name: string;
  abbreviation: string | null;
}
