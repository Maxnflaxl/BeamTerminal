// Shared UI primitives for /explorer/* pages. Mirrors the look of TRADE /
// ASSETS (Pairs/Assets lists) rather than inventing a separate theme:
//   - root font:  'SFProDisplay', monospace
//   - accent:     var(--color-green) #00f6d2
//   - bg:         var(--color-dark-blue) #042548 (page) + white-alpha surfaces
//   - text:       white + rgba(255,255,255,0.4–0.8) muted variants
//   - borders:    rgba(255,255,255,0.06–0.1) divider
//   - row hover:  rgba(255,255,255,0.03)
//
// Page implementations should compose these instead of redefining their own
// Linaria styled-components, keeping the explorer surface visually coherent
// with the rest of the app.

import React from 'react';
import { styled } from '@linaria/react';
import { theme } from './theme';

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/** Top-level page container — matches PairsList's max-width + padding. */
export const Page = styled.div`
  width: 95%;
  max-width: 1400px;
  margin: 0 auto;
  padding: ${theme.spacing.page};
  color: ${theme.color.text};
  font-family: ${theme.font.mono};
  font-size: 13px;
  line-height: 1.45;
`;

/** Narrower variant — used by pages that read better in a single column. */
export const PageNarrow = styled.div`
  width: 95%;
  max-width: 820px;
  margin: 0 auto;
  padding: ${theme.spacing.page};
  color: ${theme.color.text};
  font-family: ${theme.font.mono};
  font-size: 13px;
  line-height: 1.45;
`;

// ---------------------------------------------------------------------------
// Header / page chrome
// ---------------------------------------------------------------------------

export const ExplorerHeader = styled.header`
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin: 4px 0 20px;
  padding-bottom: 16px;
  border-bottom: 1px solid ${theme.color.divider};
`;

export const H1 = styled.h1`
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  letter-spacing: 0.01em;
  color: ${theme.color.text};
  font-family: ${theme.font.display};
`;

export const H2 = styled.h2`
  margin: 0 0 12px;
  font-size: 14px;
  font-weight: 600;
  color: ${theme.color.text};
  font-family: ${theme.font.display};
  text-transform: uppercase;
  letter-spacing: 0.05em;
`;

export const H3 = styled.h3`
  margin: 16px 0 8px;
  font-size: 11px;
  font-weight: 600;
  color: ${theme.color.muted};
  text-transform: uppercase;
  letter-spacing: 0.06em;
`;

export const Subtitle = styled.div`
  font-size: 11px;
  color: ${theme.color.muted};
  margin-top: 4px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
`;

export const Muted = styled.p`
  color: ${theme.color.muted};
  font-size: 12px;
  margin: 0 0 8px;
`;

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

export const Card = styled.section`
  background: ${theme.color.surface};
  border: 1px solid ${theme.color.borderDim};
  border-radius: ${theme.radius.lg};
  padding: ${theme.spacing.cardPad};
  margin-bottom: 16px;
`;

export const Surface2 = styled.div`
  background: ${theme.color.surface2};
  border: 1px solid ${theme.color.borderDim};
  border-radius: ${theme.radius.md};
  padding: 12px;
`;

// ---------------------------------------------------------------------------
// Stats / KPIs — match StatsBar.tsx in components/
// ---------------------------------------------------------------------------

export const StatGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
  margin-bottom: 16px;
`;

export const StatCard = styled.div`
  background: ${theme.color.surface};
  border: 1px solid ${theme.color.borderDim};
  border-radius: ${theme.radius.lg};
  padding: 14px 16px;
  transition: border-color 0.15s;
  &:hover { border-color: ${theme.color.border}; }
`;

export const Label = styled.div`
  font-size: 11px;
  color: ${theme.color.muted};
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-bottom: 4px;
`;

export const Value = styled.div`
  font-size: 18px;
  font-weight: 600;
  color: ${theme.color.text};
  font-variant-numeric: tabular-nums;
`;

export const SubValue = styled.div`
  font-size: 12px;
  color: ${theme.color.muted};
  margin-top: 4px;
`;

// ---------------------------------------------------------------------------
// Buttons / inputs — match the Search input + ToggleBtn in PairsList
// ---------------------------------------------------------------------------

export const Btn = styled.button`
  background: rgba(0, 246, 210, 0.12);
  border: 1px solid ${theme.color.accent};
  color: ${theme.color.accent};
  font: inherit;
  font-family: ${theme.font.mono};
  font-size: 12px;
  padding: 7px 14px;
  border-radius: ${theme.radius.md};
  cursor: pointer;
  transition: background 0.15s;
  &:hover { background: rgba(0, 246, 210, 0.22); }
  &:disabled { opacity: 0.4; cursor: not-allowed; }

  &[data-variant='ghost'] {
    background: transparent;
    border-color: ${theme.color.border};
    color: ${theme.color.muted};
  }
  &[data-variant='ghost']:hover {
    color: ${theme.color.text};
    border-color: ${theme.color.accent};
    background: rgba(255, 255, 255, 0.03);
  }
`;

/** Tab/pill button. Set `data-active='true'` when selected. */
export const TabBtn = styled.button`
  background: transparent;
  border: 1px solid ${theme.color.border};
  color: ${theme.color.muted};
  font: inherit;
  font-family: ${theme.font.mono};
  font-size: 11px;
  padding: 6px 12px;
  border-radius: ${theme.radius.md};
  cursor: pointer;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  &:hover { color: ${theme.color.text}; border-color: ${theme.color.accent}; }
  &[data-active='true'] {
    background: ${theme.color.accent};
    border-color: ${theme.color.accent};
    color: ${theme.color.bg};
  }
`;

export const Input = styled.input`
  background: ${theme.color.surface};
  border: 1px solid ${theme.color.border};
  color: ${theme.color.text};
  font: inherit;
  font-family: ${theme.font.mono};
  font-size: 13px;
  padding: 7px 10px;
  border-radius: ${theme.radius.md};
  width: 100%;
  outline: none;
  &:focus { border-color: ${theme.color.accent}; }
  &::placeholder { color: ${theme.color.muted}; }
`;

export const Select = styled.select`
  background: ${theme.color.surface};
  border: 1px solid ${theme.color.border};
  color: ${theme.color.text};
  font: inherit;
  font-family: ${theme.font.mono};
  font-size: 12px;
  padding: 6px 10px;
  border-radius: ${theme.radius.md};
  cursor: pointer;
  outline: none;
  &:focus { border-color: ${theme.color.accent}; }
  & option { background: ${theme.color.bg}; color: ${theme.color.text}; }
`;

// ---------------------------------------------------------------------------
// Pills / badges / dots
// ---------------------------------------------------------------------------

export const Pill = styled.span`
  display: inline-block;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  background: rgba(255, 255, 255, 0.06);
  color: ${theme.color.text};

  &[data-tone='accent']  { background: rgba(0, 246, 210, 0.14); color: ${theme.color.accent}; }
  &[data-tone='success'] { background: rgba(0, 246, 210, 0.14); color: ${theme.color.accent}; }
  &[data-tone='warn']    { background: rgba(244, 206, 74, 0.16); color: ${theme.color.warn}; }
  &[data-tone='danger']  { background: rgba(242, 95, 91, 0.18); color: ${theme.color.danger}; }
  &[data-tone='info']    { background: rgba(11, 204, 247, 0.16); color: ${theme.color.info}; }
  &[data-tone='purple']  { background: rgba(218, 104, 245, 0.16); color: ${theme.color.purple}; }
`;

export const Dot = styled.span`
  display: inline-block;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: ${theme.color.muted};
  &[data-kind='live']  { background: ${theme.color.accent}; box-shadow: 0 0 8px ${theme.color.accentGlow}; }
  &[data-kind='error'] { background: ${theme.color.danger}; }
  &[data-kind='warn']  { background: ${theme.color.warn}; }
  &[data-kind='idle']  { background: ${theme.color.muted}; }
`;

// ---------------------------------------------------------------------------
// Table — matches PairsList / AssetsList table style
// ---------------------------------------------------------------------------

export const DataTable = styled.table`
  width: 100%;
  border-collapse: collapse;
  font-family: ${theme.font.mono};
  font-size: 13px;

  th, td {
    text-align: left;
    padding: 10px 12px;
    border-bottom: 1px solid ${theme.color.divider};
  }
  th {
    color: ${theme.color.muted};
    font-weight: 600;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    user-select: none;
    border-bottom: 1px solid ${theme.color.border};
  }
  th[data-sortable] { cursor: pointer; }
  th[data-sortable]:hover { color: ${theme.color.text}; }
  td.mono   { font-family: ${theme.font.mono}; word-break: break-all; }
  td.muted  { color: ${theme.color.muted}; }
  td.danger { color: ${theme.color.danger}; }
  td.right, th.right { text-align: right; font-variant-numeric: tabular-nums; }
  a { color: ${theme.color.accent}; text-decoration: none; }
  a:hover { text-decoration: underline; }
  tbody tr:hover { background: ${theme.color.rowHover}; }
`;

export const ScrollX = styled.div`
  overflow-x: auto;
`;

// ---------------------------------------------------------------------------
// Notices
// ---------------------------------------------------------------------------

export const ErrorBox = styled.div`
  background: rgba(242, 95, 91, 0.08);
  border: 1px solid rgba(242, 95, 91, 0.3);
  border-radius: ${theme.radius.md};
  padding: 10px 14px;
  color: ${theme.color.danger};
  font-size: 12px;
  margin-bottom: 12px;
`;

export const WarnBox = styled.div`
  background: rgba(244, 206, 74, 0.08);
  border: 1px solid rgba(244, 206, 74, 0.35);
  border-radius: ${theme.radius.md};
  padding: 10px 14px;
  color: ${theme.color.warn};
  font-size: 12px;
  margin-bottom: 12px;
`;

// ---------------------------------------------------------------------------
// Node selector (shared across BANS/Health/Bridge — pick one explorer-node URL)
// ---------------------------------------------------------------------------

const NodeSelectorBox = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  background: ${theme.color.surface};
  border: 1px solid ${theme.color.borderDim};
  border-radius: ${theme.radius.md};
  padding: 4px 8px;
  font-size: 11px;
  & > .lbl { color: ${theme.color.muted}; }
`;

export interface NodeOption { value: string; label: string }

export const NodeSelector: React.FC<{
  options: ReadonlyArray<NodeOption>;
  value: string;
  onChange: (v: string) => void;
  label?: string;
}> = ({ options, value, onChange, label = 'Node' }) => (
  <NodeSelectorBox>
    <span className="lbl">{label}</span>
    <Select value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </Select>
  </NodeSelectorBox>
);

// ---------------------------------------------------------------------------
// Convenience layout helpers
// ---------------------------------------------------------------------------

export const Row = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
  margin-bottom: 10px;
`;

export const Grid2 = styled.div`
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  @media (max-width: 900px) { grid-template-columns: 1fr; }
`;

export const Spacer = styled.div`
  height: 16px;
`;
