import React, {
  useCallback, useEffect, useMemo, useRef, useState,
} from 'react';
import { useSearchParams } from 'react-router-dom';
import { createPortal } from 'react-dom';
import { styled } from '@linaria/react';
import {
  Page, Card, ExplorerHeader, H1, H2, H3,
  Btn, Input, Select, Pill,
  DataTable, ScrollX, ErrorBox, Row, theme,
} from './shared';
import { useBlockTimestamp, type BlockUrlResolver } from '../../../../shared/components/BlockHeight';

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
    url: [
      'https://explorer.0xmx.net/api/dappnet2/',
      'https://BeamSmart.net:8002/',
    ],
  },
  warp_dev3: {
    type: 'PoS',
    description: 'PoS, ~15-sec blocks',
    url: ['https://explorer.0xmx.net/api/warp_dev3/'],
  },
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
}

// View state is mirrored into the URL query string (e.g.
// `?network=mainnet&type=contract&id=<cid>`), matching the original
// BeamExplorer.htm scheme so any contract/asset/block view is a shareable link.
const VIEW_TYPES: ReadonlySet<string> = new Set<ViewType>([
  'status', 'block', 'treasury', 'asset', 'assets',
  'contract', 'contracts', 'hdrs', 'peers', 'historical',
]);

// Optional string fields carried in the URL alongside `network`/`type`.
const VIEW_PARAM_KEYS = [
  'id', 'height', 'kernel', 'hMin', 'hMax', 'nMax', 'nMaxOps', 'nMaxTxs', 'cols', 'dh', 'adj', 'q',
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

interface ColumnMeta { color: string | null; original: string; title: string; description: string }

const COLUMN_DEFAULT_DISPLAY = 'THdfkioyzp';

const columnHeaders: Record<string, ColumnMeta> = {
  h: { color: '#000000', original: 'Height', title: 'Height', description: 'Block height' },
  H: { color: null, original: 'Hash', title: 'Hash', description: 'Block hash' },
  N: { color: '#606060', original: 'Number', title: 'Number', description: 'Block number' },
  T: { color: '#808080', original: 'Timestamp', title: 'Timestamp', description: 'Block timestamp' },
  g: { color: '#bf3c3c', original: 'd.Age', title: 'Duration', description: 'Block duration (seconds)' },
  G: { color: '#d67a7a', original: 'Age', title: 'Age', description: 'Block age since genesis (seconds)' },
  d: { color: '#008484', original: 'Difficulty', title: 'Difficulty', description: 'Block difficulty' },
  D: { color: '#00bdbd', original: 'Chainwork', title: 'Chainwork', description: 'Total difficulty since genesis' },
  f: { color: '#7b00b0', original: 'Fee', title: 'Fees', description: 'Block fees (Beam)' },
  F: { color: '#8660d7', original: 'T.Fee', title: 'Total fees', description: 'Total fees since genesis' },
  k: { color: '#ff0080', original: 'Txs', title: 'Txs', description: 'Number of kernels in the block' },
  K: { color: '#ff79bc', original: 'T.Txs', title: 'Total txs', description: 'Total kernels since genesis' },
  i: { color: '#006400', original: 'MW.Inputs', title: 'MW in', description: 'Mimblewimble inputs in the block' },
  I: { color: '#00bb00', original: 'T.MW.Inputs', title: 'Total MW in', description: 'Total MW inputs since genesis' },
  o: { color: '#ff0006', original: 'MW.Outputs', title: 'MW out', description: 'Mimblewimble outputs in the block' },
  O: { color: '#ff5e5e', original: 'T.MW.Outputs', title: 'Total MW out', description: 'Total MW outputs since genesis' },
  u: { color: '#808000', original: 'MW.Utxos', title: 'MW UTXOs', description: 'Change in MW UTXO count' },
  U: { color: '#bdb76b', original: 'T.MW.Utxos', title: 'Total MW UTXOs', description: 'Total unspent MW UTXOs' },
  y: { color: '#0000e3', original: 'SH.Inputs', title: 'SH in', description: 'Lelantus Shielded Pool inputs' },
  Y: { color: '#4f4fff', original: 'T.SH.Inputs', title: 'Total SH in', description: 'Total Shielded inputs' },
  z: { color: '#804040', original: 'SH.Outputs', title: 'SH out', description: 'Shielded Pool outputs' },
  Z: { color: '#b87272', original: 'T.SH.Outputs', title: 'Total SH out', description: 'Total Shielded outputs' },
  b: { color: '#5a3362', original: 'Contracts', title: 'New contracts', description: 'Smart contracts deployed in the block' },
  B: { color: '#a66ab3', original: 'T.Contracts', title: 'Total contracts', description: 'Total contracts since genesis' },
  p: { color: '#ce00ce', original: 'ContractCalls', title: 'Contract calls', description: 'Smart contract calls in the block' },
  P: { color: '#ff53ff', original: 'T.ContractCalls', title: 'Total contract calls', description: 'Total contract calls since genesis' },
  c: { color: '#004080', original: 'D.Size.Compressed', title: 'Size variation', description: 'Blockchain size change (bytes)' },
  C: { color: '#6d92c2', original: 'Size.Compressed', title: 'Total size', description: 'Total blockchain size' },
  a: { color: '#009d27', original: 'D.Size.Archive', title: 'Archive size', description: 'Block archive size (bytes)' },
  A: { color: '#00d535', original: 'Size.Archive', title: 'Total archive size', description: 'Total archive size' },
};

// ---------------------------------------------------------------------------
// Special historical blocks (mainnet narrative)
// ---------------------------------------------------------------------------

interface SpecialBlock {
  block_list?: number[];
  block_range?: [number, number];
  title: string;
  description: string;
  links?: Array<[string, string]>;
}

const specialBlocks: SpecialBlock[] = [
  {
    block_list: [0],
    title: 'Treasury',
    description: 'Beam emission is inspired by Bitcoin\'s, but with 1-minute blocks. First halving after 1 year, then every 4 years. Total supply 262,800,000 BEAM. For the first 5 years, 20% of block rewards went to a Treasury that the Beam Foundation used to repay investors and fund development. The Treasury is represented as a pseudo-block at height 0 containing pre-allocated UTXOs with maturity schedules.',
    links: [
      ['Beam emission schedule', 'https://medium.com/beam-mw/mimblewimble-emission-schedule-215551948259'],
      ['Beam Foundation', 'https://www.beam-foundation.org'],
    ],
  },
  {
    block_list: [1],
    title: 'Genesis block',
    description: 'Beam launched the first ever Mimblewimble-based confidential cryptocurrency on January 3rd 2019 (also the 10-year anniversary of the Bitcoin genesis block). No pre-mine, no ICO; the genesis block records the hash of Bitcoin block 556833 mined the same day.',
    links: [
      ['First Beam Medium post', 'https://medium.com/beam-mw/introducing-beam-f35096a923ec'],
      ['Mainnet launch notes', 'https://medium.com/beam-mw/mimblewimble-mainnet-release-notes-8766e49e241d'],
    ],
  },
  {
    block_list: [159, 160],
    title: 'The fastest blocks on Earth',
    description: 'About 90 minutes after the genesis block, blocks 159 and 160 were mined within the same second. Possible but unlikely under a Poisson distribution with 60s target.',
  },
  {
    block_range: [25709, 25820],
    title: 'Blockchain Stop Event',
    description: 'On January 21st 2019 the chain stopped at block 25709. A hotfix was released a few hours later. No blocks were produced for 2.5 hours, and no transactions (except coinbase) for 112 blocks. No funds were lost.',
    links: [['Postmortem analysis', 'https://medium.com/beam-mw/mimblewimble-blockchain-stop-event-postmortem-21012019-9a7ef38b2813']],
  },
  {
    block_list: [321321],
    title: 'First Hard-Fork',
    description: 'PoW algorithm updated from BeamHash I to BeamHash II.',
  },
  {
    block_list: [525600, 525601],
    title: 'First Halving',
    description: 'On January 5th 2020 the block reward was halved from 100 BEAM to 50 BEAM. Subsequent halvings are every 4 years.',
  },
  {
    block_list: [777777],
    title: 'Second Hard-Fork',
    description: 'PoW updated to BeamHash III. Confidential Assets activated. Lelantus-MW protocol enabled (offline transactions).',
  },
  {
    block_list: [778579],
    title: 'First Lelantus-MW transaction',
    description: 'First transaction routed through the Shielded Pool.',
  },
  {
    block_list: [780219],
    title: 'Creation of the first Confidential Asset',
    description: 'Asset id:1 minted. Later became the basis for Tico (id:9).',
  },
  {
    block_list: [1280000],
    title: 'Third Hard-Fork (and wallet v6.0)',
    description: 'Beam Virtual Machine (BVM) added; smart contracts ("shaders") become available, making Beam the first privacy coin with smart-contract capabilities.',
  },
  {
    block_list: [1280003],
    title: 'Deployment of the first Smart Contract',
    description: 'A simple faucet, deployed minutes after the third hard-fork.',
  },
  {
    block_list: [1464852],
    title: 'BeamX creation',
    description: 'Governance token of the BeamX DAO (asset id:7). All 100,000,000 units were minted at once by the DAO Core contract.',
  },
  {
    block_list: [1820000],
    title: 'Fourth Hard-Fork (and wallet v7.0)',
    description: 'Added High-Frequency Transactions (HFTX) and IPFS storage integration on the wallet side.',
  },
  {
    block_list: [1920000],
    title: 'Fifth Hard-Fork (and wallet v7.1)',
    description: 'Confidential Asset issuance cost reduced from 3000 to 10 BEAM. Smart contracts can verify fork heights.',
  },
  {
    block_list: [2272779],
    title: 'Blockchain incident',
    description: 'Chain stopped producing blocks for 103 minutes due to a kernel sort issue. All pending transactions landed in block 2272781. No funds lost.',
  },
  {
    block_list: [2628000, 2628001],
    title: 'Second Halving & End of treasury allocation',
    description: 'January 2024: block reward halved from 50 BEAM to 25 BEAM. Treasury allocation ended; 100% of block rewards now go to miners.',
  },
];

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function readNetworkType(network: string): 'PoW' | 'PoS' {
  return explorerNodes[network]?.type ?? 'PoW';
}

function getNodeUrl(network: string): string {
  return explorerNodes[network]?.url[0] ?? explorerNodes.mainnet.url[0];
}

function buildRequestUrl(view: ViewState): string | null {
  const prefix = getNodeUrl(view.network);
  let suffix = '?exp_am=1';
  let type: string = view.type;

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

function formatTimestamp(time: number, zone: 'local' | 'utc' = 'utc'): string {
  let d = new Date();
  const diff = (zone === 'local') ? d.getTimezoneOffset() : 0;
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
  & > * + * { margin-left: 8px; }
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
  h1 { font-size: 16px; letter-spacing: 0; text-transform: none; }
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
  table th, table td {
    padding: 4px 8px;
  }
  table th {
    font-size: 11px;
    letter-spacing: 0;
    text-transform: none;
  }

  /* Compact cards / collapsibles */
  section, details {
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
  & > * + * { margin-left: 14px; }
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
  &:hover { color: ${theme.color.text}; }
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
  &[data-tone='purple']  { background: rgba(218, 104, 245, 0.16); color: ${theme.color.purple}; }
  &[data-tone='info']    { background: rgba(11, 204, 247, 0.16); color: ${theme.color.info}; }
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
  & > summary::-webkit-details-marker { display: none; }
`;

const Link = styled.a`
  color: ${theme.color.accent};
  text-decoration: none;
  cursor: pointer;
  &:hover { text-decoration: underline; color: ${theme.color.purple}; }
`;

// Inline atoms used inside the typed-cell JSON renderer.
const Mono = styled.span`
  font-family: ${theme.font.mono};
  font-size: 12px;
  word-break: break-all;
  color: ${theme.color.muted};
`;

const Pos = styled.span` color: ${theme.color.success}; `;
const Neg = styled.span` color: ${theme.color.danger}; `;
const Muted = styled.span` color: ${theme.color.muted}; font-style: italic; `;

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

const Loading = styled.div`
  color: ${theme.color.muted};
  padding: 24px;
  text-align: center;
  font-size: 16px;
`;

const Pager = styled.div`
  display: flex;
  & > * + * { margin-left: 8px; }
  margin: 8px 0;
`;

// ---------------------------------------------------------------------------
// Generic JSON renderer (mirrors Obj2Html from the original)
// ---------------------------------------------------------------------------

interface RenderCtx {
  go: (next: Partial<ViewState>) => void;
  network: string;
  viewType: ViewType;
}

function AmountClr({ amount }: { amount: string }): JSX.Element {
  const c = amount[0];
  if (c === '+') return <Pos><Mono>{amount}</Mono></Pos>;
  if (c === '-') return <Neg><Mono>{amount}</Mono></Neg>;
  return <Mono style={{ color: theme.color.warn }}>{amount}</Mono>;
}

function AssetLink({ aid, ctx }: { aid: number | string; ctx: RenderCtx }): JSX.Element {
  if (String(aid) === '0') return <span style={{ color: theme.color.accent, fontWeight: 600 }}>Beam</span>;
  return (
    <Link
      onClick={(e) => { e.preventDefault(); ctx.go({ type: 'asset', id: String(aid) }); }}
      href="#"
      style={{ color: theme.color.purple }}
    >
      Asset-{aid}
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
    : typeof ts === 'number' ? new Date(ts * 1000).toLocaleString() : 'timestamp unavailable';
  const onEnter = (): void => {
    const el = wrapRef.current;
    if (el) {
      const r = el.getBoundingClientRect();
      setPos({ x: r.left + r.width / 2, y: r.top });
    }
    setHovered(true);
  };
  return (
    <BlockLinkWrap
      ref={wrapRef}
      onMouseEnter={onEnter}
      onMouseLeave={() => setHovered(false)}
    >
      <Link
        onClick={(e) => { e.preventDefault(); ctx.go({ type: 'block', height: String(h) }); }}
        href="#"
        style={{ color: theme.color.info }}
      >
        {String(h)}
      </Link>
      {hovered && valid && pos
        && createPortal(<BlockHoverTip style={{ left: pos.x, top: pos.y - 8 }}>{tipText}</BlockHoverTip>, document.body)}
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
      onClick={(e) => { e.preventDefault(); ctx.go({ type: 'contract', id: cid }); }}
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
    case 'th':
      return <strong style={{ color: theme.color.muted }}><RenderValue value={obj.value} ctx={ctx} /></strong>;
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
        <span title={`UTC: ${formatTimestamp(Number(obj.value))}`}>
          {formatTimestamp(Number(obj.value), 'local')}
        </span>
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
        {value.map((v, i) => <li key={i}><RenderValue value={v} ctx={ctx} /></li>)}
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
  &::placeholder { color: ${theme.color.muted}; }
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
  &:hover { color: ${theme.color.accent}; }
`;

function FilterTable<T>({
  columns, rows, renderRow, initialTerms,
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
      out = out.filter((row) => active.every(([ci, term]) => {
        const col = columns[Number(ci)];
        if (!col?.text) return true;
        return col.text(row).toLowerCase().includes(term.trim().toLowerCase());
      }));
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

  const toggleSort = useCallback((ci: number) => {
    if (!columns[ci]?.sortKey) return;
    // Cycle: ascending → descending → off.
    setSort((prev) => {
      if (!prev || prev.col !== ci) return { col: ci, dir: 1 };
      if (prev.dir === 1) return { col: ci, dir: -1 };
      return null;
    });
  }, [columns]);

  return (
    <>
      {enabled && (
        <FilterToggle
          type="button"
          onClick={() => setShowFilters((s) => !s)}
          title="Show per-column search boxes"
        >
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
                    {c.header}{arrow}
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
          <tbody>
            {visible.map((row, i) => renderRow(row, i))}
          </tbody>
        </DataTable>
      </ScrollX>
    </>
  );
}

// ---------------------------------------------------------------------------
// View renderers
// ---------------------------------------------------------------------------

function FundsTable(
  { funds, ctx }: { funds: unknown[] | null | undefined; ctx: RenderCtx },
): JSX.Element | null {
  if (!funds || !Array.isArray(funds) || funds.length === 0) return null;
  return (
    <DataTable>
      <thead><tr><th>Asset</th><th className="right">Amount</th></tr></thead>
      <tbody>
        {funds.map((fr, i) => {
          const row = fr as TypedCell[];
          return (
            <tr key={i}>
              <td><AssetLink aid={row[0]?.value as string} ctx={ctx} /></td>
              <td className="right"><AmountClr amount={String(row[1]?.value ?? '')} /></td>
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
    : (input && typeof input === 'object' && Array.isArray((input as { value?: unknown }).value))
      ? ((input as { value: unknown[] }).value)
      : [];
  if (rows.length === 0) return rows;
  const first = rows[0];
  if (Array.isArray(first) && first.length > 0
    && first.every((c) => c && typeof c === 'object' && (c as { type?: string }).type === 'th')) {
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
  & > summary::-webkit-details-marker { display: none; }
  & > summary::before {
    content: '\\25B8\\00a0';
    display: inline-block;
    width: 12px;
    color: ${theme.color.muted};
  }
  &[open] > summary::before { content: '\\25BE\\00a0'; }
  & > summary:hover { color: ${theme.color.purple}; }
  & > .body { margin-top: 4px; }
`;

function LockedFundsWidget(
  { funds, ctx, maxRows = 5 }: { funds: unknown; ctx: RenderCtx; maxRows?: number },
): JSX.Element | null {
  const rows = stripHeaderRow(funds);
  if (rows.length === 0) return null;
  const table = (
    <DataTable>
      <thead><tr><th>Asset</th><th className="right">Amount</th></tr></thead>
      <tbody>
        {rows.map((fr, i) => {
          const row = (Array.isArray(fr) ? fr : []) as TypedCell[];
          return (
            <tr key={i}>
              <td><AssetLink aid={row[0]?.value as string} ctx={ctx} /></td>
              <td className="right"><AmountClr amount={String(row[1]?.value ?? '')} /></td>
            </tr>
          );
        })}
      </tbody>
    </DataTable>
  );
  if (rows.length < maxRows) return table;
  return (
    <InlineDetails>
      <summary title="Toggle">{rows.length}&nbsp;assets</summary>
      <div className="body">{table}</div>
    </InlineDetails>
  );
}

/**
 * Mirror of the Owned Assets rendering in `DisplayContracts`: per-asset table
 * with [Asset, Description, Amount] columns, collapsed behind "N owned" once
 * it crosses the row-count threshold.
 */
function OwnedAssetsWidget(
  { owned, ctx, maxRows = 5 }: { owned: unknown; ctx: RenderCtx; maxRows?: number },
): JSX.Element | null {
  const rows = stripHeaderRow(owned);
  if (rows.length === 0) return null;
  const table = (
    <DataTable>
      <thead><tr>
        <th>Asset</th><th>Description</th><th className="right">Amount</th>
      </tr></thead>
      <tbody>
        {rows.map((fr, i) => {
          const row = (Array.isArray(fr) ? fr : []) as any[];
          return (
            <tr key={i}>
              <td><AssetLink aid={row[0]?.value as string} ctx={ctx} /></td>
              <td><Mono style={{ color: theme.color.purple }} title={String(row[1] ?? '')}>{String(row[1] ?? '')}</Mono></td>
              <td className="right"><AmountClr amount={String(row[2]?.value ?? '')} /></td>
            </tr>
          );
        })}
      </tbody>
    </DataTable>
  );
  if (rows.length < maxRows) return table;
  return (
    <InlineDetails>
      <summary title="Toggle">{rows.length}&nbsp;owned</summary>
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
          onClick={(e) => { e.preventDefault(); ctx.go({ type: 'peers' }); }}
          href="#"
        >
          Connected Peers
        </Link>
      </H3>
      <Card>
        <p>
          Interactive display of the data returned by a Beam explorer node. The network and node currently queried
          are: <b>{ctx.network}</b>{' '}
          <Pill>{explorerNodes[ctx.network]?.description}</Pill> at <Mono>{getNodeUrl(ctx.network)}</Mono>.
        </p>
        <p>
          Beam is a privacy-centric blockchain with native confidential assets and smart contracts, powered by
          Mimblewimble and Lelantus. Although amounts are concealed and addresses are not stored onchain, the explorer
          shows the commitments of all inputs &amp; outputs of each block, together with kernel ids, contract calls,
          and confidential-asset mint/burn history.
        </p>
      </Card>
    </>
  );
}

function TxoTable(
  { rows, isInp, ctx }: { rows: any[]; isInp: boolean; ctx: RenderCtx },
): JSX.Element {
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
    { header: isInp ? 'Height' : 'Spent', className: 'right', text: (r) => cellText(heightCell(r)), sortKey: (r) => cellSort(heightCell(r)) },
    { header: 'Maturity', className: 'right', text: (r) => cellText(r.Maturity), sortKey: (r) => cellSort(r.Maturity) },
    { header: 'Extra', text: extraText, sortKey: extraText },
  ];
  return (
    <FilterTable
      columns={columns}
      rows={rows}
      renderRow={(r, i) => (
        <tr key={i}>
          <td><Mono title={r.commitment}>{r.commitment}</Mono></td>
          <td className="right">
            {heightCell(r) != null ? <BlockLink h={heightCell(r)} ctx={ctx} /> : ''}
          </td>
          <td className="right">
            {r.Maturity != null ? <RenderValue value={r.Maturity} ctx={ctx} /> : ''}
          </td>
          <td>{extraText(r)}</td>
        </tr>
      )}
    />
  );
}

function AssetsTable(
  { data, ctx, ownerFilter }: { data: any; ctx: RenderCtx; ownerFilter?: string },
): JSX.Element {
  const rawRows = data?.value;
  const allRows: any[][] = Array.isArray(rawRows) ? rawRows : [];
  const rows: any[][] = allRows.slice(1).map((row) => (Array.isArray(row) ? row : []));
  const columns: FilterColumn<any[]>[] = [
    { header: 'Id', text: (r) => cellText(r[0]), sortKey: (r) => cellSort(r[0]) },
    { header: 'Owner', text: (r) => cellText(r[1]), sortKey: (r) => cellSort(r[1]) },
    { header: 'Deposit', className: 'right', text: (r) => cellText(r[2]), sortKey: (r) => cellSort(r[2]) },
    { header: 'Supply', className: 'right', text: (r) => cellText(r[3]), sortKey: (r) => cellSort(r[3]) },
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
          <td><AssetLink aid={r[0]?.value} ctx={ctx} /></td>
          <td><RenderValue value={r[1]} ctx={ctx} /></td>
          <td className="right"><AmountClr amount={String(r[2]?.value ?? '')} /></td>
          <td className="right"><AmountClr amount={String(r[3]?.value ?? '')} /></td>
          <td>{r[4] != null ? <RenderValue value={r[4]} ctx={ctx} /> : ''}</td>
          <td><Mono style={{ color: theme.color.purple }}>{String(r[5] ?? '')}</Mono></td>
        </tr>
      )}
    />
  );
}

function BlockView(
  { data, view, ctx }: { data: any; view: ViewState; ctx: RenderCtx },
): JSX.Element {
  const isTreasury = view.type === 'treasury' || view.height === '0';
  if (data?.found === false || (data?.info === undefined && !isTreasury)) {
    return <ErrorBox>Block not found.</ErrorBox>;
  }
  const heightStr = data?.h != null ? String(data.h) : (view.height ?? '');
  const height = Number(heightStr);
  const kernelId = view.kernel;

  return (
    <>
      <H2>
        {isTreasury
          ? 'Treasury'
          : <>Block <span style={{ color: theme.color.accent }}>{heightStr}</span></>}
        {' '}
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
                { header: 'Fee', className: 'right', text: (k) => cellText(k.fee), sortKey: (k) => cellSort(k.fee) },
                { header: 'Height', text: (k) => `${cellText(k.minHeight)} ${cellText(k.maxHeight)}`, sortKey: (k) => cellSort(k.minHeight) },
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
                    <td><Mono title={k.id}>{k.id}</Mono></td>
                    <td className="right"><RenderValue value={k.fee} ctx={ctx} /></td>
                    <td>{mh}-{xh}</td>
                    <td><RenderValue value={rest} ctx={ctx} /></td>
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
    return (c !== null && typeof c === 'object') ? (c as { value?: unknown }).value : c;
  };
  const columns: FilterColumn<any[]>[] = [
    { header: L(0, 'Cid'), text: (r) => cellText(r[0]), sortKey: (r) => cellSort(r[0]) },
    { header: L(1, 'Kind'), text: (r) => cellText(r[1]), sortKey: (r) => cellSort(r[1]) },
    { header: L(2, 'Deploy Height'), className: 'right', text: (r) => cellText(heightVal(r)), sortKey: (r) => cellSort(heightVal(r)) },
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
              <td><CidLink cid={String(cid ?? '')} ctx={ctx} /></td>
              <td><RenderValue value={r[1]} ctx={ctx} /></td>
              <td className="right">
                {height !== undefined && height !== null && height !== ''
                  ? <BlockLink h={String(height)} ctx={ctx} />
                  : null}
              </td>
              <td><LockedFundsWidget funds={r[3]} ctx={ctx} /></td>
              <td><OwnedAssetsWidget owned={r[4]} ctx={ctx} /></td>
            </tr>
          );
        }}
      />
    </>
  );
}

function MoreLink(
  { obj, ctx, view }: { obj: any; ctx: RenderCtx; view: ViewState },
): JSX.Element | null {
  const more = obj?.more;
  if (!more || typeof more !== 'object') return null;
  return (
    <Pager>
      <Btn data-variant="ghost" onClick={() => ctx.go({ ...view, ...more })}>← Older</Btn>
    </Pager>
  );
}

function AssetView(
  { data, view, ctx }: { data: any; view: ViewState; ctx: RenderCtx },
): JSX.Element {
  const histObj = data?.['Asset history'];
  const histRowsRaw = histObj?.value;
  const histRows: any[][] = Array.isArray(histRowsRaw) ? histRowsRaw : [];
  const dist = data?.['Asset distribution'];
  return (
    <>
      <H2>Status of Asset {view.id}</H2>
      <Collapsible open>
        <summary>Asset History</summary>
        <FilterTable
          columns={[
            { header: 'Height', text: (r) => cellText(r[0]), sortKey: (r) => cellSort(r[0]) },
            { header: 'Event', text: (r) => cellText(r[1]), sortKey: (r) => cellSort(r[1]) },
            { header: 'Amount', className: 'right', text: (r) => cellText(r[2]), sortKey: (r) => cellSort(r[2]) },
            { header: 'Total Amount', className: 'right', text: (r) => cellText(r[3]), sortKey: (r) => cellSort(r[3]) },
            { header: 'Extra', text: (r) => cellText(r[4]), sortKey: (r) => cellSort(r[4]) },
          ]}
          rows={histRows.slice(1).map((row) => (Array.isArray(row) ? row : []) as any[])}
          renderRow={(r, i) => (
            <tr key={i}>
              <td><BlockLink h={cellHeight(r[0])} ctx={ctx} /></td>
              <td><RenderValue value={r[1]} ctx={ctx} /></td>
              <td className="right"><RenderValue value={r[2]} ctx={ctx} /></td>
              <td className="right"><RenderValue value={r[3]} ctx={ctx} /></td>
              <td><RenderValue value={r[4]} ctx={ctx} /></td>
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

function AssetsView(
  { data, view, ctx }: { data: any; view: ViewState; ctx: RenderCtx },
): JSX.Element {
  const h = Number(view.height || 0);
  return (
    <>
      <H2>
        {view.height
          ? <>Confidential Assets at block <BlockLink h={view.height} ctx={ctx} /></>
          : 'Current Confidential Assets'}
        {' '}
        {h > 1 && (
          <Btn data-variant="ghost" onClick={() => ctx.go({ type: 'assets', height: String(h - 1) })}>
            ← Prev block
          </Btn>
        )}
        {' '}
        <Btn data-variant="ghost" onClick={() => ctx.go({ type: 'assets', height: String((h || 0) + 1) })}>
          Next block →
        </Btn>
      </H2>
      <AssetsTable data={data} ctx={ctx} ownerFilter={view.q} />
    </>
  );
}

function ContractStateView(
  { data, view, ctx }: { data: any; view: ViewState; ctx: RenderCtx },
): JSX.Element {
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
      <H2>Contract <Mono style={{ color: theme.color.accent }}>{view.id}</Mono></H2>
      <Collapsible open>
        <summary>Call history</summary>
        <FilterTable
          columns={callColumns}
          rows={callsRows.slice(1)}
          renderRow={(r, i) => {
            const expanded = expandGroup(r);
            return expanded.map((e, j) => {
              const row = e.row;
              const n = colCount || row.length;
              return (
                <tr key={`${i}-${j}`}>
                  {Array.from({ length: n }).map((_, ci) => {
                    const cell = row[ci];
                    const label = headerLabels[ci] || '';
                    if (ci === 0) {
                      return (
                        <td key={ci}>
                          {e.depth === 0
                            ? <BlockLink h={cellHeight(cell)} ctx={ctx} />
                            : <Muted>↳</Muted>}
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
                          <FundsTable
                            funds={Array.isArray(fundsRaw) ? (fundsRaw as unknown[]) : null}
                            ctx={ctx}
                          />
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

interface HdrsRow { height: number; ts: number | null; cols: Record<string, number | null> }

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
  table th, table td {
    border-right: 1px solid rgba(255, 255, 255, 0.06);
  }
  table th:last-child, table td:last-child {
    border-right: none;
  }
`;

const ColumnGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 4px 12px;
  margin-top: 6px;
`;

const ColumnChip = styled.label`
  display: flex;
  align-items: center;
  & > * + * { margin-left: 6px; }
  font-size: 12px;
  cursor: pointer;
  user-select: none;
  padding: 2px 4px;
  border-radius: 4px;
  color: ${theme.color.muted};

  &:hover { color: ${theme.color.text}; background: rgba(255, 255, 255, 0.03); }
  & > input { margin: 0; cursor: pointer; }
  & > input:disabled { cursor: default; }
  &[data-active="true"] { color: ${theme.color.text}; }
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
  & > * + * { margin-left: 8px; }
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
  &:hover { text-decoration: underline; }
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
function niceTicks(rawMin: number, rawMax: number, targetTicks = 5): {
  values: number[]; min: number; max: number;
} {
  let min = rawMin;
  let max = rawMax;
  if (!Number.isFinite(min) || !Number.isFinite(max)) { min = 0; max = 1; }
  if (min === max) { min -= 1; max += 1; }
  if (min > max) { const t = min; min = max; max = t; }
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
function niceTimeTicks(rawMin: number, rawMax: number, targetTicks = 5): {
  values: number[]; min: number; max: number;
} {
  let min = rawMin;
  let max = rawMax;
  if (!Number.isFinite(min) || !Number.isFinite(max)) { min = 0; max = 60; }
  if (min === max) { min -= 60; max += 60; }
  if (min > max) { const t = min; min = max; max = t; }
  const MIN = 60;
  const HOUR = 3600;
  const DAY = 86400;
  const WEEK = 604800;
  const MONTH = 2629746; // 30.44 days
  const YEAR = 31556952; // 365.24 days
  const range = max - min;
  let unit: 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year';
  let primaryStep: number;
  if (range < HOUR) { unit = 'minute'; primaryStep = Math.ceil(range / targetTicks / MIN) * MIN; } else if (range < DAY) { unit = 'hour'; primaryStep = Math.ceil(range / targetTicks / HOUR) * HOUR; } else if (range < WEEK * 2) { unit = 'day'; primaryStep = Math.ceil(range / targetTicks / DAY) * DAY; } else if (range < MONTH * 2) { unit = 'week'; primaryStep = Math.ceil(range / targetTicks / WEEK) * WEEK; } else if (range < YEAR) { unit = 'month'; primaryStep = Math.ceil(range / targetTicks / MONTH) * MONTH; } else { unit = 'year'; primaryStep = Math.ceil(range / targetTicks / YEAR) * YEAR; }
  if (!(primaryStep > 0)) primaryStep = MIN;
  const d = new Date(min * 1000);
  let niceMin: number;
  switch (unit) {
    case 'minute': niceMin = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()).getTime() / 1000; break;
    case 'hour': niceMin = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()).getTime() / 1000; break;
    case 'day': niceMin = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000; break;
    case 'week': niceMin = new Date(d.getFullYear(), d.getMonth(), d.getDate() - d.getDay() + 1).getTime() / 1000; break;
    case 'month': niceMin = new Date(d.getFullYear(), d.getMonth(), 1).getTime() / 1000; break;
    case 'year': niceMin = new Date(d.getFullYear(), 0, 1).getTime() / 1000; break;
    default: niceMin = min;
  }
  let niceMax = niceMin;
  for (let i = 0; niceMax <= max && i < 1000; i += 1) niceMax += primaryStep;
  const values: number[] = [];
  for (let v = niceMin, i = 0; v <= niceMax && i < 1000; v += primaryStep, i += 1) values.push(v);
  if (values.length === 0) values.push(niceMin, niceMax);
  return { values, min: niceMin, max: niceMax };
}

const intFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

// Size columns (Size.Compressed/Archive + their deltas) are byte counts.
const BYTE_CODES = new Set(['c', 'C', 'a', 'A']);

// Compact count: 2,000,000 -> "2M", 25,600 -> "25.6K".
function fmtCompact(v: number): string {
  if (!Number.isFinite(v)) return '';
  const abs = Math.abs(v);
  const trim = (n: number): string => n.toFixed(2).replace(/\.?0+$/, '');
  if (abs >= 1e9) return `${trim(v / 1e9)}B`;
  if (abs >= 1e6) return `${trim(v / 1e6)}M`;
  if (abs >= 1e3) return `${trim(v / 1e3)}K`;
  return intFmt.format(v);
}

// Byte count -> KB/MB/GB (decimal, so 4,000,000,000 -> "4 GB").
function fmtBytesAxis(v: number, decimals = 2): string {
  if (!Number.isFinite(v)) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let n = Math.abs(v);
  let i = 0;
  while (n >= 1000 && i < units.length - 1) { n /= 1000; i += 1; }
  const s = `${i === 0 ? n.toFixed(0) : n.toFixed(decimals).replace(/\.?0+$/, '')} ${units[i]}`;
  return v < 0 ? `-${s}` : s;
}

// Compact Y-axis tick label: per column → time, bytes, or compact count.
function fmtSeriesVal(code: string, isTime: boolean, v: number): string {
  if (isTime) return fmtAxisTime(v);
  if (BYTE_CODES.has(code)) return fmtBytesAxis(v);
  return fmtCompact(v);
}

// More precise variant for the hover/frozen cursor value (we have the room):
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
  & > * + * { margin-left: 10px; }
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
  &:hover { color: ${theme.color.text}; border-color: ${theme.color.text}; }
  &:disabled { opacity: 0.4; cursor: default; }
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
  &::-webkit-color-swatch-wrapper { padding: 0; }
  &::-webkit-color-swatch { border: none; border-radius: 2px; }
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
  rows, plotted, colors, onReset, onSetColor,
}: {
  rows: HdrsRow[];
  plotted: string[];
  colors: Record<string, string>;
  /** Reset all series colors to their column defaults (palette icon). */
  onReset: () => void;
  /** Override one series' color (per-series color picker in the legend). */
  onSetColor: (code: string, color: string) => void;
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
        code, color: colors[code] ?? columnHeaders[code]?.color ?? '#00f6d2', isTime, raw, ticks,
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
      if (typeof r.ts === 'number' && Number.isFinite(r.ts)) { last = r.ts; return r.ts; }
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
  const xAt = useCallback((idx: number): number => {
    if (n <= 1) return PLOT_W / 2;
    const { min, max } = xMinMax;
    const span = max - min;
    if (!(span > 0)) return PLOT_W / 2;
    const v = xValues[idx] ?? min;
    return PAD_X + (PLOT_W - 2 * PAD_X) * ((v - min) / span);
  }, [n, xMinMax, xValues]);

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
  // Cursor freeze (faithful to graphHoverToggle: clicking the plot toggles a
  // frozen state; while frozen the cursor stays put and mousemove/leave are
  // ignored; clicking again resumes mouse-following).
  const [frozen, setFrozen] = useState(false);
  const plotRef = useRef<SVGSVGElement>(null);

  const onMove = useCallback((e: React.MouseEvent<SVGSVGElement>): void => {
    if (n === 0 || frozen) return; // frozen → mousemove ignored (graphHoverOn gate)
    const el = plotRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return;
    if (n === 1) { setCursor(0); return; }
    // Mouse x in viewBox units, then nearest sample by distance to its xsvg
    // position (matches graphHoverOn's distances.indexOf(min)). x positions are
    // non-uniform once the source is height/timestamp.
    const xUnits = ((e.clientX - rect.left) / rect.width) * PLOT_W;
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < n; i += 1) {
      const d = Math.abs(xUnits - xAt(i));
      if (d < bestDist) { bestDist = d; best = i; }
    }
    setCursor(best);
  }, [n, frozen, xAt]);

  // Click toggles freeze (graphHoverToggle). Unfreezing resumes following.
  const onPlotClick = useCallback(() => setFrozen((f) => !f), []);

  const clearCursor = useCallback(() => {
    if (frozen) return; // graphHoverOff is a no-op while frozen
    setCursor(null);
  }, [frozen]);

  // When the data window changes (new fetch / fewer rows), drop a now-stale
  // cursor index and release any freeze so we never index out of bounds.
  useEffect(() => {
    setCursor(null);
    setFrozen(false);
  }, [n]);

  if (n === 0) {
    return (
      <ChartCard>
        <ChartHint>No block-header rows to chart.</ChartHint>
      </ChartCard>
    );
  }

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
            <option value="T" disabled={!tsAvailable}>Timestamp</option>
          </Select>
        </label>
        <span style={{ marginLeft: 'auto' }}>
          {frozen ? (
            <span style={{ color: theme.color.accent }}>cursor frozen &middot; click plot to resume</span>
          ) : (
            <>check columns in the table below to plot them &middot; click plot to freeze cursor</>
          )}
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
            <svg
              ref={plotRef}
              width="100%"
              height={PLOT_H}
              viewBox={`0 0 ${PLOT_W} ${PLOT_H}`}
              preserveAspectRatio="none"
              style={{ display: 'block', cursor: frozen ? 'pointer' : 'crosshair' }}
              onMouseMove={onMove}
              onMouseLeave={clearCursor}
              onClick={onPlotClick}
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
                const pts: string[] = [];
                for (let i = 0; i < n; i += 1) {
                  pts.push(`${xAt(i).toFixed(2)},${yFor(s, s.raw[i]!).toFixed(2)}`);
                }
                return (
                  <polyline
                    key={s.code}
                    points={pts.join(' ')}
                    fill="none"
                    stroke={s.color}
                    strokeWidth={1.6}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    vectorEffect="non-scaling-stroke"
                  />
                );
              })}

              {/* Hover cursor: vertical line at the hovered point. While frozen
                  it's drawn dashed + brighter as a subtle affordance. */}
              {cursorX !== null && (
                <line
                  x1={cursorX}
                  x2={cursorX}
                  y1={PAD_Y}
                  y2={PLOT_H - PAD_Y}
                  stroke={frozen ? theme.color.accent : 'rgba(255,255,255,0.5)'}
                  strokeWidth={1}
                  strokeDasharray={frozen ? '3 3' : undefined}
                  vectorEffect="non-scaling-stroke"
                />
              )}

              {/* Hover cursor: per-series dot at the hovered point. */}
              {cursor !== null && series.map((s) => (
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
            <div style={{ position: 'relative', height: 18, marginTop: 2 }}>
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
                    background: frozen ? theme.color.accent : 'rgba(255,255,255,0.12)',
                    color: frozen ? '#0b0f10' : theme.color.text,
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
                style={{ width: w, flex: `0 0 ${w}px`, position: 'relative', height: PLOT_H }}
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
                        <text
                          x={7}
                          y={y}
                          fill={s.color}
                          fontSize={10}
                          textAnchor="start"
                          dominantBaseline="middle"
                        >
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

      {/* Legend: each enabled series' swatch is a per-series <input type="color">
          bound to its color (faithful to graphColorPicker / changeGraphColor).
          Series on/off is NOT toggled here — that stays in the table headers. */}
      {series.length > 0 && (
        <ChartLegend>
          {series.map((s) => (
            <label
              key={`leg-${s.code}`}
              style={{
                display: 'inline-flex', alignItems: 'center', marginRight: 16, color: s.color, cursor: 'pointer',
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

function HdrsTable({
  data, colCodes, plotted, colors, onTogglePlot, ctx,
}: {
  data: any;
  colCodes: string;
  plotted: string[];
  colors: Record<string, string>;
  onTogglePlot: (code: string) => void;
  ctx: RenderCtx;
}): JSX.Element {
  const isTable = data && typeof data === 'object' && data.type === 'table' && Array.isArray(data.value);
  const allRows: unknown[][] = isTable ? (data.value as unknown[]).filter(Array.isArray) as unknown[][] : [];
  if (allRows.length === 0) {
    // Fall back to the generic renderer for unexpected shapes.
    return <RenderValue value={data} ctx={ctx} />;
  }
  const headerRow = allRows[0]!;
  const dataRows = allRows.slice(1);
  // Column 0 is always Height; the rest follow `colCodes` in order.
  const codeForCol = (col: number): string | null => (col === 0 ? 'h' : (colCodes[col - 1] ?? null));

  return (
    <ScrollX>
      <DataTable>
        <thead>
          <tr>
            {headerRow.map((cell, ci) => {
              const code = codeForCol(ci);
              const graphable = code !== null && code !== 'h'
                && CHARTABLE_COLS.includes(code) && columnHeaders[code] !== undefined;
              const on = code !== null && plotted.includes(code);
              const color = code !== null
                ? (colors[code] ?? columnHeaders[code]?.color ?? undefined)
                : undefined;
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
          {dataRows.map((row, ri) => (
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
    </ScrollX>
  );
}

function HdrsView(
  { data, view, ctx }: { data: any; view: ViewState; ctx: RenderCtx },
): JSX.Element {
  const [colsDraft, setColsDraft] = useState(view.cols || COLUMN_DEFAULT_DISPLAY);
  const [nMaxDraft, setNMaxDraft] = useState(view.nMax || '100');
  const [hMaxDraft, setHMaxDraft] = useState(view.hMax || '');
  const [dhDraft, setDhDraft] = useState(view.dh || '1');

  const activeCols = view.cols || COLUMN_DEFAULT_DISPLAY;

  // Chart state lifted here so the table-header checkboxes drive the plot.
  // `plotted` = set of column codes drawn as series; `colorOverrides` holds
  // per-column color picks from Reset/Recolor (default falls back to
  // columnHeaders[code].color).
  const [plotted, setPlotted] = useState<string[]>([]);
  const [colorOverrides, setColorOverrides] = useState<Record<string, string>>({});

  // Chart is collapsed by default behind a "+ Chart" / "− Chart" toggle
  // (faithful to the reference's `graphCollapsible` <details>). We track the
  // open state so the summary can show a +/− marker and so the chart only
  // MOUNTS while open — which sidesteps the Chrome-83 hidden-SVG measurement
  // bug the reference works around in `toggleGraph`.
  const [chartOpen, setChartOpen] = useState(false);

  // Keep the local draft synced with the URL view (e.g. when navigating
  // older/newer or following a special-block link that sets cols).
  useEffect(() => {
    setColsDraft(view.cols || COLUMN_DEFAULT_DISPLAY);
    setNMaxDraft(view.nMax || '100');
    setHMaxDraft(view.hMax || '');
    setDhDraft(view.dh || '1');
  }, [view.cols, view.nMax, view.hMax, view.dh]);

  // Drop any plotted code that's no longer a visible column when `cols` changes.
  useEffect(() => {
    setPlotted((cur) => cur.filter((c) => activeCols.includes(c)));
  }, [activeCols]);

  const togglePlot = useCallback((code: string): void => {
    if (code === 'h' || !CHARTABLE_COLS.includes(code)) return;
    setPlotted((cur) => (cur.includes(code) ? cur.filter((c) => c !== code) : [...cur, code]));
  }, []);

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
      ctx.go({
        type: 'hdrs',
        cols:  overrides?.cols  ?? colsDraft,
        nMax:  overrides?.nMax  ?? nMaxDraft,
        hMax: (overrides?.hMax  ?? hMaxDraft) || undefined,
        dh:   (overrides?.dh    ?? dhDraft) || '1',
      });
    },
    [ctx, colsDraft, nMaxDraft, hMaxDraft, dhDraft],
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

  const setPreset = useCallback((preset: 'current' | 'default' | 'all') => {
    let next = colsDraft;
    if (preset === 'current') next = view.cols || COLUMN_DEFAULT_DISPLAY;
    else if (preset === 'default') next = COLUMN_DEFAULT_DISPLAY.replace(/h/g, '');
    else if (preset === 'all') next = Object.keys(columnHeaders).filter((k) => k !== 'h').join('');
    setColsDraft(next); // draft only — applied on Apply
  }, [colsDraft, view.cols]);

  const olderMore = data?.more;
  const newerHMax = olderMore?.hMax !== undefined
    ? String(Number(olderMore.hMax) + Number(nMaxDraft) * 2)
    : null;

  // Rows / interval presets (mirror BeamExplorer.htm's dropdowns). A
  // non-preset value from the URL is kept as a leading option so the select
  // still reflects it.
  const ROW_PRESETS = ['100', '200', '500', '1000', '2000'];
  const DH_PRESETS: Array<[string, string]> = [
    ['1', '1 (block)'], ['60', '60 (~hour)'], ['1440', '1,440 (~day)'],
    ['10080', '10,080 (~week)'], ['43200', '43,200 (~month)'],
  ];
  const rowOptions = ROW_PRESETS.includes(nMaxDraft) ? ROW_PRESETS : [nMaxDraft, ...ROW_PRESETS];
  const dhOptions = DH_PRESETS.some(([v]) => v === dhDraft) ? DH_PRESETS : [[dhDraft, dhDraft] as [string, string], ...DH_PRESETS];

  return (
    <>
      <H2>
        Block headers{' '}
        {olderMore && <Btn data-variant="ghost" onClick={() => ctx.go({ ...view, ...olderMore })}>« Older</Btn>}{' '}
        {newerHMax !== null && (
          <Btn data-variant="ghost" onClick={() => ctx.go({ ...view, hMax: newerHMax })}>Newer »</Btn>
        )}
      </H2>
      <Collapsible>
        <summary>Table options</summary>
        <div
          style={{
            display: 'flex', flexWrap: 'wrap', alignItems: 'center', margin: '8px 0',
          }}
        >
          <label>
            Rows:{' '}
            <Select
              style={{ display: 'inline-block' }}
              value={nMaxDraft}
              onChange={(e) => setNMaxDraft(e.target.value)}
            >
              {rowOptions.map((n) => (
                <option key={n} value={n}>
                  {Number(n).toLocaleString('en-US')}{n === '100' ? ' (default)' : n === '2000' ? ' (max)' : ''}
                </option>
              ))}
            </Select>
          </label>
          <label style={{ marginLeft: 12 }}>
            Interval:{' '}
            <Select
              style={{ display: 'inline-block' }}
              value={dhDraft}
              onChange={(e) => setDhDraft(e.target.value)}
              title="Blocks between sampled rows (Δh)"
            >
              {dhOptions.map(([v, label]) => (
                <option key={v} value={v}>{label}</option>
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
          <Btn style={{ marginLeft: 12 }} onClick={() => apply()}>Apply</Btn>
        </div>

        <ColumnPresets>
          <span>Columns:</span>
          <PresetLink onClick={() => setPreset('current')} title="Reset to the URL's columns">current</PresetLink>
          <span>|</span>
          <PresetLink onClick={() => setPreset('default')} title="Default column set">default</PresetLink>
          <span>|</span>
          <PresetLink onClick={() => setPreset('all')} title="Show every column">all</PresetLink>
          <Input
            value={colsDraft}
            onChange={(e) => setColsDraft(e.target.value)}
            onBlur={() => apply()}
            onKeyDown={(e) => { if (e.key === 'Enter') apply(); }}
            style={{ width: 200, display: 'inline-block', marginLeft: 8 }}
            title="Raw cols code string"
          />
        </ColumnPresets>

        <ColumnGrid>
          {Object.keys(columnHeaders).map((k) => {
            const checked = colsDraft.includes(k) || k === 'h';
            return (
              <ColumnChip
                key={k}
                data-active={checked ? 'true' : 'false'}
                title={columnHeaders[k]!.description}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={k === 'h'}
                  onChange={() => toggleColumn(k)}
                />
                <ColorSwatch color={columnHeaders[k]!.color ?? undefined} />
                <span>{columnHeaders[k]!.title}</span>
              </ColumnChip>
            );
          })}
        </ColumnGrid>
      </Collapsible>
      <ChartCollapsible
        open={chartOpen}
        onToggle={(e) => setChartOpen((e.currentTarget as HTMLDetailsElement).open)}
      >
        <summary>
          <span aria-hidden style={{ marginRight: 6, fontWeight: 700 }}>{chartOpen ? '−' : '+'}</span>
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
  const peerIp = (p: any): string => (typeof p === 'string' ? p : (p?.ip ?? JSON.stringify(p)));
  return (
    <>
      <H2>Connected Peers ({peers.length})</H2>
      <p>
        Network <b>{ctx.network}</b> on <Mono>{getNodeUrl(ctx.network)}</Mono>
      </p>
      {peers.length === 0 ? (
        <ScrollX>
          <DataTable>
            <thead><tr><th>#</th><th>Peer IP</th></tr></thead>
            <tbody><tr><td colSpan={2}><Muted>No peers connected</Muted></td></tr></tbody>
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
              <td><Mono>{peerIp(p)}</Mono></td>
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
          <thead><tr><th className="right">Height</th><th>Description</th></tr></thead>
          <tbody>
            {specialBlocks.map((b, i) => (
              <tr key={i}>
                <td className="right">
                  {b.block_list?.map((h) => (
                    <div key={h}><BlockLink h={h} ctx={ctx} /></div>
                  ))}
                  {b.block_range && (
                    <div>
                      <BlockLink h={b.block_range[0]} ctx={ctx} /><br />
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
                            <a href={l[1]} target="_blank" rel="noreferrer" style={{ color: theme.color.accent }}>{l[1]}</a>
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

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export const BeamExplorer: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const [data, setData] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const reqId = useRef(0);

  // The URL is the single source of truth for the view; navigating just
  // rewrites the query string and the render follows.
  const view = useMemo(() => parseView(searchParams), [searchParams]);

  const setView = useCallback((next: ViewState): void => {
    setSearchParams(serializeView(next));
    if (typeof window !== 'undefined') {
      window.scrollTo({ top: 0, behavior: 'auto' });
    }
  }, [setSearchParams]);

  const go = useCallback((patch: Partial<ViewState>): void => {
    const next: ViewState = { ...view, ...patch };
    if (patch.type && patch.type !== view.type) {
      if (patch.type !== 'block') { next.kernel = undefined; next.adj = undefined; }
      if (patch.type !== 'asset' && patch.type !== 'contract') { next.hMin = undefined; }
      if (patch.type !== 'assets') next.q = undefined; // owner filter only applies to the assets list
    }
    setView(next);
  }, [view, setView]);

  useEffect(() => {
    if (view.type === 'historical') {
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }
    const url = buildRequestUrl(view);
    if (!url) {
      if (view.type === 'asset' && view.id === '0') {
        go({ type: 'assets', id: undefined });
      }
      return;
    }
    setLoading(true);
    setError(null);
    reqId.current += 1;
    const myId = reqId.current;
    fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((j) => {
        if (myId !== reqId.current) return;
        setData(j);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (myId !== reqId.current) return;
        setError(e instanceof Error ? e.message : 'Request failed');
        setLoading(false);
      });
  }, [view, go]);

  const ctx: RenderCtx = useMemo(
    () => ({ go, network: view.network, viewType: view.type }),
    [go, view.network, view.type],
  );

  const submitSearch = (e: React.FormEvent): void => {
    e.preventDefault();
    const q = search.trim();
    if (!q) return;
    // Tolerate copy-pasted block heights with thousands separators (e.g.
    // "3,863,512" as rendered elsewhere in the terminal); kernel ids are hex
    // and never contain these, so strip them only for the numeric test.
    const cleaned = q.replace(/[\s,_]/g, '');
    if (cleaned.length < 10 && /^\d+$/.test(cleaned)) {
      go({ type: 'block', height: cleaned, kernel: undefined });
    } else {
      go({ type: 'block', kernel: q, height: undefined });
    }
  };

  const networkType = readNetworkType(view.network);

  return (
    <Page>
      <DensePage>
      <ExplorerHeader>
        <H1>Beam Smart Explorer</H1>
        <Row>
          <Select
            value={view.network}
            onChange={(e) => setView({ network: e.target.value, type: 'status' })}
            title="Change network"
          >
            {Object.keys(explorerNodes).map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </Select>
          <TinyPill data-tone={networkType === 'PoS' ? 'purple' : 'info'}>{networkType}</TinyPill>
          <SearchForm onSubmit={submitSearch}>
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search kernel id or block height"
              title="Enter a kernel id (hex) or a block height"
              style={{ fontSize: 12, padding: '4px 8px' }}
            />
            <Btn type="submit" style={{ padding: '4px 10px', fontSize: 11 }}>Search</Btn>
          </SearchForm>
        </Row>
      </ExplorerHeader>

      <NavTabs>
        <NavTab data-active={view.type === 'status' ? 'true' : 'false'} onClick={() => go({ type: 'status' })}>Status</NavTab>
        <NavTab data-active={view.type === 'hdrs' ? 'true' : 'false'} onClick={() => go({ type: 'hdrs' })}>Headers</NavTab>
        <NavTab data-active={view.type === 'contracts' ? 'true' : 'false'} onClick={() => go({ type: 'contracts' })}>Contracts</NavTab>
        <NavTab
          data-active={view.type === 'assets' ? 'true' : 'false'}
          onClick={() => go({ type: 'assets', height: undefined })}
        >
          Assets
        </NavTab>
        <NavTab data-active={view.type === 'peers' ? 'true' : 'false'} onClick={() => go({ type: 'peers' })}>Peers</NavTab>
        <NavTab data-active={view.type === 'treasury' ? 'true' : 'false'} onClick={() => go({ type: 'treasury' })}>Treasury</NavTab>
        <NavTab data-active={view.type === 'historical' ? 'true' : 'false'} onClick={() => go({ type: 'historical' })}>Historical</NavTab>
      </NavTabs>

      {loading && <Loading>Loading…</Loading>}
      {error && <ErrorBox>Failed to load: {error}</ErrorBox>}

      {!loading && !error && (
        <>
          {view.type === 'status' && <StatusView data={data} ctx={ctx} />}
          {(view.type === 'block' || view.type === 'treasury') && (
            <BlockView data={data} view={view} ctx={ctx} />
          )}
          {view.type === 'contracts' && <ContractsView data={data} ctx={ctx} />}
          {view.type === 'contract' && (
            <ContractStateView data={data} view={view} ctx={ctx} />
          )}
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
