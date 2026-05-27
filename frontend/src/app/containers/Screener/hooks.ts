import {
  useEffect, useState, useCallback, useRef,
} from 'react';
import { api } from './api/client';
import type {
  ApiStats,
  ApiPairsList,
  ApiPair,
  ApiCandle,
  ApiTradesList,
  ApiLpList,
  ApiTrade,
  ApiLpEvent,
  ApiPoolLiquidity,
  ApiAsset,
  ApiAssetsList,
  ApiAssetHistory,
  PairsQuery,
  Interval,
  Denom,
  LiquiditySource,
  LiquidityInterval,
} from './api/types';

// Polling cadence when no wallet is connected.
const POLL_INTERVAL_MS = 30_000;

interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

function useFetcher<T>(fetcher: () => Promise<T>, deps: ReadonlyArray<unknown>): AsyncState<T> & { refetch: () => void } {
  const [state, setState] = useState<AsyncState<T>>({ data: null, loading: true, error: null });

  const run = useCallback(async () => {
    // Only flip `loading` to true when there's no data yet. Refetches keep the
    // last-known data on screen so the UI doesn't flicker between loaded and
    // "Loading…" every poll interval.
    setState((s) => (s.data === null ? { ...s, loading: true, error: null } : { ...s, error: null }));
    try {
      const data = await fetcher();
      setState({ data, loading: false, error: null });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setState((s) => ({ ...s, loading: false, error: msg }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    void run();
  }, [run]);

  return { ...state, refetch: run };
}

/** Auto-polls every POLL_INTERVAL_MS unless `interval` is 0. */
function usePolling<T>(
  fetcher: () => Promise<T>,
  deps: ReadonlyArray<unknown>,
  interval = POLL_INTERVAL_MS,
): AsyncState<T> & { refetch: () => void } {
  const state = useFetcher(fetcher, deps);
  useEffect(() => {
    if (interval <= 0) return undefined;
    const t = setInterval(() => state.refetch(), interval);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interval, ...deps]);
  return state;
}

export const useStats = (): AsyncState<ApiStats> & { refetch: () => void } => usePolling(() => api.stats(), [], 60_000);

export const usePairs = (params: PairsQuery): AsyncState<ApiPairsList> & { refetch: () => void } => {
  const key = JSON.stringify(params);
  return usePolling(() => api.pairs(params), [key]);
};

export const usePair = (id: string | undefined): AsyncState<ApiPair> & { refetch: () => void } => usePolling(() => (id ? api.pair(id) : Promise.reject(new Error('no id'))), [id ?? '']);

/**
 * OHLCV with prepend-pagination. The chart calls `loadOlder` when the user
 * pans/zooms past the left edge; older candles are fetched via the API's
 * `more.to` cursor and merged before the current head. Resets whenever
 * `id`, `interval`, or `denom` change.
 */
export interface OhlcvState {
  candles: ApiCandle[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  loadOlder: () => void;
}

export function useOhlcv(
  id: string | undefined,
  opts: { interval: Interval; denom: Denom; limit?: number },
): OhlcvState {
  const limit = opts.limit ?? 500;
  const [candles, setCandles] = useState<ApiCandle[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  // Mutable refs so loadOlder can read latest cursor without re-creating itself
  // and chart can call it on a tight scroll-event cadence without races.
  const cursorRef = useRef<number | null>(null);
  const inflightRef = useRef(false);
  const hasMoreRef = useRef(false);
  const oldestRef = useRef<number | null>(null);

  // Reset + initial load on key change.
  useEffect(() => {
    let cancelled = false;
    setCandles([]);
    setError(null);
    setHasMore(false);
    cursorRef.current = null;
    oldestRef.current = null;
    hasMoreRef.current = false;
    if (!id) {
      setLoading(false);
      return () => { cancelled = true; };
    }
    setLoading(true);
    inflightRef.current = true;
    (async () => {
      try {
        const res = await api.ohlcv(id, { interval: opts.interval, denom: opts.denom, limit });
        if (cancelled) return;
        setCandles(res.candles);
        const more = res.more?.to ?? null;
        cursorRef.current = more;
        hasMoreRef.current = more !== null;
        setHasMore(more !== null);
        oldestRef.current = res.candles[0]?.time ?? null;
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
        inflightRef.current = false;
      }
    })();
    return () => { cancelled = true; };
  }, [id, opts.interval, opts.denom, limit]);

  const loadOlder = useCallback(() => {
    if (!id) return;
    if (inflightRef.current || !hasMoreRef.current) return;
    const to = cursorRef.current;
    if (to === null) return;
    inflightRef.current = true;
    setLoading(true);
    (async () => {
      try {
        const res = await api.ohlcv(id, {
          interval: opts.interval, denom: opts.denom, limit, to,
        });
        const older = res.candles;
        if (older.length === 0) {
          hasMoreRef.current = false;
          setHasMore(false);
          return;
        }
        // The API returns candles strictly older than `to`. Drop any overlap
        // defensively (shouldn't happen — bucket times are exact) and prepend.
        setCandles((prev) => {
          const firstHead = prev[0]?.time;
          const trimmed = firstHead !== undefined
            ? older.filter((c) => c.time < firstHead)
            : older;
          return [...trimmed, ...prev];
        });
        const nextCursor = res.more?.to ?? null;
        cursorRef.current = nextCursor;
        hasMoreRef.current = nextCursor !== null;
        setHasMore(nextCursor !== null);
        oldestRef.current = older[0]?.time ?? oldestRef.current;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
        inflightRef.current = false;
      }
    })();
  }, [id, opts.interval, opts.denom, limit]);

  return {
    candles, loading, error, hasMore, loadOlder,
  };
}

export const useTrades = (id: string | undefined, limit = 50): AsyncState<ApiTradesList> & { refetch: () => void } => usePolling(() => (id ? api.trades(id, { limit }) : Promise.reject(new Error('no id'))), [id ?? '', limit]);

export const useLpEvents = (id: string | undefined, limit = 50): AsyncState<ApiLpList> & { refetch: () => void } => usePolling(() => (id ? api.lpEvents(id, { limit }) : Promise.reject(new Error('no id'))), [id ?? '', limit]);

/**
 * Append-only paginated trade history. `loadMore` fetches the next page using
 * `before` from the oldest currently-loaded row's timestamp. Newest page also
 * auto-refreshes on a timer so the top of the list stays fresh.
 */
type FeedItem = ApiTradesList['trades'][number] | ApiLpList['trades'][number];

export function useTradeFeed(id: string | undefined, kind: 'Trade' | 'lp', pageSize = 50): {
  items: FeedItem[];
  loading: boolean;
  hasMore: boolean;
  loadMore: () => void;
} {
  type Item = ApiTradesList['trades'][number] | ApiLpList['trades'][number];
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(true);

  // Reset when id or kind changes.
  useEffect(() => {
    setItems([]);
    setHasMore(true);
    setLoading(true);

    let cancelled = false;
    (async () => {
      if (!id) return;
      try {
        const res = kind === 'lp'
          ? await api.lpEvents(id, { limit: pageSize })
          : await api.trades(id, { limit: pageSize });
        if (cancelled) return;
        setItems(res.trades);
        setHasMore(res.trades.length >= pageSize);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [id, kind, pageSize]);

  // Refresh the head every 30s (only if user hasn't paged back significantly).
  useEffect(() => {
    if (!id) return undefined;
    const t = setInterval(async () => {
      try {
        const res = kind === 'lp'
          ? await api.lpEvents(id, { limit: pageSize })
          : await api.trades(id, { limit: pageSize });
        setItems((prev) => {
          if (prev.length === 0) return res.trades;
          // Splice the fresh head in, dedupe by id, keep any pages user has loaded below.
          const existingIds = new Set(prev.map((p) => ('trade_id' in p ? p.trade_id : p.event_id)));
          const fresh = res.trades.filter((t) => !existingIds.has('trade_id' in t ? t.trade_id : t.event_id));
          return [...fresh, ...prev];
        });
      } catch { /* ignore */ }
    }, 30_000);
    return () => clearInterval(t);
  }, [id, kind, pageSize]);

  const loadMore = useCallback(() => {
    if (!id || loading || !hasMore || items.length === 0) return;
    const last = items[items.length - 1]!;
    const before = last.timestamp;
    setLoading(true);
    (async () => {
      try {
        const res = kind === 'lp'
          ? await api.lpEvents(id, { limit: pageSize, before })
          : await api.trades(id, { limit: pageSize, before });
        setItems((prev) => [...prev, ...res.trades]);
        setHasMore(res.trades.length >= pageSize);
      } finally {
        setLoading(false);
      }
    })();
  }, [id, kind, pageSize, items, loading, hasMore]);

  return {
    items, loading, hasMore, loadMore,
  };
}

/**
 * Numbered (offset) pagination for the recent-trades table. `count=true` so the
 * response carries the pool's total row count for "Showing X to Y of N". Polls
 * the current page every 30s so the head stays fresh without losing the page.
 */
export interface PagedState<T> {
  items: T[];
  total: number | null;
  loading: boolean;
  error: string | null;
}

export const usePagedTrades = (
  id: string | undefined,
  page: number,
  pageSize = 50,
): PagedState<ApiTrade> => {
  const state = usePolling<ApiTradesList>(
    () => (id ? api.trades(id, { limit: pageSize, offset: page * pageSize, count: true }) : Promise.reject(new Error('no id'))),
    [id ?? '', page, pageSize],
  );
  return {
    items: state.data?.trades ?? [],
    total: state.data?.total ?? null,
    loading: state.loading,
    error: state.error,
  };
};

export const usePagedLpEvents = (
  id: string | undefined,
  page: number,
  pageSize = 50,
): PagedState<ApiLpEvent> => {
  const state = usePolling<ApiLpList>(
    () => (id ? api.lpEvents(id, { limit: pageSize, offset: page * pageSize, count: true }) : Promise.reject(new Error('no id'))),
    [id ?? '', page, pageSize],
  );
  return {
    items: state.data?.trades ?? [],
    total: state.data?.total ?? null,
    loading: state.loading,
    error: state.error,
  };
};

/** Pool History series. No polling — the series is large and changes slowly;
 *  it reloads when the source/interval/range toggles change. */
export const usePoolLiquidity = (
  id: string | undefined,
  opts: { source: LiquiditySource; interval: LiquidityInterval; from?: number; to?: number },
): AsyncState<ApiPoolLiquidity> & { refetch: () => void } => usePolling(
  () => (id ? api.poolLiquidity(id, opts) : Promise.reject(new Error('no id'))),
  [id ?? '', opts.source, opts.interval, opts.from ?? 0, opts.to ?? 0],
  0,
);

export const useAsset = (aid: number | undefined): AsyncState<ApiAsset> & { refetch: () => void } => usePolling(() => (aid !== undefined ? api.asset(aid) : Promise.reject(new Error('no aid'))), [aid ?? -1]);

export const useAssets = (): AsyncState<ApiAssetsList> & { refetch: () => void } => usePolling(() => api.assets(), [], 60_000);

export const useAssetHistory = (aid: number | undefined): AsyncState<ApiAssetHistory> & { refetch: () => void } => usePolling(() => (aid !== undefined ? api.assetHistory(aid) : Promise.reject(new Error('no aid'))), [aid ?? -1], 5 * 60_000);
