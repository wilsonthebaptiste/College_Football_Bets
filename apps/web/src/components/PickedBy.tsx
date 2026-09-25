import type { TeamOwner } from '@cfb/shared';
import { Fragment } from 'react';
import { Link } from 'react-router';
import styles from './PickedBy.module.css';

/**
 * "Picked by Wilson Jordan" — the boards that hold a team, each name a link to
 * that board (plan-search-engine, Part Two).
 *
 * An empty list renders nothing: no label, no empty element, no "nobody has
 * this team". Most of the ~762 teams are on nobody's board, so a line saying so
 * on every result would be noise — and the same emptiness is what a slow or
 * failed index looks like, by design.
 *
 * No punctuation between the names: a comma or a bullet between two links is
 * read out and copied with them, and a wrapped list at 320 px leaves it
 * stranded at the end of a line. The visible gap is CSS — but the space
 * between them is a real character all the same, because CSS `gap` puts no
 * space in the text: without it the paragraph copies, and reads, as
 * "Picked byWilson". A whitespace-only text node is not rendered as a flex
 * item, so it costs the layout nothing.
 */
export function PickedBy({ owners }: { owners: readonly TeamOwner[] }) {
  if (owners.length === 0) return null;

  return (
    <p className={styles.pickedBy}>
      <span className={styles.label}>Picked by</span>
      {owners.map((owner) => (
        <Fragment key={owner.userId}>
          {' '}
          <Link
            to={`/u/${owner.userId}`}
            className={styles.chip}
            // 2.5.3 label in name: the accessible name must CONTAIN the visible
            // text, so a voice user can say what they see. "Wilson's board"
            // does; "Open board" would not.
            aria-label={`${owner.displayName}'s board`}
          >
            {owner.displayName}
          </Link>
        </Fragment>
      ))}
    </p>
  );
}
