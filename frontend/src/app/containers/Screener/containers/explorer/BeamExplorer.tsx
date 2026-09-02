import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { createPortal } from 'react-dom';
import { styled } from '@linaria/react';
import {
  Page,
  Card,
  ExplorerHeader,
  H1,
  H2,
  H3,
  Btn,
  Input,
  Select,
  Pill,
  DataTable,
  ScrollX,
  ErrorBox,
  Row,
  theme,
} from './shared';
import { specialBlocks } from './supplyMath';
import { CenteredNote } from '../../components/CenteredNote';
import { useBlockTimestamp, type BlockUrlResolver } from '../../../../shared/components/BlockHeight';
import { useComparePoints } from '../../components/chart-compare/useComparePoints';
import type { UseComparePoints } from '../../components/chart-compare/useComparePoints';
import { computeDeltas } from '../../components/chart-compare/computeDeltas';
import { DeltaPanel } from '../../components/chart-compare/DeltaPanel';
import { ChartModal } from '../../components/chart-compare/ChartModal';
import type { SeriesDescriptor, ResolvedPoint } from '../../components/chart-compare/types';
import { downloadBlob, downloadSvgAsPng } from '../../components/chart-compare/download';
import { Overlay, CloseBtn, useEscapeClose } from '../../components/modalChrome';
import { compact } from '../../components/format';
import { buildHdrsCsv, buildHdrsSvg } from './hdrs-chart/hdrsExport';
import type { HdrsExportRow, HdrsSvgModel } from './hdrs-chart/hdrsExport';

// ---------------------------------------------------------------------------
// Explorer node config
// ---------------------------------------------------------------------------

interface NetworkConfig {
  type: 'PoW' | 'PoS';
  description: string;
  url: string[];
}

const explorerNodes: Record<string, NetworkConfig> = {
  mainnet: {
    type: 'PoW',
    description: 'PoW, ~1-min blocks',
    url: [
      'https://explorer.0xmx.net/api/mainnet/',
      'https://BeamSmart.net:8000/',
      'https://explorer-api.beamprivacy.community/',
    ],
  },
  dappnet: {
    type: 'PoW',
    description: 'FakePoW, ~15-sec blocks',
    url: ['https://BeamSmart.net:8001/'],
  },
  dappnet2: {
    type: 'PoS',
    description: 'PoS, ~15-sec blocks',
    url: ['https://explorer.0xmx.net/api/dappnet2/', 'https://BeamSmart.net:8002/'],
  },
  warp_dev3: {
    type: 'PoS',
    description: 'PoS, ~15-sec blocks',
    url: ['https://explorer.0xmx.net/api/warp_dev3/'],
  },
};

// Version of the explorer front end, tracking the upstream standalone
// BeamExplorer.htm (github.com/BeamMW/beam/tree/master/explorer/htm) that this
// page mirrors. Clicking the badge opens the release notes below.
const EXPLORER_VERSION = 'v0.9';

const WHATS_NEW: { version: string; items: string[] }[] = [
  {
    version: 'v0.9',
    items: [
      'Rename status figures to Treasury Emission, Current Supply and Total Supply.',
      'Add this "What\'s new" popup!',
    ],
  },
  {
    version: 'v0.8.4',
    items: [
      'Ignore spaces, dots and commas in search.',
      'Add collapsibles to Inputs/Outputs/Kernels.',
      'Update list of explorer nodes.',
      'Add hard fork 6 to historical blocks.',
      'Add id:0 to CA ranges of post-HF6 UTXOs.',
    ],
  },
  {
    version: 'v0.8.3',
    items: [
      'Add Peer nodes list.',
      'Add Atomic Swap list.',
      'Propose multiple options for the X axis of graphs.',
      'Display all graph values directly on the graph axis.',
      'Make timestamps human-readable.',
      'Use ms in timestamps for PoS chains.',
      'Adjust columns names for PoS chains.',
    ],
  },
];

// The explorer node still reports the pre-v0.9 wording for these status rows;
// the front end shows the newer, clearer names.
const TH_LABEL_OVERRIDES: Record<string, string> = {
  'Treasury Released': 'Treasury Emission',
  'Current Circulation': 'Current Supply',
  'Total Circulation': 'Total Supply',
};

// ---------------------------------------------------------------------------
// View / route state
// ---------------------------------------------------------------------------

type ViewType =
  | 'status'
  | 'block'
  | 'treasury'
  | 'asset'
  | 'assets'
  | 'contract'
  | 'contracts'
  | 'hdrs'
  | 'peers'
  | 'historical';

interface ViewState {
  network: string;
  type: ViewType;
  id?: string;
  height?: string;
  kernel?: string;
  hMin?: string;
  hMax?: string;
  nMax?: string;
  nMaxOps?: string;
  nMaxTxs?: string;
  cols?: string;
  dh?: string;
  adj?: string;
  /** Client-side filter term for the Assets table's Owner column (used to
   *  deep-link "show every asset owned by this wallet/contract"). */
  q?: string;
  /** Which chart section on this view is open ('hdrs' — the block-headers
   *  plot). The height range it covers already rides in `hMin` / `hMax` /
   *  `nMax` / `dh`. */
  chart?: string;
  /** '1' while that chart is opened in the expanded modal. */
  expand?: string;
  /** Comma-separated column codes plotted as series in that chart. Without it
   *  a link to an expanded chart opens on "No series selected". */
  plot?: string;
}

// View state is mirrored into the URL query string (e.g.
// `?network=mainnet&type=contract&id=<cid>`), matching the original
// BeamExplorer.htm scheme so any contract/asset/block view is a shareable link.
const VIEW_TYPES: ReadonlySet<string> = new Set<ViewType>([
  'status',
  'block',
  'treasury',
  'asset',
  'assets',
  'contract',
  'contracts',
  'hdrs',
  'peers',
  'historical',
]);

// Optional string fields carried in the URL alongside `network`/`type`.
const VIEW_PARAM_KEYS = [
  'id',
  'height',
  'kernel',
  'hMin',
  'hMax',
  'nMax',
  'nMaxOps',
  'nMaxTxs',
  'cols',
  'dh',
  'adj',
  'q',
  'chart',
  'expand',
  'plot',
] as const;

function parseView(sp: URLSearchParams): ViewState {
  const rawType = sp.get('type') ?? '';
  const type = (VIEW_TYPES.has(rawType) ? rawType : 'status') as ViewType;
  const view: ViewState = { network: sp.get('network') || 'mainnet', type };
  for (const k of VIEW_PARAM_KEYS) {
    const v = sp.get(k);
    if (v !== null) view[k] = v;
  }
  return view;
}

function serializeView(v: ViewState): Record<string, string> {
  const out: Record<string, string> = { network: v.network, type: v.type };
  for (const k of VIEW_PARAM_KEYS) {
    const val = v[k];
    if (val !== undefined && val !== '') out[k] = String(val);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Column header metadata (block headers grid)
// ---------------------------------------------------------------------------

interface ColumnMeta {
  color: string | null;
  original: string;
  title: string;
  description: string;
}

const COLUMN_DEFAULT_DISPLAY = 'THdfkioyzp';

const columnHeaders: Record<string, ColumnMeta> = {
  h: {
    color: '#000000',
    original: 'Height',
    title: 'Height',
    description: 'Block height',
  },
  H: {
    color: null,
    original: 'Hash',
    title: 'Hash',
    description: 'Block hash',
  },
  N: {
    color: '#606060',
    original: 'Number',
    title: 'Number',
    description: 'Block number',
  },
  T: {
    color: '#808080',
    original: 'Timestamp',
    title: 'Timestamp',
    description: 'Block timestamp',
  },
  g: {
    color: '#bf3c3c',
    original: 'd.Age',
    title: 'Duration',
    description: 'Block duration (seconds)',
  },
  G: {
    color: '#d67a7a',
    original: 'Age',
    title: 'Age',
    description: 'Block age since genesis (seconds)',
  },
  d: {
    color: '#008484',
    original: 'Difficulty',
    title: 'Difficulty',
    description: 'Block difficulty',
  },
  D: {
    color: '#00bdbd',
    original: 'Chainwork',
    title: 'Chainwork',
    description: 'Total difficulty since genesis',
  },
  f: {
    color: '#7b00b0',
    original: 'Fee',
    title: 'Fees',
    description: 'Block fees (Beam)',
  },
  F: {
    color: '#8660d7',
    original: 'T.Fee',
    title: 'Total fees',
    description: 'Total fees since genesis',
  },
  k: {
    color: '#ff0080',
    original: 'Txs',
    title: 'Txs',
    description: 'Number of kernels in the block',
  },
  K: {
    color: '#ff79bc',
    original: 'T.Txs',
    title: 'Total txs',
    description: 'Total kernels since genesis',
  },
  i: {
    color: '#006400',
    original: 'MW.Inputs',
    title: 'MW in',
    description: 'Mimblewimble inputs in the block',
  },
  I: {
    color: '#00bb00',
    original: 'T.MW.Inputs',
    title: 'Total MW in',
    description: 'Total MW inputs since genesis',
  },
  o: {
    color: '#ff0006',
    original: 'MW.Outputs',
    title: 'MW out',
    description: 'Mimblewimble outputs in the block',
  },
  O: {
    color: '#ff5e5e',
    original: 'T.MW.Outputs',
    title: 'Total MW out',
    description: 'Total MW outputs since genesis',
  },
  u: {
    color: '#808000',
    original: 'MW.Utxos',
    title: 'MW UTXOs',
    description: 'Change in MW UTXO count',
  },
  U: {
    color: '#bdb76b',
    original: 'T.MW.Utxos',
    title: 'Total MW UTXOs',
    description: 'Total unspent MW UTXOs',
  },
  y: {
    color: '#0000e3',
    original: 'SH.Inputs',
    title: 'SH in',
    description: 'Lelantus Shielded Pool inputs',
  },
  Y: {
    color: '#4f4fff',
    original: 'T.SH.Inputs',
    title: 'Total SH in',
    description: 'Total Shielded inputs',
  },
  z: {
    color: '#804040',
    original: 'SH.Outputs',
    title: 'SH out',
    description: 'Shielded Pool outputs',
  },
  Z: {
    color: '#b87272',
    original: 'T.SH.Outputs',
    title: 'Total SH out',
    description: 'Total Shielded outputs',
  },
  b: {
    color: '#5a3362',
    original: 'Contracts',
    title: 'New contracts',
    description: 'Smart contracts deployed in the block',
  },
  B: {
    color: '#a66ab3',
    original: 'T.Contracts',
    title: 'Total contracts',
    description: 'Total contracts since genesis',
  },
  p: {
    color: '#ce00ce',
    original: 'ContractCalls',
    title: 'Contract calls',
    description: 'Smart contract calls in the block',
  },
  P: {
    color: '#ff53ff',
    original: 'T.ContractCalls',
    title: 'Total contract calls',
    description: 'Total contract calls since genesis',
  },
  c: {
    color: '#004080',
    original: 'D.Size.Compressed',
    title: 'Size variation',
    description: 'Blockchain size change (bytes)',
  },
  C: {
    color: '#6d92c2',
    original: 'Size.Compressed',
    title: 'Total size',
    description: 'Total blockchain size',
  },
  a: {
    color: '#009d27',
    original: 'D.Size.Archive',
    title: 'Archive size',
    description: 'Block archive size (bytes)',
  },
  A: {
    color: '#00d535',
    original: 'Size.Archive',
    title: 'Total archive size',
    description: 'Total archive size',
  },
};

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function readNetworkType(network: string): 'PoW' | 'PoS' {
  return explorerNodes[network]?.type ?? 'PoW';
}

function getNodeUrl(network: string): string {
  return explorerNodes[network]?.url[0] ?? explorerNodes.mainnet.url[0];
}

// The explorer caps every /hdrs request at 2048 rows
// (`std::setmin(nMax, 2048u)` in beam/explorer/adapter.cpp::get_hdrs). To show
// more than that we chain requests client-side (see fetchHdrsPaginated).
// HDRS_MAX_PAGES backstops a runaway chain: ~45k rows is about as much as the
// table can render before the tab gets unhappy, which is also the 1-month cap.
const HDRS_MAX_PER_REQUEST = 2048;
// Cap on rows RENDERED at once: a timeframe query can fetch ~43k rows, and a
// single <table> that size freezes the tab (worst in the wallet renderer).
// The chart and CSV export consume the full fetched set regardless.
const HDRS_RENDER_CAP = 2048;
const HDRS_MAX_PAGES = 22;

// BEAM targets ~60s blocks, so 1 row/min at dh=1 (matches the DH_PRESETS below).
const BLOCKS_PER_DAY = 1440;
// Cap any timeframe at one month — larger spans at dh=1 are too many rows to
// render and crash the tab. Typed tokens above this (e.g. 1y) clamp down to it.
const TIMEFRAME_MAX_BLOCKS = 30 * BLOCKS_PER_DAY; // ~43,200 rows
const TIMEFRAME_PRESETS = ['1d', '1w', '1m'];

// Translate a timeframe token into a block count at 1 block/min, clamped to
// TIMEFRAME_MAX_BLOCKS. Accepts the presets above plus any `<n><unit>`
// (d/w/m/y) or 'YTD'; null ⇒ unparseable.
function timeframeToBlocks(token: string): number | null {
  const t = token.trim();
  let blocks: number;
  if (/^ytd$/i.test(t)) {
    const jan1 = Date.UTC(new Date().getUTCFullYear(), 0, 1);
    const days = Math.max(1, Math.floor((Date.now() - jan1) / 86_400_000));
    blocks = days * BLOCKS_PER_DAY;
  } else {
    const m = /^(\d+)\s*([dwmy])$/i.exec(t);
    if (!m) return null;
    const daysPer: Record<string, number> = {
      d: 1,
      w: 7,
      m: 30,
      y: 365,
    };
    blocks = Number(m[1]) * daysPer[m[2]!.toLowerCase()]! * BLOCKS_PER_DAY;
  }
  return Math.min(blocks, TIMEFRAME_MAX_BLOCKS);
}

function buildRequestUrl(view: ViewState): string | null {
  const prefix = getNodeUrl(view.network);
  let suffix = '?exp_am=1';
  let { type } = view;

  switch (view.type) {
    case 'asset':
      if (!view.id || view.id === '0') return null;
      suffix += `&id=${encodeURIComponent(view.id)}&nMaxOps=${view.nMaxOps || 100}`;
      if (view.hMin) suffix += `&hMin=${encodeURIComponent(view.hMin)}`;
      if (view.hMax) suffix += `&hMax=${encodeURIComponent(view.hMax)}`;
      break;
    case 'block':
      if (view.kernel) suffix += `&kernel=${encodeURIComponent(view.kernel)}`;
      if (view.height !== undefined && view.height !== '') {
        suffix += `&height=${encodeURIComponent(view.height)}`;
      }
      if (view.adj != null) suffix += `&adj=${encodeURIComponent(view.adj)}`;
      break;
    case 'treasury':
      type = 'block';
      suffix += '&height=0';
      break;
    case 'contract':
      if (!view.id) return null;
      suffix += `&id=${encodeURIComponent(view.id)}&nMaxTxs=${view.nMaxTxs || 100}`;
      if (view.hMin) suffix += `&hMin=${encodeURIComponent(view.hMin)}`;
      if (view.hMax) suffix += `&hMax=${encodeURIComponent(view.hMax)}`;
      break;
    case 'hdrs': {
      const cols = view.cols || COLUMN_DEFAULT_DISPLAY;
      suffix += `&cols=${cols}&nMax=${view.nMax || 100}&dh=${view.dh || 1}`;
      if (view.hMax) suffix += `&hMax=${encodeURIComponent(view.hMax)}`;
      break;
    }
    case 'assets':
      if (view.height) suffix += `&height=${encodeURIComponent(view.height)}`;
      else suffix += '&height=';
      break;
    case 'contracts':
    case 'peers':
    case 'status':
    default:
      break;
  }

  return `${prefix}${type}${suffix}`;
}

// Client-side proxy paginator for /hdrs. The server walks descending from hMax
// and, when it truncates at the 2048-row cap, returns `more.hMax` = the next
// (not-yet-emitted) height — so consecutive pages stitch together with no
// overlap and no dedup. We fetch up to ⌈nMax / 2048⌉ pages, concatenate the
// data rows under a single column header, and re-expose the final page's
// `more` cursor so the existing « Older / Newer » nav keeps working. `dh` is
// passed straight through; the cursor already accounts for the stride.
async function fetchHdrsPaginated(
  view: ViewState,
  signal: AbortSignal,
  onProgress?: (done: number, total: number) => void,
): Promise<any> {
  const wanted = Math.min(Math.max(1, Math.floor(Number(view.nMax) || 100)), HDRS_MAX_PER_REQUEST * HDRS_MAX_PAGES);
  const totalPages = Math.ceil(wanted / HDRS_MAX_PER_REQUEST);
  let remaining = wanted;
  let hMax = view.hMax || undefined; // undefined ⇒ start at the chain tip
  let header: unknown[] | null = null;
  const dataRows: unknown[][] = [];
  let more: { hMax?: number } | undefined;

  for (let page = 0; page < HDRS_MAX_PAGES && remaining > 0; page++) {
    // Report the request we're about to make (1-based) against the plan.
    onProgress?.(page + 1, totalPages);
    const pageN = Math.min(HDRS_MAX_PER_REQUEST, remaining);
    const url = buildRequestUrl({ ...view, nMax: String(pageN), hMax });
    if (!url) break;

    const r = await fetch(url, { signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();

    const value: unknown[] = Array.isArray(j?.value) ? j.value : [];
    if (header === null && value.length > 0) header = value[0] as unknown[];
    for (let i = 1; i < value.length; i++) dataRows.push(value[i] as unknown[]);
    remaining -= Math.max(0, value.length - 1);

    // No `more.hMax` ⇒ we reached genesis; an empty/header-only page ⇒ nothing
    // left to chain. Either way, stop. Otherwise continue from the cursor.
    const nextHMax = j?.more?.hMax;
    more = nextHMax === undefined ? undefined : j.more;
    if (more === undefined || value.length <= 1) break;
    hMax = String(nextHMax);
  }

  const out: any = { type: 'table', value: header ? [header, ...dataRows] : dataRows };
  if (more) out.more = more;
  return out;
}

// Fetch a single header (height + timestamp) at hMax — or the chain tip when
// hMax is undefined. The building block for anchoring timeframes to real time.
async function fetchHdrSample(
  view: ViewState,
  hMax: string | undefined,
  signal: AbortSignal,
): Promise<{ height: number; ts: number | null } | null> {
  const url = buildRequestUrl({
    ...view,
    type: 'hdrs',
    cols: 'T',
    nMax: '1',
    hMax,
  });
  if (!url) return null;
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const rows = extractHdrsRows(await r.json(), 'T');
  return rows[0] ?? null;
}

// Resolve a timeframe token to a concrete { hMax, nMax } anchored on real block
// timestamps (the "hybrid" approach): estimate the start height at 1 block/min,
// read that block's actual timestamp, then correct the height by the observed
// error once. ~2 sample requests. Falls back to the raw estimate when the chain
// can't be sampled; returns null only when the token itself doesn't parse.
async function resolveTimeframe(
  view: ViewState,
  token: string,
  hMaxDraft: string,
  signal: AbortSignal,
): Promise<{ hMax: string | undefined; nMax: string } | null> {
  const estBlocks = timeframeToBlocks(token);
  if (estBlocks === null) return null;

  const end = await fetchHdrSample(view, hMaxDraft || undefined, signal);
  if (!end || end.ts === null) {
    // No timestamp to anchor against — use the estimate as-is.
    return { hMax: hMaxDraft || undefined, nMax: String(estBlocks) };
  }

  // Wall-clock start: exactly Jan 1 (of the anchor block's year) for YTD, else
  // a fixed duration before the anchor. estBlocks already equals seconds / 60.
  const targetStart = /^ytd$/i.test(token.trim())
    ? Math.floor(Date.UTC(new Date(end.ts * 1000).getUTCFullYear(), 0, 1) / 1000)
    : end.ts - estBlocks * 60;

  const estStartHeight = Math.max(1, end.height - estBlocks);
  const probe = await fetchHdrSample(view, String(estStartHeight), signal);
  let startHeight = estStartHeight;
  if (probe && probe.ts !== null) {
    // probe later than target ⇒ didn't reach far enough back ⇒ lower the
    // height (and the converse when probe is older than target).
    const correction = Math.round((probe.ts - targetStart) / 60);
    startHeight = Math.min(end.height - 1, Math.max(1, probe.height - correction));
  }

  const span = Math.min(TIMEFRAME_MAX_BLOCKS, Math.max(1, end.height - startHeight + 1));
  return { hMax: String(end.height), nMax: String(span) };
}

function formatTimestamp(time: number, zone: 'local' | 'utc' = 'utc'): string {
  let d = new Date();
  const diff = zone === 'local' ? d.getTimezoneOffset() : 0;
  d = new Date((time - diff * 60) * 1000);
  const iso = d.toISOString();
  return iso.replace(/(.*)T(.*)\..*/, '$1 $2');
}

// ---------------------------------------------------------------------------
// Page-specific styled components — kept because they have unique roles in the
// JSON-tree / typed-cell renderer (color-coded inline atoms) or are details
// disclosure widgets. Colors are pulled from the shared theme tokens.
// ---------------------------------------------------------------------------

const SearchForm = styled.form`
  display: flex;
  & > * + * {
    margin-left: 8px;
  }
  flex: 1;
  min-width: 240px;
`;

// ---------------------------------------------------------------------------
// Local tightened presentation — matches the density of the original
// BeamExplorer.htm without touching shared/* (other explorer pages rely on
// those sizes). Colors stay on the shared theme tokens.
// ---------------------------------------------------------------------------

const DensePage = styled.div`
  font-size: 13px;
  line-height: 1.4;

  /* Headings */
  h1 {
    font-size: 16px;
    letter-spacing: 0;
    text-transform: none;
  }
  h2 {
    font-size: 13px;
    margin: 12px 0 6px;
    text-transform: none;
    letter-spacing: 0;
    font-weight: 600;
  }
  h3 {
    font-size: 12px;
    margin: 10px 0 4px;
    text-transform: none;
    letter-spacing: 0;
  }

  /* Compact tables */
  table {
    font-size: 12px;
  }
  table th,
  table td {
    padding: 4px 8px;
  }
  table th {
    font-size: 11px;
    letter-spacing: 0;
    text-transform: none;
  }

  /* Compact cards / collapsibles */
  section,
  details {
    padding: 10px 12px;
    margin-bottom: 8px;
  }
  details > summary {
    font-size: 12px;
    padding: 2px 0;
  }
`;

/* Plain text-link tab strip (the original HTM uses bare anchors, not pills). */
const NavTabs = styled.div`
  display: flex;
  flex-wrap: wrap;
  & > * + * {
    margin-left: 14px;
  }
  margin: 6px 0 14px;
  padding-bottom: 6px;
  border-bottom: 1px solid ${theme.color.divider};
`;

const NavTab = styled.button`
  background: transparent;
  border: none;
  padding: 0;
  font: inherit;
  font-family: ${theme.font.mono};
  font-size: 12px;
  color: ${theme.color.muted};
  cursor: pointer;
  text-transform: none;
  letter-spacing: 0;
  &:hover {
    color: ${theme.color.text};
  }
  &[data-active='true'] {
    color: ${theme.color.accent};
    text-decoration: underline;
    text-underline-offset: 3px;
  }
`;

/* Tiny PoW/PoS pill, ~10px to match the original. */
const TinyPill = styled.span`
  display: inline-block;
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 10px;
  font-weight: 600;
  background: rgba(255, 255, 255, 0.08);
  color: ${theme.color.text};
  &[data-tone='purple'] {
    background: rgba(218, 104, 245, 0.16);
    color: ${theme.color.purple};
  }
  &[data-tone='info'] {
    background: rgba(11, 204, 247, 0.16);
    color: ${theme.color.info};
  }
`;

// Clickable version badge in the header — opens the release notes.
const VersionBadge = styled.button`
  background: none;
  border: none;
  padding: 0 0 0 6px;
  font-size: 11px;
  font-weight: 600;
  color: ${theme.color.muted};
  cursor: pointer;
  &:hover {
    color: ${theme.color.accent};
  }
`;

const WhatsNewCard = styled.div`
  width: 100%;
  max-width: 460px;
  background: ${theme.color.surface};
  border: 1px solid ${theme.color.borderDim};
  border-radius: ${theme.radius.lg};
  padding: 16px 18px;
  max-height: 70vh;
  overflow-y: auto;
`;

const Collapsible = styled.details`
  background: ${theme.color.surface};
  border: 1px solid ${theme.color.borderDim};
  border-radius: ${theme.radius.lg};
  padding: 12px 16px;
  margin-bottom: 12px;
  & > summary {
    cursor: pointer;
    font-weight: 600;
    color: ${theme.color.accent};
    padding: 4px 0;
    user-select: none;
  }
`;

// Same look as Collapsible, but with the native disclosure triangle suppressed
// so the summary shows only our explicit "+"/"−" marker — i.e. "+ Chart" when
// collapsed and "− Chart" when expanded (faithful to the reference's
// graphCollapsible affordance). Chrome-83-safe: list-style:none +
// ::-webkit-details-marker{display:none} (no :has / inset / gap).
const ChartCollapsible = styled.details`
  background: ${theme.color.surface};
  border: 1px solid ${theme.color.borderDim};
  border-radius: ${theme.radius.lg};
  padding: 12px 16px;
  margin-bottom: 12px;
  & > summary {
    cursor: pointer;
    font-weight: 600;
    color: ${theme.color.accent};
    padding: 4px 0;
    user-select: none;
    list-style: none;
  }
  & > summary::-webkit-details-marker {
    display: none;
  }
`;

const Link = styled.a`
  color: ${theme.color.accent};
  text-decoration: none;
  cursor: pointer;
  &:hover {
    text-decoration: underline;
    color: ${theme.color.purple};
  }
`;

// Inline atoms used inside the typed-cell JSON renderer.
const Mono = styled.span`
  font-family: ${theme.font.mono};
  font-size: 12px;
  word-break: break-all;
  color: ${theme.color.muted};
`;

const Pos = styled.span`
  color: ${theme.color.success};
`;
const Neg = styled.span`
  color: ${theme.color.danger};
`;
const Muted = styled.span`
  color: ${theme.color.muted};
  font-style: italic;
`;

const BlockLinkWrap = styled.span`
  position: relative;
  display: inline-flex;
`;

const BlockHoverTip = styled.span`
  /* Portaled into <body> with fixed coords (set inline) and centered over the
     height, so table/panel overflow can't clip it. */
  position: fixed;
  transform: translate(-50%, -100%);
  z-index: 9999;
  white-space: nowrap;
  background: rgba(0, 0, 0, 0.92);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 6px;
  padding: 5px 9px;
  font-size: 11px;
  color: #ffffff;
  font-variant-numeric: tabular-nums;
  pointer-events: none;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.5);
`;

const Pager = styled.div`
  display: flex;
  & > * + * {
    margin-left: 8px;
  }
  margin: 8px 0;
`;

// ---------------------------------------------------------------------------
// Generic JSON renderer (mirrors Obj2Html from the original)
// ---------------------------------------------------------------------------

/** How a navigation is recorded. `inPlace` rewrites the current history entry
 *  and leaves the scroll position alone — for a change that refines the view
 *  the reader is already looking at (closing an expanded chart), rather than
 *  taking them somewhere new. */
export interface GoOptions {
  inPlace?: boolean;
}

interface RenderCtx {
  go: (next: Partial<ViewState>, opts?: GoOptions) => void;
  network: string;
  viewType: ViewType;
}

function AmountClr({ amount }: { amount: string }): JSX.Element {
  const c = amount[0];
  if (c === '+')
    return (
      <Pos>
        <Mono>{amount}</Mono>
      </Pos>
    );
  if (c === '-')
    return (
      <Neg>
        <Mono>{amount}</Mono>
      </Neg>
    );
  return <Mono style={{ color: theme.color.warn }}>{amount}</Mono>;
}

function AssetLink({ aid, ctx }: { aid: number | string; ctx: RenderCtx }): JSX.Element {
  if (String(aid) === '0') return <span style={{ color: theme.color.accent, fontWeight: 600 }}>Beam</span>;
  return (
    <Link
      onClick={(e) => {
        e.preventDefault();
        ctx.go({ type: 'asset', id: String(aid) });
      }}
      href="#"
      style={{ color: theme.color.purple }}
    >
      Asset-
      {aid}
    </Link>
  );
}

function BlockLink({ h, ctx }: { h: number | string; ctx: RenderCtx }): JSX.Element {
  const wrapRef = useRef<HTMLSpanElement>(null);
  const [hovered, setHovered] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const heightNum = Number(h);
  const valid = Number.isFinite(heightNum);
  const resolveUrl = useCallback<BlockUrlResolver>(
    (height) => `${getNodeUrl(ctx.network)}block?exp_am=1&height=${height}`,
    [ctx.network],
  );
  const { ts, loading } = useBlockTimestamp(valid ? heightNum : null, {
    enabled: hovered && valid,
    resolveUrl,
  });
  const tipText = loading
    ? 'Loading…'
    : typeof ts === 'number'
    ? new Date(ts * 1000).toLocaleString()
    : 'timestamp unavailable';
  const onEnter = (): void => {
    const el = wrapRef.current;
    if (el) {
      const r = el.getBoundingClientRect();
      setPos({ x: r.left + r.width / 2, y: r.top });
    }
    setHovered(true);
  };
  return (
    <BlockLinkWrap ref={wrapRef} onMouseEnter={onEnter} onMouseLeave={() => setHovered(false)}>
      <Link
        onClick={(e) => {
          e.preventDefault();
          ctx.go({ type: 'block', height: String(h) });
        }}
        href="#"
        style={{ color: theme.color.info }}
      >
        {String(h)}
      </Link>
      {hovered &&
        valid &&
        pos &&
        createPortal(<BlockHoverTip style={{ left: pos.x, top: pos.y - 8 }}>{tipText}</BlockHoverTip>, document.body)}
    </BlockLinkWrap>
  );
}

function CidLink({ cid, ctx }: { cid: string; ctx: RenderCtx }): JSX.Element {
  // Truncate the 64-char CID so it stays on one line in table columns (the
  // full value is on hover and one click away); break-all would otherwise wrap
  // it into a narrow vertical stack.
  const short = cid.length > 16 ? `${cid.slice(0, 8)}…${cid.slice(-6)}` : cid;
  return (
    <Link
      onClick={(e) => {
        e.preventDefault();
        ctx.go({ type: 'contract', id: cid });
      }}
      href="#"
      title={cid}
    >
      <Mono style={{ whiteSpace: 'nowrap' }}>{short}</Mono>
    </Link>
  );
}

interface TypedCell {
  type?: string;
  value?: unknown;
  min?: unknown;
  max?: unknown;
}

function isTypedCell(o: unknown): o is TypedCell {
  return !!o && typeof o === 'object' && !Array.isArray(o) && 'type' in (o as object);
}

function renderSpecial(obj: TypedCell, ctx: RenderCtx): JSX.Element | null {
  if (!obj.type) return null;
  switch (obj.type) {
    case 'cid':
      return <CidLink cid={String(obj.value)} ctx={ctx} />;
    case 'th': {
      const label = typeof obj.value === 'string' ? TH_LABEL_OVERRIDES[obj.value] : undefined;
      return (
        <strong style={{ color: theme.color.muted }}>
          <RenderValue value={label ?? obj.value} ctx={ctx} />
        </strong>
      );
    }
    case 'amount':
      return <AmountClr amount={String(obj.value)} />;
    case 'aid':
      return <AssetLink aid={obj.value as number | string} ctx={ctx} />;
    case 'height':
      return <BlockLink h={obj.value as number | string} ctx={ctx} />;
    case 'blob':
      return <Mono title={String(obj.value)}>{String(obj.value)}</Mono>;
    case 'bool':
      return Number(obj.value) > 0 ? <Pos>yes</Pos> : <Neg>no</Neg>;
    case 'time':
      return (
        <span title={`UTC: ${formatTimestamp(Number(obj.value))}`}>{formatTimestamp(Number(obj.value), 'local')}</span>
      );
    case 'table': {
      const rows = Array.isArray(obj.value) ? (obj.value as unknown[]) : [];
      return <GenericTable rows={rows} ctx={ctx} />;
    }
    case 'group':
      return <RenderValue value={Array.isArray(obj.value) ? obj.value : []} ctx={ctx} />;
    default:
      return null;
  }
}

function RenderValue({ value, ctx }: { value: unknown; ctx: RenderCtx }): JSX.Element {
  if (value === null || value === undefined) return <Muted>(none)</Muted>;

  if (Array.isArray(value)) {
    return (
      <ul style={{ margin: 0, paddingLeft: 18 }}>
        {value.map((v, i) => (
          <li key={i}>
            <RenderValue value={v} ctx={ctx} />
          </li>
        ))}
      </ul>
    );
  }

  if (typeof value === 'object') {
    const obj = value as TypedCell & Record<string, unknown>;
    const special = renderSpecial(obj, ctx);
    if (special) return special;

    return (
      <ul style={{ margin: 0, paddingLeft: 18 }}>
        {Object.keys(obj).map((k) => (
          <li key={k}>
            <span style={{ color: theme.color.muted }}>{k}:</span>{' '}
            <RenderValue value={(obj as Record<string, unknown>)[k]} ctx={ctx} />
          </li>
        ))}
      </ul>
    );
  }

  if (typeof value === 'string') {
    if (value.startsWith('STD:')) return <Mono style={{ color: theme.color.purple }}>{value}</Mono>;
    if (ctx.viewType === 'hdrs') {
      const codes = Object.keys(columnHeaders);
      for (let i = 0; i < codes.length; i += 1) {
        const code = codes[i];
        if (value === columnHeaders[code].original) {
          return <span title={columnHeaders[code].description}>{columnHeaders[code].title}</span>;
        }
      }
    }
    return <>{value}</>;
  }

  return <>{String(value)}</>;
}

function flattenGroup(row: unknown): unknown[][] {
  if (Array.isArray(row)) return [row];
  if (isTypedCell(row) && row.type === 'group' && Array.isArray(row.value)) {
    return (row.value as unknown[]).flatMap(flattenGroup);
  }
  return [];
}

function GenericTable({ rows, ctx }: { rows: unknown[]; ctx: RenderCtx }): JSX.Element {
  const safeRows: unknown[] = Array.isArray(rows) ? rows : [];
  const flat: unknown[][] = safeRows.flatMap(flattenGroup);
  return (
    <ScrollX>
      <DataTable>
        <tbody>
          {flat.map((r, i) => (
            <tr key={i}>
              {(Array.isArray(r) ? r : []).map((cell, j) => (
                <td key={j} className="right">
                  <RenderValue value={cell} ctx={ctx} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </DataTable>
    </ScrollX>
  );
}

// ---------------------------------------------------------------------------
// Generic sortable + per-column-searchable table. Mirrors the click-to-filter
// / click-to-sort header feature of BeamExplorer.htm: every data table routes
// its rows + column metadata through here while keeping its own cell-rendering
// in `renderRow`. Filters/sort only appear once a table has enough rows to be
// worth it (matches the .htm's >5-row gate).
// ---------------------------------------------------------------------------

const MIN_ROWS_FOR_FILTERS = 6;

interface FilterColumn<T> {
  header: React.ReactNode;
  /** Extra class for the <th> (e.g. 'right'). */
  className?: string;
  /** Searchable text for this column; omit to make it non-searchable. */
  text?: (row: T) => string;
  /** Sort key; omit to make the column non-sortable. */
  sortKey?: (row: T) => string | number;
}

// Recursively flatten a typed cell / array / object into searchable text.
function cellText(cell: unknown): string {
  if (cell === null || cell === undefined) return '';
  if (typeof cell === 'string' || typeof cell === 'number' || typeof cell === 'boolean') return String(cell);
  if (Array.isArray(cell)) return cell.map(cellText).join(' ');
  if (typeof cell === 'object') {
    const o = cell as Record<string, unknown>;
    if ('value' in o) return cellText(o.value);
    return Object.values(o).map(cellText).join(' ');
  }
  return '';
}

// Numeric-aware sort key: parse the cell's text as a number when possible
// (so amounts/heights sort numerically), otherwise lowercase the string.
function cellSort(cell: unknown): string | number {
  const t = cellText(cell).trim();
  if (t === '') return '';
  const n = Number(t.replace(/[, +]/g, ''));
  return Number.isFinite(n) ? n : t.toLowerCase();
}

// Extract a block height from a cell. Several explorer tables (contract call
// history, asset history) return the height as a bare number rather than a
// `{type:"height", value}` wrapper, so read both shapes.
function cellHeight(cell: unknown): number | string {
  if (typeof cell === 'number' || typeof cell === 'string') return cell;
  if (cell && typeof cell === 'object' && 'value' in (cell as object)) {
    const v = (cell as { value?: unknown }).value;
    if (typeof v === 'number' || typeof v === 'string') return v;
  }
  return '';
}

const FilterInput = styled.input`
  width: 100%;
  box-sizing: border-box;
  font-family: ${theme.font.mono};
  font-size: 11px;
  font-weight: 400;
  text-transform: none;
  letter-spacing: 0;
  padding: 2px 6px;
  background: ${theme.color.surface};
  border: 1px solid ${theme.color.border};
  border-radius: 4px;
  color: ${theme.color.text};
  &::placeholder {
    color: ${theme.color.muted};
  }
`;

const FilterToggle = styled.button`
  background: transparent;
  border: none;
  font: inherit;
  font-family: ${theme.font.mono};
  font-size: 11px;
  color: ${theme.color.muted};
  cursor: pointer;
  padding: 4px 0;
  margin-bottom: 4px;
  &:hover {
    color: ${theme.color.accent};
  }
`;

function FilterTable<T>({
  columns,
  rows,
  renderRow,
  initialTerms,
}: {
  columns: FilterColumn<T>[];
  rows: T[];
  // Returns the <tr>(s) for one row; multiple <tr> are fine (e.g. grouped
  // contract calls). The caller owns React keys.
  renderRow: (row: T, index: number) => React.ReactNode;
  // Pre-applied per-column search terms (column index → term), e.g. when a
  // deep link asks to show only one owner's assets. Reveals the search row.
  initialTerms?: Record<number, string>;
}): JSX.Element {
  const enabled = rows.length >= MIN_ROWS_FOR_FILTERS;
  const initialKey = JSON.stringify(initialTerms ?? {});
  const [showFilters, setShowFilters] = useState(!!initialTerms && Object.keys(initialTerms).length > 0);
  const [terms, setTerms] = useState<Record<number, string>>(initialTerms ?? {});
  const [sort, setSort] = useState<{ col: number; dir: 1 | -1 } | null>(null);

  // Re-seed when the deep-linked filter changes (e.g. navigating from one
  // owner's assets to another's).
  useEffect(() => {
    const seed = initialTerms ?? {};
    if (Object.keys(seed).length > 0) {
      setTerms(seed);
      setShowFilters(true);
    }
    // initialKey is the stable stringified form of initialTerms.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialKey]);

  const visible = useMemo(() => {
    if (!enabled) return rows;
    let out = rows;
    const active = Object.entries(terms).filter(([, v]) => v.trim() !== '');
    if (active.length > 0) {
      out = out.filter((row) =>
        active.every(([ci, term]) => {
          const col = columns[Number(ci)];
          if (!col?.text) return true;
          return col.text(row).toLowerCase().includes(term.trim().toLowerCase());
        }),
      );
    }
    if (sort) {
      const col = columns[sort.col];
      if (col?.sortKey) {
        // Stable sort: keep original order as the tie-breaker.
        out = out
          .map((row, i) => ({ row, i, k: col.sortKey!(row) }))
          .sort((a, b) => {
            let cmp: number;
            if (typeof a.k === 'number' && typeof b.k === 'number') cmp = a.k - b.k;
            else cmp = String(a.k).localeCompare(String(b.k));
            return cmp === 0 ? a.i - b.i : cmp * sort.dir;
          })
          .map((x) => x.row);
      }
    }
    return out;
  }, [enabled, rows, terms, sort, columns]);

  const toggleSort = useCallback(
    (ci: number) => {
      if (!columns[ci]?.sortKey) return;
      // Cycle: ascending → descending → off.
      setSort((prev) => {
        if (!prev || prev.col !== ci) return { col: ci, dir: 1 };
        if (prev.dir === 1) return { col: ci, dir: -1 };
        return null;
      });
    },
    [columns],
  );

  return (
    <>
      {enabled && (
        <FilterToggle type="button" onClick={() => setShowFilters((s) => !s)} title="Show per-column search boxes">
          {showFilters ? '▾ Hide filters' : '▸ Filter / sort'}
          {visible.length !== rows.length ? ` · ${visible.length}/${rows.length}` : ''}
        </FilterToggle>
      )}
      <ScrollX>
        <DataTable>
          <thead>
            <tr>
              {columns.map((c, ci) => {
                const sortable = enabled && !!c.sortKey;
                const arrow = sort?.col === ci ? (sort.dir === 1 ? ' ▲' : ' ▼') : '';
                return (
                  <th
                    key={ci}
                    className={c.className}
                    data-sortable={sortable ? '' : undefined}
                    onClick={sortable ? () => toggleSort(ci) : undefined}
                    title={sortable ? 'Sort column' : undefined}
                  >
                    {c.header}
                    {arrow}
                  </th>
                );
              })}
            </tr>
            {enabled && showFilters && (
              <tr>
                {columns.map((c, ci) => (
                  <th key={ci} className={c.className}>
                    {c.text ? (
                      <FilterInput
                        value={terms[ci] ?? ''}
                        placeholder="🔎"
                        onChange={(e) => {
                          const { value } = e.target;
                          setTerms((t) => ({ ...t, [ci]: value }));
                        }}
                      />
                    ) : null}
                  </th>
                ))}
              </tr>
            )}
          </thead>
          <tbody>{visible.map((row, i) => renderRow(row, i))}</tbody>
        </DataTable>
      </ScrollX>
    </>
  );
}

// ---------------------------------------------------------------------------
// View renderers
// ---------------------------------------------------------------------------

function FundsTable({ funds, ctx }: { funds: unknown[] | null | undefined; ctx: RenderCtx }): JSX.Element | null {
  if (!funds || !Array.isArray(funds) || funds.length === 0) return null;
  return (
    <DataTable>
      <thead>
        <tr>
          <th>Asset</th>
          <th className="right">Amount</th>
        </tr>
      </thead>
      <tbody>
        {funds.map((fr, i) => {
          const row = fr as TypedCell[];
          return (
            <tr key={i}>
              <td>
                <AssetLink aid={row[0]?.value as string} ctx={ctx} />
              </td>
              <td className="right">
                <AmountClr amount={String(row[1]?.value ?? '')} />
              </td>
            </tr>
          );
        })}
      </tbody>
    </DataTable>
  );
}

/**
 * Strip the explorer's table-header row (typed `{type:"th"}` cells) from a
 * typed-cell table value, leaving only the data rows. Works on either the raw
 * wrapper (`{type:"table", value:[...]}`) or an already-unwrapped array.
 */
function stripHeaderRow(input: unknown): unknown[] {
  const rows = Array.isArray(input)
    ? input
    : input && typeof input === 'object' && Array.isArray((input as { value?: unknown }).value)
    ? (input as { value: unknown[] }).value
    : [];
  if (rows.length === 0) return rows;
  const first = rows[0];
  if (
    Array.isArray(first) &&
    first.length > 0 &&
    first.every((c) => c && typeof c === 'object' && (c as { type?: string }).type === 'th')
  ) {
    return rows.slice(1);
  }
  return rows;
}

/**
 * Mirror of `MakeFundsTbl` in BeamExplorer.htm: render the per-contract
 * Locked Funds list as a compact table when it has <5 rows, otherwise wrap it
 * in a `<details>` disclosure that summarises the row count ("N assets").
 */
const InlineDetails = styled.details`
  display: inline-block;
  vertical-align: top;
  width: 100%;
  & > summary {
    cursor: pointer;
    font-size: 11px;
    color: ${theme.color.accent};
    padding: 2px 0;
    user-select: none;
    list-style: none;
  }
  & > summary::-webkit-details-marker {
    display: none;
  }
  & > summary::before {
    content: '\\25B8\\00a0';
    display: inline-block;
    width: 12px;
    color: ${theme.color.muted};
  }
  &[open] > summary::before {
    content: '\\25BE\\00a0';
  }
  & > summary:hover {
    color: ${theme.color.purple};
  }
  & > .body {
    margin-top: 4px;
  }
`;

function LockedFundsWidget({
  funds,
  ctx,
  maxRows = 5,
}: {
  funds: unknown;
  ctx: RenderCtx;
  maxRows?: number;
}): JSX.Element | null {
  const rows = stripHeaderRow(funds);
  if (rows.length === 0) return null;
  const table = (
    <DataTable>
      <thead>
        <tr>
          <th>Asset</th>
          <th className="right">Amount</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((fr, i) => {
          const row = (Array.isArray(fr) ? fr : []) as TypedCell[];
          return (
            <tr key={i}>
              <td>
                <AssetLink aid={row[0]?.value as string} ctx={ctx} />
              </td>
              <td className="right">
                <AmountClr amount={String(row[1]?.value ?? '')} />
              </td>
            </tr>
          );
        })}
      </tbody>
    </DataTable>
  );
  if (rows.length < maxRows) return table;
  return (
    <InlineDetails>
      <summary title="Toggle">
        {rows.length}
        &nbsp;assets
      </summary>
      <div className="body">{table}</div>
    </InlineDetails>
  );
}

/**
 * Mirror of the Owned Assets rendering in `DisplayContracts`: per-asset table
 * with [Asset, Description, Amount] columns, collapsed behind "N owned" once
 * it crosses the row-count threshold.
 */
function OwnedAssetsWidget({
  owned,
  ctx,
  maxRows = 5,
}: {
  owned: unknown;
  ctx: RenderCtx;
  maxRows?: number;
}): JSX.Element | null {
  const rows = stripHeaderRow(owned);
  if (rows.length === 0) return null;
  const table = (
    <DataTable>
      <thead>
        <tr>
          <th>Asset</th>
          <th>Description</th>
          <th className="right">Amount</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((fr, i) => {
          const row = (Array.isArray(fr) ? fr : []) as any[];
          return (
            <tr key={i}>
              <td>
                <AssetLink aid={row[0]?.value as string} ctx={ctx} />
              </td>
              <td>
                <Mono style={{ color: theme.color.purple }} title={String(row[1] ?? '')}>
                  {String(row[1] ?? '')}
                </Mono>
              </td>
              <td className="right">
                <AmountClr amount={String(row[2]?.value ?? '')} />
              </td>
            </tr>
          );
        })}
      </tbody>
    </DataTable>
  );
  if (rows.length < maxRows) return table;
  return (
    <InlineDetails>
      <summary title="Toggle">
        {rows.length}
        &nbsp;owned
      </summary>
      <div className="body">{table}</div>
    </InlineDetails>
  );
}

function StatusView({ data, ctx }: { data: unknown; ctx: RenderCtx }): JSX.Element {
  return (
    <>
      <H2>Blockchain status</H2>
      <Card>
        <RenderValue value={data} ctx={ctx} />
      </Card>
      <H3>
        <Link
          onClick={(e) => {
            e.preventDefault();
            ctx.go({ type: 'peers' });
          }}
          href="#"
        >
          Connected Peers
        </Link>
      </H3>
      <Card>
        <p>
          Interactive display of the data returned by a Beam explorer node. The network and node currently queried are:{' '}
          <b>{ctx.network}</b> <Pill>{explorerNodes[ctx.network]?.description}</Pill> at
          <Mono>{getNodeUrl(ctx.network)}</Mono>.
        </p>
        <p>
          Beam is a privacy-centric blockchain with native confidential assets and smart contracts, powered by
          Mimblewimble and Lelantus. Although amounts are concealed and addresses are not stored onchain, the explorer
          shows the commitments of all inputs &amp; outputs of each block, together with kernel ids, contract calls, and
          confidential-asset mint/burn history.
        </p>
      </Card>
    </>
  );
}

function TxoTable({ rows, isInp, ctx }: { rows: any[]; isInp: boolean; ctx: RenderCtx }): JSX.Element {
  const heightCell = (r: any): any => (isInp ? r.height : r.spent);
  const extraText = (r: any): string => {
    const extras: string[] = [];
    if (r.Asset) extras.push(`CA [${r.Asset.min}-${r.Asset.max}]`);
    if (r.type) extras.push(String((r.type as TypedCell).value ?? r.type));
    if (r.Value != null) extras.push(String((r.Value as TypedCell).value ?? r.Value));
    return extras.join(' ');
  };
  const columns: FilterColumn<any>[] = [
    { header: 'Commitment', text: (r) => String(r.commitment ?? ''), sortKey: (r) => String(r.commitment ?? '') },
    {
      header: isInp ? 'Height' : 'Spent',
      className: 'right',
      text: (r) => cellText(heightCell(r)),
      sortKey: (r) => cellSort(heightCell(r)),
    },
    {
      header: 'Maturity',
      className: 'right',
      text: (r) => cellText(r.Maturity),
      sortKey: (r) => cellSort(r.Maturity),
    },
    { header: 'Extra', text: extraText, sortKey: extraText },
  ];
  return (
    <FilterTable
      columns={columns}
      rows={rows}
      renderRow={(r, i) => (
        <tr key={i}>
          <td>
            <Mono title={r.commitment}>{r.commitment}</Mono>
          </td>
          <td className="right">{heightCell(r) != null ? <BlockLink h={heightCell(r)} ctx={ctx} /> : ''}</td>
          <td className="right">{r.Maturity != null ? <RenderValue value={r.Maturity} ctx={ctx} /> : ''}</td>
          <td>{extraText(r)}</td>
        </tr>
      )}
    />
  );
}

function AssetsTable({ data, ctx, ownerFilter }: { data: any; ctx: RenderCtx; ownerFilter?: string }): JSX.Element {
  const rawRows = data?.value;
  const allRows: any[][] = Array.isArray(rawRows) ? rawRows : [];
  const rows: any[][] = allRows.slice(1).map((row) => (Array.isArray(row) ? row : []));
  const columns: FilterColumn<any[]>[] = [
    { header: 'Id', text: (r) => cellText(r[0]), sortKey: (r) => cellSort(r[0]) },
    { header: 'Owner', text: (r) => cellText(r[1]), sortKey: (r) => cellSort(r[1]) },
    {
      header: 'Deposit',
      className: 'right',
      text: (r) => cellText(r[2]),
      sortKey: (r) => cellSort(r[2]),
    },
    {
      header: 'Supply',
      className: 'right',
      text: (r) => cellText(r[3]),
      sortKey: (r) => cellSort(r[3]),
    },
    { header: 'Lock Height', text: (r) => cellText(r[4]), sortKey: (r) => cellSort(r[4]) },
    { header: 'Metadata', text: (r) => cellText(r[5]), sortKey: (r) => cellSort(r[5]) },
  ];
  return (
    <FilterTable
      columns={columns}
      rows={rows}
      initialTerms={ownerFilter ? { 1: ownerFilter } : undefined}
      renderRow={(r, i) => (
        <tr key={i}>
          <td>
            <AssetLink aid={r[0]?.value} ctx={ctx} />
          </td>
          <td>
            <RenderValue value={r[1]} ctx={ctx} />
          </td>
          <td className="right">
            <AmountClr amount={String(r[2]?.value ?? '')} />
          </td>
          <td className="right">
            <AmountClr amount={String(r[3]?.value ?? '')} />
          </td>
          <td>{r[4] != null ? <RenderValue value={r[4]} ctx={ctx} /> : ''}</td>
          <td>
            <Mono style={{ color: theme.color.purple }}>{String(r[5] ?? '')}</Mono>
          </td>
        </tr>
      )}
    />
  );
}

function BlockView({ data, view, ctx }: { data: any; view: ViewState; ctx: RenderCtx }): JSX.Element {
  const isTreasury = view.type === 'treasury' || view.height === '0';
  if (data?.found === false || (data?.info === undefined && !isTreasury)) {
    return <ErrorBox>Block not found.</ErrorBox>;
  }
  const heightStr = data?.h != null ? String(data.h) : view.height ?? '';
  const height = Number(heightStr);
  const kernelId = view.kernel;

  return (
    <>
      <H2>
        {isTreasury ? (
          'Treasury'
        ) : (
          <>
            Block
            <span style={{ color: theme.color.accent }}>{heightStr}</span>
          </>
        )}{' '}
        <Btn
          data-variant="ghost"
          onClick={() => ctx.go({ type: 'hdrs', hMax: String(height) })}
          title="List of block headers up to this one"
        >
          Headers
        </Btn>{' '}
        {height > 0 && (
          <Btn data-variant="ghost" onClick={() => ctx.go({ type: 'block', height: String(height - 1), adj: '-1' })}>
            ← Prev
          </Btn>
        )}{' '}
        <Btn data-variant="ghost" onClick={() => ctx.go({ type: 'block', height: String(height + 1), adj: '1' })}>
          Next →
        </Btn>
      </H2>

      {data?.info && (
        <Collapsible open>
          <summary>Block Summary</summary>
          <GenericTable rows={data.info.value} ctx={ctx} />
        </Collapsible>
      )}

      <Collapsible open>
        <summary>Block content</summary>
        {Array.isArray(data?.inputs) && data.inputs.length > 0 && (
          <>
            <H3>Inputs ({data.inputs.length})</H3>
            <TxoTable rows={data.inputs} isInp ctx={ctx} />
          </>
        )}
        {Array.isArray(data?.outputs) && data.outputs.length > 0 && (
          <>
            <H3>Outputs ({data.outputs.length})</H3>
            <TxoTable rows={data.outputs} isInp={false} ctx={ctx} />
          </>
        )}
        {Array.isArray(data?.kernels) && data.kernels.length > 0 && (
          <>
            <H3>Kernels ({data.kernels.length})</H3>
            <FilterTable
              columns={[
                { header: 'ID', text: (k) => String(k.id ?? ''), sortKey: (k) => String(k.id ?? '') },
                {
                  header: 'Fee',
                  className: 'right',
                  text: (k) => cellText(k.fee),
                  sortKey: (k) => cellSort(k.fee),
                },
                {
                  header: 'Height',
                  text: (k) => `${cellText(k.minHeight)} ${cellText(k.maxHeight)}`,
                  sortKey: (k) => cellSort(k.minHeight),
                },
                { header: 'Extra' },
              ]}
              rows={data.kernels as any[]}
              renderRow={(k, i) => {
                const rest = { ...k };
                delete rest.id;
                delete rest.fee;
                delete rest.minHeight;
                delete rest.maxHeight;
                const mh = k.minHeight ? <BlockLink h={k.minHeight} ctx={ctx} /> : '*';
                const xh = k.maxHeight ? <BlockLink h={k.maxHeight} ctx={ctx} /> : '*';
                const highlighted = kernelId && k.id === kernelId;
                return (
                  <tr key={i} style={highlighted ? { background: 'rgba(240, 165, 0, 0.12)' } : undefined}>
                    <td>
                      <Mono title={k.id}>{k.id}</Mono>
                    </td>
                    <td className="right">
                      <RenderValue value={k.fee} ctx={ctx} />
                    </td>
                    <td>
                      {mh}-{xh}
                    </td>
                    <td>
                      <RenderValue value={rest} ctx={ctx} />
                    </td>
                  </tr>
                );
              }}
            />
          </>
        )}
      </Collapsible>

      {data?.totals && (
        <Collapsible>
          <summary>Totals</summary>
          <GenericTable rows={data.totals.value} ctx={ctx} />
        </Collapsible>
      )}

      {data?.assets ? (
        <Collapsible>
          <summary>Assets state</summary>
          <AssetsTable data={data.assets} ctx={ctx} />
        </Collapsible>
      ) : height > 0 ? (
        <H3>
          <Link
            onClick={(e) => {
              e.preventDefault();
              ctx.go({ type: 'assets', height: String(height) });
            }}
            href="#"
          >
            Confidential Assets at this block height
          </Link>
        </H3>
      ) : null}
    </>
  );
}

function ContractsView({ data, ctx }: { data: any; ctx: RenderCtx }): JSX.Element {
  const rawRows = data?.value;
  const rows: any[][] = Array.isArray(rawRows) ? rawRows : [];
  // Derive header labels from the response's own first row so we stay in sync
  // if the explorer adds/removes columns (same approach as ContractStateView).
  const headerRow: any[] = Array.isArray(rows[0]) ? rows[0] : [];
  const labels: string[] = headerRow.map((c: any) => String(c?.value ?? ''));
  // Default fallback labels match the original `DisplayContracts` thead.
  const L = (i: number, fb: string): string => labels[i] || fb;
  const dataRows: any[][] = rows.slice(1).map((row) => (Array.isArray(row) ? row : []));
  // Deploy Height is a bare number in `/contracts?exp_am=1` (reading `.value`
  // on the number was the source of the "undefined" rendering).
  const heightVal = (r: any[]): unknown => {
    const c = r[2];
    return c !== null && typeof c === 'object' ? (c as { value?: unknown }).value : c;
  };
  const columns: FilterColumn<any[]>[] = [
    { header: L(0, 'Cid'), text: (r) => cellText(r[0]), sortKey: (r) => cellSort(r[0]) },
    { header: L(1, 'Kind'), text: (r) => cellText(r[1]), sortKey: (r) => cellSort(r[1]) },
    {
      header: L(2, 'Deploy Height'),
      className: 'right',
      text: (r) => cellText(heightVal(r)),
      sortKey: (r) => cellSort(heightVal(r)),
    },
    // Locked Funds / Owned Assets are interactive widgets — neither searchable
    // nor sortable.
    { header: L(3, 'Locked Funds') },
    { header: L(4, 'Owned Assets') },
  ];
  return (
    <>
      <H2>Deployed Smart Contracts</H2>
      <FilterTable
        columns={columns}
        rows={dataRows}
        renderRow={(r, i) => {
          const cid = r[0]?.value;
          const height = heightVal(r);
          return (
            <tr key={i}>
              <td>
                <CidLink cid={String(cid ?? '')} ctx={ctx} />
              </td>
              <td>
                <RenderValue value={r[1]} ctx={ctx} />
              </td>
              <td className="right">
                {height !== undefined && height !== null && height !== '' ? (
                  <BlockLink h={String(height)} ctx={ctx} />
                ) : null}
              </td>
              <td>
                <LockedFundsWidget funds={r[3]} ctx={ctx} />
              </td>
              <td>
                <OwnedAssetsWidget owned={r[4]} ctx={ctx} />
              </td>
            </tr>
          );
        }}
      />
    </>
  );
}

function MoreLink({ obj, ctx, view }: { obj: any; ctx: RenderCtx; view: ViewState }): JSX.Element | null {
  const more = obj?.more;
  if (!more || typeof more !== 'object') return null;
  return (
    <Pager>
      <Btn data-variant="ghost" onClick={() => ctx.go({ ...view, ...more })}>
        ← Older
      </Btn>
    </Pager>
  );
}

function AssetView({ data, view, ctx }: { data: any; view: ViewState; ctx: RenderCtx }): JSX.Element {
  const histObj = data?.['Asset history'];
  const histRowsRaw = histObj?.value;
  const histRows: any[][] = Array.isArray(histRowsRaw) ? histRowsRaw : [];
  const dist = data?.['Asset distribution'];
  return (
    <>
      <H2>
        Status of Asset
        {view.id}
      </H2>
      <Collapsible open>
        <summary>Asset History</summary>
        <FilterTable
          columns={[
            { header: 'Height', text: (r) => cellText(r[0]), sortKey: (r) => cellSort(r[0]) },
            { header: 'Event', text: (r) => cellText(r[1]), sortKey: (r) => cellSort(r[1]) },
            {
              header: 'Amount',
              className: 'right',
              text: (r) => cellText(r[2]),
              sortKey: (r) => cellSort(r[2]),
            },
            {
              header: 'Total Amount',
              className: 'right',
              text: (r) => cellText(r[3]),
              sortKey: (r) => cellSort(r[3]),
            },
            { header: 'Extra', text: (r) => cellText(r[4]), sortKey: (r) => cellSort(r[4]) },
          ]}
          rows={histRows.slice(1).map((row) => (Array.isArray(row) ? row : []) as any[])}
          renderRow={(r, i) => (
            <tr key={i}>
              <td>
                <BlockLink h={cellHeight(r[0])} ctx={ctx} />
              </td>
              <td>
                <RenderValue value={r[1]} ctx={ctx} />
              </td>
              <td className="right">
                <RenderValue value={r[2]} ctx={ctx} />
              </td>
              <td className="right">
                <RenderValue value={r[3]} ctx={ctx} />
              </td>
              <td>
                <RenderValue value={r[4]} ctx={ctx} />
              </td>
            </tr>
          )}
        />
        <MoreLink obj={histObj} ctx={ctx} view={view} />
      </Collapsible>
      {dist && (
        <Collapsible>
          <summary>Asset Distribution</summary>
          <RenderValue value={dist} ctx={ctx} />
        </Collapsible>
      )}
    </>
  );
}

function AssetsView({ data, view, ctx }: { data: any; view: ViewState; ctx: RenderCtx }): JSX.Element {
  const h = Number(view.height || 0);
  return (
    <>
      <H2>
        {view.height ? (
          <>
            Confidential Assets at block
            <BlockLink h={view.height} ctx={ctx} />
          </>
        ) : (
          'Current Confidential Assets'
        )}{' '}
        {h > 1 && (
          <Btn data-variant="ghost" onClick={() => ctx.go({ type: 'assets', height: String(h - 1) })}>
            ← Prev block
          </Btn>
        )}{' '}
        <Btn data-variant="ghost" onClick={() => ctx.go({ type: 'assets', height: String((h || 0) + 1) })}>
          Next block →
        </Btn>
      </H2>
      <AssetsTable data={data} ctx={ctx} ownerFilter={view.q} />
    </>
  );
}

function ContractStateView({ data, view, ctx }: { data: any; view: ViewState; ctx: RenderCtx }): JSX.Element {
  const callsObj = data?.['Calls history'];
  const callsRowsRaw = callsObj?.value;
  const callsRows: any[] = Array.isArray(callsRowsRaw) ? callsRowsRaw : [];

  // Derive column header labels from the first row of the table so we render
  // exactly the columns the explorer returned (different endpoints/versions
  // include or omit "Emission").
  const headerRowRaw = callsRows[0];
  const headerCells: any[] = Array.isArray(headerRowRaw) ? headerRowRaw : [];
  const headerLabels: string[] = headerCells.map((c: any) => String(c?.value ?? ''));
  const colCount = headerLabels.length;

  // Expand group rows recursively. Returns flat row list with depth markers.
  function expandGroup(row: any, depth = 0): Array<{ depth: number; row: any[] }> {
    if (row && typeof row === 'object' && row.type === 'group') {
      const out: Array<{ depth: number; row: any[] }> = [];
      const inners: any[] = Array.isArray(row.value) ? row.value : [];
      let d = depth;
      inners.forEach((inner: any, i: number) => {
        out.push(...expandGroup(inner, d));
        if (i === 0) d += 1;
      });
      return out;
    }
    return [{ depth, row: Array.isArray(row) ? row : [] }];
  }

  // Filter/sort operate at the top-level call granularity so a grouped call
  // (a primary call plus its nested fee/sub-calls) stays together; the column
  // accessors read the group's primary (depth-0) row.
  const FALLBACK_LABELS = ['Height', 'Cid', 'Kind', 'Method', 'Arguments', 'Funds', 'Keys'];
  const callColCount = headerLabels.length || FALLBACK_LABELS.length;
  const primaryRow = (r: any): any[] => expandGroup(r)[0]?.row ?? [];
  const callColumns: FilterColumn<any>[] = Array.from({ length: callColCount }).map((_, ci) => ({
    header: headerLabels[ci] || FALLBACK_LABELS[ci] || '',
    text: (r: any) => cellText(primaryRow(r)[ci]),
    sortKey: (r: any) => cellSort(primaryRow(r)[ci]),
  }));

  return (
    <>
      <H2>
        Contract
        <Mono style={{ color: theme.color.accent }}>{view.id}</Mono>
      </H2>
      <Collapsible open>
        <summary>Call history</summary>
        <FilterTable
          columns={callColumns}
          rows={callsRows.slice(1)}
          renderRow={(r, i) => {
            const expanded = expandGroup(r);
            return expanded.map((e, j) => {
              const { row } = e;
              const n = colCount || row.length;
              return (
                <tr key={`${i}-${j}`}>
                  {Array.from({ length: n }).map((_, ci) => {
                    const cell = row[ci];
                    const label = headerLabels[ci] || '';
                    if (ci === 0) {
                      return (
                        <td key={ci}>
                          {e.depth === 0 ? <BlockLink h={cellHeight(cell)} ctx={ctx} /> : <Muted>↳</Muted>}
                        </td>
                      );
                    }
                    // Funds/Emission columns get a dedicated FundsTable when
                    // the cell is a typed table; otherwise fall through to
                    // the generic renderer.
                    const isFundsCol = label === 'Funds' || label === 'Emission';
                    if (isFundsCol && isTypedCell(cell) && cell.type === 'table') {
                      const fundsRaw = (cell as TypedCell).value;
                      return (
                        <td key={ci}>
                          <FundsTable funds={Array.isArray(fundsRaw) ? (fundsRaw as unknown[]) : null} ctx={ctx} />
                        </td>
                      );
                    }
                    return (
                      <td key={ci}>
                        <RenderValue value={cell} ctx={ctx} />
                      </td>
                    );
                  })}
                </tr>
              );
            });
          }}
        />
        <MoreLink obj={callsObj} ctx={ctx} view={view} />
      </Collapsible>
      <Collapsible>
        <summary>State</summary>
        <RenderValue value={data?.State} ctx={ctx} />
      </Collapsible>
      <Collapsible>
        <summary>Locked Funds</summary>
        <LockedFundsWidget funds={data?.['Locked Funds']} ctx={ctx} maxRows={Infinity} />
      </Collapsible>
      <Collapsible>
        <summary>Owned assets</summary>
        <OwnedAssetsWidget owned={data?.['Owned assets']} ctx={ctx} maxRows={Infinity} />
      </Collapsible>
      <Collapsible>
        <summary>Version history</summary>
        <RenderValue value={data?.['Version History']} ctx={ctx} />
      </Collapsible>
    </>
  );
}

// Subset of hdrs column codes whose values are numeric and worth charting.
// 'T' is the timestamp axis, not a series; 'H' is the block hash. Everything
// else maps to a number after light parsing (comma-separated decimal or a
// typed-cell wrapper).
const CHARTABLE_COLS = 'NgGdDfFkKiIoOuUyYzZbBpPcCaA';

function parseHdrsNumber(cell: unknown): number | null {
  if (cell === null || cell === undefined) return null;
  if (typeof cell === 'number' && Number.isFinite(cell)) return cell;
  if (typeof cell === 'string') {
    const s = cell.replace(/,/g, '').trim();
    if (s === '') return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof cell === 'object' && cell !== null && 'value' in cell) {
    const v = (cell as { value: unknown }).value;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') {
      const n = Number(v.replace(/,/g, '').trim());
      return Number.isFinite(n) ? n : null;
    }
  }
  return null;
}

interface HdrsRow {
  height: number;
  ts: number | null;
  cols: Record<string, number | null>;
}

function extractHdrsRows(data: any, colCodes: string): HdrsRow[] {
  if (!data || typeof data !== 'object' || data.type !== 'table' || !Array.isArray(data.value)) return [];
  const dataRows: unknown[][] = (data.value as unknown[]).slice(1).filter(Array.isArray) as unknown[][];
  // Column order in the response: Height always at index 0, then `colCodes` in order.
  const out: HdrsRow[] = [];
  for (const row of dataRows) {
    const height = parseHdrsNumber(row[0]);
    if (height === null) continue;
    const cols: Record<string, number | null> = {};
    let ts: number | null = null;
    for (let i = 0; i < colCodes.length; i += 1) {
      const code = colCodes[i]!;
      const cell = row[i + 1];
      if (code === 'T') {
        ts = parseHdrsNumber(cell);
      } else {
        cols[code] = parseHdrsNumber(cell);
      }
    }
    out.push({ height, ts, cols });
  }
  return out;
}

const HdrsTableWrap = styled.div`
  /* Vertical column separators for the hdrs data grid, scoped so other
     explorer pages keep their borderless look. */
  table th,
  table td {
    border-right: 1px solid rgba(255, 255, 255, 0.06);
  }
  table th:last-child,
  table td:last-child {
    border-right: none;
  }
`;

const ColumnGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  grid-gap: 4px 12px;
  margin-top: 6px;
`;

const ColumnChip = styled.label`
  display: flex;
  align-items: center;
  & > * + * {
    margin-left: 6px;
  }
  font-size: 12px;
  cursor: pointer;
  user-select: none;
  padding: 2px 4px;
  border-radius: 4px;
  color: ${theme.color.muted};

  &:hover {
    color: ${theme.color.text};
    background: rgba(255, 255, 255, 0.03);
  }
  & > input {
    margin: 0;
    cursor: pointer;
  }
  & > input:disabled {
    cursor: default;
  }
  &[data-active='true'] {
    color: ${theme.color.text};
  }
`;

const ColorSwatch = styled.span<{ color?: string }>`
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 2px;
  background: ${(p) => p.color ?? 'transparent'};
  border: ${(p) => (p.color ? 'none' : '1px solid rgba(255,255,255,0.2)')};
`;

const ColumnPresets = styled.div`
  display: flex;
  & > * + * {
    margin-left: 8px;
  }
  align-items: center;
  font-size: 12px;
  color: ${theme.color.muted};
  flex-wrap: wrap;
  margin-top: 6px;
`;

const PresetLink = styled.a`
  cursor: pointer;
  color: ${theme.color.accent};
  text-decoration: none;
  &:hover {
    text-decoration: underline;
  }
`;

// ---------------------------------------------------------------------------
// Hdrs multi-series SVG chart — a faithful port of BeamExplorer.htm's custom
// graph. The x-axis is the row index across the fetched window; each enabled
// graphable column is its own polyline, normalized independently to the plot
// height by its own min/max, with a per-series colored value axis on the right
// (the Timestamp column 'T' gets date-formatted ticks). Series on/off is driven
// by the graph checkboxes injected into the data-table column headers, so the
// chart receives `plotted` (the set of enabled codes) and `colors` (per-column
// overrides) from HdrsView, plus a reset-all handler (palette icon) and a
// per-series recolor handler (legend color pickers).
// ---------------------------------------------------------------------------

// "Nice" axis ticks within [min,max] (port of defineNiceTicks): primary steps
// follow a 1/2/5/10 pattern; we round min/max outward to the step.
function niceTicks(
  rawMin: number,
  rawMax: number,
  targetTicks = 5,
): {
  values: number[];
  min: number;
  max: number;
} {
  let min = rawMin;
  let max = rawMax;
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    min = 0;
    max = 1;
  }
  if (min === max) {
    min -= 1;
    max += 1;
  }
  if (min > max) {
    const t = min;
    min = max;
    max = t;
  }
  const rawStep = (max - min) / targetTicks;
  const exponent = Math.floor(Math.log10(rawStep));
  const magnitude = 10 ** exponent;
  const rawFraction = rawStep / magnitude;
  const primaryFraction = rawFraction <= 1 ? 1 : rawFraction <= 2 ? 2 : rawFraction <= 5 ? 5 : 10;
  const primaryStep = primaryFraction * magnitude;
  const niceMin = Number((Math.floor(min / primaryStep) * primaryStep).toFixed(10));
  const niceMax = Number((Math.ceil(max / primaryStep) * primaryStep).toFixed(10));
  const values: number[] = [];
  // Bound the loop so a degenerate step can never spin forever.
  for (let v = niceMin, i = 0; Number(v.toFixed(10)) <= niceMax && i < 1000; v += primaryStep, i += 1) {
    values.push(Number(v.toFixed(10)));
  }
  if (values.length === 0) values.push(niceMin, niceMax);
  return { values, min: niceMin, max: niceMax };
}

// "Nice" tick values for a timestamp axis (seconds since epoch). A trimmed port
// of defineNiceTimeTicks: pick a unit (minute…year), snap the min down to that
// unit boundary, then step up by the unit until past max.
function niceTimeTicks(
  rawMin: number,
  rawMax: number,
  targetTicks = 5,
): {
  values: number[];
  min: number;
  max: number;
} {
  let min = rawMin;
  let max = rawMax;
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    min = 0;
    max = 60;
  }
  if (min === max) {
    min -= 60;
    max += 60;
  }
  if (min > max) {
    const t = min;
    min = max;
    max = t;
  }
  const MIN = 60;
  const HOUR = 3600;
  const DAY = 86400;
  const WEEK = 604800;
  const MONTH = 2629746; // 30.44 days
  const YEAR = 31556952; // 365.24 days
  const range = max - min;
  // Curated "nice" steps (seconds), ascending — pick the smallest that yields
  // about `targetTicks` ticks. Sub-hour steps keep short windows (minutes–hours)
  // from collapsing to a single hour-boundary label.
  const STEPS = [
    MIN,
    2 * MIN,
    5 * MIN,
    10 * MIN,
    15 * MIN,
    20 * MIN,
    30 * MIN,
    HOUR,
    2 * HOUR,
    3 * HOUR,
    6 * HOUR,
    12 * HOUR,
    DAY,
    2 * DAY,
    WEEK,
    2 * WEEK,
    MONTH,
    2 * MONTH,
    3 * MONTH,
    6 * MONTH,
    YEAR,
    2 * YEAR,
    5 * YEAR,
  ];
  const ideal = range / Math.max(1, targetTicks);
  let primaryStep = STEPS[STEPS.length - 1]!;
  for (const s of STEPS) {
    if (s >= ideal) {
      primaryStep = s;
      break;
    }
  }
  // Snap niceMin DOWN to a boundary aligned to the step (local calendar for
  // day+ steps; arithmetic flooring within the hour/day for sub-day steps).
  const d = new Date(min * 1000);
  let niceMin: number;
  if (primaryStep < HOUR) {
    const stepMin = primaryStep / MIN;
    const fm = Math.floor(d.getMinutes() / stepMin) * stepMin;
    niceMin = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), fm).getTime() / 1000;
  } else if (primaryStep < DAY) {
    const stepHr = primaryStep / HOUR;
    const fh = Math.floor(d.getHours() / stepHr) * stepHr;
    niceMin = new Date(d.getFullYear(), d.getMonth(), d.getDate(), fh).getTime() / 1000;
  } else if (primaryStep < WEEK) {
    niceMin = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000;
  } else if (primaryStep < MONTH) {
    niceMin = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7)).getTime() / 1000;
  } else if (primaryStep < YEAR) {
    niceMin = new Date(d.getFullYear(), d.getMonth(), 1).getTime() / 1000;
  } else {
    niceMin = new Date(d.getFullYear(), 0, 1).getTime() / 1000;
  }
  let niceMax = niceMin;
  for (let i = 0; niceMax <= max && i < 5000; i += 1) niceMax += primaryStep;
  const values: number[] = [];
  for (let v = niceMin, i = 0; v <= niceMax && i < 5000; v += primaryStep, i += 1) values.push(v);
  if (values.length === 0) values.push(niceMin, niceMax);
  return { values, min: niceMin, max: niceMax };
}

const intFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

// Size columns (Size.Compressed/Archive + their deltas) are byte counts.
const BYTE_CODES = new Set(['c', 'C', 'a', 'A']);

// Compact count: 2,000,000 -> "2M", 25,600 -> "25.6K".
function fmtCompact(v: number): string {
  if (!Number.isFinite(v)) return '';
  return compact(v, { trim: true, base: (x) => intFmt.format(x) });
}

// Byte count -> KB/MB/GB (decimal, so 4,000,000,000 -> "4 GB").
function fmtBytesAxis(v: number, decimals = 2): string {
  if (!Number.isFinite(v)) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let n = Math.abs(v);
  let i = 0;
  while (n >= 1000 && i < units.length - 1) {
    n /= 1000;
    i += 1;
  }
  const s = `${i === 0 ? n.toFixed(0) : n.toFixed(decimals).replace(/\.?0+$/, '')} ${units[i]}`;
  return v < 0 ? `-${s}` : s;
}

// Compact Y-axis tick label: per column → time, bytes, or compact count.
function fmtSeriesVal(code: string, isTime: boolean, v: number): string {
  if (isTime) return fmtAxisTime(v);
  if (BYTE_CODES.has(code)) return fmtBytesAxis(v);
  return fmtCompact(v);
}

// More precise variant for the hover cursor value (we have the room):
// full integer counts, byte sizes to 3 decimals.
function fmtSeriesValCursor(code: string, isTime: boolean, v: number): string {
  if (isTime) return fmtAxisTime(v);
  if (BYTE_CODES.has(code)) return fmtBytesAxis(v, 3);
  return intFmt.format(v);
}

// Compact date for a timestamp axis tick / cursor box (seconds since epoch).
function fmtAxisTime(sec: number): string {
  if (!Number.isFinite(sec)) return '';
  const d = new Date(sec * 1000);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Signed human duration for an interval in seconds (delta pills + time-series Δ).
function fmtDuration(sec: number): string {
  const sign = sec < 0 ? '-' : '';
  const s = Math.abs(sec);
  if (s < 90) return `${sign}${Math.round(s)}s`;
  const m = s / 60;
  if (m < 90) return `${sign}${Math.round(m)}m`;
  const h = s / 3600;
  if (h < 36) return `${sign}${h.toFixed(h < 10 ? 1 : 0)}h`;
  const d = s / 86400;
  return `${sign}${d.toFixed(d < 10 ? 1 : 0)}d`;
}

// <input type="color"> only accepts a #rrggbb value. Series colors are already
// hex (columnHeaders defaults + picker overrides), but coerce defensively:
// expand #rgb, drop alpha, and fall back to a neutral grey for anything
// non-hex so the picker never shows a blank value. (Faithful in spirit to the
// reference's convertColorToHex, without needing a canvas.)
function toHexColor(color: string): string {
  if (typeof color !== 'string') return '#888888';
  const c = color.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(c)) return c.toLowerCase();
  if (/^#[0-9a-fA-F]{8}$/.test(c)) return c.slice(0, 7).toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(c)) {
    return `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}`.toLowerCase();
  }
  return '#888888';
}

const ChartCard = styled.div`
  background: ${theme.color.surface};
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 6px;
  margin: 8px 0 12px;
  padding: 10px 12px 6px;
`;

const ChartToolbar = styled.div`
  display: flex;
  align-items: center;
  & > * + * {
    margin-left: 10px;
  }
  margin-bottom: 6px;
  font-size: 11px;
  color: ${theme.color.muted};
`;

const ChartIconBtn = styled.button`
  background: transparent;
  border: 1px solid ${theme.color.border};
  border-radius: 4px;
  color: ${theme.color.muted};
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  line-height: 1;
  padding: 4px 8px;
  &:hover {
    color: ${theme.color.text};
    border-color: ${theme.color.text};
  }
  &:disabled {
    opacity: 0.4;
    cursor: default;
  }
`;

const ChartLegend = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  margin: 6px 0 2px;
  font-size: 12px;
  color: ${theme.color.muted};
`;

const ChartHint = styled.div`
  color: ${theme.color.muted};
  font-size: 12px;
  padding: 28px 8px;
  text-align: center;
`;

// Small square color picker styled to read as a legend swatch. Avoids
// Chrome-83-unsupported CSS (no gap/inset/:has); the chrome around the native
// swatch is trimmed with padding:0 + border so it stays compact.
const LegendColorPicker = styled.input`
  width: 14px;
  height: 14px;
  padding: 0;
  margin: 0;
  border: 1px solid rgba(255, 255, 255, 0.25);
  border-radius: 3px;
  background: none;
  cursor: pointer;
  vertical-align: middle;
  &::-webkit-color-swatch-wrapper {
    padding: 0;
  }
  &::-webkit-color-swatch {
    border: none;
    border-radius: 2px;
  }
`;

// Plot geometry. The plot uses a fixed viewBox stretched to the container via
// preserveAspectRatio="none" (matching the reference's scale(1,-1) approach,
// but in React space we just compute y downward directly). Right-side value
// axes are separate fixed-width SVGs, one per enabled series.
const PLOT_W = 1000;
const PLOT_H = 320;
const PAD_X = 8;
const PAD_Y = 14;
const AXIS_W = 78; // px per per-series value axis on the right
const TS_AXIS_W = 96; // a touch wider for date labels
const DRAG_HIT_PX = 6; // viewBox units: click/drag hit radius for a comparison-point line

interface ChartSeries {
  code: string;
  color: string;
  isTime: boolean;
  /** Values aligned to the row index. Faithful to the reference's
   *  updateGraphDataY: an empty/missing cell becomes 0 (NOT a gap), and 'T'
   *  uses the raw unix-seconds value. The series is one continuous polyline. */
  raw: number[];
  ticks: { values: number[]; min: number; max: number };
}

function HdrsChart({
  rows,
  plotted,
  colors,
  onReset,
  onSetColor,
  embedded,
  pointsApi,
  expanded: expandedProp,
  onExpandedChange,
}: {
  rows: HdrsRow[];
  plotted: string[];
  colors: Record<string, string>;
  /** Reset all series colors to their column defaults (palette icon). */
  onReset: () => void;
  /** Override one series' color (per-series color picker in the legend). */
  onSetColor: (code: string, color: string) => void;
  /** When true, rendered inside a ChartModal — hides the expand button and
   *  never renders a nested modal (prevents recursion). */
  embedded?: boolean;
  /** Shared comparison-point state. The embedded (modal) instance receives the
   *  outer instance's hook so points + mode are shared between inline and modal. */
  pointsApi?: UseComparePoints<number>;
  /** Controlled expand state. Passed by a caller that keeps it in the URL, so
   *  the expanded chart is linkable; omitted, the chart owns the state itself. */
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}): JSX.Element {
  // Rows in ascending height = ascending row index along the x-axis.
  const ordered = useMemo(() => [...rows].sort((a, b) => a.height - b.height), [rows]);
  const n = ordered.length;

  // Only chart codes that are actually graphable + known.
  const codes = useMemo(
    () => plotted.filter((c) => CHARTABLE_COLS.includes(c) && columnHeaders[c] !== undefined),
    [plotted],
  );

  // Build one series per enabled code: real values per row index + nice ticks
  // from that series' own finite min/max (independent normalization).
  const series = useMemo<ChartSeries[]>(() => {
    const out: ChartSeries[] = [];
    for (const code of codes) {
      const isTime = code === 'T';
      // Match updateGraphDataY: empty/missing cell -> 0 (NOT a gap). For the
      // Timestamp column use the raw unix-seconds value (also 0 if missing).
      const raw: number[] = ordered.map((r) => {
        const v = isTime ? r.ts : r.cols[code];
        return typeof v === 'number' && Number.isFinite(v) ? v : 0;
      });
      let min = Infinity;
      let max = -Infinity;
      for (const v of raw) {
        if (v < min) min = v;
        if (v > max) max = v;
      }
      const ticks = isTime ? niceTimeTicks(min, max, 5) : niceTicks(min, max, 5);
      out.push({
        code,
        color: colors[code] ?? columnHeaders[code]?.color ?? '#00f6d2',
        isTime,
        raw,
        ticks,
      });
    }
    return out;
  }, [codes, ordered, colors]);

  // ---- X-axis source (faithful to updateGraphDataX + #xAxisSelect) --------
  // The reference allows 'row' (table row), 'h' (blockheight), 'N' (block
  // number) and 'T' (timestamp). We always have height + ts, so 'row', 'h' and
  // 'T' are available; 'T' is disabled only when every row's ts is null. The
  // per-point x is normalized over the REAL min/max of the selected source
  // (the reference forces real min/max for the X axis), so the polyline spans
  // the full plot width. Default to 'T' (timestamp).
  type XSource = 'row' | 'h' | 'T';
  const tsAvailable = useMemo(() => ordered.some((r) => typeof r.ts === 'number' && Number.isFinite(r.ts)), [ordered]);
  const [xSource, setXSource] = useState<XSource>('T');
  // If timestamp is unavailable for the current data, fall back to row index.
  const activeXSource: XSource = xSource === 'T' && !tsAvailable ? 'row' : xSource;

  // The raw x VALUE per row index for the active source. 'row' => 1..n (matches
  // the reference's `length - index` ascending), 'h' => height, 'T' => raw
  // unix-seconds. Null ts is handled defensively below so x never goes NaN.
  const xValues = useMemo<number[]>(() => {
    if (activeXSource === 'row') return ordered.map((_, i) => i + 1);
    if (activeXSource === 'h') return ordered.map((r) => r.height);
    // 'T': raw seconds; carry the last known ts across null gaps so the point
    // still lands monotonically and never produces NaN.
    let last = 0;
    return ordered.map((r) => {
      if (typeof r.ts === 'number' && Number.isFinite(r.ts)) {
        last = r.ts;
        return r.ts;
      }
      return last;
    });
  }, [activeXSource, ordered]);

  const isXTime = activeXSource === 'T';

  // Real min/max of the x source across the rows (rows are ascending, so the
  // values are monotonic — first/last would do, but min/max is safe).
  const xMinMax = useMemo<{ min: number; max: number }>(() => {
    let min = Infinity;
    let max = -Infinity;
    for (const v of xValues) {
      if (Number.isFinite(v)) {
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    if (!Number.isFinite(min)) min = 0;
    if (!Number.isFinite(max)) max = 1;
    return { min, max };
  }, [xValues]);

  // X position (in viewBox units) for a given row index, from the source value
  // normalized over [min,max]: padding + width*(x-min)/(max-min) (the reference
  // xsvg formula). Degenerate (min===max / single point) → centre.
  const xAt = useCallback(
    (idx: number): number => {
      if (n <= 1) return PLOT_W / 2;
      const { min, max } = xMinMax;
      const span = max - min;
      if (!(span > 0)) return PLOT_W / 2;
      const v = xValues[idx] ?? min;
      return PAD_X + (PLOT_W - 2 * PAD_X) * ((v - min) / span);
    },
    [n, xMinMax, xValues],
  );

  // Y position (viewBox units, top=0) for a real value on a series' scale.
  // Flat series (min===max after nice-rounding) draw at the vertical middle.
  const yFor = useCallback((s: ChartSeries, value: number): number => {
    const lo = s.ticks.min;
    const hi = s.ticks.max;
    const inner = PLOT_H - 2 * PAD_Y;
    if (!(hi > lo)) return PAD_Y + inner / 2;
    const frac = (value - lo) / (hi - lo);
    return PLOT_H - PAD_Y - inner * frac; // invert: larger value = higher up
  }, []);

  // Cursor: nearest row index under the mouse (null when not hovering).
  const [cursor, setCursor] = useState<number | null>(null);
  const plotRef = useRef<SVGSVGElement>(null);
  const axisRef = useRef<HTMLDivElement>(null);

  // Comparison points keyed by sample row index (cap 4, one per sample).
  // Own state for the inline instance; the embedded (modal) instance instead
  // uses the shared `pointsApi`, so points + mode are the same in both views.
  const ownPoints = useComparePoints<number>({ cap: 4 });
  const pts = pointsApi ?? ownPoints;

  const [ownExpanded, setOwnExpanded] = useState(false);
  const expanded = expandedProp ?? ownExpanded;
  const setExpanded = useCallback(
    (next: boolean) => {
      if (onExpandedChange) onExpandedChange(next);
      else setOwnExpanded(next);
    },
    [onExpandedChange],
  );
  const closeModal = useCallback(() => setExpanded(false), [setExpanded]);

  // Nearest sample row index for a clientX (shared by hover + add).
  const nearestIndex = useCallback(
    (clientX: number): number | null => {
      const el = plotRef.current;
      if (!el || n === 0) return null;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0) return null;
      if (n === 1) return 0;
      const xUnits = ((clientX - rect.left) / rect.width) * PLOT_W;
      let best = 0;
      let bestDist = Infinity;
      for (let i = 0; i < n; i += 1) {
        const d = Math.abs(xUnits - xAt(i));
        if (d < bestDist) {
          bestDist = d;
          best = i;
        }
      }
      return best;
    },
    [n, xAt],
  );

  const [dragIdx, setDragIdx] = useState<number | null>(null); // raw pts.keys index being dragged

  // Sample row index of a point whose line is within DRAG_HIT_PX of clientX (else null).
  const pointNear = useCallback(
    (clientX: number): number | null => {
      const el = plotRef.current;
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0) return null;
      const xUnits = ((clientX - rect.left) / rect.width) * PLOT_W;
      let best: number | null = null;
      let bestDist = DRAG_HIT_PX;
      pts.keys.forEach((idx) => {
        const d = Math.abs(xUnits - xAt(idx));
        if (d <= bestDist) {
          bestDist = d;
          best = idx;
        }
      });
      return best;
    },
    [pts.keys, xAt],
  );

  const onMouseDown = useCallback(
    (e: React.MouseEvent<SVGSVGElement>): void => {
      if (e.button !== 0) return; // left only
      const near = pointNear(e.clientX);
      if (near !== null) {
        const rawIdx = pts.keys.indexOf(near);
        if (rawIdx !== -1) setDragIdx(rawIdx);
      }
    },
    [pointNear, pts.keys],
  );

  const onMouseUp = useCallback(() => setDragIdx(null), []);

  const onContextMenu = useCallback(
    (e: React.MouseEvent<SVGSVGElement>): void => {
      const near = pointNear(e.clientX);
      if (near !== null) {
        e.preventDefault();
        pts.remove(near);
      }
    },
    [pointNear, pts],
  );

  const onMove = useCallback(
    (e: React.MouseEvent<SVGSVGElement>): void => {
      const i = nearestIndex(e.clientX);
      if (i === null) return;
      if (dragIdx !== null) {
        pts.move(dragIdx, i);
        return;
      }
      setCursor(i);
    },
    [nearestIndex, dragIdx, pts],
  );

  // Click drops a comparison point at the hovered sample (skip if clicking an existing point).
  const onPlotClick = useCallback(
    (e: React.MouseEvent<SVGSVGElement>): void => {
      if (n < 2) return; // need ≥2 samples for points/deltas to mean anything
      if (pointNear(e.clientX) !== null) return; // clicking on an existing point = no add
      const i = cursor ?? nearestIndex(e.clientX);
      if (i !== null) pts.add(i);
    },
    [n, pointNear, cursor, nearestIndex, pts],
  );

  const clearCursor = useCallback(() => setCursor(null), []);

  // New data window → drop stale cursor + all points (heights differ). Only the
  // owning (non-embedded) instance clears points, so mounting the embedded modal
  // instance does not wipe the shared points.
  useEffect(() => {
    setCursor(null);
    if (!embedded) pts.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [n]);

  // Esc clears all comparison points on the live inline chart. Skipped while the
  // modal is open (the ChartModal owns Esc → close) and in the embedded modal
  // instance — otherwise that instance's listener would also fire on the same
  // window keydown. (In the modal, points are cleared via the "Clear points" button.)
  useEffect(() => {
    if (expanded || embedded) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') pts.clear();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pts.clear, expanded, embedded]);

  // End a drag even if the mouse is released outside the plot (the svg's own
  // mouseup never fires there), so a dragged point can't latch to the cursor.
  useEffect(() => {
    if (dragIdx === null) return undefined;
    const end = (): void => setDragIdx(null);
    document.addEventListener('mouseup', end);
    return () => document.removeEventListener('mouseup', end);
  }, [dragIdx]);

  // Hide x-axis tick labels that visually collide with a comparison-point date
  // pill. Measured against the live DOM, so it's correct at any plot width
  // (a fixed viewBox-unit estimate under/over-shoots as the chart resizes).
  useLayoutEffect(() => {
    const root = axisRef.current;
    if (!root) return undefined;
    const measure = (): void => {
      const pills = Array.from(root.querySelectorAll<HTMLElement>('[data-xpill]')).map((p) =>
        p.getBoundingClientRect(),
      );
      root.querySelectorAll<HTMLElement>('[data-xtick]').forEach((t) => {
        t.style.visibility = '';
        const r = t.getBoundingClientRect();
        if (pills.some((p) => r.left < p.right + 2 && r.right > p.left - 2)) t.style.visibility = 'hidden';
      });
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [pts.keys, activeXSource, n, series]);

  const cursorX = cursor !== null ? xAt(cursor) : null;

  // Map a raw x VALUE (in source units) to its viewBox x position, using the
  // same normalization as xAt — so axis ticks line up with the polyline even
  // when ticks fall between samples.
  const xPos = (v: number): number => {
    const { min, max } = xMinMax;
    const span = max - min;
    if (!(span > 0)) return PLOT_W / 2;
    return PAD_X + (PLOT_W - 2 * PAD_X) * ((v - min) / span);
  };

  // Horizontal x-axis ticks reflect the selected source. Faithful to the
  // reference drawXAxis: build ~5 nice primary tick VALUES, but map every value
  // through the SAME real-min/max normalization the polylines use (xPos), and
  // keep only the ticks whose mapped x lands within the plot's [left,right]
  // bounds. The reference forces the REAL data min/max into the value→x mapping
  // (updateGraphDataX line "if (min != max) [xTicks.min, xTicks.max] = [min,max]"),
  // so nice ticks that fall outside the data range simply map to x<left / x>right
  // and are dropped here — typically leaving ~4-6 labels spread across the axis.
  // The earlier bug clamped nice-tick VALUES to [min,max] and `continue`d on any
  // outside it; for the timestamp source niceTimeTicks snaps to unit boundaries
  // that mostly fall outside the real range, so all-but-one were skipped and the
  // axis showed a single label.
  const PLOT_LEFT = PAD_X;
  const PLOT_RIGHT = PLOT_W - PAD_X;
  const xTicks: { value: number; x: number }[] = [];
  {
    const { min, max } = xMinMax;
    // Degenerate range (single sample / flat source): one centred label.
    if (n === 1 || !(max > min)) {
      xTicks.push({ value: min, x: PLOT_W / 2 });
    } else {
      // Nice primary tick values across [min,max]. Time uses calendar-aware
      // ticks; row/height use the 1/2/5/10 nice ticks. Both return primary
      // values that bracket the range (first ≤ min, last ≥ max), so several
      // land strictly inside once mapped through xPos().
      const tickValues = isXTime ? niceTimeTicks(min, max, 5).values : niceTicks(min, max, 5).values;
      for (const v of tickValues) {
        const x = xPos(v);
        // Only label ticks whose mapped position is within the plot bounds
        // (mirrors the reference's `pos > 0 && pos < 100` visibility gate).
        if (x < PLOT_LEFT - 0.5 || x > PLOT_RIGHT + 0.5) continue;
        xTicks.push({ value: v, x });
      }
      // Fallback: if nothing landed inside (extremely narrow range), anchor the
      // two ends so the axis is still labelled.
      if (xTicks.length === 0) {
        xTicks.push({ value: min, x: xPos(min) }, { value: max, x: xPos(max) });
      }
    }
  }
  // Label for an x value per the active source: timestamp formatted, else int.
  const fmtXLabel = (v: number): string => (isXTime ? fmtAxisTime(v) : intFmt.format(Math.round(v)));
  // The X-value box at the cursor shows the selected source's value at that row.
  const cursorXValue = cursor !== null ? xValues[cursor] ?? null : null;

  // Display-sorted point indices (row indices are monotonic in x, so numeric sort = x order).
  const pointIdx = useMemo(() => [...pts.keys].sort((a, b) => a - b), [pts.keys]);
  const todayIdx = n - 1;

  const seriesDesc = useMemo<SeriesDescriptor[]>(
    () =>
      series.map((s) => ({
        id: s.code,
        label: columnHeaders[s.code]?.title ?? s.code,
        color: s.color,
        format: (v: number) => fmtSeriesValCursor(s.code, s.isTime, v),
        formatDelta: (dv: number) =>
          s.isTime ? fmtDuration(dv) : `${dv >= 0 ? '+' : '-'}${fmtSeriesValCursor(s.code, s.isTime, Math.abs(dv))}`,
        percentable: !s.isTime,
      })),
    [series],
  );

  const resolveAt = useCallback(
    (idx: number): ResolvedPoint => ({
      xValue: xValues[idx] ?? 0,
      xLabel: fmtXLabel(xValues[idx] ?? 0),
      values: Object.fromEntries(series.map((s) => [s.code, s.raw[idx] ?? 0])),
    }),
    [xValues, series],
  );

  const deltaModel = useMemo(
    () => computeDeltas(pointIdx.map(resolveAt), resolveAt(todayIdx), seriesDesc, pts.mode, pts.baselineIndex),
    [pointIdx, resolveAt, todayIdx, seriesDesc, pts.mode, pts.baselineIndex],
  );

  // Empty-data return lives BELOW every hook: n can flip between 0 and >0 on a
  // refetch while mounted, and an early return above the hooks would change
  // the hook order between renders and crash the chart.
  if (n === 0) {
    return (
      <ChartCard>
        <ChartHint>No block-header rows to chart.</ChartHint>
      </ChartCard>
    );
  }

  // x-delta label for a top pill spanning samples a→b.
  const xDeltaLabel = (a: number, b: number): string => {
    const dv = (xValues[b] ?? 0) - (xValues[a] ?? 0);
    const main = isXTime
      ? `~${fmtDuration(dv)}`
      : activeXSource === 'h'
      ? `+${intFmt.format(dv)} blk`
      : `+${intFmt.format(dv)} rows`;
    const aTs = ordered[a]?.ts;
    const bTs = ordered[b]?.ts;
    const dur = !isXTime && typeof aTs === 'number' && typeof bTs === 'number' ? ` · ~${fmtDuration(bTs - aTs)}` : '';
    return main + dur;
  };

  // Pill segments: between adjacent points, then last point → today.
  const pillSeq =
    pointIdx.length === 0 ? [] : pointIdx[pointIdx.length - 1] === todayIdx ? pointIdx : [...pointIdx, todayIdx];
  const pills = pillSeq.slice(0, -1).map((a, i) => {
    const b = pillSeq[i + 1]!;
    return {
      a,
      b,
      midX: (xAt(a) + xAt(b)) / 2,
      text: xDeltaLabel(a, b),
    };
  });

  // Hide x-axis tick labels that would collide with a comparison-point date pill
  // (the pill wins). ~5.4 viewBox units per char approximates a label's width.
  const visibleXTicks = xTicks.filter((t) => {
    const labelW = fmtXLabel(t.value).length * 5.4;
    return !pointIdx.some((idx) => Math.abs(xAt(idx) - t.x) < labelW);
  });

  // Extended-view exports (built lazily on click). The SVG/PNG is a normalized
  // snapshot: one polyline per series + the comparison-point vertical lines.
  const exportCsv = (): void => {
    const exportRows: HdrsExportRow[] = ordered.map((r, i) => ({
      height: r.height,
      ts: typeof r.ts === 'number' ? r.ts : null,
      values: Object.fromEntries(series.map((s) => [s.code, s.raw[i] ?? 0])),
    }));
    const csv = buildHdrsCsv(
      exportRows,
      series.map((s) => ({ id: s.code, label: columnHeaders[s.code]?.title ?? s.code })),
      'Block headers',
    );
    downloadBlob(csv, 'block-headers.csv', 'text/csv;charset=utf-8');
  };

  const buildSvgModel = (): HdrsSvgModel => ({
    title: 'Block headers',
    width: PLOT_W,
    height: PLOT_H,
    series: series.map((s) => ({
      label: columnHeaders[s.code]?.title ?? s.code,
      color: s.color,
      path:
        n < 2
          ? ''
          : ordered
              .map((_, i) => `${i === 0 ? 'M' : 'L'}${xAt(i).toFixed(1)},${yFor(s, s.raw[i]!).toFixed(1)}`)
              .join(' '),
      // Per-series value-axis ticks, same scale/formatter as the live right-edge axes.
      axis: s.ticks.values
        .map((tv) => ({ y: yFor(s, tv), label: fmtSeriesVal(s.code, s.isTime, tv) }))
        .filter((a) => a.y >= 0 && a.y <= PLOT_H),
    })),
    xLabels: visibleXTicks.map((t) => ({ x: t.x, text: fmtXLabel(t.value) })),
    verticals: pointIdx.map((idx) => ({ x: xAt(idx), label: fmtXLabel(xValues[idx] ?? 0) })),
    topPills: pills.map((p) => ({ x: p.midX, text: p.text })),
    deltaTable: pointIdx.length > 0 ? deltaModel : undefined,
    deltaMode: pts.mode,
  });

  const exportSvg = (): void => downloadBlob(buildHdrsSvg(buildSvgModel()), 'block-headers.svg', 'image/svg+xml');
  const exportPng = (): void => downloadSvgAsPng(buildHdrsSvg(buildSvgModel()), 'block-headers.png');

  return (
    <ChartCard>
      <ChartToolbar>
        {/* Palette icon = reset all series colors to their defaults (faithful
            to #resetColors / resetGraphColors). No randomize. */}
        <ChartIconBtn type="button" title="Reset all graph colors to defaults" onClick={onReset}>
          &#127912;
        </ChartIconBtn>
        {/* X-axis source selector (faithful to #xAxisSelect): 'row' always
            available + default in the reference, but the user wants Timestamp
            by default here. Timestamp is disabled only when no row has a ts. */}
        <label style={{ display: 'inline-flex', alignItems: 'center' }} title="Change data of horizontal scale">
          <span style={{ marginRight: 6 }}>x-axis:</span>
          <Select
            style={{ display: 'inline-block' }}
            value={activeXSource}
            onChange={(e) => setXSource(e.target.value as XSource)}
          >
            <option value="row">Row index</option>
            <option value="h">Height</option>
            <option value="T" disabled={!tsAvailable}>
              Timestamp
            </option>
          </Select>
        </label>
        {!embedded && (
          <ChartIconBtn type="button" title="Expand chart" aria-label="Expand chart" onClick={() => setExpanded(true)}>
            <svg
              width="12"
              height="12"
              viewBox="0 0 12 12"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="7 1 11 1 11 5" />
              <polyline points="5 11 1 11 1 7" />
              <line x1="11" y1="1" x2="7" y2="5" />
              <line x1="1" y1="11" x2="5" y2="7" />
            </svg>
          </ChartIconBtn>
        )}
        {pts.keys.length > 0 && (
          <ChartIconBtn type="button" title="Clear comparison points" onClick={pts.clear}>
            Clear points
          </ChartIconBtn>
        )}
        <span style={{ marginLeft: 'auto' }}>
          {pts.keys.length >= 4
            ? 'max 4 comparison points · right-click a point to remove'
            : embedded
            ? 'click plot to add a comparison point · drag to move · right-click to remove'
            : 'check columns in the table below to plot them · click plot to add a comparison point'}
        </span>
      </ChartToolbar>

      {series.length === 0 ? (
        <ChartHint>
          No series selected. Tick a graphable column&apos;s checkbox in the table header to plot it.
        </ChartHint>
      ) : (
        <div style={{ display: 'flex', alignItems: 'stretch' }}>
          {/* Plot area (flex-grows; right axes are fixed width). */}
          <div style={{ flex: '1 1 auto', minWidth: 0, position: 'relative' }}>
            {pills.map((p, i) => (
              <span
                key={`pill-${i}`}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: `${(p.midX / PLOT_W) * 100}%`,
                  transform: 'translateX(-50%)',
                  background: theme.color.accent,
                  color: '#04222f',
                  borderRadius: 3,
                  padding: '1px 5px',
                  fontSize: 10,
                  fontWeight: 600,
                  fontVariantNumeric: 'tabular-nums',
                  whiteSpace: 'nowrap',
                  pointerEvents: 'none',
                  zIndex: 2,
                }}
              >
                {p.text}
              </span>
            ))}
            <svg
              ref={plotRef}
              width="100%"
              height={PLOT_H}
              viewBox={`0 0 ${PLOT_W} ${PLOT_H}`}
              preserveAspectRatio="none"
              style={{ display: 'block', cursor: 'crosshair' }}
              onMouseDown={onMouseDown}
              onMouseUp={onMouseUp}
              onMouseMove={onMove}
              onMouseLeave={clearCursor}
              onClick={onPlotClick}
              onContextMenu={onContextMenu}
            >
              {/* Reference grid lines at 1/4, 1/2, 3/4 of the plot height. */}
              {[0.25, 0.5, 0.75].map((f) => {
                const y = PAD_Y + (PLOT_H - 2 * PAD_Y) * f;
                return (
                  <line
                    key={f}
                    x1={PAD_X}
                    x2={PLOT_W - PAD_X}
                    y1={y}
                    y2={y}
                    stroke="rgba(255,255,255,0.06)"
                    strokeWidth={1}
                    vectorEffect="non-scaling-stroke"
                  />
                );
              })}

              {/* One single continuous polyline per enabled series through ALL
                  points — faithful to drawGraph. Missing cells are already 0,
                  so there are no gaps to split on. Needs >=2 points to draw. */}
              {series.map((s) => {
                if (n < 2) return null;
                const svgPts: string[] = [];
                for (let i = 0; i < n; i += 1) {
                  svgPts.push(`${xAt(i).toFixed(2)},${yFor(s, s.raw[i]!).toFixed(2)}`);
                }
                return (
                  <polyline
                    key={s.code}
                    points={svgPts.join(' ')}
                    fill="none"
                    stroke={s.color}
                    strokeWidth={1.6}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    vectorEffect="non-scaling-stroke"
                  />
                );
              })}

              {/* Hover cursor: vertical line at the hovered point. */}
              {cursorX !== null && (
                <line
                  x1={cursorX}
                  x2={cursorX}
                  y1={PAD_Y}
                  y2={PLOT_H - PAD_Y}
                  stroke="rgba(255,255,255,0.5)"
                  strokeWidth={1}
                  vectorEffect="non-scaling-stroke"
                />
              )}

              {/* Comparison-point vertical lines (solid accent) + today (dim dashed). */}
              {pointIdx.map((idx) => (
                <line
                  key={`pt-${idx}`}
                  x1={xAt(idx)}
                  x2={xAt(idx)}
                  y1={PAD_Y}
                  y2={PLOT_H - PAD_Y}
                  stroke={theme.color.accent}
                  strokeWidth={1.2}
                  vectorEffect="non-scaling-stroke"
                />
              ))}
              {pointIdx.length > 0 && !pointIdx.includes(todayIdx) && (
                <line
                  x1={xAt(todayIdx)}
                  x2={xAt(todayIdx)}
                  y1={PAD_Y}
                  y2={PLOT_H - PAD_Y}
                  stroke="rgba(255,255,255,0.35)"
                  strokeWidth={1}
                  strokeDasharray="2 3"
                  vectorEffect="non-scaling-stroke"
                />
              )}

              {/* Hover cursor: per-series dot at the hovered point. */}
              {cursor !== null &&
                series.map((s) => (
                  <circle
                    key={`dot-${s.code}`}
                    cx={xAt(cursor)}
                    cy={yFor(s, s.raw[cursor]!)}
                    r={2.5}
                    fill={s.color}
                    vectorEffect="non-scaling-stroke"
                  />
                ))}
            </svg>

            {/* Bottom x-axis: source-aware ticks + boxed cursor X value. Ticks
                are integers for row/height and YYYY-MM-DD HH:MM for timestamp.
                The cursor box shows the selected source's value at the row. */}
            <div ref={axisRef} style={{ position: 'relative', height: 18, marginTop: 2 }}>
              {xTicks.map((t, ti) => {
                // Nudge the first/last labels inward (left-/right-align instead
                // of centre) so they don't clip at the plot edges — equivalent
                // to the reference dropping out-of-range labels at the very ends.
                const isFirst = ti === 0;
                const isLast = ti === xTicks.length - 1 && xTicks.length > 1;
                const align = isFirst ? 'translateX(0)' : isLast ? 'translateX(-100%)' : 'translateX(-50%)';
                return (
                  <span
                    key={`xt-${ti}-${t.value}`}
                    data-xtick=""
                    style={{
                      position: 'absolute',
                      left: `${(t.x / PLOT_W) * 100}%`,
                      transform: align,
                      fontSize: 10,
                      color: theme.color.muted,
                      fontVariantNumeric: 'tabular-nums',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {fmtXLabel(t.value)}
                  </span>
                );
              })}
              {cursor !== null && cursorXValue !== null && (
                <span
                  style={{
                    position: 'absolute',
                    left: `${(xAt(cursor) / PLOT_W) * 100}%`,
                    transform: 'translateX(-50%)',
                    top: -2,
                    background: 'rgba(255,255,255,0.12)',
                    color: theme.color.text,
                    borderRadius: 3,
                    padding: '1px 5px',
                    fontSize: 10,
                    fontVariantNumeric: 'tabular-nums',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {fmtXLabel(cursorXValue)}
                </span>
              )}
              {/* Per-comparison-point date pill (accent), matching the old
                  frozen-cursor pill style — the date sits below each marker. */}
              {pointIdx.map((idx) => (
                <span
                  key={`xpt-${idx}`}
                  data-xpill=""
                  style={{
                    position: 'absolute',
                    left: `${(xAt(idx) / PLOT_W) * 100}%`,
                    transform: 'translateX(-50%)',
                    top: -2,
                    background: theme.color.accent,
                    color: '#04222f',
                    borderRadius: 3,
                    padding: '1px 5px',
                    fontSize: 10,
                    fontWeight: 600,
                    fontVariantNumeric: 'tabular-nums',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {fmtXLabel(xValues[idx] ?? 0)}
                </span>
              ))}
            </div>
          </div>

          {/* Right-edge value axes, one per enabled series, in series color.
              On hover, each series' value is shown as a boxed "scale cursor"
              positioned ON its own axis at the value's height (clamped within
              the axis pixel range), faithful to drawYAxis + scaleCursorY. Each
              value sits on its own dedicated axis column, so they never
              collide when lines cross. */}
          {series.map((s) => {
            const w = s.isTime ? TS_AXIS_W : AXIS_W;
            const inner = PLOT_H - 2 * PAD_Y;
            // Scale-cursor position for this series at the hovered sample.
            let cursorTopPx: number | null = null;
            let cursorLabel = '';
            if (cursor !== null) {
              const yPx = yFor(s, s.raw[cursor]!);
              // Clamp so the box never leaves the axis area.
              cursorTopPx = Math.max(PAD_Y, Math.min(PLOT_H - PAD_Y, yPx));
              cursorLabel = fmtSeriesValCursor(s.code, s.isTime, s.raw[cursor]!);
            }
            return (
              <div
                key={`axis-${s.code}`}
                style={{
                  width: w,
                  flex: `0 0 ${w}px`,
                  position: 'relative',
                  height: PLOT_H,
                }}
                title={columnHeaders[s.code]?.description}
              >
                <svg width={w} height={PLOT_H} style={{ display: 'block', overflow: 'visible' }}>
                  <line x1={0} x2={0} y1={PAD_Y} y2={PLOT_H - PAD_Y} stroke={s.color} strokeWidth={1.5} />
                  {s.ticks.values.map((tv, ti) => {
                    const lo = s.ticks.min;
                    const hi = s.ticks.max;
                    const frac = hi > lo ? (tv - lo) / (hi - lo) : 0.5;
                    const y = PLOT_H - PAD_Y - inner * frac;
                    if (y < 0 || y > PLOT_H) return null;
                    return (
                      <g key={ti}>
                        <line x1={0} x2={5} y1={y} y2={y} stroke={s.color} strokeWidth={1.5} />
                        <text x={7} y={y} fill={s.color} fontSize={10} textAnchor="start" dominantBaseline="middle">
                          {fmtSeriesVal(s.code, s.isTime, tv)}
                        </text>
                      </g>
                    );
                  })}
                </svg>
                {cursorTopPx !== null && (
                  <span
                    style={{
                      position: 'absolute',
                      left: 4,
                      top: cursorTopPx,
                      transform: 'translateY(-50%)',
                      background: 'rgba(0,0,0,0.85)',
                      border: `1px solid ${s.color}`,
                      color: s.color,
                      borderRadius: 3,
                      padding: '0 3px',
                      fontSize: 10,
                      fontWeight: 600,
                      lineHeight: '13px',
                      fontVariantNumeric: 'tabular-nums',
                      whiteSpace: 'nowrap',
                      pointerEvents: 'none',
                    }}
                  >
                    {cursorLabel}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {pointIdx.length > 0 && (
        <DeltaPanel model={deltaModel} mode={pts.mode} onModeChange={pts.setMode} onBaselineChange={pts.setBaseline} />
      )}

      {/* Legend: each enabled series' swatch is a per-series <input type="color">
          bound to its color (faithful to graphColorPicker / changeGraphColor).
          Series on/off is NOT toggled here — that stays in the table headers. */}
      {series.length > 0 && (
        <ChartLegend>
          {series.map((s) => (
            <label
              key={`leg-${s.code}`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                marginRight: 16,
                color: s.color,
                cursor: 'pointer',
              }}
              title="Click the swatch to change this series' color"
            >
              <LegendColorPicker
                type="color"
                value={toHexColor(s.color)}
                onChange={(e) => onSetColor(s.code, e.target.value)}
              />
              <span style={{ marginLeft: 6 }} title={columnHeaders[s.code]?.description}>
                {columnHeaders[s.code]?.title ?? s.code}
              </span>
            </label>
          ))}
        </ChartLegend>
      )}
      {expanded && !embedded && (
        <ChartModal
          onClose={closeModal}
          toolbar={
            <>
              <ChartIconBtn type="button" onClick={exportCsv} title="Download data as CSV">
                CSV
              </ChartIconBtn>
              <ChartIconBtn type="button" onClick={exportPng} title="Download chart as PNG">
                PNG
              </ChartIconBtn>
              <ChartIconBtn type="button" onClick={exportSvg} title="Download chart as SVG">
                SVG
              </ChartIconBtn>
            </>
          }
        >
          <HdrsChart
            rows={rows}
            plotted={plotted}
            colors={colors}
            onReset={onReset}
            onSetColor={onSetColor}
            embedded
            pointsApi={pts}
          />
        </ChartModal>
      )}
    </ChartCard>
  );
}

// Render the hdrs data table with a graph checkbox injected into every
// graphable column header (the reference's `th.graphable` checkbox). Height
// (col 0) is never graphable. The data cells reuse RenderValue for the same
// typed-cell formatting as the rest of the explorer.
const GraphCheckbox = styled.input`
  margin: 0 0 0 6px;
  vertical-align: middle;
  cursor: pointer;
  accent-color: ${theme.color.accent};
`;

const HdrsPager = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 2px 0;
  font-size: 11px;
  color: ${theme.color.muted};
  & > * + * {
    margin-left: 8px;
  }
`;

function HdrsTable({
  data,
  colCodes,
  plotted,
  colors,
  onTogglePlot,
  ctx,
}: {
  data: any;
  colCodes: string;
  plotted: string[];
  colors: Record<string, string>;
  onTogglePlot: (code: string) => void;
  ctx: RenderCtx;
}): JSX.Element {
  const [page, setPage] = useState(0);
  useEffect(() => {
    setPage(0);
  }, [data]);
  const isTable = data && typeof data === 'object' && data.type === 'table' && Array.isArray(data.value);
  const allRows: unknown[][] = isTable ? ((data.value as unknown[]).filter(Array.isArray) as unknown[][]) : [];
  if (allRows.length === 0) {
    // Fall back to the generic renderer for unexpected shapes.
    return <RenderValue value={data} ctx={ctx} />;
  }
  const headerRow = allRows[0]!;
  const dataRows = allRows.slice(1);
  const pageCount = Math.max(1, Math.ceil(dataRows.length / HDRS_RENDER_CAP));
  const safePage = Math.min(page, pageCount - 1);
  const visible =
    pageCount > 1 ? dataRows.slice(safePage * HDRS_RENDER_CAP, (safePage + 1) * HDRS_RENDER_CAP) : dataRows;
  // Column 0 is always Height; the rest follow `colCodes` in order.
  const codeForCol = (col: number): string | null => (col === 0 ? 'h' : colCodes[col - 1] ?? null);

  return (
    <ScrollX>
      <DataTable>
        <thead>
          <tr>
            {headerRow.map((cell, ci) => {
              const code = codeForCol(ci);
              const graphable =
                code !== null && code !== 'h' && CHARTABLE_COLS.includes(code) && columnHeaders[code] !== undefined;
              const on = code !== null && plotted.includes(code);
              const color = code !== null ? colors[code] ?? columnHeaders[code]?.color ?? undefined : undefined;
              return (
                <th key={ci} className="right">
                  <span title={code ? columnHeaders[code]?.description : undefined}>
                    <RenderValue value={cell} ctx={ctx} />
                  </span>
                  {graphable && (
                    <GraphCheckbox
                      type="checkbox"
                      checked={on}
                      title={on ? 'Hide from graph' : 'Show as graph'}
                      style={on && color ? { accentColor: color } : undefined}
                      onChange={() => onTogglePlot(code!)}
                    />
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {visible.map((row, ri) => (
            <tr key={ri}>
              {(Array.isArray(row) ? row : []).map((cell, ci) => (
                <td key={ci} className="right">
                  <RenderValue value={cell} ctx={ctx} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </DataTable>
      {pageCount > 1 && (
        <HdrsPager>
          <Btn type="button" disabled={safePage === 0} onClick={() => setPage(safePage - 1)}>
            ‹ Prev
          </Btn>
          <span>
            Rows {safePage * HDRS_RENDER_CAP + 1}–{Math.min((safePage + 1) * HDRS_RENDER_CAP, dataRows.length)}
            {' of '}
            {dataRows.length} — the chart and CSV export use the full set
          </span>
          <Btn type="button" disabled={safePage >= pageCount - 1} onClick={() => setPage(safePage + 1)}>
            Next ›
          </Btn>
        </HdrsPager>
      )}
    </ScrollX>
  );
}

// Rows ⇄ Timeframe segmented toggle.
const SegToggle = styled.div`
  display: inline-flex;
  border: 1px solid ${theme.color.border};
  border-radius: ${theme.radius.md};
  overflow: hidden;
  & button {
    background: ${theme.color.surface};
    color: ${theme.color.muted};
    border: 0;
    font: inherit;
    font-family: ${theme.font.mono};
    font-size: 12px;
    padding: 6px 10px;
    cursor: pointer;
  }
  & button[data-active='true'] {
    background: ${theme.color.accent};
    color: ${theme.color.bg};
  }
  & button + button {
    border-left: 1px solid ${theme.color.border};
  }
`;

// Single-field combobox: a free-text input plus a themed dropdown that opens on
// focus/click (the native <datalist> popup can't be themed and won't reliably
// open on click in QtWebEngine, hence the custom list). Typing filters nothing
// — every preset stays visible — but the user can type any value.
const ComboWrap = styled.div`
  position: relative;
  display: inline-block;
`;
const ComboInput = styled(Input)`
  width: 100%;
  padding-right: 26px;
  &::-webkit-outer-spin-button,
  &::-webkit-inner-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }
`;
const ComboCaret = styled.span`
  position: absolute;
  right: 9px;
  top: 50%;
  transform: translateY(-50%);
  cursor: pointer;
  color: ${theme.color.muted};
  font-size: 10px;
  user-select: none;
`;
const ComboList = styled.div`
  position: absolute;
  z-index: 30;
  top: calc(100% + 4px);
  left: 0;
  min-width: 100%;
  white-space: nowrap;
  background: ${theme.color.bg};
  border: 1px solid ${theme.color.border};
  border-radius: ${theme.radius.md};
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  overflow: hidden;
`;
const ComboOption = styled.div`
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  /* Owl margins, not gap — flex gap is unsupported in the wallet's Chrome 83. */
  & > * + * {
    margin-left: 14px;
  }
  padding: 7px 11px;
  font-family: ${theme.font.mono};
  font-size: 13px;
  color: ${theme.color.text};
  cursor: pointer;
  &:hover {
    background: ${theme.color.surface};
  }
  &[data-active='true'] {
    color: ${theme.color.accent};
  }
  & small {
    color: ${theme.color.muted};
    font-size: 11px;
  }
`;

// Inline control group in the "Table options" row. Owl margins, not gap —
// flex gap is unsupported in the wallet's Chrome 83.
const TableOptsGroup = styled.span`
  display: inline-flex;
  align-items: center;
  & > * + * {
    margin-left: 8px;
  }
`;

function ComboField({
  value,
  onChange,
  onEnter,
  options,
  type = 'text',
  width = 150,
  min,
  max,
  placeholder,
  title,
}: {
  value: string;
  onChange: (v: string) => void;
  onEnter?: () => void;
  options: Array<{ value: string; hint?: string }>;
  type?: 'text' | 'number';
  width?: number;
  min?: number;
  max?: number;
  placeholder?: string;
  title?: string;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  return (
    <ComboWrap ref={wrapRef} style={{ width }}>
      <ComboInput
        value={value}
        type={type}
        min={min}
        max={max}
        placeholder={placeholder}
        title={title}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            setOpen(false);
            onEnter?.();
          } else if (e.key === 'Escape') setOpen(false);
        }}
      />
      <ComboCaret
        aria-hidden
        onMouseDown={(e) => {
          e.preventDefault();
          setOpen((o) => !o);
        }}
      >
        ▾
      </ComboCaret>
      {open && options.length > 0 && (
        <ComboList>
          {options.map((o) => (
            <ComboOption
              key={o.value}
              data-active={o.value === value}
              // mousedown fires before the input's blur so the pick lands.
              onMouseDown={(e) => {
                e.preventDefault();
                onChange(o.value);
                setOpen(false);
              }}
            >
              <span>{o.value}</span>
              {o.hint && <small>{o.hint}</small>}
            </ComboOption>
          ))}
        </ComboList>
      )}
    </ComboWrap>
  );
}

function HdrsView({ data, view, ctx }: { data: any; view: ViewState; ctx: RenderCtx }): JSX.Element {
  const [colsDraft, setColsDraft] = useState(view.cols || COLUMN_DEFAULT_DISPLAY);
  const [nMaxDraft, setNMaxDraft] = useState(view.nMax || '100');
  const [hMaxDraft, setHMaxDraft] = useState(view.hMax || '');
  const [dhDraft, setDhDraft] = useState(view.dh || '1');
  // How the row count is expressed: a raw row count, or a timeframe (1d/1w/…)
  // resolved to blocks at dh=1. UI-only; both resolve to the same `nMax` query.
  const [sizeMode, setSizeMode] = useState<'rows' | 'timeframe'>('rows');
  const [tfDraft, setTfDraft] = useState('1w');
  // True while a timeframe is being anchored to real timestamps before navigating.
  const [resolving, setResolving] = useState(false);
  const resolveAbort = useRef<AbortController | null>(null);
  useEffect(() => () => resolveAbort.current?.abort(), []);

  const activeCols = view.cols || COLUMN_DEFAULT_DISPLAY;

  // Chart state lifted here so the table-header checkboxes drive the plot.
  // `plotted` = set of column codes drawn as series; `colorOverrides` holds
  // per-column color picks from Reset/Recolor (default falls back to
  // columnHeaders[code].color).
  // Which series are drawn lives in the URL so an expanded chart can be linked
  // as it is being read. Codes no longer displayed (a `cols` change) drop out
  // here rather than through a corrective effect.
  const plotted = useMemo(
    () => (view.plot ?? '')
      .split(',')
      .filter((c) => c !== '' && CHARTABLE_COLS.includes(c) && activeCols.includes(c)),
    [view.plot, activeCols],
  );
  const [colorOverrides, setColorOverrides] = useState<Record<string, string>>({});

  // Chart is collapsed by default behind a "+ Chart" / "− Chart" toggle
  // (faithful to the reference's `graphCollapsible` <details>). The open state
  // and the expanded modal both live in the URL: `?chart=hdrs` opens the
  // section, `&expand=1` opens it expanded, so either is a link someone can
  // send. It also has to be the URL rather than component state — this view
  // remounts whenever the query string changes, and local state would collapse
  // the section the moment the modal closed.
  //
  // The chart still only MOUNTS while open, which sidesteps the Chrome-83
  // hidden-SVG measurement bug the reference works around in `toggleGraph`.
  const chartOpen = view.chart === 'hdrs';
  const setChartOpen = useCallback(
    (open: boolean) => ctx.go(
      { chart: open ? 'hdrs' : undefined, expand: undefined },
      { inPlace: true },
    ),
    [ctx],
  );
  const setChartExpanded = useCallback(
    (expanded: boolean) => (expanded
      ? ctx.go({ chart: 'hdrs', expand: '1' })
      : ctx.go({ expand: undefined }, { inPlace: true })),
    [ctx],
  );

  // Keep the local draft synced with the URL view (e.g. when navigating
  // older/newer or following a special-block link that sets cols).
  useEffect(() => {
    setColsDraft(view.cols || COLUMN_DEFAULT_DISPLAY);
    setNMaxDraft(view.nMax || '100');
    setHMaxDraft(view.hMax || '');
    setDhDraft(view.dh || '1');
  }, [view.cols, view.nMax, view.hMax, view.dh]);

  // Ticking a series refines the view being read rather than navigating, so it
  // rewrites the current entry — the checkboxes sit in the table below the
  // chart, and a push would both fill the history and scroll away from them.
  const togglePlot = useCallback(
    (code: string): void => {
      if (code === 'h' || !CHARTABLE_COLS.includes(code)) return;
      const next = plotted.includes(code) ? plotted.filter((c) => c !== code) : [...plotted, code];
      ctx.go({ plot: next.length > 0 ? next.join(',') : undefined }, { inPlace: true });
    },
    [plotted, ctx],
  );

  // Reset = drop all overrides, restoring each column's default color from
  // columnHeaders (palette icon → resetGraphColors).
  const resetColors = useCallback(() => setColorOverrides({}), []);

  // Per-series recolor from the legend's <input type="color"> (changeGraphColor).
  const setColor = useCallback((code: string, color: string) => {
    setColorOverrides((cur) => ({ ...cur, [code]: color }));
  }, []);

  const chartRows = useMemo(() => extractHdrsRows(data, activeCols), [data, activeCols]);

  const apply = useCallback(
    (overrides?: { cols?: string; nMax?: string; hMax?: string; dh?: string }): void => {
      const tfEstimate = (): string => String(timeframeToBlocks(tfDraft) ?? (nMaxDraft || '100'));

      // Rows mode (or an explicit nMax override): navigate synchronously.
      if (sizeMode !== 'timeframe' || overrides?.nMax) {
        ctx.go({
          type: 'hdrs',
          cols: overrides?.cols ?? colsDraft,
          nMax: overrides?.nMax ?? nMaxDraft,
          hMax: (overrides?.hMax ?? hMaxDraft) || undefined,
          dh: (overrides?.dh ?? dhDraft) || '1',
        });
        return;
      }

      // Timeframe mode: anchor the span to real block timestamps (~2 sample
      // requests), then navigate with the concrete { hMax, nMax }.
      resolveAbort.current?.abort();
      const controller = new AbortController();
      resolveAbort.current = controller;
      setResolving(true);
      const dh = dhDraft || '1';
      resolveTimeframe({ ...view, type: 'hdrs' }, tfDraft, hMaxDraft, controller.signal)
        .then((res) => {
          if (controller.signal.aborted) return;
          const out = res ?? { hMax: hMaxDraft || undefined, nMax: tfEstimate() };
          ctx.go({
            type: 'hdrs',
            cols: colsDraft,
            nMax: out.nMax,
            hMax: out.hMax,
            dh,
          });
        })
        .catch(() => {
          // Anchoring failed (network/abort) — fall back to the estimate so
          // Apply still does something useful.
          if (controller.signal.aborted) return;
          ctx.go({
            type: 'hdrs',
            cols: colsDraft,
            nMax: tfEstimate(),
            hMax: hMaxDraft || undefined,
            dh,
          });
        })
        .finally(() => {
          if (!controller.signal.aborted) setResolving(false);
        });
    },
    [ctx, view, colsDraft, nMaxDraft, hMaxDraft, dhDraft, sizeMode, tfDraft],
  );

  const toggleColumn = useCallback((code: string): void => {
    if (code === 'h') return; // Height is mandatory.
    setColsDraft((prev) => {
      const order = Object.keys(columnHeaders);
      const present = new Set(prev.split(''));
      if (present.has(code)) present.delete(code);
      else present.add(code);
      // Re-emit in the canonical order so URLs stay stable across toggles.
      // Draft only — nothing refetches until the user clicks Apply.
      return order.filter((k) => k !== 'h' && present.has(k)).join('');
    });
  }, []);

  const setPreset = useCallback(
    (preset: 'current' | 'default' | 'all') => {
      let next = colsDraft;
      if (preset === 'current') next = view.cols || COLUMN_DEFAULT_DISPLAY;
      else if (preset === 'default') next = COLUMN_DEFAULT_DISPLAY.replace(/h/g, '');
      else if (preset === 'all')
        next = Object.keys(columnHeaders)
          .filter((k) => k !== 'h')
          .join('');
      setColsDraft(next); // draft only — applied on Apply
    },
    [colsDraft, view.cols],
  );

  const olderMore = data?.more;
  const appliedNMax = Number(view.nMax) || 100;
  const newerHMax = olderMore?.hMax !== undefined ? String(Number(olderMore.hMax) + appliedNMax * 2) : null;

  // Combobox presets. 2,048 is the server's per-request cap; any larger value
  // (typed, or a long timeframe) is satisfied by chaining (fetchHdrsPaginated).
  const isTf = sizeMode === 'timeframe';
  const ROW_PRESETS = ['100', '200', '500', '1000', String(HDRS_MAX_PER_REQUEST)];
  const rowOptions = ROW_PRESETS.map((n) => ({
    value: n,
    hint: n === '100' ? 'default' : n === String(HDRS_MAX_PER_REQUEST) ? 'max/request' : undefined,
  }));
  const tfOptions = TIMEFRAME_PRESETS.map((t) => {
    const b = timeframeToBlocks(t);
    return { value: t, hint: b ? `${b.toLocaleString('en-US')} rows` : undefined };
  });
  const DH_PRESETS: Array<[string, string]> = [
    ['1', '1 (block)'],
    ['60', '60 (~hour)'],
    ['1440', '1,440 (~day)'],
    ['10080', '10,080 (~week)'],
    ['43200', '43,200 (~month)'],
  ];
  const dhOptions = DH_PRESETS.some(([v]) => v === dhDraft)
    ? DH_PRESETS
    : [[dhDraft, dhDraft] as [string, string], ...DH_PRESETS];

  // Effective row count → number of chained requests, for the inline hint.
  const effectiveNMax = isTf ? timeframeToBlocks(tfDraft) ?? 0 : Math.floor(Number(nMaxDraft)) || 0;
  const cappedNMax = Math.min(effectiveNMax, HDRS_MAX_PER_REQUEST * HDRS_MAX_PAGES);
  const pageCount = effectiveNMax > 0 ? Math.ceil(cappedNMax / HDRS_MAX_PER_REQUEST) : 0;

  return (
    <>
      <H2>
        Block headers{' '}
        {olderMore && (
          <Btn data-variant="ghost" onClick={() => ctx.go({ ...view, ...olderMore })}>
            « Older
          </Btn>
        )}{' '}
        {newerHMax !== null && (
          <Btn data-variant="ghost" onClick={() => ctx.go({ ...view, hMax: newerHMax })}>
            Newer »
          </Btn>
        )}
      </H2>
      <Collapsible>
        <summary>Table options</summary>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            margin: '8px 0',
          }}
        >
          <TableOptsGroup>
            <SegToggle>
              <button type="button" data-active={!isTf} onClick={() => setSizeMode('rows')}>
                Rows
              </button>
              <button type="button" data-active={isTf} onClick={() => setSizeMode('timeframe')}>
                Timeframe
              </button>
            </SegToggle>
            {isTf ? (
              <ComboField
                value={tfDraft}
                onChange={setTfDraft}
                onEnter={() => apply()}
                options={tfOptions}
                type="text"
                width={170}
                placeholder="e.g. 1w, 3d"
                title="Timeframe to fetch at 1 block/min (1d, 1w, 1m, or e.g. 3d). Capped at 1 month (~43,200 rows); larger spans crash the tab."
              />
            ) : (
              <ComboField
                value={nMaxDraft}
                onChange={setNMaxDraft}
                onEnter={() => apply()}
                options={rowOptions}
                type="number"
                width={150}
                min={1}
                max={HDRS_MAX_PER_REQUEST * HDRS_MAX_PAGES}
                placeholder="rows"
                title={`Rows to fetch. Above ${HDRS_MAX_PER_REQUEST.toLocaleString(
                  'en-US',
                )} the client chains multiple requests.`}
              />
            )}
            {effectiveNMax > 0 && (pageCount > 1 || isTf) && (
              <Muted style={{ fontStyle: 'normal', whiteSpace: 'nowrap' }}>
                {isTf ? `${effectiveNMax.toLocaleString('en-US')} rows · ` : ''}≈{pageCount} request
                {pageCount === 1 ? '' : 's'}
              </Muted>
            )}
          </TableOptsGroup>
          <label style={{ marginLeft: 12 }}>
            Interval:{' '}
            <Select
              style={{ display: 'inline-block' }}
              value={dhDraft}
              onChange={(e) => setDhDraft(e.target.value)}
              title="Blocks between sampled rows (Δh)"
            >
              {dhOptions.map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </Select>
          </label>
          <label style={{ marginLeft: 12 }}>
            Max height:{' '}
            <Input
              style={{ width: 120, display: 'inline-block' }}
              value={hMaxDraft}
              onChange={(e) => setHMaxDraft(e.target.value)}
              type="number"
              placeholder="latest"
            />
          </label>
          <Btn style={{ marginLeft: 12 }} onClick={() => apply()} disabled={resolving}>
            {resolving ? 'Anchoring…' : 'Apply'}
          </Btn>
        </div>

        <ColumnPresets>
          <span>Columns:</span>
          <PresetLink onClick={() => setPreset('current')} title="Reset to the URL's columns">
            current
          </PresetLink>
          <span>|</span>
          <PresetLink onClick={() => setPreset('default')} title="Default column set">
            default
          </PresetLink>
          <span>|</span>
          <PresetLink onClick={() => setPreset('all')} title="Show every column">
            all
          </PresetLink>
          <Input
            value={colsDraft}
            onChange={(e) => setColsDraft(e.target.value)}
            onBlur={() => apply()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') apply();
            }}
            style={{ width: 200, display: 'inline-block', marginLeft: 8 }}
            title="Raw cols code string"
          />
        </ColumnPresets>

        <ColumnGrid>
          {Object.keys(columnHeaders).map((k) => {
            const checked = colsDraft.includes(k) || k === 'h';
            return (
              <ColumnChip key={k} data-active={checked ? 'true' : 'false'} title={columnHeaders[k]!.description}>
                <input type="checkbox" checked={checked} disabled={k === 'h'} onChange={() => toggleColumn(k)} />
                <ColorSwatch color={columnHeaders[k]!.color ?? undefined} />
                <span>{columnHeaders[k]!.title}</span>
              </ColumnChip>
            );
          })}
        </ColumnGrid>
      </Collapsible>
      {/* <details> fires `toggle` when React sets `open` on it too, so a link
          that arrives with the section already open would echo back a URL
          rewrite — dropping `expand` before the modal ever renders. Only a
          state the URL doesn't already describe is a real user toggle. */}
      <ChartCollapsible
        open={chartOpen}
        onToggle={(e) => {
          const { open } = (e.currentTarget as HTMLDetailsElement);
          if (open !== chartOpen) setChartOpen(open);
        }}
      >
        <summary>
          <span aria-hidden style={{ marginRight: 6, fontWeight: 700 }}>
            {chartOpen ? '−' : '+'}
          </span>
          Chart
        </summary>
        {/* Mount the chart only while expanded: its fixed-viewBox SVG measures
            correctly the moment it appears, and hover math reads the live
            bounding rect on each mousemove, so it works right after expand. */}
        {chartOpen && (
          <HdrsChart
            rows={chartRows}
            plotted={plotted}
            colors={colorOverrides}
            onReset={resetColors}
            onSetColor={setColor}
            expanded={view.expand === '1'}
            onExpandedChange={setChartExpanded}
          />
        )}
      </ChartCollapsible>
      <Card>
        <HdrsTableWrap>
          <HdrsTable
            data={data}
            colCodes={activeCols}
            plotted={plotted}
            colors={colorOverrides}
            onTogglePlot={togglePlot}
            ctx={ctx}
          />
        </HdrsTableWrap>
      </Card>
    </>
  );
}

function PeersView({ data, ctx }: { data: any; ctx: RenderCtx }): JSX.Element {
  const peers: any[] = Array.isArray(data) ? data : [];
  const peerIp = (p: any): string => (typeof p === 'string' ? p : p?.ip ?? JSON.stringify(p));
  return (
    <>
      <H2>Connected Peers ({peers.length})</H2>
      <p>
        Network <b>{ctx.network}</b> on <Mono>{getNodeUrl(ctx.network)}</Mono>
      </p>
      {peers.length === 0 ? (
        <ScrollX>
          <DataTable>
            <thead>
              <tr>
                <th>#</th>
                <th>Peer IP</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td colSpan={2}>
                  <Muted>No peers connected</Muted>
                </td>
              </tr>
            </tbody>
          </DataTable>
        </ScrollX>
      ) : (
        <FilterTable
          columns={[
            { header: '#', className: 'right' },
            { header: 'Peer IP', text: peerIp, sortKey: peerIp },
          ]}
          rows={peers}
          renderRow={(p, i) => (
            <tr key={i}>
              <td className="right">{i + 1}</td>
              <td>
                <Mono>{peerIp(p)}</Mono>
              </td>
            </tr>
          )}
        />
      )}
    </>
  );
}

function HistoricalView({ ctx }: { ctx: RenderCtx }): JSX.Element {
  return (
    <>
      <H2>Special historical blocks in Beam&apos;s mainnet</H2>
      <ScrollX>
        <DataTable>
          <thead>
            <tr>
              <th className="right">Height</th>
              <th>Description</th>
            </tr>
          </thead>
          <tbody>
            {specialBlocks.map((b, i) => (
              <tr key={i}>
                <td className="right">
                  {b.block_list?.map((h) => (
                    <div key={h}>
                      <BlockLink h={h} ctx={ctx} />
                    </div>
                  ))}
                  {b.block_range && (
                    <div>
                      <BlockLink h={b.block_range[0]} ctx={ctx} />
                      <br />
                      to <BlockLink h={b.block_range[1]} ctx={ctx} />
                    </div>
                  )}
                </td>
                <td>
                  <Collapsible>
                    <summary>{b.title}</summary>
                    <div style={{ marginTop: 8 }}>{b.description}</div>
                    {b.links && (
                      <ul style={{ marginTop: 8 }}>
                        {b.links.map((l, j) => (
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
            ))}
          </tbody>
        </DataTable>
      </ScrollX>
    </>
  );
}

function WhatsNewModal({ onClose }: { onClose: () => void }): JSX.Element {
  useEscapeClose(onClose);
  return createPortal(
    <Overlay z={120} onClick={onClose}>
      <WhatsNewCard role="presentation" onClick={(e) => e.stopPropagation()}>
        <Row style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <H2 style={{ margin: 0 }}>What&apos;s new</H2>
          <CloseBtn type="button" onClick={onClose} aria-label="Close">
            ×
          </CloseBtn>
        </Row>
        {WHATS_NEW.map((rel) => (
          <div key={rel.version} style={{ marginBottom: 12 }}>
            <H3 style={{ margin: '0 0 4px' }}>{rel.version}</H3>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, lineHeight: 1.5 }}>
              {rel.items.map((it) => (
                <li key={it}>{it}</li>
              ))}
            </ul>
          </div>
        ))}
      </WhatsNewCard>
    </Overlay>,
    document.body,
  );
}

// Owns the input state so typing re-renders only this small form — the
// explorer root may be showing a multi-thousand-row table at the time.
function KernelSearch({ onSearch }: { onSearch: (q: string) => void }): JSX.Element {
  const [search, setSearch] = useState('');
  const submit = (e: React.FormEvent): void => {
    e.preventDefault();
    const q = search.trim();
    if (q) onSearch(q);
  };
  return (
    <SearchForm onSubmit={submit}>
      <Input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search kernel id or block height"
        title="Enter a kernel id (hex) or a block height"
        style={{ fontSize: 12, padding: '4px 8px' }}
      />
      <Btn type="submit" style={{ padding: '4px 10px', fontSize: 11 }}>
        Search
      </Btn>
    </SearchForm>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export const BeamExplorer: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const [data, setData] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  // For a chained hdrs fetch: which request we're on out of how many planned.
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reqId = useRef(0);

  // The URL is the single source of truth for the view; navigating just
  // rewrites the query string and the render follows.
  const view = useMemo(() => parseView(searchParams), [searchParams]);

  const setView = useCallback(
    (next: ViewState, opts?: GoOptions): void => {
      setSearchParams(serializeView(next), { replace: opts?.inPlace === true });
      if (opts?.inPlace !== true && typeof window !== 'undefined') {
        window.scrollTo({ top: 0, behavior: 'auto' });
      }
    },
    [setSearchParams],
  );

  const go = useCallback(
    (patch: Partial<ViewState>, opts?: GoOptions): void => {
      const next: ViewState = { ...view, ...patch };
      if (patch.type && patch.type !== view.type) {
        if (patch.type !== 'block') {
          next.kernel = undefined;
          next.adj = undefined;
        }
        if (patch.type !== 'asset' && patch.type !== 'contract') {
          next.hMin = undefined;
        }
        if (patch.type !== 'assets') next.q = undefined; // owner filter only applies to the assets list
      }
      setView(next, opts);
    },
    [view, setView],
  );

  useEffect(() => {
    if (view.type === 'historical') {
      setData(null);
      setError(null);
      setLoading(false);
      return undefined;
    }
    const url = buildRequestUrl(view);
    if (!url) {
      if (view.type === 'asset' && view.id === '0') {
        go({ type: 'assets', id: undefined });
      }
      return undefined;
    }
    setLoading(true);
    setError(null);
    setProgress(null);
    reqId.current += 1;
    const myId = reqId.current;
    const controller = new AbortController();

    // hdrs above the 2048-row cap is satisfied by chaining requests; everything
    // else is a single fetch. The AbortController cancels an in-flight chain
    // when the view changes or the component unmounts.
    const paginate = view.type === 'hdrs' && Number(view.nMax) > HDRS_MAX_PER_REQUEST;
    const onProgress = (done: number, total: number): void => {
      // Ignore late callbacks from a superseded request.
      if (myId === reqId.current) setProgress({ done, total });
    };
    const run = paginate
      ? fetchHdrsPaginated(view, controller.signal, onProgress)
      : fetch(url, { signal: controller.signal }).then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        });

    run
      .then((j) => {
        if (myId !== reqId.current) return;
        setData(j);
        setLoading(false);
        setProgress(null);
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted || myId !== reqId.current) return;
        setError(e instanceof Error ? e.message : 'Request failed');
        setLoading(false);
        setProgress(null);
      });

    return () => controller.abort();
  }, [view, go]);

  const ctx: RenderCtx = useMemo(
    () => ({ go, network: view.network, viewType: view.type }),
    [go, view.network, view.type],
  );

  const onSearch = useCallback(
    (q: string): void => {
      // Tolerate copy-pasted block heights with thousands separators (e.g.
      // "3,863,512" as rendered elsewhere in the terminal); kernel ids are hex
      // and never contain these, so strip them only for the numeric test.
      const cleaned = q.replace(/[\s,_]/g, '');
      if (cleaned.length < 10 && /^\d+$/.test(cleaned)) {
        go({ type: 'block', height: cleaned, kernel: undefined });
      } else {
        go({ type: 'block', kernel: q, height: undefined });
      }
    },
    [go],
  );

  const networkType = readNetworkType(view.network);
  const [whatsNewOpen, setWhatsNewOpen] = useState(false);

  return (
    <Page>
      {whatsNewOpen && <WhatsNewModal onClose={() => setWhatsNewOpen(false)} />}
      <DensePage>
        <ExplorerHeader>
          <H1>
            Beam Smart Explorer
            <VersionBadge type="button" onClick={() => setWhatsNewOpen(true)} title="What's new">
              {EXPLORER_VERSION}
            </VersionBadge>
          </H1>
          <Row>
            <Select
              value={view.network}
              onChange={(e) => setView({ network: e.target.value, type: 'status' })}
              title="Change network"
            >
              {Object.keys(explorerNodes).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
            <TinyPill data-tone={networkType === 'PoS' ? 'purple' : 'info'}>{networkType}</TinyPill>
            <KernelSearch onSearch={onSearch} />
          </Row>
        </ExplorerHeader>

        <NavTabs>
          <NavTab data-active={view.type === 'status' ? 'true' : 'false'} onClick={() => go({ type: 'status' })}>
            Status
          </NavTab>
          <NavTab data-active={view.type === 'hdrs' ? 'true' : 'false'} onClick={() => go({ type: 'hdrs' })}>
            Headers
          </NavTab>
          <NavTab data-active={view.type === 'contracts' ? 'true' : 'false'} onClick={() => go({ type: 'contracts' })}>
            Contracts
          </NavTab>
          <NavTab
            data-active={view.type === 'assets' ? 'true' : 'false'}
            onClick={() => go({ type: 'assets', height: undefined })}
          >
            Assets
          </NavTab>
          <NavTab data-active={view.type === 'peers' ? 'true' : 'false'} onClick={() => go({ type: 'peers' })}>
            Peers
          </NavTab>
          <NavTab data-active={view.type === 'treasury' ? 'true' : 'false'} onClick={() => go({ type: 'treasury' })}>
            Treasury
          </NavTab>
          <NavTab
            data-active={view.type === 'historical' ? 'true' : 'false'}
            onClick={() => go({ type: 'historical' })}
          >
            Historical
          </NavTab>
        </NavTabs>

        {loading && (
          <CenteredNote pad="24px" size={16}>
            Loading…
            {progress && progress.total > 1 && ` (request ${progress.done}/${progress.total})`}
          </CenteredNote>
        )}
        {error && (
          <ErrorBox>
            Failed to load:
            {error}
          </ErrorBox>
        )}

        {!loading && !error && (
          <>
            {view.type === 'status' && <StatusView data={data} ctx={ctx} />}
            {(view.type === 'block' || view.type === 'treasury') && <BlockView data={data} view={view} ctx={ctx} />}
            {view.type === 'contracts' && <ContractsView data={data} ctx={ctx} />}
            {view.type === 'contract' && <ContractStateView data={data} view={view} ctx={ctx} />}
            {view.type === 'asset' && <AssetView data={data} view={view} ctx={ctx} />}
            {view.type === 'assets' && <AssetsView data={data} view={view} ctx={ctx} />}
            {view.type === 'hdrs' && <HdrsView data={data} view={view} ctx={ctx} />}
            {view.type === 'peers' && <PeersView data={data} ctx={ctx} />}
            {view.type === 'historical' && <HistoricalView ctx={ctx} />}
          </>
        )}
      </DensePage>
    </Page>
  );
};

export default BeamExplorer;
