import { useEffect, useState } from 'react';

/**
 * `value`, once it has stopped changing for `delayMs`. The admin team search
 * (plan §5.1, "debounced") asks the API when typing pauses, not on every key.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}
