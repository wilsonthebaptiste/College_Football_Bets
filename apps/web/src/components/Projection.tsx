import type { ProjectedTerm, ProjectionInputStatus } from '@cfb/shared';
import { cx } from '../lib/cx';
import { ESTIMATE_NOTE, lineView, PROJECTION_MEANING, provenance } from '../lib/projection';
import styles from './Projection.module.css';

/**
 * The pieces of projected points that the board and the team page share
 * (predicting_score.md, Phase 4). The home page uses only the note.
 */

/** A value that may be a dash, with words for a screen reader in the dash's place. */
function LineValue({ value, spoken }: { value: string; spoken: string }) {
  if (value === spoken) return <>{value}</>;
  return (
    <>
      <span aria-hidden="true">{value}</span>
      <span className="visually-hidden">{spoken}</span>
    </>
  );
}

/**
 * A team's six rubric lines, in rubric order.
 *
 * Each line reads in the order the plan asks for: the number, then what it
 * means, then who said so — never a bare table of decimals. The contribution
 * printed is the server's, as given: the finish line's is `2p − 1`, not
 * `points × probability`, and recomputing it here would drop the rubric's −1.
 */
export function ProjectionLines({ terms }: { terms: readonly ProjectedTerm[] }) {
  return (
    <ul role="list" className={styles.lines}>
      {terms.map((term) => {
        const line = lineView(term);
        return (
          <li key={term.kind} className={styles.line}>
            <span className={cx(styles.value, styles[line.tone])}>
              <LineValue value={line.value} spoken={line.spokenValue} />
            </span>{' '}
            <span className={styles.what}>
              <span className={styles.label}>{line.label}</span>{' '}
              <span className={styles.detail}>{line.detail}</span>
              {line.source !== null && (
                <>
                  {' '}
                  <span className={styles.source}>{line.source}</span>
                </>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

interface ProjectionNoteProps {
  sources: readonly ProjectionInputStatus[];
  /** A team page passes its team's conference (or `null`); a board leaves it out. */
  conference?: string | null;
  /** The finish-line note, where finish lines are on screen. */
  withEstimateNote?: boolean;
  className?: string | undefined;
}

/**
 * What a projection is, and where and when its numbers came from — once per
 * screen. The vocabulary is fixed in `lib/projection.ts` so all three screens
 * say the same thing: "Projected points", "Not a result", and each publisher
 * named with its own stamp, never "live" and never our read time (§23, §39).
 */
export function ProjectionNote({
  sources,
  conference,
  withEstimateNote = false,
  className,
}: ProjectionNoteProps) {
  const { asOf, problems, reference } = provenance(sources, conference);
  return (
    <div className={cx(styles.note, className)}>
      <p>{PROJECTION_MEANING}</p>
      {withEstimateNote && <p>{ESTIMATE_NOTE}</p>}
      <p className={styles.asOf}>{asOf}</p>
      {problems.map((problem) => (
        <p key={problem} className={styles.problem}>
          {problem}
        </p>
      ))}
      {reference !== null && <p className={styles.reference}>Reference: {reference}</p>}
    </div>
  );
}
