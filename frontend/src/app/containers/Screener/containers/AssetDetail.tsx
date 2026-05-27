import React, { useMemo, useState } from 'react';
import { styled } from '@linaria/react';
import { useNavigate, useParams } from 'react-router-dom';
import AssetIcon, { normalizeOptColor } from '@app/shared/components/AssetsIcon';
import { useAsset, useAssetHistory, usePairs } from '../hooks';
import { fmt$, fmtNum, pairUrlId } from '../components/format';
import { KindBadge } from '../components/KindBadge';
import { SupplyChart } from '../components/SupplyChart';

const Page = styled.div`
  width: 100%;
  max-width: 1000px;
  margin: 24px auto;
  padding: 0 20px;
  @media (max-width: 640px) { padding: 0 12px; }
`;

const TopBar = styled.div`
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 20px;
`;

const BackBtn = styled.button`
  background: none;
  border: none;
  color: rgba(255, 255, 255, 0.6);
  font-size: 18px;
  padding: 4px 8px;
  border-radius: 4px;
  cursor: pointer;
  &:hover { background: rgba(255, 255, 255, 0.06); color: white; }
`;

const Card = styled.div`
  display: flex;
  flex-direction: column;
  padding: 20px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 14px;
  margin-bottom: 20px;
`;

const HeaderRow = styled.div`
  display: flex;
  align-items: center;
  gap: 16px;
  padding-bottom: 16px;
  margin-bottom: 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
`;

const HeaderAssetIcon = styled(AssetIcon)`
  width: 48px;
  height: 48px;
  margin-right: 0;
  flex-shrink: 0;
  & svg {
    display: block;
    width: 48px;
    height: 48px;
  }
`;

const NameCol = styled.div`
  min-width: 0;
  flex: 1;
`;

const FullName = styled.div`
  font-size: 18px;
  font-weight: 700;
  color: white;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`;

const Ticker = styled.div`
  font-size: 13px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.6px;
  color: rgba(255, 255, 255, 0.5);
  margin-top: 2px;
`;

const ImposterBadge = styled.span`
  display: inline-flex;
  align-items: center;
  background: rgba(242, 95, 91, 0.18);
  color: #f25f5b;
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  margin-left: 10px;
`;

const InfoGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 0;
  @media (max-width: 600px) { grid-template-columns: 1fr; }
`;

const InfoCell = styled.div`
  padding: 10px 12px;
  border-top: 1px solid rgba(255, 255, 255, 0.04);
  &:nth-child(-n+2) { border-top: none; }
  .lbl {
    font-size: 11px;
    color: rgba(255, 255, 255, 0.4);
    text-transform: uppercase;
    letter-spacing: 0.4px;
  }
  .val {
    font-family: 'SFProDisplay', monospace;
    font-size: 14px;
    color: white;
    margin-top: 2px;
    word-break: break-word;
  }
`;

const Description = styled.div`
  font-size: 13px;
  color: rgba(255, 255, 255, 0.7);
  line-height: 1.55;
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px solid rgba(255, 255, 255, 0.04);
  white-space: pre-wrap;
`;

const Tabs = styled.div`
  display: flex;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  margin-bottom: 12px;
  button {
    padding: 10px 16px;
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    color: rgba(255, 255, 255, 0.5);
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    font-family: inherit;
    &.active { color: white; border-bottom-color: var(--color-green); }
    &:hover { color: rgba(255, 255, 255, 0.8); }
  }
`;

const Table = styled.table`
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;
  th {
    text-align: left;
    padding: 8px 12px;
    font-size: 11px;
    color: rgba(255, 255, 255, 0.4);
    text-transform: uppercase;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  }
  td {
    padding: 8px 12px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.04);
  }
  tbody tr {
    cursor: pointer;
    &:hover { background: rgba(255, 255, 255, 0.03); }
  }
  .mono { font-family: 'SFProDisplay', monospace; }
`;

const Empty = styled.div`
  padding: 40px 12px;
  text-align: center;
  color: rgba(255, 255, 255, 0.4);
`;

export const AssetDetail: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const aid = id !== undefined ? Number(id) : undefined;

  const [tab, setTab] = useState<'pools' | 'history'>('pools');

  const { data: asset, loading: assetLoading } = useAsset(aid);
  // Always fetch the supply history when an aid is set — the chart needs it
  // even on the "pools" tab. BEAM (aid 0) has no /history endpoint, skip.
  const { data: history } = useAssetHistory(aid !== undefined && aid > 0 ? aid : undefined);
  // Pull all pairs so we can show pool ticker symbols + USD valuations next to pool ids.
  const { data: pairsResp } = usePairs({ limit: 500 });

  const supplyPoints = useMemo(() => {
    if (!history || !asset) return [];
    return history.history
      .filter((h) => h.ts !== null && h.total_amount !== null)
      .map((h) => ({
        ts: h.ts as number,
        supply: Number(h.total_amount) / 10 ** asset.decimals,
      }))
      .sort((a, b) => a.ts - b.ts);
  }, [history, asset]);

  if (assetLoading || !asset) {
    return <Page>Loading asset…</Page>;
  }

  const supplyHuman = asset.emission ? Number(asset.emission) / 10 ** asset.decimals : null;
  const maxSupplyHuman = asset.max_supply ? Number(asset.max_supply) / 10 ** asset.decimals : null;
  // "Minter-issued" means the asset row carries a minter_cid. Such assets may
  // still have an unlimited cap (UINT64_MAX, which the backend normalizes to
  // null) — render those as "Unlimited" rather than the generic "—".
  const maxSupplyLabel = maxSupplyHuman !== null
    ? fmtNum(maxSupplyHuman, 0)
    : asset.minter_cid
      ? 'Unlimited'
      : '—';
  const supplyPct = supplyHuman !== null && maxSupplyHuman !== null && maxSupplyHuman > 0
    ? (supplyHuman / maxSupplyHuman) * 100
    : null;
  const pairsByPool = new Map<number, { sym1: string | null; sym2: string | null; kind: number; tvl_usd: number | null }>();
  for (const p of pairsResp?.pairs ?? []) {
    pairsByPool.set(p.pair_id, {
      sym1: p.symbol1, sym2: p.symbol2, kind: p.kind, tvl_usd: p.tvl_usd,
    });
  }

  return (
    <Page>
      <TopBar>
        <BackBtn onClick={() => navigate('/assets')}>←</BackBtn>
        <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: 13 }}>Back to Assets</span>
      </TopBar>

      <Card>
        <HeaderRow>
          <HeaderAssetIcon asset_id={asset.aid} color={asset.color} />
          <NameCol>
            <FullName>
              {asset.name ?? `Asset #${asset.aid}`}
              {asset.is_imposter && <ImposterBadge>Fake</ImposterBadge>}
            </FullName>
            <Ticker>{asset.short_name ?? `aid${asset.aid}`}</Ticker>
          </NameCol>
        </HeaderRow>

        <InfoGrid>
          <InfoCell>
            <div className="lbl">Asset ID</div>
            <div className="val">
              #
              {asset.aid}
            </div>
          </InfoCell>
          <InfoCell>
            <div className="lbl">Decimals</div>
            <div className="val">{asset.decimals}</div>
          </InfoCell>
          <InfoCell>
            <div className="lbl">Circulating</div>
            <div className="val">
              {supplyHuman !== null ? fmtNum(supplyHuman, 0) : '—'}
              {supplyPct !== null && (
                <span style={{ color: 'rgba(255,255,255,0.4)', fontSize: 12, marginLeft: 6 }}>
                  (
                  {supplyPct.toFixed(supplyPct < 1 ? 2 : 1)}
                  %)
                </span>
              )}
            </div>
          </InfoCell>
          <InfoCell>
            <div className="lbl">Max supply</div>
            <div className="val">{maxSupplyLabel}</div>
          </InfoCell>
          <InfoCell>
            <div className="lbl">First seen</div>
            <div className="val">
              {asset.aid === 0
                ? 'block #1'
                : asset.first_seen_height !== null ? `block #${asset.first_seen_height}` : '—'}
            </div>
          </InfoCell>
          <InfoCell>
            <div className="lbl">Unit name</div>
            <div className="val">{asset.unit_name ?? '—'}</div>
          </InfoCell>
          {normalizeOptColor(asset.color) && (
            <InfoCell>
              <div className="lbl">Color</div>
              <div className="val" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span
                  style={{
                    width: 12,
                    height: 12,
                    borderRadius: 3,
                    background: normalizeOptColor(asset.color) as string,
                    border: '1px solid rgba(255,255,255,0.2)',
                  }}
                />
                {normalizeOptColor(asset.color)}
              </div>
            </InfoCell>
          )}
          <InfoCell>
            <div className="lbl">Pools active</div>
            <div className="val">{asset.pools.length}</div>
          </InfoCell>
          <InfoCell>
            <div className="lbl">Issuer</div>
            <div className="val">{asset.minter_cid ? 'Asset Minter' : asset.aid === 0 ? 'Native (BEAM)' : 'Wallet'}</div>
          </InfoCell>
        </InfoGrid>

        {asset.description && <Description>{asset.description}</Description>}
      </Card>

      {aid !== undefined && aid > 0 && supplyPoints.length > 0 && (
        <Card style={{ padding: 12, marginTop: 12 }}>
          <div style={{
            fontSize: 11, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: 0.5, padding: '0 4px 8px',
          }}
          >
            Supply over time
          </div>
          <SupplyChart points={supplyPoints} unit={asset.short_name ?? `aid${asset.aid}`} />
        </Card>
      )}

      <Tabs>
        <button type="button" className={tab === 'pools' ? 'active' : ''} onClick={() => setTab('pools')}>
          Pools (
          {asset.pools.length}
          )
        </button>
        <button type="button" className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>
          Mint / Burn history
        </button>
      </Tabs>

      {tab === 'pools' && (
        asset.pools.length === 0 ? (
          <Empty>This asset isn't in any active pools.</Empty>
        ) : (
          <Table>
            <thead>
              <tr>
                <th>Pool</th>
                <th>Tier</th>
                <th>TVL</th>
              </tr>
            </thead>
            <tbody>
              {[...asset.pools]
                .sort((a, b) => (b.tvl_usd ?? -Infinity) - (a.tvl_usd ?? -Infinity))
                .map((pool) => {
                  const meta = pairsByPool.get(pool.pair_id);
                  return (
                    <tr key={pool.pair_id} onClick={() => navigate(`/pair/${pairUrlId(pool.aid1, pool.aid2, pool.kind)}`)}>
                      <td>{meta ? `${meta.sym1 ?? '?'}/${meta.sym2 ?? '?'}` : `Pool #${pool.pair_id}`}</td>
                      <td><KindBadge kind={pool.kind} /></td>
                      <td className="mono">{fmt$(pool.tvl_usd)}</td>
                    </tr>
                  );
                })}
            </tbody>
          </Table>
        )
      )}

      {tab === 'history' && (
        !history || history.history.length === 0 ? (
          <Empty>No history events.</Empty>
        ) : (
          <Table>
            <thead>
              <tr>
                <th>Height</th>
                <th>Event</th>
                <th>Amount</th>
                <th>Total Supply</th>
              </tr>
            </thead>
            <tbody>
              {history.history.map((h, i) => {
                const amt = h.amount ? Number(h.amount.replace(/^[+-]/, '')) / 10 ** asset.decimals : null;
                const tot = h.total_amount ? Number(h.total_amount) / 10 ** asset.decimals : null;
                const sign = h.amount?.startsWith('-') ? '-' : '+';
                const color = h.event === 'Burn' || sign === '-' ? '#f25f5b' : '#00f6d2';
                return (
                  <tr key={`${h.height}-${i}`} style={{ cursor: 'default' }}>
                    <td className="mono">{h.height}</td>
                    <td style={{ color, fontWeight: 600 }}>{h.event}</td>
                    <td className="mono" style={{ color }}>
                      {amt !== null ? `${sign}${fmtNum(amt, 4)}` : '—'}
                    </td>
                    <td className="mono">{tot !== null ? fmtNum(tot, 0) : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )
      )}
    </Page>
  );
};
