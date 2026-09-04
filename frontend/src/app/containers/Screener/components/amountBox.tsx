import { styled } from '@linaria/react';
import AssetIcon from '@app/shared/components/AssetsIcon';

// Amount-input kit shared by the wallet-action surfaces (SwapPanel and the
// Add/Withdraw-liquidity + Create-pool modals): the focusable amount box, its
// header row, the input row, the bare numeric input, the token badge, and the
// label/value info row. One definition keeps the surfaces from drifting.

export const Box = styled.div<{ mb?: number }>`
  background: rgba(0, 0, 0, 0.25);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 10px;
  padding: 12px;
  margin-bottom: ${(p) => p.mb ?? 8}px;
  transition: border-color 0.15s;
  &:focus-within {
    border-color: var(--color-green);
  }
`;

export const BoxHeader = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.5);
`;

export const Row = styled.div`
  display: flex;
  align-items: center;
  & > * + * {
    margin-left: 8px;
  }
  min-width: 0;
`;

export const Input = styled.input`
  flex: 1;
  background: transparent;
  border: none;
  color: white;
  font-family: var(--font-mono);
  font-size: 20px;
  font-weight: 600;
  outline: none;
  min-width: 0;
  &::placeholder {
    color: rgba(255, 255, 255, 0.3);
  }
  &:read-only {
    color: rgba(255, 255, 255, 0.7);
  }
`;

export const TokenBadge = styled.div`
  display: flex;
  align-items: center;
  & > * + * {
    margin-left: 6px;
  }
  background: rgba(255, 255, 255, 0.06);
  padding: 6px 10px;
  border-radius: 20px;
  flex-shrink: 0;
  font-weight: 600;
  font-size: 13px;
  white-space: nowrap;
`;

export const BadgeAssetIcon = styled(AssetIcon)`
  && {
    margin-right: 0;
  }
`;

export const InfoRow = styled.div`
  display: flex;
  justify-content: space-between;
  padding: 4px 0;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.5);
  span:last-child {
    font-family: var(--font-mono);
    color: rgba(255, 255, 255, 0.8);
  }
`;
