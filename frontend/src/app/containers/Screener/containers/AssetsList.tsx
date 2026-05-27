import React, { useState, useMemo } from 'react';
import { styled } from '@linaria/react';
import { useNavigate } from 'react-router-dom';
import AssetIcon from '@app/shared/components/AssetsIcon';
import { useAssets } from '../hooks';
import { fmtNum } from '../components/format';

const Page = styled.div`
  width: 100%;
  min-height: calc(100vh - 130px);
`;

const Header = styled.div`
  max-width: 1100px;
  margin: 24px auto 0;
  padding: 0 20px;
  display: flex;
  gap: 16px;
  align-items: center;
  @media (max-width: 640px) {
    padding: 0 12px;
  }
`;

const Search = styled.input`
  flex: 1;
  max-width: 360px;
  padding: 8px 12px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  color: white;
  font-size: 13px;
  outline: none;
  font-family: inherit;
  &:focus { border-color: var(--color-green); }
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
  &:hover { filter: brightness(1.1); }
`;

const TableWrap = styled.div`
  max-width: 1100px;
  margin: 16px auto;
  padding: 0 20px;
  overflow-x: auto;

  @media (max-width: 640px) {
    padding: 0 12px;
    overflow-x: visible;
  }
`;

const DesktopOnly = styled.div`
  @media (max-width: 640px) { display: none; }
`;

const MobileOnly = styled.div`
  display: none;
  @media (max-width: 640px) { display: block; }
`;

const ACard = styled.div`
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 10px;
  padding: 12px;
  margin-bottom: 8px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 10px;
  cursor: pointer;
  &:hover { background: rgba(255, 255, 255, 0.05); }
`;

const ACardMain = styled.div`
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
`;

const ACardTitleRow = styled.div`
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
`;

const ACardTitle = styled.div`
  font-weight: 600;
  font-size: 14px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`;

const ACardSub = styled.div`
  color: rgba(255, 255, 255, 0.5);
  font-size: 11px;
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

const ACardStats = styled.div`
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 2px 12px;
  margin-top: 4px;
  font-family: 'SFProDisplay', monospace;
  font-size: 12px;
`;

const ACardStat = styled.div`
  display: flex;
  flex-direction: column;
  color: rgba(255, 255, 255, 0.85);

  & > span:first-child {
    color: rgba(255, 255, 255, 0.45);
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
`;

const Table = styled.table`
  width: 100%;
  min-width: 720px;
  border-collapse: collapse;
  font-size: 14px;

  th {
    text-align: left;
    padding: 10px 12px;
    font-size: 11px;
    color: rgba(255, 255, 255, 0.5);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    white-space: nowrap;
  }
  td {
    padding: 10px 12px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.04);
    vertical-align: top;
  }
  tbody tr {
    cursor: pointer;
    transition: background 0.15s;
    &:hover { background: rgba(255, 255, 255, 0.03); }
  }
`;

const Cell = styled.div`
  display: flex;
  gap: 10px;
  align-items: center;
`;

// AssetIcon is used as-is — same component the trade panel renders. We just
// strip the right-margin (set for text-adjacent layout) since the icon sits
// in its own flex slot here.
const RowAssetIcon = styled(AssetIcon)`
  && { margin-right: 0; }
  flex-shrink: 0;
`;

const Sym = styled.div`
  font-weight: 600;
  small {
    color: rgba(255, 255, 255, 0.4);
    font-weight: 400;
    font-size: 11px;
    margin-left: 6px;
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

const Loading = styled.div`
  text-align: center;
  padding: 60px 20px;
  color: rgba(255, 255, 255, 0.5);
`;

const Empty = styled.div`
  text-align: center;
  padding: 60px 20px;
  color: rgba(255, 255, 255, 0.5);
`;

export const AssetsList: React.FC = () => {
  const navigate = useNavigate();
  const { data, loading, error } = useAssets();
  const [searchInput, setSearchInput] = useState('');
  const [showImposters, setShowImposters] = useState(false);

  const filtered = useMemo(() => {
    const all = data?.assets ?? [];
    const q = searchInput.trim().toLowerCase();
    return all
      .filter((a) => (showImposters ? true : !a.is_imposter))
      .filter((a) => {
        if (!q) return true;
        const sym = (a.short_name ?? '').toLowerCase();
        const name = (a.name ?? '').toLowerCase();
        return sym.includes(q) || name.includes(q) || String(a.aid).includes(q);
      });
  }, [data, searchInput, showImposters]);

  return (
    <Page>
      <Header>
        <Search
          type="text"
          placeholder="Search assets (symbol, name, AID)…"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
        />
        <ToggleBtn type="button" on={showImposters} onClick={() => setShowImposters((s) => !s)}>
          {showImposters ? 'Hiding imposters' : 'Show imposters'}
        </ToggleBtn>
      </Header>

      <TableWrap>
        {error ? (
          <Empty>
            Failed to load assets:
            {error}
          </Empty>
        ) : loading && filtered.length === 0 ? (
          <Loading>Loading assets…</Loading>
        ) : filtered.length === 0 ? (
          <Empty>No assets match.</Empty>
        ) : (
          <>
          <MobileOnly>
            {filtered.map((a) => {
              const supplyHuman = a.emission
                ? Number(a.emission) / 10 ** a.decimals
                : null;
              const maxSupplyHuman = a.max_supply
                ? Number(a.max_supply) / 10 ** a.decimals
                : null;
              const maxSupplyLabel = maxSupplyHuman !== null
                ? fmtNum(maxSupplyHuman, 0)
                : a.minter_cid
                  ? '∞'
                  : '—';
              return (
                <ACard key={a.aid} onClick={() => navigate(`/asset/${a.aid}`)}>
                  <RowAssetIcon asset_id={a.aid} color={a.color} />
                  <ACardMain>
                    <ACardTitleRow>
                      <ACardTitle>{a.short_name ?? `aid${a.aid}`}</ACardTitle>
                      <ACardSub>#{a.aid}</ACardSub>
                      {a.is_imposter && <ImposterBadge>Fake</ImposterBadge>}
                    </ACardTitleRow>
                    {a.name && <ACardSub>{a.name}</ACardSub>}
                    {a.description && <ACardDesc>{a.description}</ACardDesc>}
                    <ACardStats>
                      <ACardStat>
                        <span>Emission</span>
                        <span>{supplyHuman !== null ? fmtNum(supplyHuman, 0) : '—'}</span>
                      </ACardStat>
                      <ACardStat>
                        <span>Max</span>
                        <span>{maxSupplyLabel}</span>
                      </ACardStat>
                      <ACardStat>
                        <span>Pools</span>
                        <span>{a.pool_count}</span>
                      </ACardStat>
                    </ACardStats>
                  </ACardMain>
                </ACard>
              );
            })}
          </MobileOnly>
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
            <tbody>
              {filtered.map((a) => {
                const supplyHuman = a.emission
                  ? Number(a.emission) / 10 ** a.decimals
                  : null;
                const maxSupplyHuman = a.max_supply
                  ? Number(a.max_supply) / 10 ** a.decimals
                  : null;
                // Minter-issued assets with no cap (UINT64_MAX sentinel) keep
                // max_supply null on the backend — render those as "∞" so
                // they're visually distinct from non-minter rows ("—").
                const maxSupplyLabel = maxSupplyHuman !== null
                  ? fmtNum(maxSupplyHuman, 0)
                  : a.minter_cid
                    ? '∞'
                    : '—';
                return (
                  <tr key={a.aid} onClick={() => navigate(`/asset/${a.aid}`)}>
                    <td style={{ color: 'rgba(255,255,255,0.4)' }}>
                      #
                      {a.aid}
                    </td>
                    <td>
                      <Cell>
                        <RowAssetIcon asset_id={a.aid} color={a.color} />
                        <Sym>
                          {a.short_name ?? `aid${a.aid}`}
                          <small>{a.name ?? ''}</small>
                          {a.is_imposter && <ImposterBadge>Fake</ImposterBadge>}
                        </Sym>
                      </Cell>
                    </td>
                    <td>
                      <Desc>{a.description ?? ''}</Desc>
                    </td>
                    <td style={{ fontFamily: 'SFProDisplay,monospace' }}>
                      {supplyHuman !== null ? fmtNum(supplyHuman, 0) : '—'}
                    </td>
                    <td style={{ fontFamily: 'SFProDisplay,monospace' }}>
                      {maxSupplyLabel}
                    </td>
                    <td style={{ fontFamily: 'SFProDisplay,monospace' }}>{a.pool_count}</td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
          </DesktopOnly>
          </>
        )}
      </TableWrap>
    </Page>
  );
};
