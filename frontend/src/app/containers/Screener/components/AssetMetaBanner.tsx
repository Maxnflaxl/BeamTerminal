import React, { useState } from 'react';
import { styled } from '@linaria/react';
import { useAsset, useAssetHistory, useStats } from '../hooks';
import type { ApiAssetHistoryItem } from '../api/types';
import { IconsPair } from './IconsPair';
import { AssetMetaCard } from './AssetMetaCard';

// Beam mainnet launched 2019-01-03, ~1 block/minute (same genesis the explorer
// supply math uses). BEAM has no asset-history events, so block 1 is its
// "since" and it changes every block — last change is the chain tip.
const BEAM_GENESIS_TS = Math.floor(Date.UTC(2019, 0, 3, 0, 0, 0) / 1000);

const Banner = styled.div`
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.02);
  margin-bottom: 12px;
  overflow: hidden;
`;

const Bar = styled.button`
  display: flex;
  align-items: center;
  & > * + * { margin-left: 16px; }
  width: 100%;
  padding: 12px 16px;
  background: none;
  border: none;
  color: inherit;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  &:hover { background: rgba(255, 255, 255, 0.02); }
  .asset {
    display: flex;
    align-items: center;
    & > * + * { margin-left: 8px; }
    font-size: 14px;
    .id { color: rgba(255, 255, 255, 0.45); }
    .nm { color: white; font-weight: 600; }
  }
  .sep { color: rgba(255, 255, 255, 0.2); }
  .chevron {
    margin-left: auto;
    color: rgba(255, 255, 255, 0.4);
    font-size: 12px;
    transition: transform 0.15s;
  }
  .chevron.open { transform: rotate(180deg); }
`;

const Body = styled.div`
  border-top: 1px solid rgba(255, 255, 255, 0.06);
  padding: 4px 16px 16px;
`;

const Tabs = styled.div`
  display: flex;
  & > * + * { margin-left: 6px; }
  padding: 12px 0 4px;
  button {
    padding: 6px 14px;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid transparent;
    border-radius: 8px;
    color: rgba(255, 255, 255, 0.55);
    font-size: 13px;
    font-family: inherit;
    cursor: pointer;
    &:hover { color: white; }
    &.active { background: rgba(0, 246, 210, 0.12); border-color: var(--color-green); color: var(--color-green); }
  }
`;

function deriveDates(history: ApiAssetHistoryItem[] | undefined): {
  createdTs: number | null; createdHeight: number | null;
  lastTs: number | null; lastHeight: number | null;
} {
  if (!history || history.length === 0) {
    return { createdTs: null, createdHeight: null, lastTs: null, lastHeight: null };
  }
  const created = history.find((h) => h.event === 'Create')
    ?? history.reduce((min, h) => (h.height < min.height ? h : min), history[0]!);
  const last = history.reduce((mx, h) => (h.height > mx.height ? h : mx), history[0]!);
  return {
    createdTs: created.ts, createdHeight: created.height, lastTs: last.ts, lastHeight: last.height,
  };
}

interface Props {
  aid1: number;
  aid2: number;
  sym1: string;
  sym2: string;
}

/** Expandable asset-metadata banner (BeamAssets Image #1). Collapsed it shows
 *  both pair assets; expanded it tabs between each asset's metadata card. */
export const AssetMetaBanner: React.FC<Props> = ({
  aid1, aid2, sym1, sym2,
}) => {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<1 | 2>(1);

  const { data: asset1 } = useAsset(aid1);
  const { data: asset2 } = useAsset(aid2);
  // BEAM (aid 0) has no /history endpoint — skip it.
  const { data: hist1 } = useAssetHistory(aid1 > 0 ? aid1 : undefined);
  const { data: hist2 } = useAssetHistory(aid2 > 0 ? aid2 : undefined);
  const { data: stats } = useStats();

  const name1 = asset1?.name ?? sym1;
  const name2 = asset2?.name ?? sym2;

  const activeAid = tab === 1 ? aid1 : aid2;
  const activeAsset = tab === 1 ? asset1 : asset2;
  // BEAM is mined from genesis and changes every block, so it has no history
  // rows: its "since" is block 1 and its "last change" is the chain tip.
  const activeDates = activeAid === 0
    ? {
      createdTs: BEAM_GENESIS_TS,
      createdHeight: 1,
      lastTs: stats?.block_ts ?? null,
      lastHeight: stats?.last_indexed_height ?? null,
    }
    : deriveDates((tab === 1 ? hist1 : hist2)?.history);

  return (
    <Banner>
      <Bar type="button" onClick={() => setOpen((v) => !v)}>
        <IconsPair aid1={aid1} aid2={aid2} />
        <span className="asset">
          <span className="id">
            Asset ID:
            {' '}
            {aid1}
          </span>
          <span className="nm">
            {name1}
            {' '}
            (
            {sym1}
            )
          </span>
        </span>
        <span className="sep">·</span>
        <span className="asset">
          <span className="id">
            Asset ID:
            {' '}
            {aid2}
          </span>
          <span className="nm">
            {name2}
            {' '}
            (
            {sym2}
            )
          </span>
        </span>
        <span className={`chevron ${open ? 'open' : ''}`}>▼</span>
      </Bar>
      {open && (
        <Body>
          <Tabs>
            <button type="button" className={tab === 1 ? 'active' : ''} onClick={() => setTab(1)}>
              {`Asset ID ${aid1}: ${sym1}`}
            </button>
            <button type="button" className={tab === 2 ? 'active' : ''} onClick={() => setTab(2)}>
              {`Asset ID ${aid2}: ${sym2}`}
            </button>
          </Tabs>
          {activeAsset ? (
            <AssetMetaCard
              asset={activeAsset}
              createdTs={activeDates.createdTs}
              createdHeight={activeDates.createdHeight}
              lastChangeTs={activeDates.lastTs}
              lastChangeHeight={activeDates.lastHeight}
            />
          ) : (
            <div style={{ padding: 24, textAlign: 'center', color: 'rgba(255,255,255,0.4)' }}>Loading…</div>
          )}
        </Body>
      )}
    </Banner>
  );
};
