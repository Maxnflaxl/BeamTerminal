import React, {
  useCallback, useEffect, useMemo, useRef, useState,
} from 'react';
import { styled } from '@linaria/react';
import {
  createChart, ColorType, CrosshairMode,
  type IChartApi, type ISeriesApi, type LineData, type UTCTimestamp,
} from 'lightweight-charts';
import {
  Page, Card, ExplorerHeader, H1, H2, H3,
  Btn, Input, Select, Pill,
  DataTable, ScrollX, ErrorBox, Row, theme,
} from './shared';

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
}

const defaultView: ViewState = { network: 'mainnet', type: 'status' };

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
  gap: 8px;
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
  gap: 14px;
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

const Loading = styled.div`
  color: ${theme.color.muted};
  padding: 24px;
  text-align: center;
  font-size: 16px;
`;

const Pager = styled.div`
  display: flex;
  gap: 8px;
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
  return (
    <Link
      onClick={(e) => { e.preventDefault(); ctx.go({ type: 'block', height: String(h) }); }}
      href="#"
      style={{ color: theme.color.info }}
    >
      {String(h)}
    </Link>
  );
}

function CidLink({ cid, ctx }: { cid: string; ctx: RenderCtx }): JSX.Element {
  return (
    <Link
      onClick={(e) => { e.preventDefault(); ctx.go({ type: 'contract', id: cid }); }}
      href="#"
      title={cid}
    >
      <Mono>{cid}</Mono>
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
  return (
    <ScrollX>
      <DataTable>
        <thead><tr>
          <th>Commitment</th>
          <th>{isInp ? 'Height' : 'Spent'}</th>
          <th>Maturity</th>
          <th>Extra</th>
        </tr></thead>
        <tbody>
          {rows.map((r, i) => {
            const heightCell = isInp ? r.height : r.spent;
            const extras: string[] = [];
            if (r.Asset) extras.push(`CA [${r.Asset.min}-${r.Asset.max}]`);
            if (r.type) extras.push(String((r.type as TypedCell).value ?? r.type));
            if (r.Value != null) extras.push(String((r.Value as TypedCell).value ?? r.Value));
            return (
              <tr key={i}>
                <td><Mono title={r.commitment}>{r.commitment}</Mono></td>
                <td className="right">
                  {heightCell != null ? <BlockLink h={heightCell} ctx={ctx} /> : ''}
                </td>
                <td className="right">
                  {r.Maturity != null ? <RenderValue value={r.Maturity} ctx={ctx} /> : ''}
                </td>
                <td>{extras.join(' ')}</td>
              </tr>
            );
          })}
        </tbody>
      </DataTable>
    </ScrollX>
  );
}

function AssetsTable({ data, ctx }: { data: any; ctx: RenderCtx }): JSX.Element {
  const rawRows = data?.value;
  const rows: any[][] = Array.isArray(rawRows) ? rawRows : [];
  return (
    <ScrollX>
      <DataTable>
        <thead><tr>
          <th>Id</th><th>Owner</th><th className="right">Deposit</th>
          <th className="right">Supply</th><th>Lock Height</th><th>Metadata</th>
        </tr></thead>
        <tbody>
          {rows.slice(1).map((row, i) => {
            const r: any[] = Array.isArray(row) ? row : [];
            return (
              <tr key={i}>
                <td><AssetLink aid={r[0]?.value} ctx={ctx} /></td>
                <td><RenderValue value={r[1]} ctx={ctx} /></td>
                <td className="right"><AmountClr amount={String(r[2]?.value ?? '')} /></td>
                <td className="right"><AmountClr amount={String(r[3]?.value ?? '')} /></td>
                <td>{r[4] != null ? <RenderValue value={r[4]} ctx={ctx} /> : ''}</td>
                <td><Mono style={{ color: theme.color.purple }}>{String(r[5] ?? '')}</Mono></td>
              </tr>
            );
          })}
        </tbody>
      </DataTable>
    </ScrollX>
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
            <ScrollX>
              <DataTable>
                <thead><tr>
                  <th>ID</th><th className="right">Fee</th><th>Height</th><th>Extra</th>
                </tr></thead>
                <tbody>
                  {data.kernels.map((k: any, i: number) => {
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
                  })}
                </tbody>
              </DataTable>
            </ScrollX>
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
  return (
    <>
      <H2>Deployed Smart Contracts</H2>
      <ScrollX>
        <DataTable>
          <thead><tr>
            <th>{L(0, 'Cid')}</th>
            <th>{L(1, 'Kind')}</th>
            <th className="right">{L(2, 'Deploy Height')}</th>
            <th>{L(3, 'Locked Funds')}</th>
            <th>{L(4, 'Owned Assets')}</th>
          </tr></thead>
          <tbody>
            {rows.slice(1).map((row, i) => {
              const r: any[] = Array.isArray(row) ? row : [];
              const cid = r[0]?.value;
              // Deploy Height is a bare number in `/contracts?exp_am=1` (see
              // the original MakeBlock(jRow[2]) call) - reading `.value` on
              // the number was the source of the "undefined" rendering.
              const heightCell = r[2];
              const height = (heightCell !== null && typeof heightCell === 'object')
                ? (heightCell as { value?: unknown }).value
                : heightCell;
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
            })}
          </tbody>
        </DataTable>
      </ScrollX>
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
        <ScrollX>
          <DataTable>
            <thead><tr>
              <th>Height</th><th>Event</th><th className="right">Amount</th>
              <th className="right">Total Amount</th><th>Extra</th>
            </tr></thead>
            <tbody>
              {histRows.slice(1).map((row, i) => {
                const r: any[] = Array.isArray(row) ? row : [];
                return (
                  <tr key={i}>
                    <td><BlockLink h={(r[0] as TypedCell)?.value as string} ctx={ctx} /></td>
                    <td><RenderValue value={r[1]} ctx={ctx} /></td>
                    <td className="right"><RenderValue value={r[2]} ctx={ctx} /></td>
                    <td className="right"><RenderValue value={r[3]} ctx={ctx} /></td>
                    <td><RenderValue value={r[4]} ctx={ctx} /></td>
                  </tr>
                );
              })}
            </tbody>
          </DataTable>
        </ScrollX>
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
      <AssetsTable data={data} ctx={ctx} />
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

  return (
    <>
      <H2>Contract <Mono style={{ color: theme.color.accent }}>{view.id}</Mono></H2>
      <Collapsible open>
        <summary>Call history</summary>
        <ScrollX>
          <DataTable>
            <thead><tr>
              {headerLabels.length > 0
                ? headerLabels.map((label, i) => <th key={i}>{label}</th>)
                : (
                  <>
                    <th>Height</th><th>Cid</th><th>Kind</th><th>Method</th>
                    <th>Arguments</th><th>Funds</th><th>Keys</th>
                  </>
                )}
            </tr></thead>
            <tbody>
              {callsRows.slice(1).flatMap((r, i) => {
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
                                ? <BlockLink h={(cell as TypedCell)?.value as string} ctx={ctx} />
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
              })}
            </tbody>
          </DataTable>
        </ScrollX>
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

const ChartHost = styled.div`
  width: 100%;
  height: 360px;
  min-height: 240px;
  resize: vertical;
  overflow: hidden;
  background: ${theme.color.surface};
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 6px;
  margin: 8px 0 12px;
  position: relative;
`;

const ChartHostInner = styled.div`
  position: absolute;
  inset: 36px 8px 8px 8px;
`;

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
  gap: 6px;
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
  gap: 8px;
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

const ChartControls = styled.div`
  position: absolute;
  top: 6px;
  left: 8px;
  right: 8px;
  display: flex;
  align-items: center;
  gap: 8px;
  z-index: 10;
  font-size: 12px;
  color: ${theme.color.muted};
`;

function HdrsChart({ rows, colCodes }: { rows: HdrsRow[]; colCodes: string }): JSX.Element | null {
  const availableCodes = useMemo(
    () => colCodes.split('').filter((c) => CHARTABLE_COLS.includes(c) && columnHeaders[c] !== undefined),
    [colCodes],
  );
  const [selected, setSelected] = useState<string>(() => availableCodes[0] ?? '');

  // Re-pick a sensible default if the user changes the visible columns and the
  // current selection is no longer present.
  useEffect(() => {
    if (availableCodes.length === 0) return;
    if (!availableCodes.includes(selected)) setSelected(availableCodes[0]!);
  }, [availableCodes, selected]);

  const hasT = colCodes.includes('T');

  const data: LineData[] = useMemo(() => {
    if (!selected || rows.length === 0) return [];
    // Rows come newest-first; sort ascending by height so the chart draws
    // left-to-right oldest-to-newest.
    const sorted = [...rows].sort((a, b) => a.height - b.height);
    const out: LineData[] = [];
    for (const r of sorted) {
      const v = r.cols[selected];
      if (v === null || v === undefined) continue;
      const xAxis = hasT && r.ts !== null ? r.ts : r.height;
      out.push({ time: xAxis as UTCTimestamp, value: v });
    }
    return out;
  }, [rows, selected, hasT]);

  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Line'> | null>(null);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return undefined;
    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: theme.color.surface },
        textColor: theme.color.muted,
        fontSize: 10,
      },
      grid: {
        vertLines: { color: 'rgba(255, 255, 255, 0.04)' },
        horzLines: { color: 'rgba(255, 255, 255, 0.04)' },
      },
      crosshair: {
        mode: CrosshairMode.Magnet,
        vertLine: { color: 'rgba(0, 246, 210, 0.4)', width: 1 },
        horzLine: { color: 'rgba(0, 246, 210, 0.4)', width: 1 },
      },
      rightPriceScale: { borderColor: 'rgba(255, 255, 255, 0.1)' },
      timeScale: {
        borderColor: 'rgba(255, 255, 255, 0.1)',
        timeVisible: hasT,
        secondsVisible: false,
        minBarSpacing: 0.01,
      },
    });
    chartRef.current = chart;
    seriesRef.current = chart.addLineSeries({
      color: columnHeaders[selected]?.color ?? '#00f6d2',
      lineWidth: 2,
    });
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
    // Re-create when color/axis-type changes so the series picks up the new
    // colour and the time scale toggles correctly between height/timestamp.
  }, [selected, hasT]);

  useEffect(() => {
    const s = seriesRef.current;
    if (!s) return;
    s.setData(data);
    if (data.length > 0) chartRef.current?.timeScale().fitContent();
  }, [data]);

  if (availableCodes.length === 0 || rows.length === 0) return null;

  return (
    <ChartHost>
      <ChartControls>
        <span>Chart:</span>
        <Select
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          style={{ minWidth: 160 }}
        >
          {availableCodes.map((c) => (
            <option key={c} value={c}>{columnHeaders[c]!.title}</option>
          ))}
        </Select>
        <span style={{ color: 'rgba(255,255,255,0.4)' }}>
          {data.length} pts · x-axis: {hasT ? 'time' : 'height'}
        </span>
      </ChartControls>
      <ChartHostInner ref={hostRef} />
    </ChartHost>
  );
}

function HdrsView(
  { data, view, ctx }: { data: any; view: ViewState; ctx: RenderCtx },
): JSX.Element {
  const [colsDraft, setColsDraft] = useState(view.cols || COLUMN_DEFAULT_DISPLAY);
  const [nMaxDraft, setNMaxDraft] = useState(view.nMax || '100');
  const [hMaxDraft, setHMaxDraft] = useState(view.hMax || '');

  // Keep the local draft synced with the URL view (e.g. when navigating
  // older/newer or following a special-block link that sets cols).
  useEffect(() => {
    setColsDraft(view.cols || COLUMN_DEFAULT_DISPLAY);
    setNMaxDraft(view.nMax || '100');
    setHMaxDraft(view.hMax || '');
  }, [view.cols, view.nMax, view.hMax]);

  const apply = useCallback(
    (overrides?: { cols?: string; nMax?: string; hMax?: string }): void => {
      ctx.go({
        type: 'hdrs',
        cols:  overrides?.cols  ?? colsDraft,
        nMax:  overrides?.nMax  ?? nMaxDraft,
        hMax: (overrides?.hMax  ?? hMaxDraft) || undefined,
        dh: view.dh || '1',
      });
    },
    [ctx, colsDraft, nMaxDraft, hMaxDraft, view.dh],
  );

  const toggleColumn = useCallback((code: string): void => {
    if (code === 'h') return; // Height is mandatory.
    setColsDraft((prev) => {
      const order = Object.keys(columnHeaders);
      const present = new Set(prev.split(''));
      if (present.has(code)) present.delete(code);
      else present.add(code);
      // Re-emit in the canonical order so URLs stay stable across toggles.
      const next = order.filter((k) => k !== 'h' && present.has(k)).join('');
      // Auto-apply so the table updates without a separate button.
      apply({ cols: next });
      return next;
    });
  }, [apply]);

  const setPreset = useCallback((preset: 'current' | 'default' | 'all') => {
    let next = colsDraft;
    if (preset === 'current') next = view.cols || COLUMN_DEFAULT_DISPLAY;
    else if (preset === 'default') next = COLUMN_DEFAULT_DISPLAY.replace(/h/g, '');
    else if (preset === 'all') next = Object.keys(columnHeaders).filter((k) => k !== 'h').join('');
    setColsDraft(next);
    apply({ cols: next });
  }, [apply, colsDraft, view.cols]);

  const olderMore = data?.more;
  const newerHMax = olderMore?.hMax !== undefined
    ? String(Number(olderMore.hMax) + Number(nMaxDraft) * 2)
    : null;

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
            display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', margin: '8px 0',
          }}
        >
          <label>
            Max rows:{' '}
            <Input
              style={{ width: 80, display: 'inline-block' }}
              value={nMaxDraft}
              onChange={(e) => setNMaxDraft(e.target.value)}
              type="number"
            />
          </label>
          <label>
            Max height:{' '}
            <Input
              style={{ width: 120, display: 'inline-block' }}
              value={hMaxDraft}
              onChange={(e) => setHMaxDraft(e.target.value)}
              type="number"
              placeholder="latest"
            />
          </label>
          <Btn onClick={() => apply()}>Apply</Btn>
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
      <HdrsChart rows={extractHdrsRows(data, view.cols || COLUMN_DEFAULT_DISPLAY)} colCodes={view.cols || COLUMN_DEFAULT_DISPLAY} />
      <Card>
        <HdrsTableWrap>
          <RenderValue value={data} ctx={ctx} />
        </HdrsTableWrap>
      </Card>
    </>
  );
}

function PeersView({ data, ctx }: { data: any; ctx: RenderCtx }): JSX.Element {
  const peers: any[] = Array.isArray(data) ? data : [];
  return (
    <>
      <H2>Connected Peers ({peers.length})</H2>
      <p>
        Network <b>{ctx.network}</b> on <Mono>{getNodeUrl(ctx.network)}</Mono>
      </p>
      <ScrollX>
        <DataTable>
          <thead><tr><th>#</th><th>Peer IP</th></tr></thead>
          <tbody>
            {peers.length === 0
              ? <tr><td colSpan={2}><Muted>No peers connected</Muted></td></tr>
              : peers.map((p, i) => (
                <tr key={i}>
                  <td className="right">{i + 1}</td>
                  <td><Mono>{typeof p === 'string' ? p : (p.ip ?? JSON.stringify(p))}</Mono></td>
                </tr>
              ))}
          </tbody>
        </DataTable>
      </ScrollX>
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
  const [view, setView] = useState<ViewState>(defaultView);
  const [data, setData] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const reqId = useRef(0);

  const go = useCallback((patch: Partial<ViewState>): void => {
    setView((prev) => {
      const next: ViewState = { ...prev, ...patch };
      if (patch.type && patch.type !== prev.type) {
        if (patch.type !== 'block') { next.kernel = undefined; next.adj = undefined; }
        if (patch.type !== 'asset' && patch.type !== 'contract') { next.hMin = undefined; }
      }
      return next;
    });
    if (typeof window !== 'undefined') {
      window.scrollTo({ top: 0, behavior: 'auto' });
    }
  }, []);

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
    if (q.length < 10 && /^\d+$/.test(q)) {
      go({ type: 'block', height: q, kernel: undefined });
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
