import { styled } from '@linaria/react';

// Shared chrome for the DEX wallet-action modals (Add/Withdraw liquidity and
// Create pool): the centered overlay + card, the close button, the four-variant
// action button, the fee-tier table, and the connect/busy/action button-state
// machine. Keeps the two modals visually and behaviourally in lockstep.

export const FEE_TIERS = [
  { kind: 0, label: 'Low · 0.05%' },
  { kind: 1, label: 'Medium · 0.30%' },
  { kind: 2, label: 'High · 1.00%' },
] as const;

export const tierLabel = (kind: number): string => FEE_TIERS.find((t) => t.kind === kind)?.label ?? `kind ${kind}`;

// Fee percent per AMM fee-tier kind (0/1/2 → 0.05% / 0.30% / 1.00%). Canonical
// source so the tier cards, modal subtitles, and detail-page pills agree.
const TIER_FEE_PCT: Record<number, number> = { 0: 0.05, 1: 0.3, 2: 1 };

export const tierFeePct = (kind: number): number => TIER_FEE_PCT[kind] ?? 0;

export const Overlay = styled.div`
  position: fixed;
  /* The inset shorthand isn't supported in QtWebEngine 5.15.2 (Chrome 83), the
     BEAM Wallet host — without the longhand the fixed overlay collapses to
     content size and the modal never positions, so it appears not to open. */
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  z-index: 1000;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
`;

export const Card = styled.div`
  width: 100%;
  max-width: 420px;
  background: #042548;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 14px;
  padding: 18px;
  max-height: calc(100vh - 32px);
  overflow-y: auto;
`;

export const CloseBtn = styled.button`
  background: none;
  border: none;
  color: rgba(255, 255, 255, 0.5);
  font-size: 22px;
  line-height: 1;
  cursor: pointer;
  padding: 0 4px;
  &:hover { color: #fff; }
`;

export type BtnVariant = 'primary' | 'muted' | 'error' | 'success';

export const Btn = styled.button<{ variant: BtnVariant }>`
  width: 100%;
  padding: 12px;
  margin-top: 12px;
  font-size: 14px;
  font-weight: 600;
  border-radius: 10px;
  border: none;
  cursor: pointer;
  font-family: inherit;
  transition: all 0.15s;
  background: ${(p) => (p.variant === 'error'
    ? 'var(--color-red)'
    : p.variant === 'muted'
      ? 'rgba(255, 255, 255, 0.08)'
      : 'var(--color-green)')};
  color: ${(p) => (p.variant === 'error'
    ? 'white'
    : p.variant === 'muted'
      ? 'rgba(255, 255, 255, 0.5)'
      : 'var(--color-dark-blue)')};
  &:hover:not(:disabled) { filter: brightness(1.1); }
  &:disabled { cursor: not-allowed; opacity: 0.8; }
`;

export interface ActionBtnState { text: string; variant: BtnVariant; disabled: boolean; }

/**
 * The connect → busy → action button lifecycle shared by the wallet-action
 * modals. Precedence: terminal feedback, then connect (when headless), then the
 * in-flight/disabled reasons, then the live action.
 */
export function actionButtonState(opts: {
  feedback: { kind: 'success' | 'error'; text: string } | null;
  headless: boolean;
  connecting: boolean;
  executing: boolean;
  busyLabel: string;
  /** A muted/disabled reason blocking the action (e.g. "Enter amount"); null if ready. */
  disabledReason?: string | null;
  actionLabel: string;
}): ActionBtnState {
  const {
    feedback, headless, connecting, executing, busyLabel, disabledReason, actionLabel,
  } = opts;
  if (feedback?.kind === 'success') return { text: feedback.text, variant: 'success', disabled: true };
  if (feedback?.kind === 'error') return { text: feedback.text, variant: 'error', disabled: true };
  if (headless) {
    return connecting
      ? { text: 'Connecting…', variant: 'muted', disabled: true }
      : { text: 'Connect Wallet', variant: 'primary', disabled: false };
  }
  if (executing) return { text: busyLabel, variant: 'muted', disabled: true };
  if (disabledReason) return { text: disabledReason, variant: 'muted', disabled: true };
  return { text: actionLabel, variant: 'primary', disabled: false };
}
