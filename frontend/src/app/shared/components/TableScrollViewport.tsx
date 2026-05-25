import React from 'react';
import { styled } from '@linaria/react';

const Viewport = styled.div<{ tableMinWidth: number }>`
  width: 100%;
  max-width: 1100px;
  min-width: 0;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  overscroll-behavior-x: contain;

  & > table {
    min-width: ${({ tableMinWidth }) => tableMinWidth}px;
  }
`;

export interface TableScrollViewportProps {
  /** Minimum table width in px before horizontal scroll appears */
  tableMinWidth?: number;
  children: React.ReactNode;
}

const TableScrollViewport: React.FC<TableScrollViewportProps> = ({
  tableMinWidth = 720,
  children,
}) => (
  <Viewport tableMinWidth={tableMinWidth}>{children}</Viewport>
);

export default TableScrollViewport;
