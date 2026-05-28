import React from 'react';
import { styled } from '@linaria/react';

const Bar = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  & > * + * { margin-left: 12px; }
  padding: 8px 12px;
  flex-wrap: wrap;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.5);
`;

const Pages = styled.div`
  display: flex;
  align-items: center;
  & > * + * { margin-left: 4px; }
  margin-left: auto;
  button {
    min-width: 26px;
    height: 26px;
    padding: 0 6px;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 6px;
    color: rgba(255, 255, 255, 0.6);
    font-size: 12px;
    font-family: inherit;
    cursor: pointer;
    &:hover:not(:disabled) { background: rgba(255, 255, 255, 0.06); color: white; }
    &.active {
      border-color: var(--color-green);
      color: var(--color-green);
      font-weight: 600;
    }
    &:disabled { opacity: 0.3; cursor: default; }
  }
  .gap { padding: 0 2px; color: rgba(255, 255, 255, 0.3); }
`;

interface Props {
  /** 0-based current page. */
  page: number;
  pageSize: number;
  /** Total rows (null while unknown — falls back to a prev/next-only pager). */
  total: number | null;
  /** Rows actually on the current page (for the "Showing X to Y" upper bound). */
  loadedCount: number;
  onChange: (page: number) => void;
}

// Build the page-number window: always page 1 and the last page, a ±1 window
// around the current page, and "…" gaps between. Mirrors the BeamAssets pager
// (1 2 3 4 5 … 225).
function pageList(current: number, last: number): Array<number | 'gap'> {
  const out: Array<number | 'gap'> = [];
  const push = (n: number): void => { if (!out.includes(n)) out.push(n); };
  const window = [current - 1, current, current + 1].filter((n) => n >= 1 && n <= last);
  push(1);
  if ((window[0] ?? 1) > 2) out.push('gap');
  for (const n of window) push(n);
  if ((window[window.length - 1] ?? last) < last - 1) out.push('gap');
  if (last > 1) push(last);
  return out;
}

export const Pager: React.FC<Props> = ({
  page, pageSize, total, loadedCount, onChange,
}) => {
  const current1 = page + 1; // 1-based for display
  const lastPage = total !== null ? Math.max(1, Math.ceil(total / pageSize)) : null;
  const from = total === 0 ? 0 : page * pageSize + 1;
  const to = page * pageSize + loadedCount;

  const canPrev = page > 0;
  const canNext = lastPage !== null ? current1 < lastPage : loadedCount >= pageSize;

  return (
    <Bar>
      <span>
        {total !== null
          ? `Showing ${from.toLocaleString('en-US')} to ${to.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} entries`
          : `Showing ${from.toLocaleString('en-US')} to ${to.toLocaleString('en-US')}`}
      </span>
      <Pages>
        <button type="button" disabled={!canPrev} onClick={() => onChange(page - 1)}>‹</button>
        {lastPage !== null
          ? pageList(current1, lastPage).map((p, i) => (p === 'gap' ? (
            // eslint-disable-next-line react/no-array-index-key
            <span key={`gap-${i}`} className="gap">…</span>
          ) : (
            <button
              key={p}
              type="button"
              className={p === current1 ? 'active' : ''}
              onClick={() => onChange(p - 1)}
            >
              {p}
            </button>
          )))
          : <button type="button" className="active">{current1}</button>}
        <button type="button" disabled={!canNext} onClick={() => onChange(page + 1)}>›</button>
      </Pages>
    </Bar>
  );
};
