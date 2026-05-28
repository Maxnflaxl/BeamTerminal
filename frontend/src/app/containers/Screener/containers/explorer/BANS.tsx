import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { styled } from '@linaria/react';
import {
  Page,
  ExplorerHeader,
  H1,
  Subtitle,
  Dot,
  NodeSelector,
  StatGrid,
  StatCard,
  Label,
  Value,
  Btn,
  TabBtn,
  Input,
  Pill,
  DataTable,
  ScrollX,
  ErrorBox,
  theme,
} from './shared';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CID = 'af4550f1f8a6051ffeffea06e0cb978f8076fdfc2101d2273d4e62c86540bc5e';
const PAGE_SIZE = 50;
const ACTIVITY_LIMIT = 25;
const CONTRACT_NMAXTXS = 200;
const POLL_MS = 60_000;
const BLOCK_SECONDS = 60;

const API_BASES = [
  { value: 'https://explorer.0xmx.net/api', label: 'explorer.0xmx.net' },
  { value: 'https://explorer-api.beamprivacy.com', label: 'explorer-api.beamprivacy.com' },
  { value: 'https://explorer.beam.mw/api', label: 'explorer.beam.mw' },
];

const LS_API = 'bans_api_base';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type DomainStatus = 'active' | 'expired' | 'hold';

interface Domain {
  name: string;
  owner: string;
  expiration: number;
  status: DomainStatus;
  statusRaw: string;
  price: number | null;
  priceAid: number | null;
}

interface Activity {
  height: number | null;
  method: string;
  args: Record<string, unknown> | null;
  name: string | null;
}

type SortKey = 'name' | 'owner' | 'expiration' | 'status' | 'price';

interface SortState { key: SortKey; dir: 1 | -1 }

type MethodTone = 'accent' | 'info' | 'warn' | 'purple' | 'danger' | 'neutral';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtNum(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return Number(n).toLocaleString('en-US');
}

function fmtBlocksETA(blocks: number | null | undefined): string {
  if (blocks === null || blocks === undefined) return '';
  const sec = blocks * BLOCK_SECONDS;
  if (sec === 0) return 'now';
  const abs = Math.abs(sec);
  const days = Math.floor(abs / 86400);
  const hours = Math.floor((abs % 86400) / 3600);
  let label: string;
  if (days > 365) label = `${(days / 365).toFixed(1)}y`;
  else if (days >= 1) label = `${days}d`;
  else label = `${hours}h`;
  return sec < 0 ? `${label} ago` : `in ${label}`;
}

function truncBlob(hex: string): string {
  if (!hex) return '';
  if (hex.length <= 14) return hex;
  return `${hex.slice(0, 6)}…${hex.slice(-6)}`;
}

function copyText(text: string): void {
  if (!navigator.clipboard) return;
  navigator.clipboard.writeText(text).catch(() => { /* ignore */ });
}

function parseDomains(data: any): Domain[] {
  const out: Domain[] = [];
  const node = data && data.State && data.State.Domains;
  const rows = node && node.value;
  if (!Array.isArray(rows) || rows.length < 2) return out;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!Array.isArray(r) || r.length < 5) continue;
    const name = typeof r[0] === 'string' ? r[0] : String(r[0] || '');
    const owner = (r[1] && typeof r[1] === 'object') ? r[1].value : (r[1] || '');
    const expiration = (r[2] && typeof r[2] === 'object') ? Number(r[2].value) : Number(r[2] || 0);
    const statusRaw = typeof r[3] === 'string' ? r[3] : '';
    let status: DomainStatus;
    if (statusRaw === '') status = 'active';
    else if (statusRaw.toLowerCase().indexOf('hold') !== -1) status = 'hold';
    else status = 'expired';
    const priceCell = r[4];
    let price: number | null = null;
    let priceAid: number | null = null;
    if (Array.isArray(priceCell) && priceCell.length >= 2) {
      const a = priceCell[0];
      const b = priceCell[1];
      priceAid = (a && typeof a === 'object') ? Number(a.value) : null;
      const v = (b && typeof b === 'object') ? b.value : null;
      if (v !== null && v !== undefined) price = parseFloat(String(v).replace(/,/g, ''));
    }
    out.push({ name: String(name), owner: String(owner), expiration, status, statusRaw, price, priceAid });
  }
  return out;
}

function flattenArgs(args: any): Record<string, unknown> | null {
  if (!args || typeof args !== 'object') return null;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(args)) {
    const v = args[k];
    if (v && typeof v === 'object' && 'value' in v) out[k] = (v as { value: unknown }).value;
    else if (v && typeof v === 'object') out[k] = JSON.stringify(v);
    else out[k] = v;
  }
  return out;
}

function parseActivity(data: any): Activity[] {
  const out: Activity[] = [];
  const node = data && data['Calls history'];
  const rows = node && node.value;
  if (!Array.isArray(rows) || rows.length < 2) return out;
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.type !== 'group' || !Array.isArray(row.value) || row.value.length === 0) continue;
    const first = row.value[0];
    if (!Array.isArray(first) || first.length < 5) continue;
    const height = Number(first[0]) || null;
    const method = String(first[3] || '');
    const argsObj = (first[4] && typeof first[4] === 'object' && !Array.isArray(first[4])) ? first[4] : null;
    const args = flattenArgs(argsObj);
    const name = args && (args.name || args.Name) ? String(args.name || args.Name) : null;
    out.push({ height, method, args, name });
  }
  return out;
}

function methodClass(method: string): string {
  const m = (method || '').toLowerCase();
  if (m.indexOf('register') !== -1) return 'register';
  if (m.indexOf('extend') !== -1 || m.indexOf('renew') !== -1 || m.indexOf('prolong') !== -1) return 'extend';
  if (m.indexOf('transfer') !== -1 || m.indexOf('buy') !== -1) return 'buy';
  if (m.indexOf('sell') !== -1 || m.indexOf('list') !== -1 || m.indexOf('offer') !== -1) return 'sell';
  if (m.indexOf('update') !== -1 || m.indexOf('set') !== -1 || m.indexOf('change') !== -1) return 'update';
  if (m.indexOf('delete') !== -1 || m.indexOf('cancel') !== -1 || m.indexOf('remove') !== -1) return 'delete';
  return 'other';
}

function methodTone(cls: string): MethodTone {
  if (cls === 'register') return 'accent';
  if (cls === 'extend') return 'info';
  if (cls === 'update') return 'warn';
  if (cls === 'buy' || cls === 'sell') return 'purple';
  if (cls === 'delete') return 'danger';
  return 'neutral';
}

// ---------------------------------------------------------------------------
// Page-specific styled bits (kept because they have no shared equivalent)
// ---------------------------------------------------------------------------

const LogoArea = styled.div`
  display: flex;
  align-items: center;
  & > * + * { margin-left: 12px; }
`;

const HeaderRight = styled.div`
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  & > * + * { margin-top: 8px; }
`;

const StatusLine = styled.div`
  display: flex;
  align-items: center;
  & > * + * { margin-left: 6px; }
  font-size: 11px;
  color: ${theme.color.muted};
`;

const ContractBar = styled.div`
  display: flex;
  flex-wrap: wrap;
  & > * + * { margin-left: 24px; }
  align-items: center;
  background: ${theme.color.surface};
  border: 1px solid ${theme.color.borderDim};
  border-radius: ${theme.radius.lg};
  padding: 12px 16px;
  margin-bottom: 20px;
  font-size: 11px;
`;

const BarLabel = styled.span`
  color: ${theme.color.muted};
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-size: 10px;
  margin-right: 6px;
`;

const BarValue = styled.span`
  color: ${theme.color.text};
  font-variant-numeric: tabular-nums;
`;

const CidMono = styled.span`
  font-size: 11px;
  color: ${theme.color.accent};
  background: ${theme.color.surface2};
  padding: 3px 8px;
  border-radius: 4px;
  border: 1px solid ${theme.color.borderDim};
  cursor: pointer;
  word-break: break-all;
  &:hover { background: ${theme.color.accentDim}; }
`;

const Panel = styled.div`
  background: ${theme.color.surface};
  border: 1px solid ${theme.color.borderDim};
  border-radius: ${theme.radius.lg};
  overflow: hidden;
  margin-bottom: 20px;
`;

const PanelHeader = styled.div`
  padding: 14px 16px;
  border-bottom: 1px solid ${theme.color.borderDim};
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  & > * + * { margin-left: 10px; }
`;

const PanelTitle = styled.div`
  font-size: 15px;
  font-weight: 700;
`;

const PanelMeta = styled.div`
  font-size: 11px;
  color: ${theme.color.muted};
`;

const Toolbar = styled.div`
  display: flex;
  flex-wrap: wrap;
  & > * + * { margin-left: 10px; }
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid ${theme.color.borderDim};
`;

const SearchWrap = styled.div`
  flex: 1;
  min-width: 220px;
  max-width: 360px;
`;

const ChipGroup = styled.div`
  display: flex;
  flex-wrap: wrap;
  & > * + * { margin-left: 6px; }
`;

const Spacer = styled.div` flex: 1; `;

const OwnerBlob = styled.span`
  font-size: 11px;
  background: ${theme.color.surface2};
  padding: 2px 6px;
  border-radius: 4px;
  border: 1px solid ${theme.color.borderDim};
  cursor: pointer;
  &:hover { color: ${theme.color.text}; border-color: ${theme.color.border}; }
`;

const Eta = styled.div`
  font-size: 10px;
  color: ${theme.color.muted};
  margin-top: 2px;
`;

const Price = styled.span`
  color: ${theme.color.purple};
  font-weight: 600;
`;

const PriceAid = styled.span`
  color: ${theme.color.muted};
  font-size: 10px;
  margin-left: 4px;
`;

const SortArrow = styled.span`
  color: ${theme.color.accent};
  margin-left: 4px;
  opacity: 0.85;
`;

const Pagination = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  border-top: 1px solid ${theme.color.borderDim};
  font-size: 11px;
`;

const PageInfo = styled.div` color: ${theme.color.muted}; `;
const PageBtns = styled.div` display: flex; & > * + * { margin-left: 6px; } `;

const Empty = styled.div`
  padding: 30px;
  text-align: center;
  color: ${theme.color.muted};
  font-size: 12px;
`;

const ActivityRow = styled.div`
  display: grid;
  grid-template-columns: 110px 110px 1fr;
  gap: 12px;
  padding: 10px 16px;
  border-bottom: 1px solid ${theme.color.borderDim};
  font-size: 12px;
  align-items: center;
  &:last-child { border-bottom: 0; }
`;

const HCell = styled.div`
  color: ${theme.color.muted};
  font-variant-numeric: tabular-nums;
  font-size: 11px;
`;

const Target = styled.div`
  color: ${theme.color.text};
  word-break: break-all;
`;

const NameTag = styled.span`
  color: ${theme.color.accent};
`;

const MutedInline = styled.span`
  color: ${theme.color.muted};
`;

const SaleSpacer = styled.span`
  margin-left: 6px;
`;

const SubDetails = styled.details`
  background: ${theme.color.surface2};
  border: 1px solid ${theme.color.borderDim};
  border-radius: ${theme.radius.md};
  margin-top: 8px;
  & summary {
    padding: 8px 12px;
    cursor: pointer;
    font-size: 11px;
    color: ${theme.color.muted};
    list-style: none;
  }
  & summary::-webkit-details-marker { display: none; }
  &[open] summary {
    border-bottom: 1px solid ${theme.color.borderDim};
    color: ${theme.color.text};
  }
`;

const ArgsBlock = styled.pre`
  padding: 10px 12px;
  font-size: 11px;
  color: ${theme.color.text};
  white-space: pre-wrap;
  word-break: break-all;
  margin: 0;
`;

const ArgKey = styled.span`
  color: ${theme.color.muted};
`;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const BANS: React.FC = () => {
  const [apiBase, setApiBase] = useState<string>(() => {
    try { return localStorage.getItem(LS_API) || API_BASES[0].value; } catch { return API_BASES[0].value; }
  });

  const [tipHeight, setTipHeight] = useState<number | null>(null);
  const [kind, setKind] = useState<string>('—');
  const [deployedAt, setDeployedAt] = useState<number | null>(null);
  const [domains, setDomains] = useState<Domain[]>([]);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [status, setStatus] = useState<{ kind: 'idle' | 'live' | 'error'; text: string }>({ kind: 'idle', text: 'Loading…' });
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | DomainStatus>('all');
  const [saleOnly, setSaleOnly] = useState(false);
  const [sort, setSort] = useState<SortState>({ key: 'name', dir: 1 });
  const [page, setPage] = useState(0);

  const apiBaseRef = useRef(apiBase);
  apiBaseRef.current = apiBase;

  const load = useCallback(async () => {
    setError(null);
    setStatus({ kind: 'idle', text: 'Fetching…' });
    try {
      const url = `${apiBaseRef.current.replace(/\/$/, '')}/contract?id=${CID}&exp_am=1&nMaxTxs=${CONTRACT_NMAXTXS}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as any;
      setTipHeight(typeof data.h === 'number' ? data.h : null);
      setKind(data.kind || '—');
      setDomains(parseDomains(data));
      setActivity(parseActivity(data));

      const vh = data && data['Version History'] && data['Version History'].value;
      if (Array.isArray(vh) && vh.length > 1) {
        const firstVer = vh[1];
        if (firstVer && Array.isArray(firstVer)) {
          const h = (firstVer[0] && typeof firstVer[0] === 'object') ? firstVer[0].value : firstVer[0];
          const n = Number(h);
          if (Number.isFinite(n)) setDeployedAt(n);
        }
      }

      setStatus({ kind: 'live', text: `Live · ${new Date().toLocaleTimeString()}` });
    } catch (err) {
      setStatus({ kind: 'error', text: 'Error' });
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Failed to load contract data: ${msg}`);
    }
  }, []);

  // Initial + polling
  useEffect(() => {
    void load();
    const id = setInterval(() => { void load(); }, POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  // Reload on API base change
  useEffect(() => {
    try { localStorage.setItem(LS_API, apiBase); } catch { /* ignore */ }
    void load();
  }, [apiBase, load]);

  // ---- KPIs ----
  const kpi = useMemo(() => {
    let active = 0; let expired = 0; let hold = 0; let sale = 0;
    for (const d of domains) {
      if (d.status === 'active') active++;
      else if (d.status === 'expired') expired++;
      else if (d.status === 'hold') hold++;
      if (d.price !== null && d.price > 0) sale++;
    }
    return { total: domains.length, active, expired, hold, sale };
  }, [domains]);

  // ---- Filtered + sorted ----
  const filtered = useMemo(() => {
    let arr = domains;
    if (search) {
      const q = search.toLowerCase();
      arr = arr.filter((d) => d.name.toLowerCase().indexOf(q) !== -1);
    }
    if (statusFilter !== 'all') arr = arr.filter((d) => d.status === statusFilter);
    if (saleOnly) arr = arr.filter((d) => d.price !== null && d.price > 0);
    const { key, dir } = sort;
    arr = arr.slice().sort((a, b) => {
      let av: number | string; let bv: number | string;
      if (key === 'name') { av = a.name; bv = b.name; }
      else if (key === 'owner') { av = a.owner || ''; bv = b.owner || ''; }
      else if (key === 'expiration') { av = a.expiration; bv = b.expiration; }
      else if (key === 'status') { av = a.status; bv = b.status; }
      else { av = a.price === null ? -1 : a.price; bv = b.price === null ? -1 : b.price; }
      if (typeof av === 'string' && typeof bv === 'string') return av.localeCompare(bv) * dir;
      return ((av as number) - (bv as number)) * dir;
    });
    return arr;
  }, [domains, search, statusFilter, saleOnly, sort]);

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(Math.max(0, page), pages - 1);
  const start = safePage * PAGE_SIZE;
  const slice = filtered.slice(start, start + PAGE_SIZE);

  // Keep page index in range when filters change
  useEffect(() => {
    if (page > pages - 1) setPage(Math.max(0, pages - 1));
  }, [pages, page]);

  function toggleSort(key: SortKey): void {
    setSort((prev) => {
      if (prev.key === key) return { key, dir: (prev.dir === 1 ? -1 : 1) as 1 | -1 };
      const defaultDir: 1 | -1 = (key === 'expiration' || key === 'price') ? -1 : 1;
      return { key, dir: defaultDir };
    });
  }

  const sortArrow = (key: SortKey): string | null => (sort.key === key ? (sort.dir > 0 ? '▲' : '▼') : null);

  const recent = activity.slice(0, ACTIVITY_LIMIT);

  return (
    <Page>
      <ExplorerHeader>
        <LogoArea>
          <div>
            <H1>BANS Explorer</H1>
            <Subtitle>Beam Anonymous Name System · Domain Registry</Subtitle>
          </div>
        </LogoArea>
        <HeaderRight>
          <StatusLine>
            <Dot data-kind={status.kind} />
            <span>{status.text}</span>
          </StatusLine>
          <NodeSelector
            label="Explorer API"
            options={API_BASES}
            value={apiBase}
            onChange={setApiBase}
          />
        </HeaderRight>
      </ExplorerHeader>

      {error && <ErrorBox>{error}</ErrorBox>}

      <ContractBar>
        <div>
          <BarLabel>Contract</BarLabel>
          <CidMono onClick={() => copyText(CID)} title="Click to copy">{CID}</CidMono>
        </div>
        <div><BarLabel>Kind</BarLabel><BarValue>{kind || '—'}</BarValue></div>
        <div><BarLabel>Tip height</BarLabel><BarValue>{fmtNum(tipHeight)}</BarValue></div>
        <div><BarLabel>Deployed at</BarLabel><BarValue>{fmtNum(deployedAt)}</BarValue></div>
      </ContractBar>

      <StatGrid>
        <StatCard>
          <Label>Total domains</Label>
          <Value style={{ color: theme.color.accent }}>{fmtNum(kpi.total)}</Value>
          <Label style={{ marginTop: 6, marginBottom: 0 }}>Registered names</Label>
        </StatCard>
        <StatCard>
          <Label>Active</Label>
          <Value style={{ color: theme.color.accent }}>{fmtNum(kpi.active)}</Value>
          <Label style={{ marginTop: 6, marginBottom: 0 }}>Not yet expired</Label>
        </StatCard>
        <StatCard>
          <Label>Expired</Label>
          <Value style={{ color: theme.color.danger }}>{fmtNum(kpi.expired)}</Value>
          <Label style={{ marginTop: 6, marginBottom: 0 }}>Past expiration height</Label>
        </StatCard>
        <StatCard>
          <Label>On hold</Label>
          <Value style={{ color: theme.color.warn }}>{fmtNum(kpi.hold)}</Value>
          <Label style={{ marginTop: 6, marginBottom: 0 }}>Grace / locked</Label>
        </StatCard>
        <StatCard>
          <Label>For sale</Label>
          <Value style={{ color: theme.color.purple }}>{fmtNum(kpi.sale)}</Value>
          <Label style={{ marginTop: 6, marginBottom: 0 }}>Listed with price</Label>
        </StatCard>
      </StatGrid>

      <Panel>
        <PanelHeader>
          <PanelTitle>Domains</PanelTitle>
          <PanelMeta>
            {`${filtered.length} ${filtered.length === 1 ? 'match' : 'matches'} · ${domains.length} total`}
          </PanelMeta>
        </PanelHeader>
        <Toolbar>
          <SearchWrap>
            <Input
              type="text"
              placeholder="Search by name…"
              autoComplete="off"
              value={search}
              onChange={(e) => { setSearch(e.target.value.trim()); setPage(0); }}
            />
          </SearchWrap>
          <ChipGroup>
            <TabBtn type="button" data-active={statusFilter === 'all'} onClick={() => { setStatusFilter('all'); setPage(0); }}>All</TabBtn>
            <TabBtn type="button" data-active={statusFilter === 'active'} onClick={() => { setStatusFilter('active'); setPage(0); }}>Active</TabBtn>
            <TabBtn type="button" data-active={statusFilter === 'hold'} onClick={() => { setStatusFilter('hold'); setPage(0); }}>On hold</TabBtn>
            <TabBtn type="button" data-active={statusFilter === 'expired'} onClick={() => { setStatusFilter('expired'); setPage(0); }}>Expired</TabBtn>
          </ChipGroup>
          <TabBtn type="button" data-active={saleOnly} onClick={() => { setSaleOnly((s) => !s); setPage(0); }}>For sale only</TabBtn>
          <Spacer />
          <Btn type="button" data-variant="ghost" onClick={() => { void load(); }}>Refresh</Btn>
        </Toolbar>
        <ScrollX>
          <DataTable>
            <thead>
              <tr>
                <th data-sortable onClick={() => toggleSort('name')}>Name {sortArrow('name') && <SortArrow>{sortArrow('name')}</SortArrow>}</th>
                <th data-sortable onClick={() => toggleSort('owner')}>Owner</th>
                <th data-sortable onClick={() => toggleSort('expiration')}>Expires at {sortArrow('expiration') && <SortArrow>{sortArrow('expiration')}</SortArrow>}</th>
                <th data-sortable onClick={() => toggleSort('status')}>Status</th>
                <th data-sortable className="right" onClick={() => toggleSort('price')}>Sell price</th>
              </tr>
            </thead>
            <tbody>
              {slice.length === 0 ? (
                <tr>
                  <td colSpan={5}><Empty>No domains match the current filters.</Empty></td>
                </tr>
              ) : (
                slice.map((d, idx) => {
                  const blocks = tipHeight !== null ? d.expiration - tipHeight : null;
                  const eta = fmtBlocksETA(blocks);
                  return (
                    <tr key={`${d.name}-${idx}`}>
                      <td style={{ color: theme.color.accent, fontWeight: 600 }}>{d.name}</td>
                      <td className="muted">
                        <OwnerBlob
                          onClick={() => copyText(d.owner)}
                          title={`${d.owner} — click to copy`}
                        >
                          {truncBlob(d.owner)}
                        </OwnerBlob>
                      </td>
                      <td>
                        <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtNum(d.expiration)}</span>
                        {eta && <Eta>{eta}</Eta>}
                      </td>
                      <td>
                        {d.status === 'active' && <Pill data-tone="accent">Active</Pill>}
                        {d.status === 'hold' && <Pill data-tone="warn">On hold</Pill>}
                        {d.status === 'expired' && <Pill data-tone="danger">Expired</Pill>}
                        {d.price !== null && d.price > 0 && <SaleSpacer><Pill data-tone="purple">For sale</Pill></SaleSpacer>}
                      </td>
                      <td className="right">
                        {d.price !== null && d.price > 0 ? (
                          <>
                            <Price>{d.price.toLocaleString('en-US', { maximumFractionDigits: 8 })}</Price>
                            <PriceAid>{d.priceAid === 0 ? 'BEAM' : `aid:${d.priceAid !== null ? d.priceAid : '?'}`}</PriceAid>
                          </>
                        ) : (
                          <MutedInline>—</MutedInline>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </DataTable>
        </ScrollX>
        <Pagination>
          <PageInfo>
            {filtered.length === 0
              ? 'Page 0 of 0'
              : `Page ${safePage + 1} of ${pages} · ${start + 1}–${Math.min(start + PAGE_SIZE, filtered.length)} of ${filtered.length}`}
          </PageInfo>
          <PageBtns>
            <Btn type="button" data-variant="ghost" disabled={safePage === 0} onClick={() => setPage(0)}>⏮</Btn>
            <Btn type="button" data-variant="ghost" disabled={safePage === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>‹ Prev</Btn>
            <Btn type="button" data-variant="ghost" disabled={safePage >= pages - 1} onClick={() => setPage((p) => p + 1)}>Next ›</Btn>
            <Btn type="button" data-variant="ghost" disabled={safePage >= pages - 1} onClick={() => setPage(pages - 1)}>⏭</Btn>
          </PageBtns>
        </Pagination>
      </Panel>

      <Panel>
        <PanelHeader>
          <PanelTitle>Recent registry activity</PanelTitle>
          <PanelMeta>
            {recent.length > 0
              ? `Showing latest ${recent.length} of ${activity.length} loaded calls`
              : '—'}
          </PanelMeta>
        </PanelHeader>
        <div>
          {recent.length === 0 ? (
            <Empty>No recent activity loaded.</Empty>
          ) : (
            recent.map((a, idx) => {
              const cls = methodClass(a.method);
              const argKeys = a.args ? Object.keys(a.args) : [];
              const firstKey = argKeys[0];
              return (
                <ActivityRow key={`${a.height}-${idx}`}>
                  <HCell>{`h ${fmtNum(a.height)}`}</HCell>
                  <div><Pill data-tone={methodTone(cls)}>{a.method || '—'}</Pill></div>
                  <Target>
                    {a.name ? (
                      <NameTag>{a.name}</NameTag>
                    ) : firstKey ? (
                      <>
                        <MutedInline>{`${firstKey}: `}</MutedInline>
                        {String(a.args![firstKey])}
                      </>
                    ) : null}
                    {a.args && argKeys.length > 0 && (
                      <SubDetails>
                        <summary>args</summary>
                        <ArgsBlock>
                          {argKeys.map((k, i) => (
                            <React.Fragment key={k}>
                              <ArgKey>{`${k}: `}</ArgKey>
                              {String(a.args![k])}
                              {i < argKeys.length - 1 ? '\n' : ''}
                            </React.Fragment>
                          ))}
                        </ArgsBlock>
                      </SubDetails>
                    )}
                  </Target>
                </ActivityRow>
              );
            })
          )}
        </div>
      </Panel>
    </Page>
  );
};

export default BANS;
