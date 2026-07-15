import { styled } from '@linaria/react';

// Shared list-table for the DEX (PairsList), ASSETS (AssetsList) and Asset-detail
// tables, which were three near-identical copies. Pages extend it via
// `styled(ScreenerTable)` for their specifics — sortable headers (PairsList),
// top-aligned cells (AssetsList), tighter padding (AssetDetail).
export const ScreenerTable = styled.table`
  width: 100%;
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
    vertical-align: middle;
  }
  tbody tr {
    cursor: pointer;
    transition: background 0.15s;
    &:hover {
      background: rgba(255, 255, 255, 0.03);
    }
  }
  .mono {
    font-family: var(--font-mono);
  }
  .positive {
    color: var(--color-green);
  }
  .negative {
    color: var(--color-red);
  }
  .neutral {
    color: rgba(255, 255, 255, 0.5);
  }
`;
