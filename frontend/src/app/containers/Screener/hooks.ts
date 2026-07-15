import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
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
  ApiAssetDistribution,
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

function useFetcher<T>(
  fetcher: () => Promise<T>,
  deps: ReadonlyArray<unknown>,
  enabled = true,
): AsyncState<T> & { refetch: () => void } {
  const [state, setState] = useState<AsyncState<T>>({ data: null, loading: enabled, error: null });
  // Bumped when deps change or the hook unmounts, so a response that lands
  // after navigation can neither overwrite the new page's data nor setState
  // on an unmounted component.
  const genRef = useRef(0);
  const lastJsonRef = useRef<string | null>(null);

  const run = useCallback(async () => {
    if (!enabled) return;
    const gen = genRef.current;
    // Only flip `loading` to true when there's no data yet. Refetches keep the
    // last-known data on screen so the UI doesn't flicker between loaded and
    // "Loading…" every poll interval. Identity-preserving: no new state object
    // unless something actually changes.
    setState((s) => {
      if (s.data === null) return { ...s, loading: true, error: null };
      return s.error === null ? s : { ...s, error: null };
    });
    try {
      const data = await fetcher();
      if (genRef.current !== gen) return;
      const raw = JSON.stringify(data);
      const prevRaw = lastJsonRef.current;
      lastJsonRef.current = raw;
      // Unchanged payload → keep the previous state (and data identity), so
      // React bails out instead of re-rendering the subtree on every poll.
      setState((s) =>
        s.data !== null && !s.loading && s.error === null && raw === prevRaw
          ? s
          : { data, loading: false, error: null },
      );
    } catch (err) {
      if (genRef.current !== gen) return;
      const msg = err instanceof Error ? err.message : String(err);
      setState((s) => (!s.loading && s.error === msg ? s : { ...s, loading: false, error: msg }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, enabled]);

  useEffect(() => {
    lastJsonRef.current = null;
    if (!enabled) {
      setState((s) =>
        s.data === null && !s.loading && s.error === null ? s : { data: null, loading: false, error: null },
      );
      return undefined;
    }
    void run();
    return () => {
      genRef.current += 1;
    };
  }, [run, enabled]);

  return { ...state, refetch: run };
}

/** Auto-polls every POLL_INTERVAL_MS unless `interval` is 0. Hidden tabs skip
 *  the tick and refetch once on return to visible; `enabled: false` (e.g. no
 *  id yet) fetches nothing and reports an idle, non-loading state. */
function usePolling<T>(
  fetcher: () => Promise<T>,
  deps: ReadonlyArray<unknown>,
  interval = POLL_INTERVAL_MS,
  enabled = true,
): AsyncState<T> & { refetch: () => void } {
  const state = useFetcher(fetcher, deps, enabled);
  useEffect(() => {
    if (!enabled || interval <= 0) return undefined;
    const t = setInterval(() => {
      if (document.hidden) return;
      state.refetch();
    }, interval);
    const onVisible = (): void => {
      if (!document.hidden) state.refetch();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interval, enabled, ...deps]);
  return state;
}

/** Generic polled fetch for pages outside the pair/asset hook family —
 *  same idle/visibility/staleness semantics as the endpoint hooks above. */
export const usePolled = usePolling;

export const useStats = (): AsyncState<ApiStats> & { refetch: () => void } => usePolling(() => api.stats(), [], 60_000);

export const usePairs = (params: PairsQuery): AsyncState<ApiPairsList> & { refetch: () => void } => {
  const key = JSON.stringify(params);
  return usePolling(() => api.pairs(params), [key]);
};

export const usePair = (id: string | undefined): AsyncState<ApiPair> & { refetch: () => void } =>
  usePolling(() => (id ? api.pair(id) : Promise.reject(new Error('no id'))), [id ?? ''], POLL_INTERVAL_MS, Boolean(id));

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
      return () => {
        cancelled = true;
      };
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
    return () => {
      cancelled = true;
    };
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
          interval: opts.interval,
          denom: opts.denom,
          limit,
          to,
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
          const trimmed = firstHead !== undefined ? older.filter((c) => c.time < firstHead) : older;
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
    candles,
    loading,
    error,
    hasMore,
    loadOlder,
  };
}

export const useTrades = (id: string | undefined, limit = 50): AsyncState<ApiTradesList> & { refetch: () => void } =>
  usePolling(
    () => (id ? api.trades(id, { limit }) : Promise.reject(new Error('no id'))),
    [id ?? '', limit],
    POLL_INTERVAL_MS,
    Boolean(id),
  );

export const useLpEvents = (id: string | undefined, limit = 50): AsyncState<ApiLpList> & { refetch: () => void } =>
  usePolling(
    () => (id ? api.lpEvents(id, { limit }) : Promise.reject(new Error('no id'))),
    [id ?? '', limit],
    POLL_INTERVAL_MS,
    Boolean(id),
  );

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

export const usePagedTrades = (id: string | undefined, page: number, pageSize = 50): PagedState<ApiTrade> => {
  const state = usePolling<ApiTradesList>(
    () =>
      id
        ? api.trades(id, { limit: pageSize, offset: page * pageSize, count: true })
        : Promise.reject(new Error('no id')),
    [id ?? '', page, pageSize],
    POLL_INTERVAL_MS,
    Boolean(id),
  );
  return {
    items: state.data?.trades ?? [],
    total: state.data?.total ?? null,
    loading: state.loading,
    error: state.error,
  };
};

export const usePagedLpEvents = (id: string | undefined, page: number, pageSize = 50): PagedState<ApiLpEvent> => {
  const state = usePolling<ApiLpList>(
    () =>
      id
        ? api.lpEvents(id, { limit: pageSize, offset: page * pageSize, count: true })
        : Promise.reject(new Error('no id')),
    [id ?? '', page, pageSize],
    POLL_INTERVAL_MS,
    Boolean(id),
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
): AsyncState<ApiPoolLiquidity> & { refetch: () => void } =>
  usePolling(
    () => (id ? api.poolLiquidity(id, opts) : Promise.reject(new Error('no id'))),
    [id ?? '', opts.source, opts.interval, opts.from ?? 0, opts.to ?? 0],
    0,
    Boolean(id),
  );

export const useAsset = (aid: number | undefined): AsyncState<ApiAsset> & { refetch: () => void } =>
  usePolling(
    () => (aid !== undefined ? api.asset(aid) : Promise.reject(new Error('no aid'))),
    [aid ?? -1],
    POLL_INTERVAL_MS,
    aid !== undefined,
  );

export const useAssets = (): AsyncState<ApiAssetsList> & { refetch: () => void } =>
  usePolling(() => api.assets(), [], 60_000);

/** aid → catalogue entry, built once per /api/assets payload. Replaces the
 *  per-page pattern of fetching the catalogue and hand-rolling the Map. */
export function useAssetIndex(): Map<number, ApiAssetsList['assets'][number]> {
  const { data } = useAssets();
  return useMemo(() => {
    const m = new Map<number, ApiAssetsList['assets'][number]>();
    for (const a of data?.assets ?? []) m.set(a.aid, a);
    return m;
  }, [data]);
}

export const useAssetHistory = (aid: number | undefined): AsyncState<ApiAssetHistory> & { refetch: () => void } =>
  usePolling(
    () => (aid !== undefined ? api.assetHistory(aid) : Promise.reject(new Error('no aid'))),
    [aid ?? -1],
    5 * 60_000,
    aid !== undefined,
  );

export const useAssetDistribution = (
  aid: number | undefined,
): AsyncState<ApiAssetDistribution> & { refetch: () => void } =>
  usePolling(
    () => (aid !== undefined ? api.assetDistribution(aid) : Promise.reject(new Error('no aid'))),
    [aid ?? -1],
    60_000,
    aid !== undefined,
  );
