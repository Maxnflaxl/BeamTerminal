import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { styled } from '@linaria/react';
import { api } from '@app/containers/Screener/api/client';
import type {
  ApiBridgeHealth,
  ApiBridgeHealthRow,
  ApiBridgeMessage,
  ApiBridgeMessages,
  ApiBridgeLookup,
} from '@app/containers/Screener/api/types';
import {
  Page,
  ExplorerHeader,
  H1,
  H2,
  Subtitle,
  Muted,
  Card,
  StatGrid,
  StatCard,
  Label,
  Value,
  SubValue,
  Pill,
  DataTable,
  ScrollX,
  ErrorBox,
  WarnBox,
  Select,
  Btn,
  Input,
} from './shared/components';
import { theme } from './shared/theme';

// ---------------------------------------------------------------------------
// Bridge Tracker
//
// Answers the question a bridge user actually has — "I sent funds across, where
// are they?" — rather than only showing aggregate supply.
//
// Everything renders from /api/bridge/* for anonymous visitors. The previous
// version required each visitor to paste their own Etherscan key into
// localStorage before any panel would populate; that key now lives server-side
// on the indexer.
//
// Two vocabularies, deliberately distinct (see docs/api.md):
//   beam2eth  pending / relayed / failed
//   eth2beam  not_delivered / unclaimed / complete
// `unclaimed` is NOT an error — only the recipient can sign ReceiveFunds, so a
// transfer can legitimately rest there for years. It is presented as its own
// category, never folded into failures.
// ---------------------------------------------------------------------------

const POLL_MS = 60_000;
const PAGE_SIZE = 25;

const EXPLORER_UI = 'https://explorer.0xmx.net/';

// ---------------------------------------------------------------------------
// Presentation atoms
// ---------------------------------------------------------------------------

const BridgeGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 14px;
  margin-top: 14px;
`;

// Column flex so the footer and action can be pushed to the bottom: the status
// chip rows vary in height between bridges, and without this the "View
// transfers" buttons land at a different height in every card.
const BridgeCard = styled.div`
  display: flex;
  flex-direction: column;
  border: 1px solid ${theme.color.border};
  border-radius: 10px;
  padding: 16px;
  background: ${theme.color.surface2};
`;

const CardTop = styled.div`
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 12px;
`;

const CardTitle = styled.div`
  font-size: 15px;
  font-weight: 600;
  color: ${theme.color.text};
`;

// Collateral bar: wrapped supply measured against the collateral backing it.
// Which chain holds which varies — the b-assets lock on Ethereum and mint on
// Beam, BEAM/WBEAM does the reverse — so the API reports both sides already
// oriented and this only renders the ratio.
const PegBar = styled.div`
  position: relative;
  height: 8px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.07);
  overflow: hidden;
  margin: 8px 0 6px;
`;

const PegFill = styled.div`
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: 4px;
  background: ${theme.color.accent};
  &[data-tone='warn'] {
    background: ${theme.color.warn};
  }
  &[data-tone='danger'] {
    background: ${theme.color.danger};
  }
`;

// Minted and locked are the two halves of one comparison, so they get equal
// columns with the label above the number. Side-by-side inline text wrapped
// badly once the figures ran long (millions of BEAM with locale separators).
const PegStats = styled.div`
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 4px 12px;
  margin-top: 8px;
`;

const PegStatLabel = styled.div`
  font-size: 10px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: ${theme.color.muted};
`;

const PegStatValue = styled.div`
  font-family: ${theme.font.mono};
  font-size: 12px;
  color: ${theme.color.text};
  white-space: nowrap;
`;

const CardFoot = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
  /* auto, not a fixed gap: absorbs the difference in chip-row height so the
     footer and the button below it line up across the row. */
  margin-top: auto;
  padding-top: 10px;
  border-top: 1px solid ${theme.color.borderDim};
  font-size: 11px;
  color: ${theme.color.muted};
`;

const LinkRow = styled.div`
  display: flex;
  gap: 6px;
`;

// Default anchor styling (bright blue, underlined) is unreadable against the
// card surface at this size. These read as quiet affordances instead, and only
// pick up colour on hover.
const LinkChip = styled.a`
  display: inline-block;
  padding: 3px 8px;
  border: 1px solid ${theme.color.border};
  border-radius: 5px;
  font-family: ${theme.font.mono};
  font-size: 11px;
  line-height: 1.3;
  color: ${theme.color.textDim};
  text-decoration: none;
  white-space: nowrap;
  transition: color 0.12s ease, border-color 0.12s ease, background 0.12s ease;

  &:hover,
  &:focus-visible {
    color: ${theme.color.accent};
    border-color: ${theme.color.accent};
    background: rgba(0, 246, 210, 0.08);
    text-decoration: none;
  }
`;

const Chips = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 12px;
  /* The footer's separator is positioned with margin-top:auto, which collapses
     to zero on a card whose content already fills the column — leaving the rule
     flush against these chips. The gap has to live here, where nothing can
     collapse it. Kept tight: the rule is a divider, not a section break. */
  margin-bottom: 10px;
`;

const Filters = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  margin: 12px 0;
`;

const Mono = styled.span`
  font-family: ${theme.font.mono};
`;

const Pager = styled.div`
  display: flex;
  gap: 8px;
  align-items: center;
  justify-content: flex-end;
  margin-top: 12px;
  font-size: 12px;
  color: ${theme.color.muted};
`;

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function fmtAmount(n: number | null, maxFrac = 6): string {
  if (n === null || !Number.isFinite(n)) return '—';
  if (n === 0) return '0';
  // Junk messages carry values near 2^256. Spelled out that's 78 digits, which
  // blows the column apart — and the exact figure is meaningless anyway.
  if (Math.abs(n) >= 1e20) return n.toExponential(2);
  if (Math.abs(n) < 0.000001) return n.toExponential(2);
  return n.toLocaleString(undefined, { maximumFractionDigits: maxFrac });
}

function fmtUsd(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

function fmtAge(iso: string | null): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const secs = Math.max(0, (Date.now() - t) / 1000);
  const d = Math.floor(secs / 86400);
  if (d >= 365) return `${(d / 365).toFixed(1)}y`;
  if (d >= 1) return `${d}d`;
  const h = Math.floor(secs / 3600);
  if (h >= 1) return `${h}h`;
  return `${Math.floor(secs / 60)}m`;
}

function shortHex(s: string | null | undefined, head = 8, tail = 6): string {
  if (!s) return '—';
  const clean = s.replace(/^0x/, '');
  if (clean.length <= head + tail) return clean;
  return `${clean.slice(0, head)}…${clean.slice(-tail)}`;
}

type Tone = 'accent' | 'success' | 'warn' | 'danger' | 'info' | 'purple';

// The tone map encodes the editorial position: unclaimed is informational
// (funds are safe, just uncollected), not_delivered is a real warning, failed
// is an error, pending is neutral-in-progress.
function statusTone(status: string): Tone {
  switch (status) {
    case 'complete':
    case 'relayed':
      return 'success';
    case 'unclaimed':
      return 'info';
    case 'not_delivered':
      return 'warn';
    case 'failed':
      return 'danger';
    default:
      return 'purple';
  }
}

// One vocabulary across the page: the cards and the table used to disagree
// ("in flight" vs "pending") about the same API status.
function statusLabel(status: string): string {
  switch (status) {
    case 'not_delivered':
      return 'not delivered';
    case 'unclaimed':
      return 'awaiting claim';
    case 'pending':
      return 'in flight';
    default:
      return status;
  }
}

// ratio = minted ÷ locked. At or below 1 every wrapped unit is backed by
// collateral; above 1 means more has been issued than is held, which is the
// only genuinely alarming state here.
function pegTone(ratio: number | null): Tone {
  if (ratio === null) return 'purple';
  if (ratio > 1.01) return 'danger';
  if (ratio > 1.0001) return 'warn';
  return 'success';
}

function beamAssetUrl(aid: number): string {
  return `${EXPLORER_UI}asset/${aid}`;
}

function etherscanAddr(addr: string): string {
  return `https://etherscan.io/address/${addr}`;
}

function etherscanTx(hash: string): string {
  return `https://etherscan.io/tx/${hash}`;
}

const ExtLink: React.FC<{ href: string; children: React.ReactNode }> = ({ href, children }) => (
  <a href={href} target="_blank" rel="noopener noreferrer">
    {children}
  </a>
);

// ---------------------------------------------------------------------------
// Per-bridge card
// ---------------------------------------------------------------------------

const BridgeSummaryCard: React.FC<{
  row: ApiBridgeHealthRow;
  settlementAvailable: boolean;
  onFocus: (bridge: string) => void;
}> = ({ row, settlementAvailable, onFocus }) => {
  const ratio = row.collateral_ratio;
  // Fill = share of the locked collateral that has been issued, clamped so an
  // over-issued bridge pins at full rather than overflowing the track. The
  // percentage below the bar is unclamped, so the real figure stays visible.
  const pct = ratio === null ? 0 : Math.max(0, Math.min(1, ratio)) * 100;
  const open = row.outgoing.pending + row.incoming.not_delivered;

  return (
    <BridgeCard>
      <CardTop>
        <CardTitle>{row.label}</CardTitle>
        <Pill data-tone={open > 0 ? 'warn' : 'success'}>{open > 0 ? `${open} open` : 'settled'}</Pill>
      </CardTop>

      <Label>Collateral backing</Label>
      <PegBar>
        <PegFill data-tone={pegTone(ratio)} style={{ width: `${pct}%` }} />
      </PegBar>
      <PegStats>
        <PegStatLabel>Wrapped supply</PegStatLabel>
        <PegStatValue>{fmtAmount(row.minted, 4)}</PegStatValue>
        <PegStatLabel>Collateral held</PegStatLabel>
        <PegStatValue>{fmtAmount(row.escrow?.locked ?? null, 4)}</PegStatValue>
      </PegStats>
      <SubValue style={{ marginTop: 8 }}>
        {ratio === null ? 'backing unknown' : `${(ratio * 100).toFixed(2)}% of collateral issued`}
      </SubValue>

      <Chips>
        {row.incoming.unclaimed > 0 && <Pill data-tone="info">{row.incoming.unclaimed} awaiting claim</Pill>}
        {row.incoming.not_delivered > 0 && <Pill data-tone="warn">{row.incoming.not_delivered} not delivered</Pill>}
        {row.outgoing.failed > 0 && <Pill data-tone="danger">{row.outgoing.failed} failed</Pill>}
        {settlementAvailable && row.outgoing.pending > 0 && (
          <Pill data-tone="purple">
            {row.outgoing.pending} {statusLabel('pending')}
          </Pill>
        )}
        {!settlementAvailable && row.outgoing.total > 0 && (
          <Pill data-tone="purple">{row.outgoing.total} out, unverified</Pill>
        )}
      </Chips>

      <CardFoot>
        <span>last activity {fmtAge(row.last_message_ts)} ago</span>
        <LinkRow>
          <LinkChip
            href={etherscanAddr(row.eth_pipe)}
            target="_blank"
            rel="noopener noreferrer"
            title={`Pipe contract ${row.eth_pipe} on Etherscan`}
          >
            Pipe ↗
          </LinkChip>
          <LinkChip
            href={beamAssetUrl(row.aid)}
            target="_blank"
            rel="noopener noreferrer"
            title={`Beam asset ${row.aid} in the explorer`}
          >
            {row.aid === 0 ? 'BEAM ↗' : `Asset ${row.aid} ↗`}
          </LinkChip>
        </LinkRow>
      </CardFoot>

      <Btn style={{ marginTop: 12 }} onClick={() => onFocus(row.bridge)}>
        View transfers
      </Btn>
    </BridgeCard>
  );
};

// ---------------------------------------------------------------------------
// "Where is my transfer?" lookup
//
// The common support question isn't "is the bridge healthy" but "I sent this an
// hour ago, is it stuck?". Relaying costs Ethereum gas, so when the network is
// expensive the relayer deliberately waits — a transfer sitting for hours is
// usually fine, and saying so plainly is the point of this dialog.
// ---------------------------------------------------------------------------

const Overlay = styled.div`
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 8vh 16px 16px;
  background: rgba(4, 12, 24, 0.72);
  overflow-y: auto;
`;

const Dialog = styled.div`
  width: 100%;
  max-width: 620px;
  border: 1px solid ${theme.color.border};
  border-radius: 12px;
  /* Opaque page background, not the translucent card surface — a dialog over an
     overlay has to be solid or the page shows through it. */
  background: ${theme.color.bg};
  padding: 20px;
`;

const DialogTop = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 4px;
`;

const CloseBtn = styled.button`
  border: 1px solid ${theme.color.border};
  border-radius: 6px;
  background: transparent;
  color: ${theme.color.muted};
  font-size: 14px;
  line-height: 1;
  padding: 6px 10px;
  cursor: pointer;
  &:hover {
    color: ${theme.color.text};
    border-color: ${theme.color.text};
  }
`;

const LookupForm = styled.form`
  display: flex;
  gap: 8px;
  margin: 14px 0 4px;
  flex-wrap: wrap;
`;

const ResultCard = styled.div`
  border: 1px solid ${theme.color.border};
  border-radius: 8px;
  padding: 14px;
  margin-top: 12px;
  background: ${theme.color.surface2};
`;

const ResultGrid = styled.div`
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 4px 14px;
  margin-top: 10px;
  font-size: 12px;
`;

const LookupModal: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<ApiBridgeLookup | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const q = value.trim();
      if (!q) return;
      setBusy(true);
      setErr(null);
      setRes(null);
      try {
        setRes(await api.bridgeLookup(q));
      } catch (e2) {
        setErr(e2 instanceof Error ? e2.message : String(e2));
      } finally {
        setBusy(false);
      }
    },
    [value],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <Overlay onClick={onClose}>
      <Dialog onClick={(e) => e.stopPropagation()}>
        <DialogTop>
          <H2 style={{ margin: 0 }}>Check a transfer</H2>
          <CloseBtn type="button" onClick={onClose} aria-label="Close">
            ✕
          </CloseBtn>
        </DialogTop>
        <Muted style={{ margin: 0 }}>Paste a Beam kernel ID or an Ethereum / Arbitrum transaction hash.</Muted>

        <LookupForm onSubmit={submit}>
          <Input
            autoFocus
            value={value}
            placeholder="0x… or a 64-character Beam kernel ID"
            onChange={(e) => setValue(e.target.value)}
            style={{ flex: '1 1 320px' }}
          />
          <Btn type="submit" disabled={busy || value.trim().length === 0}>
            {busy ? 'Checking…' : 'Check'}
          </Btn>
        </LookupForm>

        {err && <ErrorBox>{err}</ErrorBox>}

        {res && res.matches.length === 0 && (
          <WarnBox>
            {res.kind === 'unrecognised'
              ? 'That does not look like a Beam kernel ID or an EVM transaction hash, and nothing matched it.'
              : 'No bridge transfer found for that ID. If you sent it in the last few minutes it may ' +
                'not be indexed yet — the monitor refreshes every few minutes. Otherwise it may not ' +
                'be a bridge transaction.'}
          </WarnBox>
        )}

        {res?.matches.map((m) => (
          <ResultCard key={`${m.bridge}-${m.direction}-${m.msg_id}`}>
            <CardTop style={{ marginBottom: 0 }}>
              <CardTitle>{m.label}</CardTitle>
              <Pill data-tone={statusTone(m.status)}>{statusLabel(m.status)}</Pill>
            </CardTop>
            <Muted style={{ marginTop: 10 }}>{m.explanation}</Muted>
            <ResultGrid>
              <PegStatLabel>Direction</PegStatLabel>
              <PegStatValue>{m.direction === 'beam2eth' ? 'Beam → Ethereum' : 'Ethereum → Beam'}</PegStatValue>
              <PegStatLabel>Amount</PegStatLabel>
              <PegStatValue>{fmtAmount(m.amount)}</PegStatValue>
              <PegStatLabel>Relayer fee</PegStatLabel>
              <PegStatValue>{fmtAmount(m.relayer_fee)}</PegStatValue>
              <PegStatLabel>Message</PegStatLabel>
              <PegStatValue>#{m.msg_id}</PegStatValue>
              <PegStatLabel>Age</PegStatLabel>
              <PegStatValue>{fmtAge(m.src_ts)}</PegStatValue>
              {m.src_height !== null && (
                <>
                  <PegStatLabel>Beam height</PegStatLabel>
                  <PegStatValue>{m.src_height}</PegStatValue>
                </>
              )}
            </ResultGrid>
            <LinkRow style={{ marginTop: 12 }}>
              {m.src_tx && (
                <LinkChip href={etherscanTx(m.src_tx)} target="_blank" rel="noopener noreferrer">
                  Origin tx ↗
                </LinkChip>
              )}
              {m.settle_tx && (
                <LinkChip href={etherscanTx(m.settle_tx)} target="_blank" rel="noopener noreferrer">
                  Settlement tx ↗
                </LinkChip>
              )}
            </LinkRow>
          </ResultCard>
        ))}
      </Dialog>
    </Overlay>
  );
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

const BridgeTracker: React.FC = () => {
  const [health, setHealth] = useState<ApiBridgeHealth | null>(null);
  const [healthErr, setHealthErr] = useState<string | null>(null);

  const [msgs, setMsgs] = useState<ApiBridgeMessages | null>(null);
  const [msgsErr, setMsgsErr] = useState<string | null>(null);
  const [loadingMsgs, setLoadingMsgs] = useState(false);

  const [lookupOpen, setLookupOpen] = useState(false);
  const [fBridge, setFBridge] = useState('');
  const [fDirection, setFDirection] = useState('');
  const [fStatus, setFStatus] = useState('');
  const [offset, setOffset] = useState(0);

  const loadHealth = useCallback(async () => {
    try {
      setHealth(await api.bridgeHealth());
      setHealthErr(null);
    } catch (err) {
      setHealthErr(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const loadMessages = useCallback(async () => {
    setLoadingMsgs(true);
    try {
      const res = await api.bridgeMessages({
        bridge: fBridge || undefined,
        direction: fDirection || undefined,
        status: fStatus || undefined,
        limit: PAGE_SIZE,
        offset,
      });
      setMsgs(res);
      setMsgsErr(null);
    } catch (err) {
      setMsgsErr(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingMsgs(false);
    }
  }, [fBridge, fDirection, fStatus, offset]);

  useEffect(() => {
    void loadHealth();
    const t = setInterval(() => {
      void loadHealth();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [loadHealth]);

  useEffect(() => {
    void loadMessages();
  }, [loadMessages]);

  const totals = useMemo(() => {
    const rows = health?.bridges ?? [];
    return {
      bridges: rows.length,
      unclaimed: rows.reduce((a, r) => a + r.incoming.unclaimed, 0),
      notDelivered: rows.reduce((a, r) => a + r.incoming.not_delivered, 0),
      failed: rows.reduce((a, r) => a + r.outgoing.failed, 0),
      transfers: rows.reduce((a, r) => a + r.incoming.total + r.outgoing.total, 0),
      worstRatio: rows.reduce<number | null>((worst, r) => {
        if (r.collateral_ratio === null) return worst;
        if (worst === null) return r.collateral_ratio;
        return r.collateral_ratio > worst ? r.collateral_ratio : worst;
      }, null),
    };
  }, [health]);

  const focusBridge = useCallback((bridge: string) => {
    setFBridge(bridge);
    setOffset(0);
    const el = document.getElementById('bridge-transfers');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  const resetFilters = useCallback(() => {
    setFBridge('');
    setFDirection('');
    setFStatus('');
    setOffset(0);
  }, []);

  const total = msgs?.total ?? 0;
  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <Page>
      <ExplorerHeader>
        <div>
          <H1>Bridge Tracker</H1>
          <Subtitle>Beam ⇄ Ethereum &amp; Arbitrum Pipe bridges · per-transfer status and collateral backing</Subtitle>
        </div>
        <Btn type="button" onClick={() => setLookupOpen(true)}>
          Check my transfer
        </Btn>
      </ExplorerHeader>

      {lookupOpen && <LookupModal onClose={() => setLookupOpen(false)} />}

      {healthErr && <ErrorBox>Could not load bridge health: {healthErr}</ErrorBox>}

      {health && !health.settlement_available && (
        <WarnBox>
          Beam→Ethereum settlement is <strong>unverified</strong>: the indexer has no Etherscan API key configured.
          Those transfers are shown as outgoing but their arrival on Ethereum cannot be confirmed, so a zero failure
          count here means “not observable”, not “none”. Ethereum→Beam direction is unaffected.
        </WarnBox>
      )}

      <StatGrid>
        <StatCard>
          <Label>Bridge TVL</Label>
          <Value>{fmtUsd(health?.tvl_usd ?? null)}</Value>
          <SubValue>
            collateral locked across {totals.bridges || 0} {totals.bridges === 1 ? 'bridge' : 'bridges'}
            {health && health.tvl_priced < totals.bridges ? ` · ${totals.bridges - health.tvl_priced} unpriced` : ''}
          </SubValue>
        </StatCard>
        <StatCard>
          <Label>Transfers tracked</Label>
          <Value>{totals.transfers.toLocaleString()}</Value>
          <SubValue>both directions, all time</SubValue>
        </StatCard>
        <StatCard>
          <Label>Awaiting claim</Label>
          <Value style={{ color: totals.unclaimed > 0 ? theme.color.info : undefined }}>{totals.unclaimed}</Value>
          <SubValue>delivered, not yet collected</SubValue>
        </StatCard>
        <StatCard>
          <Label>Not delivered</Label>
          <Value style={{ color: totals.notDelivered > 0 ? theme.color.warn : undefined }}>{totals.notDelivered}</Value>
          <SubValue>never relayed to Beam</SubValue>
        </StatCard>
      </StatGrid>

      <Card>
        <H2>Bridges</H2>
        <Muted>
          Each bridge mints a wrapped asset on one chain against collateral locked on the other. The bar shows how much
          of the locked collateral has been issued — full and green means every minted unit is backed.
        </Muted>
        {!health && !healthErr && <Muted>Loading…</Muted>}
        <BridgeGrid>
          {(health?.bridges ?? []).map((row) => (
            <BridgeSummaryCard
              key={row.bridge}
              row={row}
              settlementAvailable={health?.settlement_available ?? false}
              onFocus={focusBridge}
            />
          ))}
        </BridgeGrid>
      </Card>

      <Card id="bridge-transfers">
        <H2>Transfers</H2>
        <Filters>
          <Select
            value={fBridge}
            onChange={(e) => {
              setFBridge(e.target.value);
              setOffset(0);
            }}
          >
            <option value="">All bridges</option>
            {(health?.bridges ?? []).map((b) => (
              <option key={b.bridge} value={b.bridge}>
                {b.label}
              </option>
            ))}
          </Select>
          <Select
            value={fDirection}
            onChange={(e) => {
              setFDirection(e.target.value);
              setFStatus('');
              setOffset(0);
            }}
          >
            <option value="">Both directions</option>
            <option value="beam2eth">Beam → Ethereum</option>
            <option value="eth2beam">Ethereum → Beam</option>
          </Select>
          <Select
            value={fStatus}
            onChange={(e) => {
              setFStatus(e.target.value);
              setOffset(0);
            }}
          >
            <option value="">Any status</option>
            {fDirection !== 'eth2beam' && (
              <>
                <option value="pending">in flight</option>
                <option value="relayed">relayed</option>
                <option value="failed">failed</option>
              </>
            )}
            {fDirection !== 'beam2eth' && (
              <>
                <option value="not_delivered">not delivered</option>
                <option value="unclaimed">awaiting claim</option>
                <option value="complete">complete</option>
              </>
            )}
            <option value="unknown">unknown</option>
          </Select>
          <Btn onClick={resetFilters}>Reset</Btn>
          <Muted style={{ margin: 0 }}>{loadingMsgs ? 'loading…' : `${total.toLocaleString()} matching`}</Muted>
        </Filters>

        {msgsErr && <ErrorBox>Could not load transfers: {msgsErr}</ErrorBox>}

        <ScrollX>
          <DataTable>
            <thead>
              <tr>
                <th>Bridge</th>
                <th>Direction</th>
                <th>#</th>
                <th>Status</th>
                <th style={{ textAlign: 'right' }}>Amount</th>
                <th style={{ textAlign: 'right' }}>Relayer fee</th>
                <th>Recipient</th>
                <th>Age</th>
                <th>Reference</th>
              </tr>
            </thead>
            <tbody>
              {(msgs?.messages ?? []).map((m: ApiBridgeMessage) => (
                <tr key={`${m.bridge}-${m.direction}-${m.msg_id}`}>
                  <td>{health?.bridges.find((b) => b.bridge === m.bridge)?.label ?? m.bridge}</td>
                  <td>{m.direction === 'beam2eth' ? 'Beam → ETH' : 'ETH → Beam'}</td>
                  <td>
                    <Mono>{m.msg_id}</Mono>
                  </td>
                  <td>
                    <Pill data-tone={statusTone(m.status)}>{statusLabel(m.status)}</Pill>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <Mono>{fmtAmount(m.amount)}</Mono>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <Mono>{fmtAmount(m.relayer_fee)}</Mono>
                  </td>
                  <td>
                    <Mono>{shortHex(m.receiver)}</Mono>
                  </td>
                  <td>{fmtAge(m.src_ts)}</td>
                  <td>
                    {m.settle_tx ? (
                      <ExtLink href={etherscanTx(m.settle_tx)}>settled</ExtLink>
                    ) : m.src_tx ? (
                      <ExtLink href={etherscanTx(m.src_tx)}>origin</ExtLink>
                    ) : m.src_height ? (
                      <Mono>h {m.src_height}</Mono>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              ))}
              {!loadingMsgs && (msgs?.messages.length ?? 0) === 0 && (
                <tr>
                  <td colSpan={9}>
                    <Muted style={{ margin: '12px 0' }}>No transfers match these filters.</Muted>
                  </td>
                </tr>
              )}
            </tbody>
          </DataTable>
        </ScrollX>

        <Pager>
          <Btn disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
            Previous
          </Btn>
          <span>
            page {page} of {pages}
          </span>
          <Btn disabled={offset + PAGE_SIZE >= total} onClick={() => setOffset(offset + PAGE_SIZE)}>
            Next
          </Btn>
        </Pager>
      </Card>

      <Card>
        <H2>How to read this</H2>
        <Muted style={{ maxWidth: 720 }}>
          <strong>Ethereum → Beam</strong> takes two steps: a relayer delivers the message to Beam, then the recipient
          claims it. <em>Not delivered</em> means the first step never happened. <em>Awaiting claim</em> means it did,
          and the funds are on Beam waiting for their owner — safe, but uncollected.
          <br />
          <br />
          <strong>Beam → Ethereum</strong> is settled by a single relayer transaction.
        </Muted>
      </Card>
    </Page>
  );
};

// app.tsx lazy-imports the named export; the default keeps direct imports working.
export { BridgeTracker };
export default BridgeTracker;
