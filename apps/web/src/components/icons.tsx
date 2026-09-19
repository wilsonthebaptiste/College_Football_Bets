/**
 * The handful of icons the app uses, inline so there is no icon dependency.
 * All are decorative: every one sits next to text that says the same thing.
 */

interface IconProps {
  className?: string | undefined;
  size?: number;
}

export function ChevronLeftIcon({ className, size = 16 }: IconProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M10 3.5 5.5 8l4.5 4.5"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function RefreshIcon({ className, size = 16 }: IconProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M13.25 8a5.25 5.25 0 1 1-1.54-3.71M13.25 2.5v3.25H10"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ClockAlertIcon({ className, size = 16 }: IconProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M8 4.75V8.5l2.25 1.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** The wordmark's ball: a football on its side, laces up. */
export function FootballIcon({ className, size = 22 }: IconProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <ellipse
        cx="12"
        cy="12"
        rx="9.5"
        ry="5.75"
        transform="rotate(-35 12 12)"
        fill="currentColor"
      />
      <path
        d="M8.2 14.9 15.8 9.1M10 11.4l1.3 1.8M11.9 10l1.3 1.8M13.8 8.6l1.3 1.8"
        stroke="var(--color-surface)"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}
