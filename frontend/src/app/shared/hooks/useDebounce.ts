import { useState, useEffect, useRef } from 'react';

/**
 * Leading + trailing debounce: fires immediately when idle, then
 * throttles subsequent changes so at most one update per `delay` ms.
 */
export function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState<T>(value);
  const lastFiredRef = useRef(0);

  useEffect(() => {
    const elapsed = Date.now() - lastFiredRef.current;

    if (elapsed >= delay) {
      setDebounced(value);
      lastFiredRef.current = Date.now();
      return undefined;
    }

    const timer = setTimeout(() => {
      setDebounced(value);
      lastFiredRef.current = Date.now();
    }, delay - elapsed);

    return () => clearTimeout(timer);
  }, [value, delay]);

  return debounced;
}
