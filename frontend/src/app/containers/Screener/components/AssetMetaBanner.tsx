import React, { useState } from 'react';
import { styled } from '@linaria/react';
import AssetIcon, { normalizeOptColor } from '@app/shared/components/AssetsIcon';
import { AssetLabel } from '@app/shared/components/AssetLabel';
import { useAsset, useAssetHistory, useStats } from '../hooks';
import type { ApiAsset, ApiAssetHistoryItem } from '../api/types';
import { IconsPair } from './IconsPair';
import { fmtNum } from './format';

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
  & > * + * {
    margin-left: 16px;
  }
  width: 100%;
  padding: 12px 16px;
  background: none;
  border: none;
  color: inherit;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  &:hover {
    background: rgba(255, 255, 255, 0.02);
  }
  .asset {
    display: flex;
    align-items: center;
    & > * + * {
      margin-left: 8px;
    }
    font-size: 14px;
    .id {
      color: rgba(255, 255, 255, 0.45);
    }
    .nm {
      color: white;
      font-weight: 600;
    }
  }
  .sep {
    color: rgba(255, 255, 255, 0.2);
  }
  .chevron {
    margin-left: auto;
    color: rgba(255, 255, 255, 0.4);
    font-size: 12px;
    transition: transform 0.15s;
  }
  .chevron.open {
    transform: rotate(180deg);
  }
`;

const Body = styled.div`
  border-top: 1px solid rgba(255, 255, 255, 0.06);
  padding: 4px 16px 16px;
  overflow-x: auto;
`;

// Both assets side by side: a field-label column plus one value column per asset.
const Compare = styled.table`
  width: 100%;
  max-width: 820px;
  margin: 10px auto 0;
  border-collapse: collapse;
  font-size: 13px;
  th,
  td {
    padding: 9px 12px;
    text-align: left;
    vertical-align: top;
  }
  thead th {
    padding-top: 6px;
  }
  thead .head {
    display: flex;
    align-items: center;
    & > * + * {
      margin-left: 8px;
    }
    .icon {
      width: 26px;
      height: 26px;
      flex-shrink: 0;
    }
    .icon svg {
      display: block;
      width: 26px;
      height: 26px;
    }
    .nm {
      font-size: 15px;
      font-weight: 700;
      color: white;
    }
  }
  tbody th {
    color: rgba(255, 255, 255, 0.45);
    font-weight: 400;
    white-space: nowrap;
    width: 1%;
  }
  tbody td {
    color: white;
    font-family: var(--font-mono);
    word-break: break-word;
  }
  tbody tr + tr th,
  tbody tr + tr td {
    border-top: 1px solid rgba(255, 255, 255, 0.06);
  }
  .swatch {
    display: inline-block;
    width: 12px;
    height: 12px;
    border-radius: 3px;
    border: 1px solid rgba(255, 255, 255, 0.2);
    margin-right: 6px;
    vertical-align: -1px;
  }
`;

const Desc = styled.div`
  max-width: 820px;
  margin: 16px auto 0;
  font-size: 13px;
  color: rgba(255, 255, 255, 0.7);
  line-height: 1.55;
  & > * + * {
    margin-top: 10px;
  }
  .who {
    color: rgba(255, 255, 255, 0.45);
    margin-right: 6px;
  }
  .txt {
    white-space: pre-wrap;
  }
`;

// UTC date+time, matching the explorer's "YYYY-MM-DD HH:MM (UTC)" presentation.
function fmtUtc(ts: number | null): string {
  if (!ts) return '—';
  const d = new Date(ts * 1000);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(
    d.getUTCMinutes(),
  )} (UTC)`;
}

interface AssetDates {
  createdTs: number | null;
  createdHeight: number | null;
  lastTs: number | null;
  lastHeight: number | null;
}

function deriveDates(history: ApiAssetHistoryItem[] | undefined): AssetDates {
  if (!history || history.length === 0) {
    return {
      createdTs: null,
      createdHeight: null,
      lastTs: null,
      lastHeight: null,
    };
  }
  const created =
    history.find((h) => h.event === 'Create') ??
    history.reduce((min, h) => (h.height < min.height ? h : min), history[0]!);
  const last = history.reduce((mx, h) => (h.height > mx.height ? h : mx), history[0]!);
  return {
    createdTs: created.ts,
    createdHeight: created.height,
    lastTs: last.ts,
    lastHeight: last.height,
  };
}

function supplyStr(asset: ApiAsset | null | undefined): string {
  if (!asset || !asset.emission) return '—';
  const human = Number(asset.emission) / 10 ** asset.decimals;
  return `${fmtNum(human, 0)} ${asset.short_name ?? `aid${asset.aid}`}`;
}

function dateWithBlock(ts: number | null, height: number | null): string {
  if (!ts) return '—';
  return height != null ? `${fmtUtc(ts)} · block ${height.toLocaleString('en-US')}` : fmtUtc(ts);
}

interface Props {
  aid1: number;
  aid2: number;
  sym1: string;
  sym2: string;
}

/** Expandable asset-metadata banner. Collapsed it shows both pair assets;
 *  expanded it shows both assets' metadata side by side as a comparison table. */
export const AssetMetaBanner: React.FC<Props> = ({ aid1, aid2, sym1, sym2 }) => {
  const [open, setOpen] = useState(false);

  const { data: asset1 } = useAsset(aid1);
  const { data: asset2 } = useAsset(aid2);
  // BEAM (aid 0) has no /history endpoint — skip it.
  const { data: hist1 } = useAssetHistory(aid1 > 0 ? aid1 : undefined);
  const { data: hist2 } = useAssetHistory(aid2 > 0 ? aid2 : undefined);
  const { data: stats } = useStats();

  const name1 = asset1?.name ?? sym1;
  const name2 = asset2?.name ?? sym2;

  // BEAM is mined from genesis and changes every block, so it has no history
  // rows: its "since" is block 1 and its "last change" is the chain tip.
  const datesFor = (aid: number, hist: ApiAssetHistoryItem[] | undefined): AssetDates =>
    aid === 0
      ? {
          createdTs: BEAM_GENESIS_TS,
          createdHeight: 1,
          lastTs: stats?.block_ts ?? null,
          lastHeight: stats?.last_indexed_height ?? null,
        }
      : deriveDates(hist);
  const dates1 = datesFor(aid1, hist1?.history);
  const dates2 = datesFor(aid2, hist2?.history);

  const color1 = normalizeOptColor(asset1?.color);
  const color2 = normalizeOptColor(asset2?.color);
  // BEAM's stock "Native BEAM asset" blurb is noise in the comparison; show only
  // real token descriptions (skip the native asset, aid 0).
  const desc1 = aid1 !== 0 ? asset1?.description : null;
  const desc2 = aid2 !== 0 ? asset2?.description : null;

  const rows: Array<{ label: string; v1: React.ReactNode; v2: React.ReactNode }> = [
    { label: 'Asset ID', v1: aid1, v2: aid2 },
    { label: 'Short name', v1: asset1?.short_name ?? '—', v2: asset2?.short_name ?? '—' },
    { label: 'Unit name', v1: asset1?.unit_name ?? '—', v2: asset2?.unit_name ?? '—' },
    { label: 'Decimals', v1: asset1?.decimals ?? '—', v2: asset2?.decimals ?? '—' },
    { label: 'Supply', v1: supplyStr(asset1), v2: supplyStr(asset2) },
    {
      label: 'Since',
      v1: dateWithBlock(dates1.createdTs, dates1.createdHeight),
      v2: dateWithBlock(dates2.createdTs, dates2.createdHeight),
    },
    {
      label: 'Last change',
      v1: dateWithBlock(dates1.lastTs, dates1.lastHeight),
      v2: dateWithBlock(dates2.lastTs, dates2.lastHeight),
    },
  ];
  if (color1 || color2) {
    rows.push({
      label: 'Color',
      v1: color1 ? (
        <span>
          <span className="swatch" style={{ background: color1 }} />
          {color1}
        </span>
      ) : (
        '—'
      ),
      v2: color2 ? (
        <span>
          <span className="swatch" style={{ background: color2 }} />
          {color2}
        </span>
      ) : (
        '—'
      ),
    });
  }

  const head = (aid: number, name: string, asset: ApiAsset | null | undefined): React.ReactNode => (
    <span className="head">
      <AssetIcon className="icon" asset_id={aid} color={asset?.color} logoUrl={asset?.logo_url} />
      <span className="nm">{name}</span>
    </span>
  );

  return (
    <Banner>
      <Bar type="button" onClick={() => setOpen((v) => !v)}>
        <IconsPair aid1={aid1} aid2={aid2} />
        <span className="asset">
          <span className="nm">
            <AssetLabel aid={aid1} sym={sym1} />
          </span>
          <span className="id">{name1}</span>
        </span>
        <span className="sep">·</span>
        <span className="asset">
          <span className="nm">
            <AssetLabel aid={aid2} sym={sym2} />
          </span>
          <span className="id">{name2}</span>
        </span>
        <span className={`chevron ${open ? 'open' : ''}`}>▼</span>
      </Bar>
      {open && (
        <Body>
          <Compare>
            <thead>
              <tr>
                <th aria-hidden="true" />
                <th>{head(aid1, name1, asset1)}</th>
                <th>{head(aid2, name2, asset2)}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.label}>
                  <th scope="row">{r.label}</th>
                  <td>{r.v1}</td>
                  <td>{r.v2}</td>
                </tr>
              ))}
            </tbody>
          </Compare>
          {(desc1 || desc2) && (
            <Desc>
              {desc1 && (
                <div>
                  <span className="who">{name1}:</span>
                  <span className="txt">{desc1}</span>
                </div>
              )}
              {desc2 && (
                <div>
                  <span className="who">{name2}:</span>
                  <span className="txt">{desc2}</span>
                </div>
              )}
            </Desc>
          )}
        </Body>
      )}
    </Banner>
  );
};
