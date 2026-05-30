// Per-pair favorites, persisted in localStorage.
//
// Keyed by the canonical pair key "<aid1>_<aid2>" (see format.pairKey) — the
// API guarantees aid1 < aid2 (the contract pool-key invariant), so a pair has
// one stable key regardless of fee tier. Favoriting works headless (no wallet
// needed), so it lives outside the wallet/shader layer.
//
// React 17 has no useSyncExternalStore, so we keep a module-level Set and a
// tiny pub/sub to keep every mounted component in sync after a toggle.

import { useEffect, useState } from 'react';
import { pairKey } from './components/format';

const STORAGE_KEY = 'dexFavorites';

function load(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr.map(String) : []);
  } catch {
    return new Set();
  }
}

let current: Set<string> = load();
const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((fn) => fn());
}

// Cross-tab sync: when another tab/webview rewrites the key, reload and notify
// so this instance's stars and Favorites filter stay in step.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEY) {
      current = load();
      notify();
    }
  });
}

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...current]));
  } catch {
    /* localStorage unavailable (private mode) — keep the in-memory set only. */
  }
}

export function toggleFavorite(aid1: number, aid2: number): void {
  const key = pairKey(aid1, aid2);
  const next = new Set(current);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  current = next;
  persist();
  notify();
}

/** Subscribe to the favorites set. Re-renders on any toggle, anywhere. */
export function useFavorites(): { favorites: Set<string>; toggle: typeof toggleFavorite } {
  const [favorites, setFavorites] = useState<Set<string>>(current);

  useEffect(() => {
    const onChange = (): void => setFavorites(current);
    listeners.add(onChange);
    // Resync in case current changed between initial render and subscribe.
    onChange();
    return () => {
      listeners.delete(onChange);
    };
  }, []);

  return { favorites, toggle: toggleFavorite };
}
