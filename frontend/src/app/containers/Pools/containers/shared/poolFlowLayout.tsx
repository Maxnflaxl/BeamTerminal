import { styled } from '@linaria/react';

/** Absolute-position flip control for legacy standalone trade layout */
export const ExchangeWrapper = styled.div`
  position: absolute;
  top: 71px;
  left: 435px;
  @media (max-width: 913px) {
    top: 135px;
    left: 44%;
  }
`;

export const SectionWrapper = styled.div`
  margin: 10px 0 40px 0;
  display: flex;
  flex-direction: column;
  gap: var(--pool-section-column-gap);
  width: 100%;
  height: auto;
  align-items: center;
`;

export const SummaryWrapper = styled.div`
  display: flex;
  flex-direction: column;
  margin-top: 48px;
`;

export const SummaryTitle = styled.div`
  font-style: normal;
  font-weight: 400;
  font-size: 14px;
  line-height: 14px;
  color: rgba(255, 255, 255, 0.5);
  flex: 0 0 62px;
  min-width: 62px;
  max-width: 62px;
  margin-right: var(--pool-summary-title-margin-right);
`;

export const TotalTitle = styled(SummaryTitle)`
  font-weight: 700;
  line-height: 17px;
  color: var(--color-white);
`;

/**
 * Embedded trade summary: `<table>` + `table-layout: fixed` keeps label / icon / value
 * columns aligned even when ancestors use flex or `display: contents` (e.g. EmbeddedRightStack).
 */
export const TradeSummaryTable = styled.table`
  align-self: stretch;
  width: 100%;
  min-width: 0;
  table-layout: fixed;
  border-collapse: collapse;
  border-spacing: 0;

  tbody tr:not(:last-child) td {
    padding-bottom: var(--pool-trade-summary-row-pad);
  }
`;

export const TradeSummaryTitleInGrid = styled(SummaryTitle)`
  margin-right: 0;
  flex: unset;
  min-width: 0;
  width: 62px;
  min-width: 62px;
  max-width: 62px;
`;

export const TradeSummaryTdLabel = styled.td`
  width: 92px;
  max-width: 92px;
  padding: 0 var(--pool-trade-summary-td-label-pad-right) 0 0;
  vertical-align: top;
  box-sizing: border-box;
`;

export const TradeSummaryTdIcon = styled.td`
  width: 28px;
  max-width: 28px;
  padding: 0;
  vertical-align: top;
  box-sizing: border-box;
`;

/** Mirrors AssetLabel value row: amount + title + id stay on one line when they fit. */
export const TradeSummaryValueInner = styled.div`
  display: flex;
  flex-direction: row;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-start;
  gap: 0;
  min-width: 0;
  width: 100%;
  overflow-wrap: anywhere;
`;

/** Token title + (id:) stay adjacent; title ellipsizes when the cell is narrow */
export const TradeSummaryNameId = styled.span`
  display: inline-flex;
  flex-wrap: nowrap;
  align-items: center;
  min-width: 0;
  max-width: 100%;

  & > :first-child {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  & > :last-child {
    margin-left: 6px;
    line-height: inherit;
  }
`;

export const TradeSummaryIconInner = styled.div`
  display: flex;
  align-items: flex-start;
  justify-content: flex-start;
  width: 28px;
  min-height: 18px;

  /* AssetIcon adds margin-right for inline labels; values live in the next column. */
  & > div {
    margin-right: 0;
  }
`;

export const TradeSummaryTdValue = styled.td`
  width: auto;
  padding: 0;
  vertical-align: top;
  box-sizing: border-box;
`;

export const SummaryContainer = styled.div`
  display: flex;
  width: 100%;
  margin-bottom: var(--pool-summary-container-margin-bottom);
  align-items: center;
`;

export const SummaryAsset = styled.div`
  display: flex;
`;

export const AssetAmount = styled.div`
  justify-content: flex-start;
  display: flex;
`;

export const Line = styled.div`
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 2px;
  width: 100%;
  max-width: 412px;
  margin: var(--pool-line-margin-y) 0;
`;

export const ButtonBlock = styled.div`
  display: flex;
  justify-content: center;
  width: 100%;
`;

export const ButtonWrapper = styled.div`
  display: flex;
  max-width: 363px;
  width: 100%;
  justify-content: space-between;
`;

export const SelectWrapper = styled.div`
  width: 100%;
  max-width: 914px;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  grid-gap: var(--pool-select-wrapper-gap);
  margin: var(--pool-select-wrapper-margin-y) 0;
  @media (max-width: 913px) {
    grid-template-columns: 1fr;
  }
`;

export const EmbeddedLayout = styled.div`
  width: 100%;
  max-width: 1230px;
  min-width: 0;
  overflow-x: hidden;
  display: grid;
  grid-template-columns: minmax(0, 620px) minmax(0, 1fr);
  grid-gap: var(--pool-grid-gap);
  align-items: flex-start;
  margin-top: var(--pool-embedded-layout-margin-top);
  @media (max-width: 1080px) {
    grid-template-columns: 1fr;
  }
`;

/** Left column (swap form); on narrow screens first: trade, then summary, then pool. */
export const EmbeddedSwapColumn = styled.div`
  min-width: 0;
  @media (max-width: 1080px) {
    order: 1;
  }
`;

export const SwapCard = styled.div`
  width: 100%;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 18px;
  background: rgba(255, 255, 255, 0.02);
  padding: var(--pool-card-padding);
`;

export const SwapBlock = styled.div`
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 14px;
  padding: var(--pool-block-padding);
  margin-bottom: var(--pool-block-margin-bottom);
`;

export const InputRow = styled.div`
  display: flex;
  width: 100%;
  gap: var(--pool-input-row-gap);
  align-items: center;
  min-width: 0;

  & > *:first-child {
    flex: 1;
    min-width: 0;
  }
`;

export const InlineSelect = styled.div`
  width: 220px;
  max-width: 52%;
  min-width: 200px;
  min-height: 41px;
  flex-shrink: 0;

  @media (max-width: 480px) {
    width: 148px;
    max-width: 38%;
    min-width: 108px;
  }
`;

export const SearchHint = styled.div`
  font-size: 11px;
  color: rgba(255, 255, 255, 0.55);
  margin-top: var(--pool-hint-margin-top);
`;

export const HintRow = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: var(--pool-hint-margin-top);
  font-size: 11px;
  color: rgba(255, 255, 255, 0.55);
`;

export const ErrorHint = styled.span`
  color: #ff625c;
  font-size: 11px;
`;

export const BlockLabel = styled.div`
  font-size: 12px;
  text-transform: uppercase;
  color: rgba(255, 255, 255, 0.6);
  margin-bottom: var(--pool-block-label-margin-bottom);
`;

export const EmbeddedExchangeWrap = styled.div`
  display: flex;
  justify-content: center;
  margin: var(--pool-embedded-exchange-margin-block-start) 0
    var(--pool-embedded-exchange-margin-block-end);

  svg {
    transform: rotate(90deg);
  }
`;

export const EmbeddedTradeButtonWrap = styled.div`
  width: 100%;
  margin-top: var(--pool-embedded-trade-button-margin-top);
`;

/** Right column stack: pool info card, then trade summary below (spacing via margin, not gap). */
export const EmbeddedRightStack = styled.div`
  display: flex;
  flex-direction: column;
  width: 100%;
  min-width: 0;
  @media (max-width: 1080px) {
    display: contents;
  }
`;

/** Separates trade summary from the pool card; margin works more reliably than flex gap here. */
export const EmbeddedTradeSummaryBelowPool = styled.div`
  margin-top: var(--pool-embedded-summary-margin-top);
  width: 100%;
  @media (max-width: 1080px) {
    order: 2;
  }
`;

export const RightPanel = styled.div`
  width: 100%;
  min-height: 0;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 18px;
  background: rgba(255, 255, 255, 0.02);
  padding: var(--pool-right-panel-padding);
  display: flex;
  flex-direction: column;
  justify-content: flex-start;
  @media (max-width: 1080px) {
    order: 3;
  }
`;

export const EmptyPoolState = styled.div`
  color: rgba(255, 255, 255, 0.6);
  font-size: 14px;
  padding: var(--pool-empty-pool-padding-y) 0;
  text-align: center;
`;

export const EmbeddedActionRow = styled.div`
  width: 100%;
  display: flex;
  flex-wrap: wrap;
  gap: var(--pool-embedded-action-row-gap);
  margin-top: var(--pool-embedded-action-margin-top);
`;

export const RateText = styled.div`
  flex: 1 1 100%;
  align-self: stretch;
  width: 100%;
  min-width: 0;
  color: var(--color-white);
  font-size: 14px;
  line-height: 14px;
`;

export const SummaryPanel = styled.div`
  width: 100%;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 18px;
  padding: var(--pool-summary-panel-padding);
  margin-top: 0;
  background: rgba(255, 255, 255, 0.02);
`;

export const SummaryHeader = styled.div`
  font-weight: 700;
  font-size: 14px;
  line-height: 17px;
  letter-spacing: 3px;
  text-transform: uppercase;
  color: var(--color-white);
  margin-bottom: var(--pool-summary-header-margin-bottom);
`;
