import { styled } from '@linaria/react';
import { MOBILE_MEDIA } from './responsive';

// Scaffold shared by the top-level list pages (PairsList / AssetsList): the
// full-height page shell, the search input, the table wrapper, and the mobile
// card kit. Page-specific chrome (header rows, sort pills, toggles) stays in
// the pages; layout differences are props, not copies.

export const ListPage = styled.div`
  width: 100%;
  min-height: calc(100vh - 130px);
`;

export const SearchInput = styled.input<{ maxW?: number }>`
  flex: 1;
  max-width: ${(p) => p.maxW ?? 400}px;
  padding: 8px 12px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  color: white;
  font-size: 13px;
  outline: none;
  font-family: inherit;
  &:focus {
    border-color: var(--color-green);
  }
`;

export const TableWrap = styled.div<{ maxWidth?: number }>`
  max-width: ${(p) => p.maxWidth ?? 1400}px;
  margin: 16px auto;
  padding: 0 20px;
  overflow-x: auto;

  ${MOBILE_MEDIA} {
    padding: 0 12px;
    overflow-x: visible;
  }
`;

/** Mobile row card. `sideColumn` adds the right-hand slot (star + sparkline). */
export const MobileCard = styled.div<{ sideColumn?: boolean }>`
  display: grid;
  grid-template-columns: ${(p) => (p.sideColumn ? 'auto 1fr auto' : 'auto 1fr')};
  grid-gap: 10px;
  padding: 12px;
  margin-bottom: 8px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 10px;
  cursor: pointer;
  &:hover {
    background: rgba(255, 255, 255, 0.05);
  }
`;

export const MobileCardMain = styled.div`
  min-width: 0;
  display: flex;
  flex-direction: column;
  & > * + * {
    margin-top: 4px;
  }
`;

export const MobileCardTopRow = styled.div`
  display: flex;
  align-items: baseline;
  & > * + * {
    margin-left: 8px;
  }
  flex-wrap: wrap;
`;

export const MobileCardTitle = styled.div`
  font-weight: 600;
  font-size: 14px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`;

export const MobileCardSub = styled.div`
  color: rgba(255, 255, 255, 0.5);
  font-size: 11px;
`;

export const MobileCardStats = styled.div<{ cols?: number }>`
  display: grid;
  grid-template-columns: repeat(${(p) => p.cols ?? 2}, 1fr);
  grid-gap: 2px 12px;
  margin-top: 4px;
  font-family: var(--font-mono);
  font-size: 12px;
`;

/** Label/value pair. Default is a spaced row; `column` stacks label above. */
export const MobileCardStat = styled.div<{ column?: boolean }>`
  display: flex;
  flex-direction: ${(p) => (p.column ? 'column' : 'row')};
  justify-content: ${(p) => (p.column ? 'flex-start' : 'space-between')};
  color: rgba(255, 255, 255, 0.8);

  & > span:first-child {
    color: rgba(255, 255, 255, 0.45);
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin-right: ${(p) => (p.column ? 0 : 8)}px;
  }
`;
