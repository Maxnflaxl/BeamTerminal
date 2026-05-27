import React from 'react';
import { styled } from '@linaria/react';
import AssetIcon, { normalizeOptColor } from '@app/shared/components/AssetsIcon';
import type { ApiAsset } from '../api/types';
import { fmtNum } from './format';

const Card = styled.div`
  padding: 16px 4px 4px;
`;

const Head = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  margin-bottom: 18px;
  .icon { width: 40px; height: 40px; flex-shrink: 0; }
  .icon svg { display: block; width: 40px; height: 40px; }
  .name { font-size: 22px; font-weight: 700; color: white; }
`;

const Grid = styled.div`
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 14px 28px;
  max-width: 820px;
  margin: 0 auto;
  @media (max-width: 720px) { grid-template-columns: repeat(2, 1fr); }
  @media (max-width: 480px) { grid-template-columns: 1fr; }
`;

const Cell = styled.div`
  display: flex;
  gap: 8px;
  font-size: 13px;
  .lbl { color: rgba(255, 255, 255, 0.45); white-space: nowrap; }
  .val { color: white; font-family: 'SFProDisplay', monospace; word-break: break-word; }
`;

const Desc = styled.div`
  max-width: 820px;
  margin: 16px auto 0;
  font-size: 13px;
  color: rgba(255, 255, 255, 0.7);
  line-height: 1.55;
  white-space: pre-wrap;
`;

// UTC date+time, matching the explorer's "YYYY-MM-DD HH:MM (UTC)" presentation.
function fmtUtc(ts: number | null): string {
  if (!ts) return '—';
  const d = new Date(ts * 1000);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} (UTC)`;
}

interface Props {
  asset: ApiAsset;
  createdTs: number | null;
  createdHeight: number | null;
  lastChangeTs: number | null;
  lastChangeHeight: number | null;
}

/** BeamAssets-style metadata card for one asset of a pair. Uses only fields the
 *  backend already stores; "Since"/"Last change" come from the asset history. */
export const AssetMetaCard: React.FC<Props> = ({
  asset, createdTs, createdHeight, lastChangeTs, lastChangeHeight,
}) => {
  const sym = asset.short_name ?? `aid${asset.aid}`;
  const supplyHuman = asset.emission ? Number(asset.emission) / 10 ** asset.decimals : null;

  return (
    <Card>
      <Head>
        <AssetIcon className="icon" asset_id={asset.aid} color={asset.color} />
        <span className="name">{asset.name ?? `Asset #${asset.aid}`}</span>
      </Head>
      <Grid>
        <Cell><span className="lbl">Asset ID:</span><span className="val">{asset.aid}</span></Cell>
        <Cell><span className="lbl">Short name:</span><span className="val">{asset.short_name ?? '—'}</span></Cell>
        <Cell>
          <span className="lbl">{asset.aid === 0 ? 'Mined supply:' : 'Minted supply:'}</span>
          <span className="val">
            {supplyHuman !== null ? `${fmtNum(supplyHuman, 0)} ${sym}` : '—'}
          </span>
        </Cell>
        <Cell><span className="lbl">Since:</span><span className="val">{fmtUtc(createdTs)}</span></Cell>
        <Cell><span className="lbl">Unit name:</span><span className="val">{asset.unit_name ?? '—'}</span></Cell>
        <Cell><span className="lbl">Last change:</span><span className="val">{fmtUtc(lastChangeTs)}</span></Cell>
        <Cell>
          <span className="lbl">Block:</span>
          <span className="val">{createdHeight !== null ? createdHeight.toLocaleString('en-US') : '—'}</span>
        </Cell>
        <Cell><span className="lbl">Decimals:</span><span className="val">{asset.decimals}</span></Cell>
        <Cell>
          <span className="lbl">Block:</span>
          <span className="val">{lastChangeHeight !== null ? lastChangeHeight.toLocaleString('en-US') : '—'}</span>
        </Cell>
        {normalizeOptColor(asset.color) && (
          <Cell>
            <span className="lbl">Color:</span>
            <span className="val" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
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
            </span>
          </Cell>
        )}
      </Grid>
      {asset.description && <Desc>{asset.description}</Desc>}
    </Card>
  );
};
