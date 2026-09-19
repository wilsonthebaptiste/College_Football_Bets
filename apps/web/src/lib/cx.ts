import type { CSSProperties } from 'react';

/** Joins class names, skipping the falsy ones. CSS-module lookups may be undefined. */
export function cx(...parts: Array<string | false | null | undefined>): string | undefined {
  const joined = parts.filter((part): part is string => typeof part === 'string' && part !== '');
  return joined.length === 0 ? undefined : joined.join(' ');
}

/** Inline custom properties, which React's `CSSProperties` does not type. */
export function cssVars(vars: Record<`--${string}`, string | null>): CSSProperties {
  const style: Record<string, string> = {};
  for (const [name, value] of Object.entries(vars)) {
    if (value !== null) style[name] = value;
  }
  return style;
}
