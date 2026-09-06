import React from 'react';
import { styled } from '@linaria/react';
import { usePolled } from '../../hooks';
import { api } from '../../api/client';
import type { ApiOracleState } from '../../api/types';
import OracleGlyph from './shared/icons/oracle.svg';
import { Page, ExplorerHeader, H1, DataTable, ScrollX, Pill, ErrorBox, theme } from './shared';

const POLL_MS = 30_000;
const BLOCK_SECONDS = 60;

const Panel = styled.section`
  background: ${theme.color.surface};
  border: 1px solid ${theme.color.borderDim};
  border-radius: ${theme.radius.lg};
  margin-bottom: 20px;
  overflow: hidden;
`;
const PanelHead = styled.div`
  padding: 12px 16px;
  border-bottom: 1px solid ${theme.color.borderDim};
  font-size: 12px;
  color: ${theme.color.muted};
  text-transform: uppercase;
  letter-spacing: 0.05em;
`;
const PanelBody = styled.div`
  padding: 16px;
`;

const MedianRow = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  & > * + * {
    margin-left: 14px;
  }
`;
const MedianValue = styled.div`
  font-size: 32px;
  font-weight: 600;
  color: ${theme.color.accent};
  font-variant-numeric: tabular-nums;
  line-height: 1.1;
`;
const Note = styled.p`
  color: ${theme.color.textDim};
  font-size: 13px;
  margin: 14px 0 0;
  max-width: 78ch;
`;

const MetaGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  grid-gap: 12px;
  margin-top: 20px;
`;
const MetaLabel = styled.div`
  font-size: 11px;
  color: ${theme.color.muted};
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-bottom: 6px;
`;
const MetaValue = styled.div`
  font-size: 15px;
  color: ${theme.color.text};
  font-variant-numeric: tabular-nums;
  word-break: break-all;
`;

const Brand = styled.div`
  display: flex;
  align-items: center;
  & > * + * {
    margin-left: 12px;
  }
`;

const CopyBtn = styled.button`
  background: none;
  border: none;
  padding: 0 0 0 8px;
  font: inherit;
  font-size: 11px;
  color: ${theme.color.muted};
  cursor: pointer;
  &:hover {
    color: ${theme.color.accent};
  }
`;

const fmtNum = (n: number): string => n.toLocaleString('en-US');

/** Blocks as an approximate wall-clock span at BEAM's ~1-minute block time. */
function fmtAge(blocks: number): string {
  const sec = Math.max(0, blocks) * BLOCK_SECONDS;
  const mins = Math.round(sec / 60);
  if (mins < 60) return `~${mins}m`;
  const hours = Math.round(sec / 3600);
  if (hours < 48) return `~${hours}h`;
  return `~${Math.round(sec / 86400)}d`;
}

function shortKey(hex: string): string {
  return hex.length <= 20 ? hex : `${hex.slice(0, 8)}…${hex.slice(-8)}`;
}

const CopyKey: React.FC<{ value: string }> = ({ value }) => {
  const [copied, setCopied] = React.useState(false);
  return (
    <CopyBtn
      type="button"
      title="Copy public key"
      onClick={() => {
        navigator.clipboard?.writeText(value).then(
          () => setCopied(true),
          () => setCopied(false),
        );
      }}
    >
      {copied ? 'copied' : 'copy'}
    </CopyBtn>
  );
};

// The stored median lives on-chain and is only recomputed when a provider
// writes to the contract, so "enough live entries right now" and "the stored
// median is still valid" are two different questions — say which one failed.
function medianStatus(d: ApiOracleState): { label: string; tone: string; note: string } {
  const window = `${fmtNum(d.h_validity)}-block validity window`;
  if (!d.quorum) {
    return {
      label: 'No quorum',
      tone: 'warn',
      note: `${d.valid_providers} of ${d.min_providers} required entries are inside the ${window}. The stored median is only recomputed when the contract is written to.`,
    };
  }
  if (!d.median_valid) {
    return {
      label: 'Expired',
      tone: 'warn',
      note: `${d.valid_providers} of ${
        d.min_providers
      } required entries are inside the ${window}, but the stored median expired at block ${fmtNum(
        d.median_h_end,
      )} and has not been rewritten since.`,
    };
  }
  return {
    label: 'Live',
    tone: 'success',
    note: `${d.valid_providers} of ${d.min_providers} required entries are inside the ${window}. The stored median is only recomputed when the contract is written to.`,
  };
}

export const Oracle: React.FC = () => {
  const { data: d, error } = usePolled<ApiOracleState>(() => api.oracle(), [], POLL_MS);
  const status = d ? medianStatus(d) : null;

  return (
    <Page>
      <ExplorerHeader>
        <Brand>
          <OracleGlyph width={34} height={34} />
          <H1>Beam Oracle</H1>
        </Brand>
      </ExplorerHeader>

      {error && (
        <ErrorBox>
          Failed to load the oracle:
          {error}
        </ErrorBox>
      )}

      <Panel>
        <PanelHead>Median feed value</PanelHead>
        <PanelBody>
          <MedianRow>
            <MedianValue>{d?.median ?? '—'}</MedianValue>
            {status && <Pill data-tone={status.tone}>{status.label}</Pill>}
          </MedianRow>
          {status && <Note>{status.note}</Note>}

          <MetaGrid>
            <div>
              <MetaLabel>Valid through</MetaLabel>
              <MetaValue>{d && d.median_h_end > 0 ? fmtNum(d.median_h_end) : '—'}</MetaValue>
            </div>
            <div>
              <MetaLabel>Valid providers</MetaLabel>
              <MetaValue>
                {d ? `${d.valid_providers} of ${d.providers.length} · ${d.min_providers} required` : '—'}
              </MetaValue>
            </div>
            <div>
              <MetaLabel>Shader version</MetaLabel>
              <MetaValue>{d?.kind?.replace(/^Oracle2\s*/i, '') || '—'}</MetaValue>
            </div>
            <div>
              <MetaLabel>Contract</MetaLabel>
              <MetaValue>
                {d ? shortKey(d.cid) : '—'}
                {d && <CopyKey value={d.cid} />}
              </MetaValue>
            </div>
          </MetaGrid>
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHead>
          {d ? `Providers (${d.providers.length}) · valid for ${fmtNum(d.h_validity)} blocks` : 'Providers'}
        </PanelHead>
        <ScrollX>
          <DataTable>
            <thead>
              <tr>
                <th>#</th>
                <th>Public key</th>
                <th>Value</th>
                <th className="right">Updated at</th>
                <th className="right">Age</th>
                <th className="right">Status</th>
              </tr>
            </thead>
            <tbody>
              {(d?.providers ?? []).map((p) => (
                <tr key={p.pk || p.index}>
                  <td className="muted">{p.index}</td>
                  <td className="mono">
                    {shortKey(p.pk)}
                    <CopyKey value={p.pk} />
                  </td>
                  <td>{p.value}</td>
                  <td className="right">{fmtNum(p.h_updated)}</td>
                  <td className="right">{`${fmtNum(p.age)} ${p.age === 1 ? 'block' : 'blocks'} (${fmtAge(p.age)})`}</td>
                  <td className="right">{p.stale && <Pill data-tone="danger">Stale</Pill>}</td>
                </tr>
              ))}
              {d && d.providers.length === 0 && (
                <tr>
                  <td colSpan={6} style={{ textAlign: 'center', padding: 22, color: theme.color.muted }}>
                    No providers registered.
                  </td>
                </tr>
              )}
            </tbody>
          </DataTable>
        </ScrollX>
      </Panel>
    </Page>
  );
};

export default Oracle;
