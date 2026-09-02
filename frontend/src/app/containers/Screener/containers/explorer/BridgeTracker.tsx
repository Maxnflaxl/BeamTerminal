import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { styled } from '@linaria/react';
import { api } from '@app/containers/Screener/api/client';
import { usePolled } from '@app/containers/Screener/hooks';
import { fmt$ } from '@app/containers/Screener/components/format';
import { Overlay, Card as ModalCard, CloseBtn, useEscapeClose } from '@app/containers/Screener/components/modalChrome';
import type {
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
import { fmtRelative } from './shared';

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
  margin-bottom: 12px;
  & > * + * {
    margin-left: 10px;
  }
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
  top: 0;
  bottom: 0;
  left: 0;
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
  flex-wrap: wrap;
  /* auto, not a fixed margin: absorbs the difference in chip-row height so the
     footer and the button below it line up across the row. */
  margin-top: auto;
  padding-top: 10px;
  border-top: 1px solid ${theme.color.borderDim};
  font-size: 11px;
  color: ${theme.color.muted};
  & > * + * {
    margin-left: 8px;
  }
`;

const LinkRow = styled.div`
  display: flex;
  & > * + * {
    margin-left: 6px;
  }
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

// Same affordance as LinkChip but for in-app navigation. The asset page is ours
// (route /asset/:id), so this must not leave the site — and it can't be an
// absolute URL either: the same bundle runs inside the BEAM wallet as a .dapp,
// where beamterminal.0xmx.net isn't where it lives.
const NavChip = styled.button`
  display: inline-block;
  padding: 3px 8px;
  border: 1px solid ${theme.color.border};
  border-radius: 5px;
  background: transparent;
  font-family: ${theme.font.mono};
  font-size: 11px;
  line-height: 1.3;
  color: ${theme.color.textDim};
  white-space: nowrap;
  cursor: pointer;
  transition: color 0.12s ease, border-color 0.12s ease, background 0.12s ease;

  &:hover,
  &:focus-visible {
    color: ${theme.color.accent};
    border-color: ${theme.color.accent};
    background: rgba(0, 246, 210, 0.08);
  }
`;

// Wrapping rows space their children with per-child margins and pull the
// container in by the same amount, so the outer edges stay flush.
const Chips = styled.div`
  display: flex;
  flex-wrap: wrap;
  /* The footer's separator is positioned with margin-top:auto, which collapses
     to zero on a card whose content already fills the column — leaving the rule
     flush against these chips. The spacing has to live here, where nothing can
     collapse it. Kept tight: the rule is a divider, not a section break.
     Resolves to 12px above and 10px below once the child margins are added. */
  margin: 9px -3px 7px;
  & > * {
    margin: 3px;
  }
`;

const Filters = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  margin: 7px -5px;
  & > * {
    margin: 5px;
  }
`;

// Sorting is server-side (the table is paginated), so a header click refetches
// rather than reordering what's on screen.
const SortTh = styled.th`
  cursor: pointer;
  user-select: none;
  white-space: nowrap;

  &:hover {
    color: ${theme.color.text};
  }
`;

const SortMark = styled.span`
  margin-left: 4px;
  color: ${theme.color.accent};
`;

const RefCell = styled.div`
  display: flex;
  flex-wrap: wrap;
  margin: -3px;
  & > * {
    margin: 3px;
  }
`;

const Mono = styled.span`
  font-family: ${theme.font.mono};

  /* An underflowed amount is a real figure but not a transfer: a number in a
     warning colour, not a pill. */
  &[data-tone='warn'] {
    color: ${theme.color.warn};
  }
`;

const Pager = styled.div`
  display: flex;
  align-items: center;
  justify-content: flex-end;
  margin-top: 12px;
  font-size: 12px;
  color: ${theme.color.muted};
  & > * + * {
    margin-left: 8px;
  }
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
  // Pinned to en-US like every other explorer surface: the browser locale would
  // otherwise render 605.47245 as "605,47245", which reads as a thousands
  // separator against the grouped figures sitting next to it in the column.
  return n.toLocaleString('en-US', { maximumFractionDigits: maxFrac });
}

// Underflowed amounts arrive unwrapped (negative) and are worth printing: that
// is how far the fee overshot. An overflow's figure means nothing — wrapping the
// total was the point — so it gets a label instead.
function malformedNote(kind: 'overflow' | 'underflow'): string {
  const lines =
    kind === 'underflow'
      ? [
          'The relayer fee exceeded the amount it was subtracted from, and the unsigned result',
          'wrapped past 2^64. Shown is how far the fee overshot. Nothing of value crossed.',
        ]
      : [
          'An attempt on the bridge, not a transfer: the Ethereum Pipe adds amount and relayer fee',
          'without an overflow check, so a large enough pair wraps the total down to almost nothing.',
          'The relayer refuses these.',
        ];
  return lines.join(' ');
}

// Bridges span more than one EVM chain, so neither the filter nor the table can
// say "Ethereum" unconditionally.
function chainName(chainId: number | undefined): string {
  if (chainId === 42161) return 'Arbitrum';
  if (chainId === 1) return 'Ethereum';
  return 'EVM';
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
    // Warn, not purple: purple is the pending/in-flight tone, and these three
    // are exactly the states that will never become in-flight.
    case 'not_delivered':
    case 'skipped':
    case 'unsettleable':
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
    case 'unsettleable':
      return 'cannot settle';
    case 'skipped':
      return 'passed over';
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

// Arbitrum transactions live on Arbiscan; sending them to Etherscan just adds a
// hop for the reader.
function evmExplorer(chainId: number | undefined): string {
  return chainId === 42161 ? 'https://arbiscan.io' : 'https://etherscan.io';
}

function evmAddrUrl(addr: string, chainId?: number): string {
  return `${evmExplorer(chainId)}/address/${addr}`;
}

function evmTxUrl(hash: string, chainId?: number): string {
  return `${evmExplorer(chainId)}/tx/${hash}`;
}

// Beam block, for the height an outgoing message's call landed in.
/** Tooltip for a Beam-side step: when it happened, and how long after the
 *  step before it. The elapsed part is the interesting half — it's the relayer's
 *  latency for a delivery, and the recipient's for a claim. */
function beamStepTitle(what: string, height: number, ts: string | null, since: string | null): string {
  const parts = [`${what} in block ${height}`];
  if (ts) parts.push(new Date(ts).toLocaleString('en-US'));
  const a = ts ? Date.parse(ts) : NaN;
  const b = since ? Date.parse(since) : NaN;
  if (!Number.isNaN(a) && !Number.isNaN(b) && a > b) {
    parts.push(`${fmtDuration((a - b) / 1000)} later`);
  }
  return parts.join(' · ');
}

function fmtDuration(secs: number): string {
  if (secs < 60) return `${Math.round(secs)}s`;
  if (secs < 3600) return `${Math.round(secs / 60)}m`;
  if (secs < 86400) return `${(secs / 3600).toFixed(1)}h`;
  return `${(secs / 86400).toFixed(1)}d`;
}

function beamBlockUrl(height: number): string {
  return `https://explorer.0xmx.net/?network=mainnet&type=block&height=${height}`;
}

// ---------------------------------------------------------------------------
// Per-bridge card
// ---------------------------------------------------------------------------

const BridgeSummaryCard: React.FC<{
  row: ApiBridgeHealthRow;
  settlementAvailable: boolean;
  onFocus: (bridge: string) => void;
}> = ({ row, settlementAvailable, onFocus }) => {
  const navigate = useNavigate();
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
        {row.outgoing.skipped > 0 && (
          <Pill
            data-tone="warn"
            title={
              'Outgoing messages the relayer has moved past — later ones on this bridge have ' +
              'already settled. It retries three times, so these will not be picked up again.'
            }
          >
            {row.outgoing.skipped} {statusLabel('skipped')}
          </Pill>
        )}
        {/* Same count and wording as the table's status, so the card and the
            rows below it can't tell different stories. */}
        {row.outgoing.unsettleable > 0 && (
          <Pill
            data-tone="warn"
            title={
              'Outgoing messages whose amount is larger than everything this bridge holds, so they ' +
              'can never settle. The collateral itself is unaffected — see the backing bar above.'
            }
          >
            {row.outgoing.unsettleable} {statusLabel('unsettleable')}
          </Pill>
        )}
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
        <span>last activity {fmtRelative(row.last_message_ts)}</span>
        <LinkRow>
          <LinkChip
            href={evmAddrUrl(row.eth_pipe, row.chain_id)}
            target="_blank"
            rel="noopener noreferrer"
            title={`Pipe contract ${row.eth_pipe} on Etherscan`}
          >
            Pipe ↗
          </LinkChip>
          <NavChip type="button" onClick={() => navigate(`/asset/${row.aid}`)} title={`Open asset ${row.aid}`}>
            {row.asset_symbol ?? `Asset ${row.aid}`}
          </NavChip>
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

// Wider than the shared modal card: lookup results carry a two-column grid
// plus a row of reference links.
const Dialog = styled(ModalCard)`
  max-width: 620px;
  border-color: ${theme.color.border};
  /* Opaque page background, not the translucent card surface — a dialog over an
     overlay has to be solid or the page shows through it. */
  background: ${theme.color.bg};
  padding: 20px;
`;

const DialogTop = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 4px;
  & > * + * {
    margin-left: 12px;
  }
`;

const LookupForm = styled.form`
  display: flex;
  flex-wrap: wrap;
  margin: 10px -4px 0;
  & > * {
    margin: 4px;
  }
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

  useEscapeClose(onClose);

  return (
    <Overlay z={60} backdrop="rgba(4, 12, 24, 0.72)" onClick={onClose}>
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
            placeholder="0x…, a Beam kernel ID, or a block height"
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
              <PegStatValue>
                {m.malformed === 'overflow' ? <Pill data-tone="danger">overflow</Pill> : fmtAmount(m.amount)}
              </PegStatValue>
              <PegStatLabel>Relayer fee</PegStatLabel>
              <PegStatValue>{fmtAmount(m.relayer_fee)}</PegStatValue>
              <PegStatLabel>Message</PegStatLabel>
              <PegStatValue>#{m.msg_id}</PegStatValue>
              <PegStatLabel>Age</PegStatLabel>
              <PegStatValue>{fmtRelative(m.src_ts)}</PegStatValue>
              {(m.src_call_height ?? m.src_height) !== null && (
                <>
                  <PegStatLabel>Beam block</PegStatLabel>
                  <PegStatValue>{m.src_call_height ?? m.src_height}</PegStatValue>
                </>
              )}
              {m.delivered_height !== null && (
                <>
                  <PegStatLabel>Delivered</PegStatLabel>
                  <PegStatValue>
                    {`block ${m.delivered_height}`}
                    {m.delivered_ts ? ` · ${fmtRelative(m.delivered_ts)}` : ''}
                  </PegStatValue>
                </>
              )}
              {m.claimed_height !== null && (
                <>
                  <PegStatLabel>Claimed</PegStatLabel>
                  <PegStatValue>
                    {`block ${m.claimed_height}`}
                    {m.claimed_ts ? ` · ${fmtRelative(m.claimed_ts)}` : ''}
                  </PegStatValue>
                </>
              )}
            </ResultGrid>
            <LinkRow style={{ marginTop: 12 }}>
              {m.src_tx && (
                <LinkChip href={evmTxUrl(m.src_tx)} target="_blank" rel="noopener noreferrer">
                  Origin tx ↗
                </LinkChip>
              )}
              {m.settle_tx && (
                <LinkChip href={evmTxUrl(m.settle_tx)} target="_blank" rel="noopener noreferrer">
                  Settlement tx ↗
                </LinkChip>
              )}
              {!m.src_tx && (m.src_call_height ?? m.src_height) !== null && (
                <LinkChip
                  href={beamBlockUrl((m.src_call_height ?? m.src_height) as number)}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Beam block ↗
                </LinkChip>
              )}
              {m.delivered_height !== null && (
                <LinkChip href={beamBlockUrl(m.delivered_height)} target="_blank" rel="noopener noreferrer">
                  Delivery block ↗
                </LinkChip>
              )}
              {m.claimed_height !== null && (
                <LinkChip href={beamBlockUrl(m.claimed_height)} target="_blank" rel="noopener noreferrer">
                  Claim block ↗
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
  const { data: health, error: healthErr } = usePolled(() => api.bridgeHealth(), [], POLL_MS);

  const [msgs, setMsgs] = useState<ApiBridgeMessages | null>(null);
  const [msgsErr, setMsgsErr] = useState<string | null>(null);
  const [loadingMsgs, setLoadingMsgs] = useState(false);

  const [lookupOpen, setLookupOpen] = useState(false);
  const [fBridge, setFBridge] = useState('');
  const [fDirection, setFDirection] = useState('');
  const [fStatus, setFStatus] = useState('');
  const [sort, setSort] = useState('age');
  const [dir, setDir] = useState<'asc' | 'desc'>('desc');
  const [offset, setOffset] = useState(0);

  const loadMessages = useCallback(async () => {
    setLoadingMsgs(true);
    try {
      const res = await api.bridgeMessages({
        bridge: fBridge || undefined,
        direction: fDirection || undefined,
        status: fStatus || undefined,
        sort,
        dir,
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
  }, [fBridge, fDirection, fStatus, sort, dir, offset]);

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

  // "View transfers" means "show me everything for this bridge", so it clears
  // the other filters rather than inheriting them. Leaving a stale status filter
  // in place made the table look empty (or wrongly narrow) for the bridge just
  // clicked, with the reason sitting in a dropdown well above the fold.
  const focusBridge = useCallback((bridge: string) => {
    setFBridge(bridge);
    setFDirection('');
    setFStatus('');
    setSort('age');
    setDir('desc');
    setOffset(0);
    const el = document.getElementById('bridge-transfers');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  // First click on a new column sorts descending — for age that's newest first,
  // which is what anyone scanning a transfer list wants; a second click flips it.
  const toggleSort = useCallback(
    (key: string) => {
      setOffset(0);
      if (sort === key) {
        setDir((d) => (d === 'desc' ? 'asc' : 'desc'));
      } else {
        setSort(key);
        setDir('desc');
      }
    },
    [sort],
  );

  const resetFilters = useCallback(() => {
    setFBridge('');
    setFDirection('');
    setFStatus('');
    setSort('age');
    setDir('desc');
    setOffset(0);
  }, []);

  // With a bridge selected the filter can name its chain exactly; without one it
  // has to cover both rather than claiming Ethereum.
  const filterChain = fBridge
    ? chainName(health?.bridges.find((b) => b.bridge === fBridge)?.chain_id)
    : 'Ethereum / Arbitrum';

  const mark = (key: string): React.ReactNode =>
    sort === key ? <SortMark>{dir === 'desc' ? '▾' : '▴'}</SortMark> : null;

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
          <Value>{fmt$(health?.tvl_usd)}</Value>
          <SubValue>
            collateral locked across {totals.bridges || 0} {totals.bridges === 1 ? 'bridge' : 'bridges'}
            {health && health.tvl_priced < totals.bridges ? ` · ${totals.bridges - health.tvl_priced} unpriced` : ''}
          </SubValue>
        </StatCard>
        <StatCard>
          <Label>Transfers tracked</Label>
          <Value>{totals.transfers.toLocaleString('en-US')}</Value>
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
            <option value="beam2eth">Beam → {filterChain}</option>
            <option value="eth2beam">{filterChain} → Beam</option>
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
          <Muted style={{ margin: 0 }}>{loadingMsgs ? 'loading…' : `${total.toLocaleString('en-US')} matching`}</Muted>
        </Filters>

        {msgsErr && <ErrorBox>Could not load transfers: {msgsErr}</ErrorBox>}

        <ScrollX>
          <DataTable>
            <thead>
              <tr>
                <SortTh onClick={() => toggleSort('bridge')}>Bridge{mark('bridge')}</SortTh>
                <SortTh onClick={() => toggleSort('direction')}>Direction{mark('direction')}</SortTh>
                <SortTh onClick={() => toggleSort('msg_id')}>#{mark('msg_id')}</SortTh>
                <SortTh onClick={() => toggleSort('status')}>Status{mark('status')}</SortTh>
                <SortTh style={{ textAlign: 'right' }} onClick={() => toggleSort('amount')}>
                  Amount{mark('amount')}
                </SortTh>
                <SortTh style={{ textAlign: 'right' }} onClick={() => toggleSort('fee')}>
                  Relayer fee{mark('fee')}
                </SortTh>
                <th>Recipient</th>
                <SortTh onClick={() => toggleSort('age')}>Age{mark('age')}</SortTh>
                <th>Reference</th>
              </tr>
            </thead>
            <tbody>
              {(msgs?.messages ?? []).map((m: ApiBridgeMessage) => (
                <tr key={`${m.bridge}-${m.direction}-${m.msg_id}`}>
                  <td>{health?.bridges.find((b) => b.bridge === m.bridge)?.label ?? m.bridge}</td>
                  <td>
                    {(() => {
                      const c = chainName(health?.bridges.find((b) => b.bridge === m.bridge)?.chain_id);
                      return m.direction === 'beam2eth' ? `Beam → ${c}` : `${c} → Beam`;
                    })()}
                  </td>
                  <td>
                    <Mono>{m.msg_id}</Mono>
                  </td>
                  <td>
                    <Pill data-tone={statusTone(m.status)}>{statusLabel(m.status)}</Pill>
                  </td>
                  <td style={{ textAlign: 'right' }} title={m.malformed ? malformedNote(m.malformed) : undefined}>
                    {m.malformed === 'overflow' ? (
                      <Pill data-tone="danger">overflow</Pill>
                    ) : (
                      <Mono data-tone={m.malformed ? 'warn' : undefined}>{fmtAmount(m.amount)}</Mono>
                    )}
                  </td>
                  <td style={{ textAlign: 'right' }} title={m.malformed ? malformedNote(m.malformed) : undefined}>
                    <Mono>{fmtAmount(m.relayer_fee)}</Mono>
                  </td>
                  <td>
                    <Mono>{shortHex(m.receiver)}</Mono>
                  </td>
                  <td>{fmtRelative(m.src_ts)}</td>
                  <td>
                    {(() => {
                      const chainId = health?.bridges.find((b) => b.bridge === m.bridge)?.chain_id;
                      // Outgoing messages have no tx hash on the Beam side — the
                      // Pipe records only a height — so the block is the only
                      // reference, and it doubles as a lookup key.
                      const h = m.src_call_height ?? m.src_height;
                      return (
                        <RefCell>
                          {m.settle_tx && (
                            <LinkChip href={evmTxUrl(m.settle_tx, chainId)} target="_blank" rel="noopener noreferrer">
                              settled ↗
                            </LinkChip>
                          )}
                          {m.src_tx && (
                            <LinkChip href={evmTxUrl(m.src_tx, chainId)} target="_blank" rel="noopener noreferrer">
                              origin ↗
                            </LinkChip>
                          )}
                          {!m.src_tx && h !== null && (
                            <LinkChip
                              href={beamBlockUrl(h)}
                              target="_blank"
                              rel="noopener noreferrer"
                              title={`Beam block ${h} — paste this height into “Check my transfer”`}
                            >
                              block {h} ↗
                            </LinkChip>
                          )}
                          {m.delivered_height !== null && (
                            <LinkChip
                              href={beamBlockUrl(m.delivered_height)}
                              target="_blank"
                              rel="noopener noreferrer"
                              title={beamStepTitle('Delivered to Beam', m.delivered_height, m.delivered_ts, m.src_ts)}
                            >
                              delivered {m.delivered_height} ↗
                            </LinkChip>
                          )}
                          {m.claimed_height !== null && (
                            <LinkChip
                              href={beamBlockUrl(m.claimed_height)}
                              target="_blank"
                              rel="noopener noreferrer"
                              title={beamStepTitle('Claimed on Beam', m.claimed_height, m.claimed_ts, m.delivered_ts)}
                            >
                              claimed {m.claimed_height} ↗
                            </LinkChip>
                          )}
                          {!m.settle_tx && !m.src_tx && h === null && '—'}
                        </RefCell>
                      );
                    })()}
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
