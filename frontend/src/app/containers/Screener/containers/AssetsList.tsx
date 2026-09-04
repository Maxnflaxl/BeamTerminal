import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { styled } from '@linaria/react';
import { useNavigate } from 'react-router-dom';
import AssetIcon from '@app/shared/components/AssetsIcon';
import { AssetLabel } from '@app/shared/components/AssetLabel';
import { MOBILE_MEDIA, DesktopOnly, MobileOnly, useIsMobile } from '../components/responsive';
import type { ApiAssetsList } from '../api/types';
import { useSharedAssets } from '../assetColors';
import { fmtNum, fromGroths } from '../components/format';
import { CenteredNote } from '../components/CenteredNote';
import {
  ListPage as Page,
  SearchInput as Search,
  TableWrap,
  MobileCard as ACard,
  MobileCardMain as ACardMain,
  MobileCardTopRow as ACardTitleRow,
  MobileCardTitle as ACardTitle,
  MobileCardSub as ACardSub,
  MobileCardStats as ACardStats,
  MobileCardStat as ACardStat,
} from '../components/listPage';
import { ScreenerTable } from '../components/ScreenerTable';

const Header = styled.div`
  max-width: 1100px;
  margin: 24px auto 0;
  padding: 0 20px;
  display: flex;
  & > * + * {
    margin-left: 16px;
  }
  align-items: center;
  ${MOBILE_MEDIA} {
    padding: 0 12px;
  }
`;

const ToggleBtn = styled.button<{ on: boolean }>`
  background: ${(p) => (p.on ? 'var(--color-green)' : 'rgba(255, 255, 255, 0.08)')};
  color: ${(p) => (p.on ? 'var(--color-dark-blue)' : 'rgba(255, 255, 255, 0.6)')};
  border: none;
  font-family: inherit;
  font-size: 12px;
  font-weight: 600;
  padding: 8px 12px;
  border-radius: 8px;
  cursor: pointer;
  flex-shrink: 0;
  margin-left: 16px;
  &:hover {
    filter: brightness(1.1);
  }
`;

const ACardDesc = styled.div`
  color: rgba(255, 255, 255, 0.55);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
`;

// Top-aligned cells so multi-line descriptions sit at the row top.
const Table = styled(ScreenerTable)`
  min-width: 720px;
  && td {
    vertical-align: top;
  }
`;

const Cell = styled.div`
  display: flex;
  & > * + * {
    margin-left: 10px;
  }
  align-items: center;
`;

// AssetIcon is used as-is — same component the trade panel renders. We just
// strip the right-margin (set for text-adjacent layout) since the icon sits
// in its own flex slot here.
const RowAssetIcon = styled(AssetIcon)`
  && {
    margin-right: 0;
  }
  flex-shrink: 0;
`;

const Sym = styled.div`
  font-weight: 600;
  small {
    color: rgba(255, 255, 255, 0.4);
    font-weight: 400;
    font-size: 11px;
    margin-left: 8px;
  }
`;

const Desc = styled.div`
  font-size: 12px;
  color: rgba(255, 255, 255, 0.5);
  max-width: 360px;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
`;

const ImposterBadge = styled.span`
  display: inline-flex;
  align-items: center;
  background: rgba(242, 95, 91, 0.18);
  color: #f25f5b;
  padding: 1px 7px;
  border-radius: 8px;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  margin-left: 8px;
  letter-spacing: 0.4px;
`;

type AssetEntry = ApiAssetsList['assets'][number];

interface AssetRowProps {
  a: AssetEntry;
  onOpen: (aid: number) => void;
}

// Human supply figures for one catalogue row. Minter-issued assets with no cap
// (UINT64_MAX sentinel) keep max_supply null on the backend — render those as
// "∞" so they're visually distinct from non-minter rows ("—").
function supplyLabels(a: AssetEntry): { emission: string; max: string } {
  const emission = a.emission ? fmtNum(fromGroths(a.emission, a.decimals), 0) : '—';
  const max = a.max_supply ? fmtNum(fromGroths(a.max_supply, a.decimals), 0) : a.minter_cid ? '∞' : '—';
  return { emission, max };
}

const AssetCard = React.memo(({ a, onOpen }: AssetRowProps) => {
  const supply = supplyLabels(a);
  return (
    <ACard onClick={() => onOpen(a.aid)}>
      <RowAssetIcon asset_id={a.aid} color={a.color} />
      <ACardMain>
        <ACardTitleRow>
          <ACardTitle>
            <AssetLabel aid={a.aid} sym={a.short_name} />
          </ACardTitle>
          {a.is_imposter && <ImposterBadge>Fake</ImposterBadge>}
        </ACardTitleRow>
        {a.name && <ACardSub>{a.name}</ACardSub>}
        {a.description && <ACardDesc>{a.description}</ACardDesc>}
        <ACardStats cols={3}>
          <ACardStat column>
            <span>Emission</span>
            <span>{supply.emission}</span>
          </ACardStat>
          <ACardStat column>
            <span>Max</span>
            <span>{supply.max}</span>
          </ACardStat>
          <ACardStat column>
            <span>Pools</span>
            <span>{a.pool_count}</span>
          </ACardStat>
        </ACardStats>
      </ACardMain>
    </ACard>
  );
});

const AssetRow = React.memo(({ a, onOpen }: AssetRowProps) => {
  const supply = supplyLabels(a);
  return (
    <tr onClick={() => onOpen(a.aid)}>
      <td style={{ color: 'rgba(255,255,255,0.4)' }}>#{a.aid}</td>
      <td>
        <Cell>
          <RowAssetIcon asset_id={a.aid} color={a.color} />
          <Sym>
            {a.short_name ?? `Asset #${a.aid}`}
            <small>{a.name ?? ''}</small>
            {a.is_imposter && <ImposterBadge>Fake</ImposterBadge>}
          </Sym>
        </Cell>
      </td>
      <td>
        <Desc>{a.description ?? ''}</Desc>
      </td>
      <td style={{ fontFamily: 'var(--font-mono)' }}>{supply.emission}</td>
      <td style={{ fontFamily: 'var(--font-mono)' }}>{supply.max}</td>
      <td style={{ fontFamily: 'var(--font-mono)' }}>{a.pool_count}</td>
    </tr>
  );
});

export const AssetsList: React.FC = () => {
  const navigate = useNavigate();
  const { data, loading, error } = useSharedAssets();
  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [showImposters, setShowImposters] = useState(false);
  // Render only the active layout's rows — same gate as PairsList: the card
  // and table lists both map every asset, and without it both live in the DOM
  // with one CSS-hidden, doubling row count and icon subscriptions.
  const isMobile = useIsMobile();

  // Debounce search input so each keystroke doesn't re-filter and re-render
  // every row.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchInput), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const onOpen = useCallback((aid: number) => navigate(`/asset/${aid}`), [navigate]);

  const filtered = useMemo(() => {
    const all = data?.assets ?? [];
    const q = debouncedSearch.trim().toLowerCase();
    return all
      .filter((a) => (showImposters ? true : !a.is_imposter))
      .filter((a) => {
        if (!q) return true;
        const sym = (a.short_name ?? '').toLowerCase();
        const name = (a.name ?? '').toLowerCase();
        return sym.includes(q) || name.includes(q) || String(a.aid).includes(q);
      });
  }, [data, debouncedSearch, showImposters]);

  return (
    <Page>
      <Header>
        <Search
          maxW={360}
          type="text"
          placeholder="Search assets (symbol, name, AID)…"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
        />
        <ToggleBtn type="button" on={showImposters} onClick={() => setShowImposters((s) => !s)}>
          {showImposters ? 'Hiding imposters' : 'Show imposters'}
        </ToggleBtn>
      </Header>

      <TableWrap maxWidth={1100}>
        {error ? (
          <CenteredNote>
            Failed to load assets:
            {error}
          </CenteredNote>
        ) : loading && filtered.length === 0 ? (
          <CenteredNote>Loading assets…</CenteredNote>
        ) : filtered.length === 0 ? (
          <CenteredNote>No assets match.</CenteredNote>
        ) : (
          <>
            <MobileOnly>{isMobile && filtered.map((a) => <AssetCard key={a.aid} a={a} onOpen={onOpen} />)}</MobileOnly>
            <DesktopOnly>
              <Table>
                <thead>
                  <tr>
                    <th style={{ width: 60 }}>AID</th>
                    <th>Asset</th>
                    <th>Description</th>
                    <th style={{ width: 100 }}>Emission</th>
                    <th style={{ width: 100 }}>Max Supply</th>
                    <th style={{ width: 70 }}>Pools</th>
                  </tr>
                </thead>
                <tbody>{!isMobile && filtered.map((a) => <AssetRow key={a.aid} a={a} onOpen={onOpen} />)}</tbody>
              </Table>
            </DesktopOnly>
          </>
        )}
      </TableWrap>
    </Page>
  );
};
