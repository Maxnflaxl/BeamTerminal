import React, { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { styled } from '@linaria/react';
import { css } from '@linaria/core';
import { Page, Pill, ErrorBox, DataTable, ScrollX, Btn, Muted, theme } from '../shared';
import { ROUTES } from '@app/shared/constants';
import { api } from '../../../api/client';
import type { ApiDaoProposalDetail } from '../../../api/types';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { fmtBeamx, fmtCompact, grothToBeamx, variantColor, outcomeTone, outcomeLabel } from './daoShared';

const LIMIT = 25;

const backCls = css`
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  font-weight: 600;
  padding: 6px 14px;
  margin-bottom: 16px;
  border-radius: 6px;
  border: 1px solid ${theme.color.border};
  background: ${theme.color.surface2};
  color: ${theme.color.accent};
  text-decoration: none;
  transition: background 0.15s, border-color 0.15s;
  &:hover {
    background: ${theme.color.rowHover};
    border-color: ${theme.color.accent};
    color: ${theme.color.accent};
  }
`;
const TitleRow = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  & > * + * { margin-left: 12px; }
`;
const Title = styled.h1`
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  color: ${theme.color.text};
  font-family: ${theme.font.display};
`;
const Meta = styled.div`
  font-size: 11px;
  color: ${theme.color.muted};
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin: 6px 0 10px;
`;
const ForumLink = styled.a`
  display: inline-block;
  font-size: 12px;
  color: ${theme.color.accent};
  text-decoration: none;
  margin-bottom: 12px;
  &:hover { text-decoration: underline; }
`;
const Desc = styled.div`
  font-size: 13px;
  color: ${theme.color.text};
  background: ${theme.color.surface};
  border: 1px solid ${theme.color.borderDim};
  border-radius: ${theme.radius.md};
  padding: 14px 16px;
  margin-bottom: 20px;
  word-break: break-word;
  line-height: 1.55;
  max-height: 340px;
  overflow-y: auto;
  & > *:first-child { margin-top: 0; }
  & > *:last-child { margin-bottom: 0; }
  & h1, & h2, & h3, & h4 { color: ${theme.color.text}; margin: 14px 0 6px; font-size: 15px; font-weight: 700; }
  & p { margin: 0 0 8px; }
  & a { color: ${theme.color.accent}; }
  & ul, & ol { margin: 0 0 8px; padding-left: 20px; }
  & li { margin: 2px 0; }
  & code { background: ${theme.color.surface2}; padding: 1px 5px; border-radius: 3px; font-size: 12px; }
  & pre { background: ${theme.color.surface2}; padding: 10px 12px; border-radius: 6px; overflow-x: auto; }
  & blockquote { margin: 0 0 8px; padding-left: 12px; border-left: 3px solid ${theme.color.borderDim}; color: ${theme.color.muted}; }
  & hr { border: 0; border-top: 1px solid ${theme.color.borderDim}; margin: 12px 0; }
  & img { max-width: 100%; border-radius: 6px; }
  & table { border-collapse: collapse; }
  & th, & td { border: 1px solid ${theme.color.borderDim}; padding: 4px 8px; }
`;
const Panel = styled.div`
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
const PanelBody = styled.div` padding: 14px 16px; `;
const VariantRow = styled.div` margin: 0 0 12px; `;
const VTop = styled.div`
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  color: ${theme.color.text};
  margin-bottom: 4px;
`;
const VTrack = styled.div`
  height: 10px;
  background: ${theme.color.surface2};
  border-radius: 4px;
  overflow: hidden;
`;
const VFill = styled.div` height: 100%; `;
const Pager = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  border-top: 1px solid ${theme.color.borderDim};
  font-size: 11px;
  color: ${theme.color.muted};
  & > span > * + * { margin-left: 6px; }
`;
const Note = styled.div`
  font-size: 11px;
  color: ${theme.color.muted};
`;

function truncPk(pk: string): string {
  if (!pk || pk.length <= 14) return pk;
  return `${pk.slice(0, 6)}…${pk.slice(-6)}`;
}

export const DaoProposal: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const pid = Number(id);
  const [data, setData] = useState<ApiDaoProposalDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);

  useEffect(() => {
    let alive = true;
    api
      .daoProposal(pid, page * LIMIT, LIMIT)
      .then((d) => {
        if (alive) {
          setData(d);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [pid, page]);

  const p = data?.proposal;
  const total = data?.votes.total ?? 0;

  return (
    <Page>
      <Link to={ROUTES.NAV.EXPLORER_DAO_GOVERNANCE} className={backCls}>← Governance</Link>
      {error && <ErrorBox>Failed to load proposal: {error}</ErrorBox>}
      {!p && !error && <Muted>Loading…</Muted>}
      {p && (
        <>
          <TitleRow>
            <Title>{p.title ?? `Proposal #${p.id}`}</Title>
            <Pill data-tone={outcomeTone(p.status, p.outcome)}>{outcomeLabel(p.status, p.outcome)}</Pill>
          </TitleRow>
          <Meta>
            {`#${String(p.id).padStart(4, '0')} · Epoch #${p.epoch}`}
            {p.quorum_pct != null ? ` · quorum ${p.quorum_pct}%` : ''}
            {p.turnout_pct != null ? ` · turnout ${p.turnout_pct.toFixed(1)}%` : ''}
          </Meta>
          {p.forum_link && /^https?:\/\//i.test(p.forum_link) && (
            <div>
              <ForumLink href={p.forum_link} target="_blank" rel="noreferrer">
                Open forum discussion ↗
              </ForumLink>
            </div>
          )}
          {p.description && (
            <Desc>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{p.description}</ReactMarkdown>
            </Desc>
          )}

          <Panel>
            <PanelHead>
              Results
              {p.yes_needed ? ` · ${fmtCompact(grothToBeamx(p.yes_needed))} BEAMX YES needed to pass` : ''}
            </PanelHead>
            <PanelBody>
              {p.tallies.map((t) => (
                <VariantRow key={t.variant}>
                  <VTop>
                    <span>{t.label}</span>
                    <span style={{ color: variantColor(t.variant) }}>
                      {t.pct.toFixed(1)}% · {fmtBeamx(t.stake)}
                    </span>
                  </VTop>
                  <VTrack>
                    <VFill style={{ width: `${t.pct}%`, background: variantColor(t.variant) }} />
                  </VTrack>
                </VariantRow>
              ))}
            </PanelBody>
          </Panel>

          <Panel>
            <PanelHead>Individual votes · {total}</PanelHead>
            <ScrollX>
              <DataTable>
                <thead>
                  <tr>
                    <th>Voter</th>
                    <th>Choice</th>
                    <th className="right">Weight</th>
                    <th className="right">Height</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.votes.rows ?? []).map((v, i) => (
                    <tr key={`${v.voter}-${i}`}>
                      <td style={{ color: theme.color.accent }}>{truncPk(v.voter)}</td>
                      <td>
                        <Pill data-tone={v.variant === 1 ? 'accent' : v.variant === 0 ? 'danger' : 'purple'}>{v.label}</Pill>
                      </td>
                      <td className="right">{v.weight != null ? fmtBeamx(v.weight) : '—'}</td>
                      <td className="right">{v.height}</td>
                    </tr>
                  ))}
                  {(data?.votes.rows.length ?? 0) === 0 && (
                    <tr>
                      <td colSpan={4} style={{ textAlign: 'center', padding: 22, color: theme.color.muted }}>
                        No individual votes recorded yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </DataTable>
            </ScrollX>
            {total > LIMIT && (
              <Pager>
                <span>{`${page * LIMIT + 1}–${Math.min((page + 1) * LIMIT, total)} of ${total}`}</span>
                <span>
                  <Btn type="button" data-variant="ghost" disabled={page === 0} onClick={() => setPage((n) => Math.max(0, n - 1))}>
                    ‹ Prev
                  </Btn>
                  <Btn type="button" data-variant="ghost" disabled={(page + 1) * LIMIT >= total} onClick={() => setPage((n) => n + 1)}>
                    Next ›
                  </Btn>
                </span>
              </Pager>
            )}
          </Panel>
        </>
      )}
    </Page>
  );
};

export default DaoProposal;
