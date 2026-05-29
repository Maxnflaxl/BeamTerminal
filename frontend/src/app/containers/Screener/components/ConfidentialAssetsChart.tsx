import React, {
  useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { styled } from '@linaria/react';
import type { IChartApi, UTCTimestamp } from 'lightweight-charts';

import AssetIcon from '@app/shared/components/AssetsIcon';
import { SimpleChart } from './SimpleChart';
import { useAssets } from '../hooks';
import type { ApiChartPoint } from '../api/client';
import type { ApiAssetListEntry } from '../api/types';

interface Props {
  series: ReadonlyArray<ApiChartPoint>;
  title?: string;
  scale?: number;
  formatter?: (v: number) => string;
  logScale?: boolean;
  /** When false, render a plain SimpleChart with no icon overlay (used for
   *  the cramped grid cell — the icons only earn their keep at modal size). */
  showMarkers?: boolean;
}

// Icon size + per-lane vertical spacing. Lanes stack upward so the bottom-most
// lane (lane 0) sits just above the time axis.
const ICON_PX = 18;
const LANE_PX = ICON_PX + 4;
const MAX_LANES = 4;
// Distance from the bottom of the chart container to lane 0's centre. The
// lightweight-charts time axis (date labels) is ~28 px tall at the bottom of
// the canvas; this offset clears the date row with a comfortable margin so
// the lowest lane sits inside the plot area, not on top of the labels.
const BOTTOM_OFFSET_PX = 58;

const Outer = styled.div`
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
`;

// `inset: 0` shorthand isn't available in Chromium < 87 (the wallet host runs
// QtWebEngine 5.15.2 = Chrome 83), so spell the four edges out explicitly.
// Explicit z-index keeps the icons above the chart's canvas-rendered date
// axis instead of being painted under it.
const Strip = styled.div`
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  pointer-events: none;
  z-index: 2;
`;

// A zero-size positioning anchor. Its x lives entirely in `transform`
// (translate3d, set imperatively each frame) so panning stays on the
// compositor — never `left`, which would force a strip-wide reflow per frame —
// and carries no transition so the icon doesn't smear while the chart is
// dragged. `bottom` (the lane offset) is set inline per marker.
const MarkerAnchor = styled.div`
  position: absolute;
  left: 0;
  width: 0;
  height: 0;
`;

// The visible chip. Its transform centres it horizontally on the anchor and
// drops it half a height so the icon centre sits at the configured bottom
// offset; the :hover scale composes via a CSS custom property so the centring
// transform never needs to be re-stated. The 120ms transition lives here (on
// the scale), kept off the anchor so pan movement is instant, not animated.
const MarkerChip = styled.div`
  --marker-scale: 1;
  position: absolute;
  left: 0;
  bottom: 0;
  width: ${ICON_PX}px;
  height: ${ICON_PX}px;
  transform: translate(-50%, 50%) scale(var(--marker-scale));
  pointer-events: auto;
  cursor: pointer;
  border-radius: 50%;
  background: #042548;
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.18), 0 1px 2px rgba(0, 0, 0, 0.6);
  transition: transform 120ms, box-shadow 120ms;

  & > * {
    margin: 0 !important;
    width: 100% !important;
    height: 100% !important;
  }

  &:hover,
  &:focus-visible {
    --marker-scale: 1.18;
    box-shadow: 0 0 0 1px rgba(0, 246, 210, 0.65), 0 2px 6px rgba(0, 0, 0, 0.7);
    z-index: 5;
    outline: none;
  }
`;

const Popover = styled.div`
  position: absolute;
  z-index: 20;
  width: 240px;
  background: #0a3163;
  border: 1px solid rgba(0, 246, 210, 0.35);
  border-radius: 8px;
  padding: 10px 12px;
  color: rgba(255, 255, 255, 0.92);
  font-family: 'SFProDisplay', monospace;
  font-size: 12px;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.55);
  pointer-events: auto;
`;

const PopHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;

  & > * + * { margin-left: 8px; }
`;

const PopTitle = styled.div`
  display: flex;
  align-items: center;
  min-width: 0;

  & > .icon {
    flex-shrink: 0;
    width: 20px;
    height: 20px;
    margin-right: 8px;
  }
  & > .icon > * { margin: 0 !important; }
`;

const PopName = styled.div`
  display: flex;
  flex-direction: column;
  min-width: 0;
`;

const PopNameMain = styled.div`
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`;

const PopNameSub = styled.div`
  font-size: 10px;
  color: rgba(255, 255, 255, 0.55);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`;

const ArrowButton = styled.button`
  width: 24px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 246, 210, 0.12);
  color: #00f6d2;
  border: 1px solid rgba(0, 246, 210, 0.45);
  border-radius: 4px;
  cursor: pointer;
  padding: 0;
  flex-shrink: 0;

  &:hover {
    background: rgba(0, 246, 210, 0.22);
    border-color: rgba(0, 246, 210, 0.75);
  }
`;

const PopRow = styled.div`
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.65);
  & + & { margin-top: 2px; }
`;

const PopDesc = styled.div`
  margin-top: 6px;
  font-size: 11px;
  line-height: 1.35;
  color: rgba(255, 255, 255, 0.7);
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
`;

const ArrowIcon: React.FC = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <line x1="2" y1="6" x2="10" y2="6" />
    <polyline points="6 2 10 6 6 10" />
  </svg>
);

// Local-time YYYY-MM-DD — toISOString() would drift by a day for users far
// from UTC and disagree with every other date the wallet UI shows.
function formatDate(ts: number): string {
  const d = new Date(ts * 1000);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

interface PlacedMarker {
  asset: ApiAssetListEntry;
  x: number;
  lane: number;
}

export const ConfidentialAssetsChart: React.FC<Props> = ({
  series, title, scale, formatter, logScale, showMarkers = false,
}) => {
  // Bypass the entire overlay machinery when markers aren't wanted (grid cell)
  // — keeps that path a plain SimpleChart with no extra renders, no polling
  // of /api/assets, no event subscriptions.
  if (!showMarkers) {
    return (
      <SimpleChart
        series={series}
        title={title ?? ''}
        scale={scale}
        formatter={formatter}
        logScale={logScale}
      />
    );
  }
  return (
    <ConfidentialAssetsChartWithMarkers
      series={series}
      title={title}
      scale={scale}
      formatter={formatter}
      logScale={logScale}
    />
  );
};

// Pre-compute lane assignment from chronological mint order. Lanes are
// allocated purely from the timestamp sequence (rather than from current
// pixel positions), so they stay stable across pan/zoom — a marker doesn't
// hop between lanes when the user moves the time scale.
function assignLanesByTs(
  assets: ReadonlyArray<ApiAssetListEntry>,
): Array<{ asset: ApiAssetListEntry; lane: number }> {
  const sorted = assets.slice().sort((a, b) => (a.minted_at_ts ?? 0) - (b.minted_at_ts ?? 0));
  const laneLastTs: number[] = [];
  const out: Array<{ asset: ApiAssetListEntry; lane: number }> = [];
  // Minimum gap (in seconds) between two markers sharing a lane. One day is
  // the natural granularity of the chart's day-bucket series.
  const MIN_GAP_S = 86400;
  for (const a of sorted) {
    if (a.minted_at_ts == null) continue;
    let lane = -1;
    for (let i = 0; i < laneLastTs.length; i += 1) {
      if (a.minted_at_ts - laneLastTs[i]! >= MIN_GAP_S) { lane = i; break; }
    }
    if (lane === -1 && laneLastTs.length < MAX_LANES) {
      lane = laneLastTs.length;
      laneLastTs.push(0);
    }
    if (lane === -1) {
      // All lanes full: overflow into the one with the oldest last-ts.
      lane = 0;
      for (let i = 1; i < laneLastTs.length; i += 1) {
        if (laneLastTs[i]! < laneLastTs[lane]!) lane = i;
      }
    }
    laneLastTs[lane] = a.minted_at_ts;
    out.push({ asset: a, lane });
  }
  return out;
}

const ConfidentialAssetsChartWithMarkers: React.FC<Omit<Props, 'showMarkers'>> = ({
  series, title, scale, formatter, logScale,
}) => {
  const { data: assetsData } = useAssets();
  const navigate = useNavigate();

  // Hot-path refs: chart instance and per-marker anchor DOM nodes. We
  // deliberately keep these out of React state so panning the chart never
  // schedules a re-render of every marker — instead a rAF-batched pass mutates
  // each anchor's `transform` directly when the chart's projection changes.
  const chartRef = useRef<IChartApi | null>(null);
  const markerNodes = useRef<Map<number, HTMLDivElement>>(new Map());
  // Bumped only when chart instance arrives / disappears, so the popover
  // / fallback paths can react. The hot path doesn't touch this.
  const [, forceRender] = useReducer((n: number) => n + 1, 0);

  // Snap to UTC day-start so timeToCoordinate hits the chart's plotted
  // bucket (the backend uses `time_bucket(INTERVAL '1 day', …)`).
  const dayBucket = useCallback((ts: number): number => Math.floor(ts / 86400) * 86400, []);

  // Eligible assets + their static lane assignment. Recomputed only when the
  // asset list changes — not on pan/zoom. Filters BEAM, imposters, and any
  // asset whose mint timestamp we couldn't resolve server-side.
  const placed = useMemo(() => {
    if (!assetsData) return [];
    const eligible = assetsData.assets.filter(
      (a) => a.aid !== 0 && !a.is_imposter && a.minted_at_ts != null,
    );
    return assignLanesByTs(eligible);
  }, [assetsData]);

  // Imperative position update — called on every visible-range / logical-range
  // / resize event under a single rAF, so multiple events per frame collapse
  // into one DOM write pass. Only `transform` is touched (compositor-only, no
  // reflow); off-window markers (timeToCoordinate → null) are hidden.
  const updatePositions = useCallback((): void => {
    const chart = chartRef.current;
    if (!chart) return;
    const ts = chart.timeScale();
    for (const { asset } of placed) {
      const el = markerNodes.current.get(asset.aid);
      if (!el || asset.minted_at_ts == null) continue;
      const x = ts.timeToCoordinate(dayBucket(asset.minted_at_ts) as UTCTimestamp);
      if (x == null) {
        el.style.display = 'none';
      } else {
        el.style.display = '';
        el.style.transform = `translate3d(${x}px, 0, 0)`;
      }
    }
  }, [placed, dayBucket]);

  // Route the position-update callback through a ref so the subscription
  // registered in onChartReady (once per chart instance) always invokes the
  // latest closure — otherwise the schedule would keep calling a stale
  // updatePositions that captured assetsData=null from the first render.
  const updatePositionsRef = useRef(updatePositions);
  useEffect(() => { updatePositionsRef.current = updatePositions; }, [updatePositions]);

  const onChartReady = useCallback((c: IChartApi, el: HTMLDivElement): (() => void) => {
    chartRef.current = c;
    forceRender();
    let rafId: number | null = null;
    const schedule = (): void => {
      if (rafId != null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        updatePositionsRef.current();
      });
    };
    // Both range signals feed the same coalesced pass. The logical-range event
    // is the load-bearing one: it fires on every projection change — including
    // the price-axis-width reflow that silently shifts every bar's x without
    // changing the visible *time* range or the container size — so markers
    // never keep a coordinate from a stale layout.
    c.timeScale().subscribeVisibleTimeRangeChange(schedule);
    c.timeScale().subscribeVisibleLogicalRangeChange(schedule);
    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    // Run once so markers land in the right spot before the first paint.
    updatePositionsRef.current();
    return () => {
      if (rafId != null) cancelAnimationFrame(rafId);
      ro.disconnect();
      c.timeScale().unsubscribeVisibleTimeRangeChange(schedule);
      c.timeScale().unsubscribeVisibleLogicalRangeChange(schedule);
      chartRef.current = null;
      forceRender();
    };
  }, []);

  // Re-run the position pass whenever the eligible set changes (so newly
  // mounted markers land at the right x without waiting for a chart event).
  useLayoutEffect(() => {
    updatePositions();
  }, [placed, updatePositions]);

  // Hover state — touches React but only at hover frequency, not pan frequency.
  const [hoverAid, setHoverAid] = useState<number | null>(null);
  const hoverTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (hoverTimerRef.current != null) window.clearTimeout(hoverTimerRef.current);
  }, []);

  const openHover = useCallback((aid: number): void => {
    if (hoverTimerRef.current != null) window.clearTimeout(hoverTimerRef.current);
    setHoverAid(aid);
  }, []);
  const scheduleCloseHover = useCallback((): void => {
    if (hoverTimerRef.current != null) window.clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = window.setTimeout(() => setHoverAid(null), 120);
  }, []);

  const handleMarkerKey = useCallback((aid: number, e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      navigate(`/asset/${aid}`);
    }
  }, [navigate]);

  const handleMarkerClick = useCallback((aid: number): void => {
    navigate(`/asset/${aid}`);
  }, [navigate]);

  const setMarkerRef = useCallback((aid: number, el: HTMLDivElement | null): void => {
    if (el) markerNodes.current.set(aid, el);
    else markerNodes.current.delete(aid);
  }, []);

  // Hovered marker info — looked up from `placed` (the React-rendered list),
  // so popover positioning uses the latest pan-aware x via timeToCoordinate.
  const hovered = useMemo(() => {
    if (hoverAid == null) return null;
    const p = placed.find((m) => m.asset.aid === hoverAid);
    if (!p) return null;
    const chart = chartRef.current;
    if (!chart || p.asset.minted_at_ts == null) return null;
    const x = chart.timeScale().timeToCoordinate(dayBucket(p.asset.minted_at_ts) as UTCTimestamp);
    if (x == null) return null;
    return { asset: p.asset, x, lane: p.lane };
  }, [hoverAid, placed, dayBucket]);

  // Clear hoverAid when the hovered asset goes off-screen, so panning back
  // doesn't silently re-open the popover.
  useEffect(() => {
    if (hoverAid != null && hovered == null) setHoverAid(null);
  }, [hoverAid, hovered]);

  return (
    <Outer>
      <SimpleChart
        series={series}
        title={title ?? ''}
        scale={scale}
        formatter={formatter}
        logScale={logScale}
        onChartReady={onChartReady}
      />
      <Strip>
        {placed.map(({ asset, lane }) => {
          const label = asset.short_name ?? asset.name ?? `Asset #${asset.aid}`;
          return (
            <MarkerAnchor
              key={asset.aid}
              ref={(el) => setMarkerRef(asset.aid, el)}
              style={{
                /* Hidden until updatePositions writes the transform — avoids a
                   one-frame flash at x=0 before the first reposition pass. */
                display: 'none',
                bottom: `${BOTTOM_OFFSET_PX + lane * LANE_PX}px`,
              }}
            >
              <MarkerChip
                role="button"
                tabIndex={0}
                aria-label={`Open details for ${label}`}
                onMouseEnter={() => openHover(asset.aid)}
                onMouseLeave={scheduleCloseHover}
                onFocus={() => openHover(asset.aid)}
                onBlur={scheduleCloseHover}
                onClick={() => handleMarkerClick(asset.aid)}
                onKeyDown={(e) => handleMarkerKey(asset.aid, e)}
              >
                <AssetIcon
                  asset_id={asset.aid}
                  color={asset.color}
                  logoUrl={asset.logo_url}
                  size={ICON_PX}
                />
              </MarkerChip>
            </MarkerAnchor>
          );
        })}
        {hovered ? (
          <HoveredPopover
            marker={hovered}
            onMouseEnter={() => openHover(hovered.asset.aid)}
            onMouseLeave={scheduleCloseHover}
            onOpen={() => navigate(`/asset/${hovered.asset.aid}`)}
          />
        ) : null}
      </Strip>
    </Outer>
  );
};

interface HoveredPopoverProps {
  marker: PlacedMarker;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onOpen: () => void;
}

const HoveredPopover: React.FC<HoveredPopoverProps> = ({
  marker, onMouseEnter, onMouseLeave, onOpen,
}) => {
  const { asset, x, lane } = marker;
  const popRef = useRef<HTMLDivElement | null>(null);
  // Pin the popover above the marker, centred on its x. Flip to left/right
  // edges of the chart when it would clip horizontally.
  const [shift, setShift] = useState(0);

  // useLayoutEffect so the clip runs before the first paint — otherwise the
  // popover paints once at the unshifted x and then jumps to its clipped
  // position on the next frame (visible flicker at chart edges and when
  // moving between markers with different shifts).
  useLayoutEffect(() => {
    const el = popRef.current;
    if (!el) return;
    const parent = el.parentElement;
    if (!parent) return;
    const popW = el.offsetWidth;
    const parentW = parent.clientWidth;
    const desiredLeft = x - popW / 2;
    const minLeft = 6;
    const maxLeft = parentW - popW - 6;
    if (desiredLeft < minLeft) setShift(minLeft - desiredLeft);
    else if (desiredLeft > maxLeft) setShift(maxLeft - desiredLeft);
    else setShift(0);
  }, [x, asset.aid]);

  const bottom = BOTTOM_OFFSET_PX + (lane + 1) * LANE_PX + 4;
  const subParts = [
    asset.short_name,
    asset.unit_name && asset.unit_name !== asset.short_name ? asset.unit_name : null,
    `aid ${asset.aid}`,
  ].filter(Boolean).join(' · ');

  return (
    <Popover
      ref={popRef}
      style={{
        left: `${x + shift}px`,
        bottom: `${bottom}px`,
        transform: 'translateX(-50%)',
      }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <PopHeader>
        <PopTitle>
          <span className="icon">
            <AssetIcon
              asset_id={asset.aid}
              color={asset.color}
              logoUrl={asset.logo_url}
              size={20}
            />
          </span>
          <PopName>
            <PopNameMain>{asset.name ?? asset.short_name ?? `Asset #${asset.aid}`}</PopNameMain>
            <PopNameSub>{subParts}</PopNameSub>
          </PopName>
        </PopTitle>
        <ArrowButton type="button" onClick={onOpen} title="Open asset details" aria-label="Open asset details">
          <ArrowIcon />
        </ArrowButton>
      </PopHeader>
      {asset.minted_at_ts != null ? (
        <PopRow>
          <span>Minted</span>
          <span>{formatDate(asset.minted_at_ts)}</span>
        </PopRow>
      ) : null}
      {asset.minted_at_height != null ? (
        <PopRow>
          <span>Block</span>
          <span>#{asset.minted_at_height.toLocaleString('en-US')}</span>
        </PopRow>
      ) : null}
      <PopRow>
        <span>Pools</span>
        <span>{asset.pool_count}</span>
      </PopRow>
      {asset.description ? <PopDesc>{asset.description}</PopDesc> : null}
    </Popover>
  );
};
