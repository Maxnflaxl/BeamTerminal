import React, { useEffect, useRef, useState } from 'react';
import { styled } from '@linaria/react';
import {
  PageNarrow, Card, H2, Label, Value, Muted, theme,
} from './shared';

// Mainnet emission schedule — mirrors beam/core/block_crypt.cpp Rules::Emission.
const EXPLORER_API = 'https://explorer.0xmx.net/api/';
const DROP0 = 1440 * 365;        // blocks until first halving
const DROP1 = 1440 * 365 * 4;    // blocks between subsequent halvings
const EMIT_BASE = 80;            // base subsidy
const POLL_MS = 45_000;

interface Emission { rate: number; hEnd: number }

function getEmissionEx(h: number, base: number): Emission {
  const b0 = Math.floor(base);
  if (!b0) return { rate: 0, hEnd: 0 };
  if (h < 1) return { rate: 0, hEnd: 0 };
  const hp = h - 1;
  if (hp < DROP0) return { rate: b0, hEnd: DROP0 + 1 };
  const n = 1 + Math.floor((hp - DROP0) / DROP1);
  if (n >= 53) return { rate: 0, hEnd: 9007199254740991 };
  const hEnd = DROP0 + n * DROP1 + 1;
  let b = b0;
  if (n >= 2) b += b >> 2;
  // eslint-disable-next-line no-bitwise
  return { rate: b >> n, hEnd };
}

const blockRewardAtHeight = (h: number): number =>
  (h < 1 ? 0 : getEmissionEx(h, EMIT_BASE).rate);

function nextHalvingHeight(tip: number): number | null {
  const hQuery = Math.max(1, Math.floor(Number(tip)));
  const { rate, hEnd } = getEmissionEx(hQuery, EMIT_BASE);
  return rate ? hEnd : null;
}

function parseExplorerNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const n = Number(v.replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function extractStatusMetric(node: unknown, label: string): number | null {
  if (!node) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      if (
        Array.isArray(item) && item.length >= 2
        && (item[0] as { type?: string; value?: unknown })?.type === 'th'
        && (item[0] as { value?: unknown })?.value === label
      ) {
        const raw = (item[1] as { value?: unknown })?.value ?? item[1];
        const parsed = parseExplorerNumber(raw);
        if (parsed !== null) return parsed;
      }
      const nested = extractStatusMetric(item, label);
      if (nested !== null) return nested;
    }
    return null;
  }
  if (typeof node === 'object') {
    for (const key of Object.keys(node as Record<string, unknown>)) {
      const nested = extractStatusMetric((node as Record<string, unknown>)[key], label);
      if (nested !== null) return nested;
    }
  }
  return null;
}

function extractTimestampSeconds(node: unknown): number | null {
  if (!node || typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;
  const direct = parseExplorerNumber(obj.timestamp)
    ?? parseExplorerNumber(obj.Timestamp)
    ?? parseExplorerNumber(obj.time);
  if (direct !== null && direct > 1e9 && direct < 4e10) return direct;
  if (Array.isArray(node)) {
    for (const item of node) {
      const t = extractTimestampSeconds(item);
      if (t !== null) return t;
    }
    return null;
  }
  for (const key of Object.keys(obj)) {
    const t = extractTimestampSeconds(obj[key]);
    if (t !== null) return t;
  }
  return null;
}

const parseTipFromStatus = (data: Record<string, unknown>): number | null =>
  parseExplorerNumber(data.height)
  ?? parseExplorerNumber(data.h)
  ?? extractStatusMetric(data, 'Height')
  ?? null;

async function fetchTipBlockTimestamp(tip: number): Promise<number | null> {
  try {
    const res = await fetch(`${EXPLORER_API}block?height=${tip}&exp_am=1`);
    const data = await res.json() as Record<string, unknown>;
    if (data && data.found === false) return null;
    const sec = extractTimestampSeconds(data);
    return sec !== null ? sec * 1000 : null;
  } catch {
    return null;
  }
}

interface State {
  tip: number | null;
  nextH: number | null;
  blocksLeft: number | null;
  lastBlockMs: number | null;
  exhausted: boolean;
  error: string | null;
}

const initialState: State = {
  tip: null, nextH: null, blocksLeft: null, lastBlockMs: null, exhausted: false, error: null,
};

const fmtAmount = (n: number): string =>
  Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 8 });

// ---------------------------------------------------------------------------
// Page-specific styled components (no shared equivalent)
// ---------------------------------------------------------------------------

const Grid = styled.div`
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
  text-align: center;
  margin-top: 8px;

  @media (max-width: 480px) {
    grid-template-columns: repeat(2, 1fr);
  }
`;

const Unit = styled.div`
  background: ${theme.color.surface2};
  border: 1px solid ${theme.color.borderDim};
  border-radius: ${theme.radius.md};
  padding: 16px 8px;
`;

const Num = styled.div`
  font-size: clamp(28px, 8vw, 40px);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: ${theme.color.text};
  line-height: 1.1;
`;

const UnitLabel = styled.div`
  font-size: 12px;
  color: ${theme.color.muted};
  margin-top: 6px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
`;

const StatusMsg = styled.div<{ kind: 'ok' | 'bad' | 'muted' }>`
  font-size: ${(p) => (p.kind === 'muted' ? '16px' : '22px')};
  font-weight: 500;
  margin-top: 12px;
  color: ${(p) => (p.kind === 'ok' ? theme.color.success : p.kind === 'bad' ? theme.color.danger : theme.color.muted)};
  text-shadow: ${(p) => (p.kind === 'ok' ? `0 0 8px ${theme.color.accentGlow}` : 'none')};
`;

const Footnote = styled.p`
  font-size: 12px;
  color: ${theme.color.muted};
  margin-top: 16px;
  line-height: 1.5;
`;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const Countdown: React.FC = () => {
  const [state, setState] = useState<State>(initialState);
  const [now, setNow] = useState<number>(Date.now());
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    let stopped = false;

    async function poll(): Promise<void> {
      try {
        const res = await fetch(`${EXPLORER_API}status?exp_am=1`);
        const data = await res.json() as Record<string, unknown>;
        if (stopped) return;
        const tip = parseTipFromStatus(data);

        if (tip === null || tip < 1) {
          setState({ ...initialState, tip, error: 'Could not read chain height from explorer.' });
          return;
        }

        const { rate } = getEmissionEx(tip, EMIT_BASE);
        if (!rate) {
          setState({ ...initialState, tip, exhausted: true });
          return;
        }

        const nextH = nextHalvingHeight(tip);
        const blocksLeft = nextH !== null ? Math.max(0, nextH - tip) : null;

        const statusTs = extractTimestampSeconds(data);
        let lastBlockMs = statusTs !== null ? statusTs * 1000 : null;
        if (lastBlockMs === null) {
          lastBlockMs = await fetchTipBlockTimestamp(tip);
        }
        if (stopped) return;
        setState({ tip, nextH, blocksLeft, lastBlockMs, exhausted: false, error: null });
      } catch {
        if (stopped) return;
        setState({ ...initialState, error: 'Explorer unavailable.' });
      }
    }

    void poll();
    const pollId = setInterval(poll, POLL_MS);
    const tickId = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      stopped = true;
      clearInterval(pollId);
      clearInterval(tickId);
    };
  }, []);

  const {
    tip, nextH, blocksLeft, lastBlockMs, exhausted, error,
  } = state;

  let status: { text: string; kind: 'ok' | 'bad' | 'muted' } | null = null;
  let showCountdown = false;
  if (error) status = { text: error, kind: 'bad' };
  else if (exhausted) status = { text: 'Miner subsidy schedule ended (no further halvings).', kind: 'ok' };
  else if (tip === null || tip < 1 || nextH === null) status = { text: 'Waiting for a valid chain height from the explorer…', kind: 'muted' };
  else showCountdown = true;

  let days = 0;
  let hours = 0;
  let mins = 0;
  let secs = 0;
  if (showCountdown && tip !== null && blocksLeft !== null) {
    const baseMs = lastBlockMs !== null ? lastBlockMs : now;
    const deadlineMs = baseMs + blocksLeft * 60 * 1000;
    let rem = Math.max(0, Math.floor((deadlineMs - now) / 1000));
    days = Math.floor(rem / 86400); rem -= days * 86400;
    hours = Math.floor(rem / 3600); rem -= hours * 3600;
    mins = Math.floor(rem / 60); secs = rem - mins * 60;
  }

  const pad = (n: number): string => String(n).padStart(2, '0');

  return (
    <PageNarrow>
      <H2>Next halving</H2>
      <Muted>Miner subsidy schedule (mainnet).</Muted>

      <Card>
        <Label>Countdown (estimated)</Label>
        {showCountdown && (
          <Grid>
            <Unit><Num>{String(days)}</Num><UnitLabel>days</UnitLabel></Unit>
            <Unit><Num>{pad(hours)}</Num><UnitLabel>hours</UnitLabel></Unit>
            <Unit><Num>{pad(mins)}</Num><UnitLabel>minutes</UnitLabel></Unit>
            <Unit><Num>{pad(secs)}</Num><UnitLabel>seconds</UnitLabel></Unit>
          </Grid>
        )}
        {status && <StatusMsg kind={status.kind}>{status.text}</StatusMsg>}
        <Footnote>
          ETA uses the timestamp of the current chain tip when available, plus remaining blocks × 60s (Beam target block time).
          Explorer polls every 45s.
        </Footnote>
      </Card>

      <Card>
        <Label>Chain tip height</Label>
        <Value>{error || tip === null ? '—' : tip.toLocaleString('en-US')}</Value>
        <Label style={{ marginTop: 16 }}>Next subsidy change (first block at new rate)</Label>
        <Value>{exhausted || error || nextH === null ? '—' : nextH.toLocaleString('en-US')}</Value>
        <Label style={{ marginTop: 16 }}>Blocks remaining</Label>
        <Value>{exhausted || error || blocksLeft === null ? '—' : blocksLeft.toLocaleString('en-US')}</Value>
        <Label style={{ marginTop: 16 }}>Block reward after halving (BEAM)</Label>
        <Value>{exhausted || error || nextH === null ? '—' : fmtAmount(blockRewardAtHeight(nextH))}</Value>
      </Card>
    </PageNarrow>
  );
};

export default Countdown;
