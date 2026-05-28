import React, { useCallback, useEffect, useRef, useState } from 'react';
import { styled } from '@linaria/react';
import {
  Page, Card, ExplorerHeader, H1, H2, H3, Subtitle, Muted, Btn, TabBtn,
  Input, Pill, DataTable, ScrollX, ErrorBox, WarnBox, Row, Grid2, theme,
} from './shared';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LS_API = 'bridge_tracker_etherscan_api_v2';
const LS_BASE = 'bridge_tracker_explorer_api_base';
const LS_PRO = 'bridge_tracker_pro_holders';
const WBEAM = '0xE5AcBB03D73267c03349c76EaD672Ee4d941F499';
const WBEAM_DECIMALS = 8;
const ETHERSCAN_V2 = 'https://api.etherscan.io/v2/api';
const ETHERSCAN_MIN_INTERVAL_MS = 340;
const EXPLORER_UI = 'https://explorer.0xmx.net/';
const DEFAULT_API_BASE = 'https://explorer.0xmx.net/api';
const ZERO = '0x0000000000000000000000000000000000000000';

// Allowlisted bridge asset IDs on Beam.
const KNOWN_ETH_BRIDGE_AIDS = new Set<number>([36, 37, 38, 39]);
const KNOWN_ARB_BRIDGE_AIDS = new Set<number>([]);

// ---------------------------------------------------------------------------
// Page-specific styled components (only the truly unique presentation bits).
// ---------------------------------------------------------------------------

// A wrapper that gives form fields a sensible min-width inside a Row.
const FieldWrap = styled.div`
  flex: 1;
  min-width: 200px;
`;

// Real <label> element so htmlFor keeps working (shared Label is a div).
const FormLabel = styled.label`
  display: block;
  font-size: 10px;
  color: ${theme.color.muted};
  margin-bottom: 4px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
`;

const Mono = styled.span`
  font-family: inherit;
  word-break: break-all;
`;

// <details> accordion for the per-asset Beam panel — no shared primitive.
const AssetPanel = styled.details`
  background: ${theme.color.surface2};
  border: 1px solid ${theme.color.borderDim};
  border-radius: ${theme.radius.md};
  margin-bottom: 8px;
  > summary {
    padding: 10px 14px;
    cursor: pointer;
    font-weight: 600;
    list-style: none;
  }
  > summary::-webkit-details-marker { display: none; }
  > .inner { padding: 0 14px 14px; }
`;

const CheckboxLabel = styled.label`
  display: flex;
  align-items: center;
  & > * + * { margin-left: 8px; }
  cursor: pointer;
  font-size: 12px;
  color: ${theme.color.text};
`;

const Spinner = styled.span`
  display: inline-block;
  width: 14px;
  height: 14px;
  border: 2px solid ${theme.color.borderDim};
  border-top-color: ${theme.color.accent};
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
  vertical-align: middle;
  margin-right: 8px;
  @keyframes spin { to { transform: rotate(360deg); } }
`;

// Inline tab nav row (shared TabBtn handles the buttons themselves).
const TopNav = styled.div`
  display: flex;
  flex-wrap: wrap;
  & > * + * { margin-left: 6px; }
  padding: 10px 0 14px;
  margin-bottom: 8px;
  border-bottom: 1px solid ${theme.color.divider};
`;

const StatusLine = styled.div`
  color: ${theme.color.muted};
  font-size: 11px;
  margin-bottom: 14px;
`;

const InlineErr = styled.span`
  color: ${theme.color.danger};
  font-size: 12px;
`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Json = unknown;

interface AssetRow {
  Aid: number | string;
  Metadata?: unknown;
  Supply?: unknown;
  'Lock height'?: unknown;
  [k: string]: unknown;
}

interface HistoryRow {
  Event?: string;
  Height?: number | string;
  Amount?: unknown;
  'Total Amount'?: unknown;
  [k: string]: unknown;
}

interface DistributionRow {
  Cid?: string;
  Kind?: string;
  'Locked Value'?: unknown;
  [k: string]: unknown;
}

interface WbeamSupplyRow {
  label: string;
  chainid: number;
  supply?: string;
  rawSmallest?: number;
  err?: string;
}

interface TokenTx {
  hash?: string;
  from?: string;
  to?: string;
  value?: string;
  timeStamp?: string;
  blockNumber?: string;
  logIndex?: string;
  tokenDecimal?: string;
}

interface HolderRow {
  addr: string;
  bal?: bigint;
  balStr?: string;
}

type PageId = 'settings' | 'assets' | 'wbeamTx' | 'holders' | 'beam';

// Pill tone mapping: eth → info, arb → info, mint → success, burn → danger.
type BridgeTone = 'eth' | 'arb' | 'mint' | 'burn';
function pillTone(t: BridgeTone): 'info' | 'success' | 'danger' {
  if (t === 'mint') return 'success';
  if (t === 'burn') return 'danger';
  return 'info';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseTableValue(cell: unknown): unknown {
  if (cell == null) return null;
  if (typeof cell !== 'object') return cell;
  const c = cell as Record<string, unknown>;
  if (c.type === 'table') return cell;
  if (c.type === 'amount') return c.value;
  if ('value' in c) return c.value;
  return cell;
}

function parseTableRows(data: Json): Record<string, unknown>[] {
  const d = data as { value?: unknown[] } | null;
  if (!d || !d.value || !Array.isArray(d.value) || d.value.length < 2) return [];
  const headerRow = d.value[0];
  if (!Array.isArray(headerRow)) return [];
  const headers = headerRow.map((h) => parseTableValue(h) || String(h));
  return d.value.slice(1).map((row) => {
    if (!Array.isArray(row)) return {} as Record<string, unknown>;
    const obj: Record<string, unknown> = {};
    headers.forEach((h, i) => { obj[String(h)] = parseTableValue(row[i]); });
    return obj;
  });
}

function parseMetadata(m: unknown): Record<string, string> {
  if (!m) return {};
  if (typeof m === 'object') return m as Record<string, string>;
  const r: Record<string, string> = {};
  String(m).replace(/^STD:/, '').split(';').forEach((p) => {
    const parts = p.split('=');
    const k = parts[0];
    const v = parts.slice(1).join('=');
    if (k) r[k] = v;
  });
  return r;
}

const DECIMAL_UNITS: Record<string, number> = {
  Groth: 8, Cent: 6, Satoshi: 8, fomo: 8, Flicker: 8, MiniB: 8, bGROTH: 8,
};

function getDecimals(nthun: string | undefined): number {
  if (!nthun) return 8;
  return DECIMAL_UNITS[nthun] || 8;
}

function cleanNumber(s: unknown): number {
  if (typeof s === 'number') return s;
  if (!s) return 0;
  return parseInt(String(s).replace(/,/g, ''), 10) || 0;
}

function formatNum(n: unknown): string {
  return n != null ? new Intl.NumberFormat().format(Number(n)) : '0';
}

function formatAssetAmt(amt: unknown, dec: number): string {
  const v = Math.abs(Number(amt)) / Math.pow(10, dec);
  if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(2) + 'K';
  return v.toFixed(Math.min(dec, 6));
}

function parseAmountCell(s: unknown): number {
  if (typeof s === 'number') return s;
  return parseInt(String(s || '').replace(/[+,]/g, ''), 10) || 0;
}

function bridgeGroupFromRow(row: AssetRow): 'eth' | 'arb' | null {
  const aid = Number(row.Aid);
  if (KNOWN_ARB_BRIDGE_AIDS.has(aid)) return 'arb';
  if (KNOWN_ETH_BRIDGE_AIDS.has(aid)) return 'eth';
  return null;
}

function assetExplorerUrl(id: unknown): string {
  return EXPLORER_UI + '?network=mainnet&type=asset&id=' + encodeURIComponent(String(id));
}

function blockExplorerUrl(h: unknown): string {
  return EXPLORER_UI + '?network=mainnet&type=block&height=' + encodeURIComponent(String(h));
}

function evmTokenUrl(chainid: number): string {
  if (Number(chainid) === 42161) return 'https://arbiscan.io/token/' + WBEAM;
  return 'https://etherscan.io/token/' + WBEAM;
}

function evmTxUrl(chainid: number, hash: string): string {
  if (Number(chainid) === 42161) return 'https://arbiscan.io/tx/' + hash;
  return 'https://etherscan.io/tx/' + hash;
}

function evmAddrUrl(chainid: number, addr: string): string {
  if (Number(chainid) === 42161) return 'https://arbiscan.io/address/' + addr;
  return 'https://etherscan.io/address/' + addr;
}

function extractCurrentCirculationBeam(statusData: Json): number | null {
  function walk(o: unknown): number | null {
    if (!o) return null;
    if (Array.isArray(o)) {
      for (let i = 0; i < o.length; i += 1) {
        const sub = o[i];
        if (Array.isArray(sub) && sub.length >= 2) {
          const h = sub[0] as { type?: string; value?: unknown } | undefined;
          const v = sub[1] as { value?: unknown } | unknown;
          if (h && h.type === 'th' && h.value === 'Current Circulation') {
            const raw = (typeof v === 'object' && v != null && 'value' in (v as Record<string, unknown>))
              ? (v as { value: unknown }).value : v;
            const n = parseFloat(String(raw).replace(/,/g, ''));
            if (Number.isFinite(n) && n > 0) return n;
          }
        }
        const r = walk(sub);
        if (r != null) return r;
      }
    } else if (typeof o === 'object') {
      const obj = o as Record<string, unknown>;
      const keys = Object.keys(obj);
      for (let k = 0; k < keys.length; k += 1) {
        const r = walk(obj[keys[k]]);
        if (r != null) return r;
      }
    }
    return null;
  }
  return walk(statusData);
}

function formatPctWbeamOfBeam(wbeamSmallestUnits: number, beamCircBEAM: number | null): string | null {
  if (beamCircBEAM == null || beamCircBEAM <= 0) return null;
  const wbeam = Number(wbeamSmallestUnits) / Math.pow(10, WBEAM_DECIMALS);
  if (!Number.isFinite(wbeam) || wbeam < 0) return null;
  const pct = (wbeam / beamCircBEAM) * 100;
  if (!Number.isFinite(pct)) return null;
  if (pct === 0) return '0%';
  if (pct < 0.000001) return pct.toExponential(2) + '%';
  if (pct < 0.01) return pct.toFixed(6) + '%';
  return pct.toFixed(4) + '%';
}

function aggregateFromTokentx(allTxs: TokenTx[], tokenDecimals: number): { list: HolderRow[]; dec: number } {
  const sorted = allTxs.slice().sort((a, b) => {
    const hb = Number(b.blockNumber) - Number(a.blockNumber);
    if (hb !== 0) return hb;
    return Number(b.logIndex || 0) - Number(a.logIndex || 0);
  });
  sorted.reverse();
  const bal = new Map<string, bigint>();
  function add(addr: string | undefined, delta: bigint): void {
    if (!addr || addr.toLowerCase() === ZERO) return;
    const k = addr.toLowerCase();
    const cur = bal.get(k) || 0n;
    bal.set(k, cur + delta);
  }
  sorted.forEach((t) => {
    const v = BigInt(t.value || '0');
    const from = (t.from || '').toLowerCase();
    const to = (t.to || '').toLowerCase();
    const z = ZERO.toLowerCase();
    if (from === z) add(t.to, v);
    else if (to === z) add(t.from, -v);
    else { add(t.from, -v); add(t.to, v); }
  });
  const dec = tokenDecimals || 8;
  const list: HolderRow[] = [];
  bal.forEach((wei, addr) => {
    if (wei > 0n) list.push({ addr, bal: wei });
  });
  list.sort((a, b) => {
    const ab = a.bal as bigint;
    const bb = b.bal as bigint;
    if (bb > ab) return 1;
    if (bb < ab) return -1;
    return 0;
  });
  return { list: list.slice(0, 50), dec };
}

// ---------------------------------------------------------------------------
// Network primitives (module-level so they share Etherscan throttling)
// ---------------------------------------------------------------------------

let esChain: Promise<unknown> = Promise.resolve();
let esLastStart = 0;

async function fetchAPI(apiBase: string, endpoint: string, params: Record<string, unknown>): Promise<Json> {
  const base = apiBase.replace(/\/$/, '');
  const url = new URL(base + endpoint);
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v != null && v !== '') url.searchParams.append(k, String(v));
  });
  const resp = await fetch(url.toString());
  if (!resp.ok) throw new Error('Explorer HTTP ' + resp.status);
  return resp.json();
}

async function etherscan(params: Record<string, string>): Promise<{ status?: string; message?: string; result?: unknown }> {
  const key = localStorage.getItem(LS_API);
  if (!key) throw new Error('No Etherscan API key saved');
  const exec = async (): Promise<{ status?: string; message?: string; result?: unknown }> => {
    const now = Date.now();
    const wait = Math.max(0, ETHERSCAN_MIN_INTERVAL_MS - (now - esLastStart));
    if (wait) await new Promise((r) => { setTimeout(r, wait); });
    esLastStart = Date.now();
    const url = new URL(ETHERSCAN_V2);
    Object.entries(params).forEach(([k, v]) => url.searchParams.append(k, v));
    url.searchParams.append('apikey', key);
    const resp = await fetch(url.toString());
    if (!resp.ok) throw new Error('Etherscan HTTP ' + resp.status);
    return resp.json();
  };
  const p = esChain.then(exec);
  esChain = p.catch(() => undefined);
  return p;
}

async function loadTokentxPages(chainid: number, pages: number, offset: number): Promise<{ txs: TokenTx[]; decimals: number }> {
  const all: TokenTx[] = [];
  let decimals = 8;
  for (let page = 1; page <= pages; page += 1) {
    // eslint-disable-next-line no-await-in-loop
    const j = await etherscan({
      chainid: String(chainid),
      module: 'account',
      action: 'tokentx',
      contractaddress: WBEAM,
      page: String(page),
      offset: String(offset),
      sort: 'desc',
    });
    if (j.status !== '1' || !Array.isArray(j.result)) {
      throw new Error(typeof j.result === 'string' ? j.result : (j.message || 'tokentx failed'));
    }
    const arr = j.result as TokenTx[];
    if (arr.length && arr[0].tokenDecimal) decimals = Number(arr[0].tokenDecimal) || 8;
    all.push(...arr);
  }
  return { txs: all, decimals };
}

async function tryTopHolders(chainid: number): Promise<HolderRow[] | null> {
  const j = await etherscan({
    chainid: String(chainid),
    module: 'token',
    action: 'topholders',
    contractaddress: WBEAM,
  });
  if (j.status !== '1' || !Array.isArray(j.result)) return null;
  return (j.result as Array<Record<string, unknown>>).map((r) => {
    const addr = String(r.TokenHolderAddress || r.tokenHolderAddress || '').toLowerCase();
    const qty = String(r.TokenHolderQuantity || r.tokenHolderQuantity || '0');
    return { addr, balStr: qty };
  }).filter((x) => x.addr);
}

// ---------------------------------------------------------------------------
// Small render helpers
// ---------------------------------------------------------------------------

const ExtLink: React.FC<{ href: string; children: React.ReactNode }> = ({ href, children }) => (
  <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
);

function shortHash(h: string | undefined, n = 10): string {
  if (!h) return '';
  return h.length > n ? h.slice(0, n) + '…' : h;
}

function shortAddr(a: string | undefined, n = 8): string {
  if (!a) return '';
  return a.length > n ? a.slice(0, n) + '…' : a;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface AssetPanelData {
  aid: number | string;
  sym: string;
  dec: number;
  totalSupplyDisplay: string;
  mintBurn: HistoryRow[];
  distribution: DistributionRow[];
  err?: string;
}

export const BridgeTracker: React.FC = () => {
  const [page, setPage] = useState<PageId>('settings');
  const [apiBase, setApiBase] = useState<string>(() => {
    try { return localStorage.getItem(LS_BASE) || DEFAULT_API_BASE; } catch { return DEFAULT_API_BASE; }
  });
  const [etherscanKeyInput, setEtherscanKeyInput] = useState('');
  const [hasKey, setHasKey] = useState<boolean>(() => {
    try { return !!localStorage.getItem(LS_API); } catch { return false; }
  });
  const [usePro, setUsePro] = useState<boolean>(() => {
    try { return localStorage.getItem(LS_PRO) === '1'; } catch { return false; }
  });

  const [status, setStatus] = useState('');
  const [statusErr, setStatusErr] = useState('');

  const [ethRows, setEthRows] = useState<AssetRow[]>([]);
  const [arbRows, setArbRows] = useState<AssetRow[]>([]);
  const [assetsErr, setAssetsErr] = useState('');

  const [beamCirc, setBeamCirc] = useState<number | null>(null);
  const [wbeamSupplies, setWbeamSupplies] = useState<WbeamSupplyRow[] | null>(null);
  const [wbeamLoading, setWbeamLoading] = useState(false);

  const [ethTxs, setEthTxs] = useState<TokenTx[] | null>(null);
  const [arbTxs, setArbTxs] = useState<TokenTx[] | null>(null);
  const [ethTxErr, setEthTxErr] = useState('');
  const [arbTxErr, setArbTxErr] = useState('');
  const [txLoading, setTxLoading] = useState(false);

  const [ethHolders, setEthHolders] = useState<{ rows: HolderRow[]; dec: number; title: string } | null>(null);
  const [arbHolders, setArbHolders] = useState<{ rows: HolderRow[]; dec: number; title: string } | null>(null);
  const [ethHoldersErr, setEthHoldersErr] = useState('');
  const [arbHoldersErr, setArbHoldersErr] = useState('');

  const [beamPanels, setBeamPanels] = useState<AssetPanelData[] | null>(null);
  const [beamPanelsLoading, setBeamPanelsLoading] = useState(false);

  const cancelRef = useRef({ cancelled: false });

  const refreshAll = useCallback(async () => {
    cancelRef.current.cancelled = false;
    const base = apiBase.replace(/\/$/, '');
    try { localStorage.setItem(LS_BASE, base); } catch { /* ignore */ }

    setStatus('Loading assets…');
    setStatusErr('');
    setAssetsErr('');

    let ethList: AssetRow[] = [];
    let arbList: AssetRow[] = [];
    try {
      const assetsResp = await fetchAPI(base, '/assets', {});
      const rows = parseTableRows(assetsResp) as AssetRow[];
      for (let i = 0; i < rows.length; i += 1) {
        const row = rows[i];
        if (Number(row.Aid) === 0) continue;
        const g = bridgeGroupFromRow(row);
        if (g === 'eth') ethList.push(row);
        else if (g === 'arb') arbList.push(row);
      }
      ethList.sort((a, b) => Number(a.Aid) - Number(b.Aid));
      arbList.sort((a, b) => Number(a.Aid) - Number(b.Aid));
      if (cancelRef.current.cancelled) return;
      setEthRows(ethList);
      setArbRows(arbList);
      setStatus('Beam assets: ' + (ethList.length + arbList.length) + ' bridge-linked rows.');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setAssetsErr(msg);
      setStatus('');
      setStatusErr(msg);
      return;
    }

    // Beam current circulation (for WBEAM % denominator).
    let circ: number | null = null;
    try {
      const data = await fetchAPI(base, '/status', { exp_am: 1 });
      circ = extractCurrentCirculationBeam(data);
    } catch {
      circ = null;
    }
    if (cancelRef.current.cancelled) return;
    setBeamCirc(circ);

    // WBEAM supply via Etherscan (if key saved).
    const key = (() => { try { return localStorage.getItem(LS_API); } catch { return null; } })();
    if (key) {
      setWbeamLoading(true);
      const chains = [
        { id: 1, label: 'Ethereum' },
        { id: 42161, label: 'Arbitrum One' },
      ];
      const results: WbeamSupplyRow[] = [];
      for (let i = 0; i < chains.length; i += 1) {
        const c = chains[i];
        try {
          // eslint-disable-next-line no-await-in-loop
          const j = await etherscan({
            chainid: String(c.id),
            module: 'stats',
            action: 'tokensupply',
            contractaddress: WBEAM,
          });
          if (j.status !== '1') {
            results.push({ label: c.label, chainid: c.id, err: typeof j.result === 'string' ? j.result : (j.message || 'Error') });
          } else {
            const raw = String(j.result || '0').replace(/,/g, '');
            const n = parseInt(raw, 10) || 0;
            results.push({ label: c.label, chainid: c.id, supply: formatAssetAmt(n, WBEAM_DECIMALS), rawSmallest: n });
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          results.push({ label: c.label, chainid: c.id, err: msg });
        }
      }
      if (!cancelRef.current.cancelled) setWbeamSupplies(results);
      setWbeamLoading(false);
    } else {
      setWbeamSupplies(null);
    }

    // WBEAM transfers + holders (per chain).
    if (key) {
      setTxLoading(true);
      const evmChains = [
        { id: 1, setTxs: setEthTxs, setTxErr: setEthTxErr, setHolders: setEthHolders, setHoldersErr: setEthHoldersErr },
        { id: 42161, setTxs: setArbTxs, setTxErr: setArbTxErr, setHolders: setArbHolders, setHoldersErr: setArbHoldersErr },
      ];
      for (let i = 0; i < evmChains.length; i += 1) {
        const c = evmChains[i];
        try {
          // eslint-disable-next-line no-await-in-loop
          const pack = await loadTokentxPages(c.id, 3, 100);
          if (cancelRef.current.cancelled) return;
          c.setTxs(pack.txs);
          c.setTxErr('');
          let usedPro = false;
          if (usePro) {
            try {
              // eslint-disable-next-line no-await-in-loop
              const top = await tryTopHolders(c.id);
              if (top && top.length) {
                c.setHolders({ rows: top, dec: 8, title: 'Etherscan Pro · topholders' });
                c.setHoldersErr('');
                usedPro = true;
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              c.setHoldersErr('Pro topholders: ' + msg);
            }
          }
          if (!usedPro) {
            const agg = aggregateFromTokentx(pack.txs, pack.decimals);
            c.setHolders({ rows: agg.list, dec: agg.dec, title: 'Approximation from last ' + pack.txs.length + ' transfers' });
            c.setHoldersErr('');
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          c.setTxErr(msg);
          c.setHoldersErr(msg);
          c.setTxs(null);
          c.setHolders(null);
        }
      }
      setTxLoading(false);
    } else {
      setEthTxs(null);
      setArbTxs(null);
      setEthHolders(null);
      setArbHolders(null);
    }

    // Beam asset panels (mint/burn + distribution).
    const combined = ethList.concat(arbList);
    if (!combined.length) {
      setBeamPanels([]);
    } else {
      setBeamPanelsLoading(true);
      const panels: AssetPanelData[] = [];
      for (let i = 0; i < combined.length; i += 1) {
        const a = combined[i];
        const meta0 = parseMetadata(a.Metadata);
        const sym0 = meta0.UN || meta0.SN || meta0.N || ('CA-' + a.Aid);
        try {
          // eslint-disable-next-line no-await-in-loop
          const resp = await fetchAPI(base, '/asset', { id: a.Aid, nMaxOps: 100 }) as Record<string, unknown>;
          const meta = parseMetadata(resp.metadata || a.Metadata);
          const sym = meta.UN || meta.SN || meta.N || ('CA-' + a.Aid);
          const dec = getDecimals(meta.NTHUN);
          const distribution = parseTableRows(resp['Asset distribution'] || {}) as DistributionRow[];
          const history = parseTableRows(resp['Asset history'] || {}) as HistoryRow[];
          const mintBurn = history.filter((h) => h.Event === 'Mint' || h.Event === 'Burn');
          const recentBridge = mintBurn.slice(-20).reverse();
          panels.push({
            aid: a.Aid,
            sym,
            dec,
            totalSupplyDisplay: formatAssetAmt(cleanNumber(resp.value != null ? resp.value : a.Supply), dec),
            mintBurn: recentBridge,
            distribution,
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          panels.push({
            aid: a.Aid, sym: sym0, dec: 8, totalSupplyDisplay: '—', mintBurn: [], distribution: [], err: msg,
          });
        }
        if (cancelRef.current.cancelled) return;
        setBeamPanels(panels.slice());
      }
      setBeamPanelsLoading(false);
    }
  }, [apiBase, usePro]);

  useEffect(() => {
    refreshAll();
    return () => { cancelRef.current.cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onSave = (): void => {
    const k = etherscanKeyInput.trim();
    try {
      if (k) localStorage.setItem(LS_API, k);
      localStorage.setItem(LS_BASE, apiBase.replace(/\/$/, ''));
      localStorage.setItem(LS_PRO, usePro ? '1' : '0');
    } catch { /* ignore */ }
    setEtherscanKeyInput('');
    setHasKey(!!k || hasKey);
    refreshAll();
  };

  const onClearKey = (): void => {
    try { localStorage.removeItem(LS_API); } catch { /* ignore */ }
    setEtherscanKeyInput('');
    setHasKey(false);
    refreshAll();
  };

  return (
    <Page>
      <ExplorerHeader>
        <div>
          <H1>Beam Bridge Tracker</H1>
          <Subtitle>Ethereum &amp; Arbitrum bridges · WBEAM · Confidential bridge assets</Subtitle>
        </div>
      </ExplorerHeader>

      <TopNav>
        <TabBtn type="button" data-active={page === 'settings'} onClick={() => setPage('settings')}>Settings</TabBtn>
        <TabBtn type="button" data-active={page === 'assets'} onClick={() => setPage('assets')}>Bridge assets</TabBtn>
        <TabBtn type="button" data-active={page === 'wbeamTx'} onClick={() => setPage('wbeamTx')}>WBEAM transfers</TabBtn>
        <TabBtn type="button" data-active={page === 'holders'} onClick={() => setPage('holders')}>WBEAM holders</TabBtn>
        <TabBtn type="button" data-active={page === 'beam'} onClick={() => setPage('beam')}>Beam mint/burn</TabBtn>
      </TopNav>

      <StatusLine>
        {statusErr ? <InlineErr>{statusErr}</InlineErr> : status}
      </StatusLine>

      {page === 'settings' && (
        <Card>
          <H2>Settings</H2>
          <Row>
            <FieldWrap>
              <FormLabel htmlFor="apiBase">Beam explorer API base</FormLabel>
              <Input
                id="apiBase"
                type="url"
                value={apiBase}
                autoComplete="off"
                onChange={(e) => setApiBase(e.target.value)}
              />
            </FieldWrap>
          </Row>
          <Row>
            <FieldWrap>
              <FormLabel htmlFor="etherscanKey">Etherscan API V2 key (stored in this browser only)</FormLabel>
              <Input
                id="etherscanKey"
                type="password"
                placeholder={hasKey ? 'Key saved — paste to replace' : 'Paste API key'}
                autoComplete="off"
                value={etherscanKeyInput}
                onChange={(e) => setEtherscanKeyInput(e.target.value)}
              />
            </FieldWrap>
          </Row>
          <Row>
            <CheckboxLabel>
              <input
                type="checkbox"
                checked={usePro}
                onChange={(e) => setUsePro(e.target.checked)}
              />
              <span>Try Etherscan Pro <code>topholders</code> (falls back if not available)</span>
            </CheckboxLabel>
          </Row>
          <Row>
            <Btn type="button" onClick={onSave}>Save locally</Btn>
            <Btn type="button" data-variant="ghost" onClick={onClearKey}>Remove API key</Btn>
            <Btn type="button" onClick={refreshAll}>Refresh all data</Btn>
          </Row>
          <Muted>
            The API key is sent to <Mono>api.etherscan.io</Mono> from your browser when loading EVM data.
            Do not use a shared computer. Calls are spaced to respect the{' '}
            <ExtLink href="https://docs.etherscan.io/resources/rate-limits">Etherscan free tier</ExtLink>{' '}
            limit of <strong>3 calls/sec</strong>.
          </Muted>
        </Card>
      )}

      {page === 'assets' && (
        <Card>
          <H2>Bridge assets on Beam</H2>
          <Muted>
            Only asset IDs listed in <Mono>KNOWN_ETH_BRIDGE_AIDS</Mono> and{' '}
            <Mono>KNOWN_ARB_BRIDGE_AIDS</Mono> in this file are shown (rows are matched from{' '}
            <Mono>/assets</Mono>).
          </Muted>
          <H3>WBEAM (ERC-20)</H3>
          <Muted>
            Wrapped BEAM on Ethereum and Arbitrum — same contract address. Total supply from Etherscan
            when a key is saved (3 calls/sec). <strong>% of circulation</strong> is WBEAM on that
            network ÷ Beam <em>Current Circulation</em> from explorer <Mono>/status?exp_am=1</Mono>.
          </Muted>

          <ScrollX style={{ marginBottom: 18 }}>
            <WbeamBox
              hasKey={hasKey}
              loading={wbeamLoading}
              supplies={wbeamSupplies}
              beamCirc={beamCirc}
            />
          </ScrollX>

          <Grid2>
            <div>
              <H3><Pill data-tone={pillTone('eth')}>Ethereum</Pill> Confidential assets</H3>
              {assetsErr ? <ErrorBox>{assetsErr}</ErrorBox> : (
                <ScrollX><AssetTable rows={ethRows} /></ScrollX>
              )}
            </div>
            <div>
              <H3><Pill data-tone={pillTone('arb')}>Arbitrum</Pill> Confidential assets</H3>
              {assetsErr ? <ErrorBox>{assetsErr}</ErrorBox> : (
                <ScrollX><AssetTable rows={arbRows} /></ScrollX>
              )}
            </div>
          </Grid2>
        </Card>
      )}

      {page === 'wbeamTx' && (
        <Card>
          <H2>WBEAM · Recent transfers</H2>
          <Muted>
            ERC-20 <Mono>{WBEAM}</Mono> on both chains (8 decimals).
          </Muted>
          {!hasKey ? (
            <Muted>Save an Etherscan API key to load WBEAM transfers.</Muted>
          ) : (
            <Grid2>
              <div>
                <H3>Ethereum <Pill data-tone={pillTone('eth')}>chainid 1</Pill></H3>
                {ethTxErr ? <ErrorBox>{ethTxErr}</ErrorBox>
                  : ethTxs ? <ScrollX><TokenTxTable result={ethTxs} chainid={1} /></ScrollX>
                  : <p><Spinner />{txLoading ? 'Loading…' : '—'}</p>}
              </div>
              <div>
                <H3>Arbitrum One <Pill data-tone={pillTone('arb')}>chainid 42161</Pill></H3>
                {arbTxErr ? <ErrorBox>{arbTxErr}</ErrorBox>
                  : arbTxs ? <ScrollX><TokenTxTable result={arbTxs} chainid={42161} /></ScrollX>
                  : <p><Spinner />{txLoading ? 'Loading…' : '—'}</p>}
              </div>
            </Grid2>
          )}
        </Card>
      )}

      {page === 'holders' && (
        <Card>
          <H2>WBEAM · Holders</H2>
          <WarnBox>
            <strong>Approximate holders</strong> (free API): balances are recomputed from the last few
            pages of token transfers only — not a full chain snapshot. Inactive wallets may be missing.
            When Pro <code>topholders</code> succeeds, that table is shown for that chain.
          </WarnBox>
          {!hasKey ? (
            <Muted style={{ marginTop: 14 }}>Save an Etherscan API key to load holders.</Muted>
          ) : (
            <Grid2 style={{ marginTop: 14 }}>
              <div>
                <H3>Ethereum</H3>
                {ethHoldersErr ? <ErrorBox>{ethHoldersErr}</ErrorBox>
                  : ethHolders ? <ScrollX><HolderTable title={ethHolders.title} rows={ethHolders.rows} dec={ethHolders.dec} chainid={1} /></ScrollX>
                  : <p><Spinner />Loading…</p>}
              </div>
              <div>
                <H3>Arbitrum</H3>
                {arbHoldersErr ? <ErrorBox>{arbHoldersErr}</ErrorBox>
                  : arbHolders ? <ScrollX><HolderTable title={arbHolders.title} rows={arbHolders.rows} dec={arbHolders.dec} chainid={42161} /></ScrollX>
                  : <p><Spinner />Loading…</p>}
              </div>
            </Grid2>
          )}
        </Card>
      )}

      {page === 'beam' && (
        <Card>
          <H2>Beam · Mint / burn &amp; distribution</H2>
          <Muted>
            From <Mono>/asset?id=…&amp;nMaxOps=100</Mono> for each allowlisted bridge asset.
          </Muted>
          {beamPanels === null
            ? <p><Spinner />Loading Beam asset details…</p>
            : beamPanels.length === 0
              ? <Muted>No bridge assets to show.</Muted>
              : (
                <>
                  {beamPanelsLoading && <p><Spinner />Loading more…</p>}
                  {beamPanels.map((p) => (
                    <AssetPanel key={String(p.aid)} open>
                      <summary>{p.sym} (Aid {String(p.aid)})</summary>
                      <div className="inner">
                        {p.err ? <ErrorBox>{p.err}</ErrorBox> : (
                          <>
                            <Muted>
                              Total supply (API): <Mono>{p.totalSupplyDisplay}</Mono> ·{' '}
                              <ExtLink href={assetExplorerUrl(p.aid)}>Open in explorer</ExtLink>
                            </Muted>
                            {p.mintBurn.length ? (
                              <>
                                <H3 style={{ marginTop: 12 }}>Recent Mint / Burn (up to 20)</H3>
                                <DataTable>
                                  <thead>
                                    <tr>
                                      <th>Height</th><th>Event</th><th>Amount</th><th>Total supply</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {p.mintBurn.map((h, i) => (
                                      <tr key={i}>
                                        <td className="mono">
                                          <ExtLink href={blockExplorerUrl(h.Height)}>{formatNum(h.Height)}</ExtLink>
                                        </td>
                                        <td>
                                          {h.Event === 'Mint' ? (
                                            <Pill data-tone={pillTone('mint')}>{h.Event}</Pill>
                                          ) : h.Event === 'Burn' ? (
                                            <Pill data-tone={pillTone('burn')}>{h.Event}</Pill>
                                          ) : (
                                            <Pill>{h.Event || ''}</Pill>
                                          )}
                                        </td>
                                        <td className="mono">{formatAssetAmt(parseAmountCell(h.Amount), p.dec)}</td>
                                        <td className="mono">
                                          {h['Total Amount'] != null
                                            ? formatAssetAmt(parseAmountCell(h['Total Amount']), p.dec)
                                            : '-'}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </DataTable>
                              </>
                            ) : (
                              <Muted>No Mint/Burn rows in the last 100 ops.</Muted>
                            )}
                            {p.distribution.length ? (
                              <>
                                <H3 style={{ marginTop: 12 }}>Distribution</H3>
                                <DataTable>
                                  <thead>
                                    <tr><th>Contract</th><th>Kind</th><th>Locked</th></tr>
                                  </thead>
                                  <tbody>
                                    {p.distribution.map((d, i) => (
                                      <tr key={i}>
                                        <td className="mono">{d.Cid ? String(d.Cid).slice(0, 16) + '…' : '-'}</td>
                                        <td>{d.Kind || ''}</td>
                                        <td className="mono">{formatAssetAmt(parseAmountCell(d['Locked Value']), p.dec)}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </DataTable>
                              </>
                            ) : null}
                          </>
                        )}
                      </div>
                    </AssetPanel>
                  ))}
                </>
              )}
        </Card>
      )}
    </Page>
  );
};

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

const WbeamBox: React.FC<{
  hasKey: boolean;
  loading: boolean;
  supplies: WbeamSupplyRow[] | null;
  beamCirc: number | null;
}> = ({ hasKey, loading, supplies, beamCirc }) => {
  const rows: WbeamSupplyRow[] = supplies || [
    { label: 'Ethereum', chainid: 1 },
    { label: 'Arbitrum One', chainid: 42161 },
  ];
  return (
    <div>
      {loading && <p><Spinner />Loading WBEAM supply…</p>}
      <DataTable>
        <thead>
          <tr>
            <th>Chain</th>
            <th>Token</th>
            <th>Total supply</th>
            <th title="WBEAM on this chain ÷ Beam Current Circulation">% of circulation</th>
            <th>Explorer</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            let pctNode: React.ReactNode = '—';
            if (!r.err && r.rawSmallest != null) {
              const pctStr = formatPctWbeamOfBeam(r.rawSmallest, beamCirc);
              pctNode = pctStr != null ? pctStr : '—';
            }
            return (
              <tr key={r.chainid}>
                <td>{r.label}</td>
                <td className="mono">WBEAM</td>
                {r.err ? <td className="danger">{r.err}</td>
                  : <td className="mono">{r.supply != null ? r.supply : '—'}</td>}
                <td className={r.err ? 'muted' : 'mono'}>{pctNode}</td>
                <td><ExtLink href={evmTokenUrl(r.chainid)}>Token</ExtLink></td>
              </tr>
            );
          })}
        </tbody>
      </DataTable>
      <Muted style={{ marginTop: 8 }}>
        {beamCirc != null && Number.isFinite(beamCirc)
          ? <>Beam Current Circulation (denominator): <Mono>{formatNum(Math.round(beamCirc))} BEAM</Mono></>
          : 'Beam Current Circulation unavailable (could not parse /status?exp_am=1).'}
      </Muted>
      {!hasKey && <Muted>Save an Etherscan API key to load WBEAM supply and this column.</Muted>}
    </div>
  );
};

const AssetTable: React.FC<{ rows: AssetRow[] }> = ({ rows }) => {
  if (!rows.length) return <Muted>No assets in this group.</Muted>;
  return (
    <DataTable>
      <thead>
        <tr><th>ID</th><th>Symbol</th><th>Supply</th><th>Lock</th><th>Explorer</th></tr>
      </thead>
      <tbody>
        {rows.map((a) => {
          const meta = parseMetadata(a.Metadata);
          const sym = meta.UN || meta.SN || meta.N || ('CA-' + a.Aid);
          const dec = getDecimals(meta.NTHUN);
          return (
            <tr key={String(a.Aid)}>
              <td className="mono">{String(a.Aid)}</td>
              <td>{sym}</td>
              <td className="mono">{formatAssetAmt(cleanNumber(a.Supply), dec)}</td>
              <td className="mono">{a['Lock height'] != null ? formatNum(a['Lock height']) : '-'}</td>
              <td><ExtLink href={assetExplorerUrl(a.Aid)}>Asset</ExtLink></td>
            </tr>
          );
        })}
      </tbody>
    </DataTable>
  );
};

const TokenTxTable: React.FC<{ result: TokenTx[]; chainid: number }> = ({ result, chainid }) => {
  if (!result.length) return <Muted>No transfers returned.</Muted>;
  const dec = Number(result[0].tokenDecimal) || 8;
  return (
    <DataTable>
      <thead>
        <tr><th>Time</th><th>Tx</th><th>From</th><th>To</th><th>Value</th></tr>
      </thead>
      <tbody>
        {result.slice(0, 40).map((t, i) => {
          const ts = t.timeStamp ? new Date(Number(t.timeStamp) * 1000).toLocaleString() : '-';
          return (
            <tr key={(t.hash || '') + i}>
              <td>{ts}</td>
              <td className="mono">
                <ExtLink href={evmTxUrl(chainid, t.hash || '')}>{shortHash(t.hash, 10)}</ExtLink>
              </td>
              <td className="mono"><ExtLink href={evmAddrUrl(chainid, t.from || '')}>{shortAddr(t.from)}</ExtLink></td>
              <td className="mono"><ExtLink href={evmAddrUrl(chainid, t.to || '')}>{shortAddr(t.to)}</ExtLink></td>
              <td className="mono">{formatAssetAmt(t.value, dec)}</td>
            </tr>
          );
        })}
      </tbody>
    </DataTable>
  );
};

const HolderTable: React.FC<{ title: string; rows: HolderRow[]; dec: number; chainid: number }> = ({
  title, rows, dec, chainid,
}) => (
  <>
    <Muted>{title}</Muted>
    {rows.length === 0 ? (
      <Muted>No rows.</Muted>
    ) : (
      <DataTable>
        <thead>
          <tr><th>#</th><th>Address</th><th>Balance</th></tr>
        </thead>
        <tbody>
          {rows.map((x, i) => (
            <tr key={x.addr + i}>
              <td>{i + 1}</td>
              <td className="mono"><ExtLink href={evmAddrUrl(chainid, x.addr)}>{x.addr}</ExtLink></td>
              <td className="mono">
                {typeof x.bal === 'bigint' ? formatAssetAmt(Number(x.bal), dec) : String(x.balStr != null ? x.balStr : x.bal)}
              </td>
            </tr>
          ))}
        </tbody>
      </DataTable>
    )}
  </>
);

export default BridgeTracker;
