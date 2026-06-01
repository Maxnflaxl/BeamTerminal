import { useCallback, useState } from 'react';
import type { DeltaMode } from './types';

export interface UseComparePoints<TKey> {
  keys: TKey[];
  mode: DeltaMode;
  baselineIndex: number;
  /** Add a point. No-op when at cap or the key is already present. */
  add: (key: TKey) => void;
  /** Move the point at display-index `i` to `key`. No-op if the target is occupied. */
  move: (i: number, key: TKey) => void;
  remove: (key: TKey) => void;
  clear: () => void;
  setMode: (m: DeltaMode) => void;
  setBaseline: (i: number) => void;
}

// Generic point-state. TKey is the adapter's point identity (HdrsChart: the
// sample row index). The hook enforces a cap and one-point-per-key; ordering by
// x and resolving values are the adapter's job.
export function useComparePoints<TKey>(opts?: {
  cap?: number;
  sameKey?: (a: TKey, b: TKey) => boolean;
}): UseComparePoints<TKey> {
  const cap = opts?.cap ?? 4;
  const sameKey = opts?.sameKey ?? ((a: TKey, b: TKey): boolean => a === b);

  const [keys, setKeys] = useState<TKey[]>([]);
  const [mode, setMode] = useState<DeltaMode>('consecutive');
  const [baselineIndex, setBaseline] = useState(0);

  const add = useCallback((key: TKey): void => {
    setKeys((cur) => {
      if (cur.length >= cap) return cur;
      if (cur.some((k) => sameKey(k, key))) return cur;
      return [...cur, key];
    });
  }, [cap, sameKey]);

  const move = useCallback((i: number, key: TKey): void => {
    setKeys((cur) => {
      if (i < 0 || i >= cur.length) return cur;
      if (cur.some((k, j) => j !== i && sameKey(k, key))) return cur; // occupied
      const next = cur.slice();
      next[i] = key;
      return next;
    });
  }, [sameKey]);

  const remove = useCallback((key: TKey): void => {
    setKeys((cur) => cur.filter((k) => !sameKey(k, key)));
  }, [sameKey]);

  const clear = useCallback((): void => setKeys([]), []);

  return { keys, mode, baselineIndex, add, move, remove, clear, setMode, setBaseline };
}
