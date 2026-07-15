import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { styled } from '@linaria/react';
import AssetsSwapGlyph from '@app/shared/icons/icon-assets-swap.svg';
import AssetIcon from '@app/shared/components/AssetsIcon';
import {
  Page,
  Card,
  ExplorerHeader,
  H1,
  H2,
  Subtitle,
  Muted,
  TabBtn,
  Pill,
  DataTable,
  ScrollX,
  ErrorBox,
  theme,
  Toolbar,
  SummaryStrip,
  Headline,
  StatLabel,
  HeadNum,
  Chips,
  Chip,
  EmptyState,
  EmptyIcon,
  EmptyTitle,
  EmptySub,
  fmtRelative,
} from './shared';
import { api } from '../../api/client';
import type { ApiAssetSwapOffer, ApiAssetsList, ApiAsset } from '../../api/types';

const AssetCell = styled.span`
  display: inline-flex;
  align-items: center;
  & > * + * {
    margin-left: 6px;
  }
  white-space: nowrap;
`;

// The shared AssetIcon already resolves branded glyphs (BEAM/BeamX/NPH), a
// colour-tinted generic glyph for unknown assets, and falls back off a broken
// logo URL — so external logos blocked by the wallet's COEP degrade gracefully
// instead of showing an empty circle. Strip its default right margin; the cell
// handles spacing.
const CellIcon = styled(AssetIcon)`
  margin-right: 0;
  flex: 0 0 18px;
`;

const AssetAid = styled.span`
  color: ${theme.color.muted};
  font-size: 11px;
`;

// ---------------------------------------------------------------------------
// /asset-swaps — wallet-gossiped DEX-style asset-to-asset offers (no L2 chain
// involved, unlike atomic swaps). Source: backend `/api/asset-swaps`, fed by
// the wallet-api daemon's `assets_swap_offers_list`.
// ---------------------------------------------------------------------------

type FilterTab = 'open' | 'all';

function decimalsFor(asset: ApiAsset | undefined): number {
  // Heuristic: BEAM and most BEAM-issued tokens are 8-decimals. The /api/asset
  // endpoint doesn't currently return decimals here (different shape), so we
  // hard-code 8. Refine later if asset metadata gets surfaced via /api/asset-swaps.
  if (!asset) return 8;
  return 8;
}

function formatGroths(amount: string, dec: number): string {
  // Amount is the raw integer unit (groths for 8-dec assets).
  const v = Number(amount) / 10 ** dec;
  if (!Number.isFinite(v)) return amount;
  if (Math.abs(v) >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (Math.abs(v) >= 1e3) return `${(v / 1e3).toFixed(2)}K`;
  return v.toFixed(Math.min(dec, 6)).replace(/\.?0+$/, '');
}

function timeLeft(iso: string): string {
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return '—';
  const delta = Math.round((ts - Date.now()) / 1000);
  if (delta <= 0) return 'expired';
  if (delta < 60) return `${delta}s`;
  if (delta < 3600) return `${Math.round(delta / 60)}m`;
  if (delta < 86400) return `${Math.round(delta / 3600)}h`;
  return `${Math.round(delta / 86400)}d`;
}

export const AssetSwaps: React.FC = () => {
  const [tab, setTab] = useState<FilterTab>('open');
  const [offers, setOffers] = useState<ApiAssetSwapOffer[] | null>(null);
  const [assets, setAssets] = useState<ApiAssetsList | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [a, list] = await Promise.all([
        api.assetSwaps(tab === 'all' ? { include: 'all' } : {}),
        // Load the asset catalogue once so the table can resolve aid → label.
        assets === null ? api.assets() : Promise.resolve(assets),
      ]);
      setOffers(a.offers);
      if (assets === null) setAssets(list);
      setErr(null);
    } catch (e) {
      // wallet-api may be unreachable / disabled in this deployment.
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [tab, assets]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const assetIndex = useMemo(() => {
    const m = new Map<number, ApiAsset>();
    if (assets) {
      for (const a of assets.assets) m.set(a.aid, a as unknown as ApiAsset);
    }
    return m;
  }, [assets]);

  function labelForAid(aid: number, fallback: string | null): string {
    const a = assetIndex.get(aid);
    return a?.short_name ?? a?.unit_name ?? a?.name ?? fallback ?? `AID ${aid}`;
  }

  // Render the `<icon> <name> (<id>)` cell used in both swap legs. The shared
  // AssetIcon resolves the branded glyph, palette colour, and logo-URL fallback
  // from the aid + the REST catalogue's colour/logo fields.
  function renderAssetCell(aid: number, currencyName: string | null): React.ReactNode {
    const asset = assetIndex.get(aid);
    const label = labelForAid(aid, currencyName);
    return (
      <AssetCell>
        <CellIcon asset_id={aid} size={18} color={asset?.color} logoUrl={asset?.logo_url} />
        <span>{label}</span>
        <AssetAid>
          (#
          {aid})
        </AssetAid>
      </AssetCell>
    );
  }

  const openCount = offers ? offers.filter((o) => !o.gone_at).length : 0;
  const mineCount = offers ? offers.filter((o) => o.is_my).length : 0;

  return (
    <Page>
      <ExplorerHeader>
        <div>
          <H1>Asset swaps</H1>
          <Subtitle>Wallet-gossiped DEX-style asset-to-asset offers (no L2 chain involved).</Subtitle>
        </div>
      </ExplorerHeader>

      {offers ? (
        <SummaryStrip>
          <Headline>
            <StatLabel>Open offers</StatLabel>
            <HeadNum>{openCount}</HeadNum>
          </Headline>
          <Chips>
            <Chip hot={offers.length > 0}>
              <span>Shown</span>
              <span className="v">{offers.length}</span>
            </Chip>
            <Chip hot={mineCount > 0}>
              <span>Mine</span>
              <span className="v">{mineCount}</span>
            </Chip>
          </Chips>
        </SummaryStrip>
      ) : null}

      <Card>
        <H2>Offers</H2>
        <Toolbar>
          <TabBtn type="button" data-active={tab === 'open'} onClick={() => setTab('open')}>
            Open
          </TabBtn>
          <TabBtn type="button" data-active={tab === 'all'} onClick={() => setTab('all')}>
            All (incl. closed)
          </TabBtn>
        </Toolbar>
        {err ? (
          <ErrorBox>
            {err}
            <Muted>
              The asset-swaps feed requires a connected wallet-api daemon (see <code>WALLET_API_URL</code>
              ). If this deployment doesn&apos;t run one, the list will be empty.
            </Muted>
          </ErrorBox>
        ) : null}
        {offers === null ? (
          <Muted>Loading…</Muted>
        ) : offers.length === 0 ? (
          <EmptyState>
            <EmptyIcon>
              <AssetsSwapGlyph />
            </EmptyIcon>
            <EmptyTitle>
              {tab === 'open' ? 'No open asset-swap offers right now' : 'No asset-swap offers found'}
            </EmptyTitle>
            <EmptySub>DEX-style asset-to-asset offers created in the BEAM wallet appear here.</EmptySub>
          </EmptyState>
        ) : (
          <ScrollX>
            <DataTable>
              <thead>
                <tr>
                  <th>Send</th>
                  <th>Amount</th>
                  <th>Receive</th>
                  <th>Amount</th>
                  <th>Created</th>
                  <th>Expires in</th>
                  <th>Last seen</th>
                  <th>State</th>
                  <th>Mine?</th>
                </tr>
              </thead>
              <tbody>
                {offers.map((o) => (
                  <tr key={o.id}>
                    <td>{renderAssetCell(o.send.asset_id, o.send.currency_name)}</td>
                    <td className="mono">
                      {formatGroths(o.send.amount, decimalsFor(assetIndex.get(o.send.asset_id)))}
                    </td>
                    <td>{renderAssetCell(o.receive.asset_id, o.receive.currency_name)}</td>
                    <td className="mono">
                      {formatGroths(o.receive.amount, decimalsFor(assetIndex.get(o.receive.asset_id)))}
                    </td>
                    <td>{fmtRelative(o.create_time)}</td>
                    <td className="mono">{timeLeft(o.expire_time)}</td>
                    <td>{fmtRelative(o.last_seen_at)}</td>
                    <td>
                      {o.gone_at ? <Pill data-tone="danger">closed</Pill> : <Pill data-tone="success">open</Pill>}
                    </td>
                    <td>{o.is_my ? <Pill data-tone="info">yes</Pill> : ''}</td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          </ScrollX>
        )}
      </Card>
    </Page>
  );
};

export default AssetSwaps;
