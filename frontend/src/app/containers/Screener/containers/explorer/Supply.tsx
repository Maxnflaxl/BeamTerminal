import React, { useCallback, useEffect, useRef, useState } from 'react';
import { styled } from '@linaria/react';
import {
  ColorType,
  LineType,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type UTCTimestamp,
} from 'lightweight-charts';
import { createBeamChart } from '../../components/chartTheme';
import {
  EXPLORER_API,
  HALVING_MARKERS,
  FORK_MARKERS,
  expectedSupplyFast,
  blockRewardAtHeight,
  emissionRateChangeHeights,
  parseExplorerNumber,
  extractStatusMetric,
  fmtInt,
  fmtDateFromHeight,
  specialBlocks,
  type SupplySnapshot,
} from './supplyMath';
import { Page, Card, H2, Label, Value, Btn, Input, Grid2, Row, theme, DataTable, ScrollX } from './shared';

// ---------------------------------------------------------------------------
// Page-specific styled components
// ---------------------------------------------------------------------------

const Status = styled.div<{ kind: 'ok' | 'bad' | 'neutral' }>`
  font-size: 26px;
  margin-top: 10px;
  color: ${(p) => (p.kind === 'ok' ? theme.color.success : p.kind === 'bad' ? theme.color.danger : theme.color.muted)};
  text-shadow: ${(p) =>
    p.kind === 'ok' ? `0 0 8px ${theme.color.success}` : p.kind === 'bad' ? `0 0 8px ${theme.color.danger}` : 'none'};
`;

const Dot = styled.span<{ color: string }>`
  display: inline-block;
  width: 10px;
  height: 3px;
  border-radius: 1px;
  vertical-align: middle;
  margin-right: 4px;
  background: ${(p) => p.color};
`;

const ChartWrap = styled.div`
  background: ${theme.color.surface};
  border: 1px solid ${theme.color.borderDim};
  border-radius: ${theme.radius.lg};
  padding: 10px;
  height: 600px;
`;

const Collapsible = styled.details`
  & > summary {
    cursor: pointer;
    font-weight: 600;
    color: ${theme.color.accent};
    padding: 4px 0;
    user-select: none;
  }
`;

// Fixed layout so expanding a row's description grows only its height — with the
// default auto layout the column widths recompute and the whole table jumps.
const SpecialBlocksTable = styled(DataTable)`
  table-layout: fixed;
  td {
    vertical-align: top;
  }
  td a {
    word-break: break-all;
  }
`;

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

interface ChainSupply {
  total: number | null;
  miner: number | null;
  treasury: number | null;
}

function parseChainFromExplorerResponse(data: unknown): ChainSupply {
  let miner = extractStatusMetric(data, 'Current Emission');
  if (miner === null) miner = extractStatusMetric(data, 'Total Emission');
  let treasury = extractStatusMetric(data, 'Treasury Released');
  if (treasury === null) treasury = extractStatusMetric(data, 'Treasury Total');
  let total = extractStatusMetric(data, 'Current Circulation');
  if (total === null) total = extractStatusMetric(data, 'Total Circulation');
  if (total === null && miner !== null && treasury !== null) total = miner + treasury;
  return { total, miner, treasury };
}

interface ChartPoint {
  time: UTCTimestamp;
  value: number;
}

interface ChartData {
  total: ChartPoint[];
  miner: ChartPoint[];
  treasury: ChartPoint[];
  reward: ChartPoint[];
  // Block-height markers (height + label + color), positioned in time by
  // a date interpolation from genesis or real explorer timestamps.
  markers: { time: UTCTimestamp; label: string; color: string; kind: 'halving' | 'fork' | 'special' }[];
}

// Non-halving/non-fork narrative blocks, as chart markers. Derived from the same
// specialBlocks catalog; multi-height entries mark their last block.
const SPECIAL_MARKERS = specialBlocks
  .filter((b) => !/Halving|Hard-Fork/.test(b.title))
  .map((b) => {
    const hs = b.block_list ?? (b.block_range ? [b.block_range[1]] : []);
    return { height: hs[hs.length - 1] ?? 0, label: b.title };
  })
  .filter((m) => m.height > 0);

function collectChartHeights(tip: number, step: number): number[] {
  const s = new Set<number>();
  for (let h = 0; h <= tip; h += step) s.add(h);
  s.add(tip);
  for (const m of HALVING_MARKERS) if (m.height <= tip) s.add(m.height);
  for (const m of FORK_MARKERS) if (m.height <= tip) s.add(m.height);
  for (const m of SPECIAL_MARKERS) if (m.height <= tip) s.add(m.height);
  for (const h of emissionRateChangeHeights(tip)) s.add(h);
  return Array.from(s).sort((a, b) => a - b);
}

async function fetchHeightDates(maxHeight: number, step: number, labelCount: number): Promise<Map<number, number>> {
  // Returns Map<height, unix-seconds>. Uses /hdrs?cols=TH&dh=...
  try {
    const nMax = Math.min(Math.max(labelCount + 1, 50), 1200);
    const url = `${EXPLORER_API}/hdrs?cols=TH&hMax=${maxHeight}&nMax=${nMax}&dh=${step}&exp_am=1`;
    const res = await fetch(url);
    const data = (await res.json()) as { value?: unknown };
    const m = new Map<number, number>();
    const rows = Array.isArray(data?.value) ? (data.value as unknown[]) : [];
    for (let i = 1; i < rows.length; i += 1) {
      const r = rows[i];
      if (!Array.isArray(r) || r.length < 2) continue;
      const h = parseExplorerNumber((r[0] as { value?: unknown })?.value);
      const ts = parseExplorerNumber((r[1] as { value?: unknown })?.value);
      if (h === null || ts === null) continue;
      m.set(h, ts);
    }
    return m;
  } catch {
    return new Map();
  }
}

const GENESIS_MS = Date.UTC(2019, 0, 3, 0, 0, 0);
const tsForHeight = (h: number, real: Map<number, number>): UTCTimestamp => {
  const known = real.get(h);
  if (known !== undefined) return known as UTCTimestamp;
  return Math.floor((GENESIS_MS + Math.max(0, h) * 60_000) / 1000) as UTCTimestamp;
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const Supply: React.FC = () => {
  const [height, setHeight] = useState<number | null>(null);
  const [chain, setChain] = useState<ChainSupply>({ total: null, miner: null, treasury: null });
  const [expected, setExpected] = useState<SupplySnapshot>({ total: 0, miner: 0, treasury: 0 });
  const [manualHeight, setManualHeight] = useState('');
  const [manualActual, setManualActual] = useState('');
  const readFlag = (key: string, dflt: boolean): boolean => {
    try {
      const v = localStorage.getItem(key);
      return v === null ? dflt : v === 'true';
    } catch {
      return dflt;
    }
  };
  const [showHalvings, setShowHalvings] = useState(() => readFlag('supplyChartShowHalvings', true));
  const [showForks, setShowForks] = useState(() => readFlag('supplyChartShowForks', true));
  const [showSpecial, setShowSpecial] = useState(() => readFlag('supplyChartShowSpecial', false));
  const [manualOverride, setManualOverride] = useState<number | null>(null);

  const chartWrapRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<Record<string, ISeriesApi<'Line'> | null>>({});
  const dataRef = useRef<ChartData | null>(null);

  // Initial load + URL-style auto-update from status endpoint.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${EXPLORER_API}/status?exp_am=1`);
        const data = (await res.json()) as Record<string, unknown>;
        if (cancelled) return;
        const h =
          parseExplorerNumber(data.height) ?? parseExplorerNumber(data.h) ?? extractStatusMetric(data, 'Height') ?? 0;
        setHeight(h);
        setChain(parseChainFromExplorerResponse(data));
        setExpected(expectedSupplyFast(h));
      } catch {
        if (!cancelled) setHeight(0);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Build chart when height changes.
  useEffect(() => {
    if (height === null) return undefined;
    let cancelled = false;
    (async () => {
      const tip = Math.max(0, Math.floor(height));
      const step = Math.max(1, Math.floor(tip / 200));
      const heights = collectChartHeights(tip, step);
      const dates = await fetchHeightDates(tip, step, heights.length);
      if (cancelled) return;
      const data: ChartData = {
        total: [],
        miner: [],
        treasury: [],
        reward: [],
        markers: [],
      };
      for (const h of heights) {
        const s = expectedSupplyFast(h);
        const ts = tsForHeight(h, dates);
        data.total.push({ time: ts, value: s.total });
        data.miner.push({ time: ts, value: s.miner });
        data.treasury.push({ time: ts, value: s.treasury });
        data.reward.push({ time: ts, value: blockRewardAtHeight(h) });
      }
      for (const m of HALVING_MARKERS) {
        if (m.height <= tip) {
          data.markers.push({
            time: tsForHeight(m.height, dates),
            label: m.label,
            color: '#ff9c6e',
            kind: 'halving',
          });
        }
      }
      for (const m of FORK_MARKERS) {
        if (m.height <= tip) {
          data.markers.push({
            time: tsForHeight(m.height, dates),
            label: m.label,
            color: '#b388ff',
            kind: 'fork',
          });
        }
      }
      for (const m of SPECIAL_MARKERS) {
        if (m.height <= tip) {
          data.markers.push({
            time: tsForHeight(m.height, dates),
            label: m.label,
            color: '#22d3ee',
            kind: 'special',
          });
        }
      }
      data.markers.sort((a, b) => Number(a.time) - Number(b.time));
      dataRef.current = data;
      renderChart(data);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [height]);

  // Re-render markers when any toggle flips.
  useEffect(() => {
    if (dataRef.current) renderChart(dataRef.current);
    try {
      localStorage.setItem('supplyChartShowHalvings', showHalvings ? 'true' : 'false');
      localStorage.setItem('supplyChartShowForks', showForks ? 'true' : 'false');
      localStorage.setItem('supplyChartShowSpecial', showSpecial ? 'true' : 'false');
    } catch {
      /* ignore */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showHalvings, showForks, showSpecial]);

  // Dispose the chart on unmount — renderChart only removes the *previous*
  // instance on re-render, so without this the last chart's canvas + WebGL
  // context leak every time the Supply page is navigated away from.
  useEffect(
    () => () => {
      chartRef.current?.remove();
      chartRef.current = null;
    },
    [],
  );

  function renderChart(data: ChartData): void {
    const el = chartWrapRef.current;
    if (!el) return;
    if (chartRef.current) {
      chartRef.current.remove();
      chartRef.current = null;
    }
    // Shared base theme; this chart keeps its lighter surface background,
    // brighter labels, and the left price scale.
    const chart = createBeamChart(el, {
      layout: {
        background: { type: ColorType.Solid, color: theme.color.surface },
        textColor: 'rgba(255, 255, 255, 0.7)',
      },
      rightPriceScale: { borderColor: 'rgba(255, 255, 255, 0.1)', visible: true },
      leftPriceScale: { borderColor: 'rgba(255, 255, 255, 0.1)', visible: true },
    });
    chartRef.current = chart;
    const mkLine = (
      color: string,
      priceScaleId: 'left' | 'right',
      lineType: LineType = LineType.Simple,
    ): ISeriesApi<'Line'> =>
      chart.addLineSeries({
        color,
        lineWidth: 2,
        lineType,
        priceLineVisible: false,
        lastValueVisible: false,
        priceScaleId,
      });
    const sTotal = mkLine('#7eb8ff', 'left');
    const sMiner = mkLine('#00c853', 'left');
    const sTrea = mkLine('#ff9800', 'left');
    const sRew = mkLine('#ffd54f', 'right', LineType.WithSteps);
    seriesRef.current = {
      total: sTotal,
      miner: sMiner,
      treasury: sTrea,
      reward: sRew,
    };
    sTotal.setData(data.total as LineData[]);
    sMiner.setData(data.miner as LineData[]);
    sTrea.setData(data.treasury as LineData[]);
    sRew.setData(data.reward as LineData[]);

    const shownKinds = {
      halving: showHalvings,
      fork: showForks,
      special: showSpecial,
    };
    sTotal.setMarkers(
      data.markers
        .filter((m) => shownKinds[m.kind])
        .map((m) => ({
          time: m.time,
          position: 'inBar' as const,
          color: m.color,
          shape: 'arrowDown' as const,
          text: m.label,
        })),
    );
    chart.timeScale().fitContent();
  }

  const manualCheck = useCallback((): void => {
    const h = parseInt(manualHeight || '0', 10);
    const a = parseFloat(manualActual);
    if (!Number.isFinite(h) || h < 0) return;
    setManualOverride(Number.isFinite(a) ? a : null);
    (async () => {
      try {
        const res = await fetch(`${EXPLORER_API}/block?height=${h}&exp_am=1`);
        const data = (await res.json()) as Record<string, unknown>;
        setHeight(h);
        setExpected(expectedSupplyFast(h));
        if (data.found === false) {
          setChain({ total: null, miner: null, treasury: null });
        } else {
          setChain(parseChainFromExplorerResponse(data));
        }
      } catch {
        setHeight(h);
        setExpected(expectedSupplyFast(h));
        setChain({ total: null, miner: null, treasury: null });
      }
    })();
  }, [manualHeight, manualActual]);

  // Match status: compares chain.total (or manual override) against expected.
  let status: { text: string; kind: 'ok' | 'bad' | 'neutral' };
  const useManual = manualOverride !== null && Number.isFinite(manualOverride);
  const compareTotal = useManual ? manualOverride : chain.total;
  if (compareTotal !== null && compareTotal !== undefined && Number.isFinite(compareTotal)) {
    const diffTotal = Math.abs(compareTotal - expected.total);
    if (useManual) {
      status = diffTotal < 1 ? { text: '✔ MATCH (total)', kind: 'ok' } : { text: '✖ MISMATCH (total)', kind: 'bad' };
    } else {
      const diffMiner = chain.miner !== null ? Math.abs(chain.miner - expected.miner) : 0;
      const diffTrea = chain.treasury !== null ? Math.abs(chain.treasury - expected.treasury) : 0;
      status =
        diffTotal < 1 && diffMiner < 1 && diffTrea < 1
          ? { text: '✔ MATCH', kind: 'ok' }
          : { text: '✖ MISMATCH', kind: 'bad' };
    }
  } else {
    status = { text: '—', kind: 'neutral' };
  }

  return (
    <Page>
      <H2>Beam Supply Dashboard</H2>

      <Grid2>
        <Card>
          <Label>Chain (Explorer)</Label>
          <Value>{height === null ? '—' : `Height: ${fmtInt(height)}`}</Value>
          <Value>{`Miner + Treasury: ${chain.total !== null ? fmtInt(chain.total) : 'Unavailable'}`}</Value>
          <Value>{`Miner: ${chain.miner !== null ? fmtInt(chain.miner) : 'Unavailable'}`}</Value>
          <Value>{`Treasury: ${chain.treasury !== null ? fmtInt(chain.treasury) : 'Unavailable'}`}</Value>
        </Card>
        <Card>
          <Label>Expected (Model)</Label>
          <Value>{`Miner + Treasury: ${fmtInt(expected.total)}`}</Value>
          <Value>{`Miner: ${fmtInt(expected.miner)}`}</Value>
          <Value>{`Treasury: ${fmtInt(expected.treasury)}`}</Value>
          <Status kind={status.kind}>{status.text}</Status>
        </Card>
      </Grid2>

      <Card>
        <Label>Check at exact height</Label>
        <Input
          type="number"
          placeholder="Block height"
          value={manualHeight}
          onChange={(e) => setManualHeight(e.target.value)}
        />
        <div style={{ height: 8 }} />
        <Input
          type="number"
          placeholder="Optional: override total for match (else explorer)"
          value={manualActual}
          onChange={(e) => setManualActual(e.target.value)}
        />
        <div style={{ height: 10 }} />
        <Btn type="button" onClick={manualCheck}>
          Check
        </Btn>
      </Card>

      <div>
        <Row>
          <label>
            <input
              type="checkbox"
              checked={showHalvings}
              onChange={(e) => setShowHalvings(e.target.checked)}
              style={{ marginRight: 6 }}
            />
            <Dot color="#ff9c6e" /> Halvings
          </label>
          <label>
            <input
              type="checkbox"
              checked={showForks}
              onChange={(e) => setShowForks(e.target.checked)}
              style={{ marginRight: 6 }}
            />
            <Dot color="#b388ff" /> Hard forks
          </label>
          <label>
            <input
              type="checkbox"
              checked={showSpecial}
              onChange={(e) => setShowSpecial(e.target.checked)}
              style={{ marginRight: 6 }}
            />
            <Dot color="#22d3ee" /> Special blocks
          </label>
        </Row>
        <ChartWrap ref={chartWrapRef} />
      </div>

      <Card>
        <H2>Special historical blocks</H2>
        <ScrollX>
          <SpecialBlocksTable>
            <thead>
              <tr>
                <th className="right" style={{ width: 130 }}>
                  Height
                </th>
                <th style={{ width: 110 }}>Date</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              {specialBlocks.map((b, i) => {
                const repHeight = b.block_list?.[0] ?? b.block_range?.[0] ?? 0;
                return (
                  // eslint-disable-next-line react/no-array-index-key
                  <tr key={i}>
                    <td className="right">
                      {b.block_list?.map((h) => (
                        <div key={h}>{fmtInt(h)}</div>
                      ))}
                      {b.block_range && (
                        <div>
                          {fmtInt(b.block_range[0])}
                          <br />
                          to
                          {fmtInt(b.block_range[1])}
                        </div>
                      )}
                    </td>
                    <td>{fmtDateFromHeight(repHeight)}</td>
                    <td>
                      <Collapsible>
                        <summary>{b.title}</summary>
                        <div style={{ marginTop: 8 }}>{b.description}</div>
                        {b.links && (
                          <ul style={{ marginTop: 8 }}>
                            {b.links.map((l, j) => (
                              // eslint-disable-next-line react/no-array-index-key
                              <li key={j}>
                                {l[0]}:{' '}
                                <a href={l[1]} target="_blank" rel="noreferrer" style={{ color: theme.color.accent }}>
                                  {l[1]}
                                </a>
                              </li>
                            ))}
                          </ul>
                        )}
                      </Collapsible>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </SpecialBlocksTable>
        </ScrollX>
      </Card>
    </Page>
  );
};

export default Supply;
