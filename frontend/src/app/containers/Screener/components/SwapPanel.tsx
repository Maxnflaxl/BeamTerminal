import React, {
  useState, useEffect, useMemo, useCallback,
} from 'react';
import { styled } from '@linaria/react';
import AssetIcon from '@app/shared/components/AssetsIcon';
import type { ApiPair } from '../api/types';
import { fmt$, fmtPrice } from './format';
import { useWallet, invokeTrade } from '../wallet';

const Panel = styled.div`
  padding: 14px 16px;
  h4 {
    font-size: 11px;
    color: rgba(255, 255, 255, 0.4);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin: 0 0 12px;
  }
`;

const Box = styled.div`
  background: rgba(0, 0, 0, 0.25);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 10px;
  padding: 12px;
  margin-bottom: 4px;
  transition: border-color 0.15s;
  &:focus-within {
    border-color: var(--color-green);
  }
`;

const BoxHeader = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.5);
`;

const UsdHint = styled.span`
  font-family: 'SFProDisplay', monospace;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.4);
`;

const Row = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
`;

const Input = styled.input`
  flex: 1;
  background: transparent;
  border: none;
  color: white;
  font-family: 'SFProDisplay', monospace;
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

const TokenBadge = styled.div`
  display: flex;
  align-items: center;
  gap: 6px;
  background: rgba(255, 255, 255, 0.06);
  padding: 6px 10px;
  border-radius: 20px;
  flex-shrink: 0;
  font-weight: 600;
  font-size: 13px;
  small {
    font-size: 10px;
    color: rgba(255, 255, 255, 0.4);
    font-weight: 400;
  }
`;

const BadgeAssetIcon = styled(AssetIcon)`
  && {
    margin-right: 0;
  }
`;

const FlipWrap = styled.div`
  display: flex;
  justify-content: center;
  margin: -2px 0;
  position: relative;
  z-index: 1;
`;

const FlipBtn = styled.button`
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.08);
  border: 3px solid var(--color-dark-blue);
  color: rgba(255, 255, 255, 0.6);
  font-size: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.15s;
  &:hover {
    background: var(--color-green);
    color: var(--color-dark-blue);
  }
`;

const InfoRow = styled.div`
  display: flex;
  justify-content: space-between;
  padding: 3px 0;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.5);
  span:last-child {
    font-family: 'SFProDisplay', monospace;
    color: rgba(255, 255, 255, 0.8);
  }
`;

const Btn = styled.button<{ variant: 'primary' | 'muted' | 'error' | 'success' }>`
  width: 100%;
  padding: 12px;
  margin-top: 10px;
  font-size: 14px;
  font-weight: 600;
  border-radius: 10px;
  border: none;
  cursor: pointer;
  font-family: inherit;
  transition: all 0.15s;

  background: ${(p) => (p.variant === 'primary'
    ? 'var(--color-green)'
    : p.variant === 'success'
      ? 'var(--color-green)'
      : p.variant === 'error'
        ? 'var(--color-red)'
        : 'rgba(255, 255, 255, 0.08)')};
  color: ${(p) => (p.variant === 'primary'
    ? 'var(--color-dark-blue)'
    : p.variant === 'success'
      ? 'var(--color-dark-blue)'
      : p.variant === 'error'
        ? 'white'
        : 'rgba(255, 255, 255, 0.5)')};

  &:hover:not(:disabled) {
    filter: brightness(1.1);
  }
  &:disabled {
    cursor: not-allowed;
    opacity: 0.8;
  }
`;

interface Props {
  pair: ApiPair;
}

interface Side {
  aid: number;
  symbol: string;
  decimals: number;
}

const GROTHS = (whole: number, decimals: number): number => Math.floor(whole * 10 ** decimals);
const fromGroths = (groths: number, decimals: number): number => groths / 10 ** decimals;

/**
 * Estimate `dy` from a constant-product pool with a fee:
 *   dy = r2 * dx / (r1 + dx) * (1 - fee)
 * All inputs in whole units.
 */
function estimateOut(r1: number, r2: number, dx: number, fee: number): number {
  if (r1 <= 0 || r2 <= 0 || dx <= 0) return 0;
  return (r2 * dx) / (r1 + dx) * (1 - fee);
}

const TIER_FEE: Record<number, number> = { 0: 0.0005, 1: 0.003, 2: 0.01 };

export const SwapPanel: React.FC<Props> = ({ pair }) => {
  const { headless, connecting, connect } = useWallet();

  // direction:
  //   'buy_aid2'  -> user pays aid1, receives aid2 (default)
  //   'buy_aid1'  -> user pays aid2, receives aid1
  const [direction, setDirection] = useState<'buy_aid2' | 'buy_aid1'>('buy_aid2');
  const [amountIn, setAmountIn] = useState<string>('');
  const [estimatedOut, setEstimatedOut] = useState<number | null>(null);
  const [confirmedQuote, setConfirmedQuote] = useState<{ buy: number; pay: number; fee_dao?: number; fee_pool?: number } | null>(null);
  const [flipRate, setFlipRate] = useState(false);
  const [quoting, setQuoting] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  const pay: Side = direction === 'buy_aid2'
    ? { aid: pair.aid1, symbol: pair.symbol1 ?? `aid${pair.aid1}`, decimals: pair.decimals1 }
    : { aid: pair.aid2, symbol: pair.symbol2 ?? `aid${pair.aid2}`, decimals: pair.decimals2 };
  const receive: Side = direction === 'buy_aid2'
    ? { aid: pair.aid2, symbol: pair.symbol2 ?? `aid${pair.aid2}`, decimals: pair.decimals2 }
    : { aid: pair.aid1, symbol: pair.symbol1 ?? `aid${pair.aid1}`, decimals: pair.decimals1 };

  const fee = TIER_FEE[pair.kind] ?? 0;
  const reserves = useMemo(() => ({
    r1: pair.reserve1_human ?? 0,
    r2: pair.reserve2_human ?? 0,
  }), [pair.reserve1_human, pair.reserve2_human]);

  // Local estimate updates synchronously as the user types.
  useEffect(() => {
    const v = parseFloat(amountIn);
    if (!Number.isFinite(v) || v <= 0) {
      setEstimatedOut(null);
      setConfirmedQuote(null);
      return;
    }
    const out = direction === 'buy_aid2'
      ? estimateOut(reserves.r1, reserves.r2, v, fee)
      : estimateOut(reserves.r2, reserves.r1, v, fee);
    setEstimatedOut(out > 0 ? out : null);
  }, [amountIn, direction, reserves, fee]);

  // Debounced authoritative quote once a wallet is reachable.
  useEffect(() => {
    if (headless) return;
    const v = parseFloat(amountIn);
    if (!Number.isFinite(v) || v <= 0) {
      setConfirmedQuote(null);
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      setQuoting(true);
      try {
        // Shader convention (from BeamScreener line 1547):
        //   val2_pay = groths the user is paying in callAid2
        //   callAid2 = the "pay" side  → callAid1 = the "receive" side
        const callAid1 = receive.aid;
        const callAid2 = pay.aid;
        const val2_pay = GROTHS(v, pay.decimals);
        const res = await invokeTrade({
          aid1: callAid1,
          aid2: callAid2,
          kind: pair.kind,
          val1_buy: 0,
          val2_pay,
          bPredictOnly: 1,
        });
        if (cancelled) return;
        // dex-app's TradePoolApi returns the shader's parsed result.
        // The AMM predict returns { res: { buy, pay, fee } } or similar.
        const r = (res as { res?: { buy?: number; pay?: number; fee_dao?: number; fee_pool?: number } })?.res
          ?? (res as { buy?: number; pay?: number; fee_dao?: number; fee_pool?: number });
        const buy = r?.buy ?? 0;
        const payActual = r?.pay ?? val2_pay;
        if (buy > 0) {
          setConfirmedQuote({
            buy,
            pay: payActual,
            ...(typeof r?.fee_dao === 'number' ? { fee_dao: r.fee_dao } : {}),
            ...(typeof r?.fee_pool === 'number' ? { fee_pool: r.fee_pool } : {}),
          });
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[swap] quote failed', err);
        setConfirmedQuote(null);
      } finally {
        if (!cancelled) setQuoting(false);
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [amountIn, headless, direction, pair.kind, pay.aid, pay.decimals, receive.aid]);

  const flip = useCallback(() => {
    setDirection((d) => (d === 'buy_aid2' ? 'buy_aid1' : 'buy_aid2'));
    setAmountIn(estimatedOut !== null ? estimatedOut.toFixed(6) : '');
    setConfirmedQuote(null);
    setFeedback(null);
  }, [estimatedOut]);

  const onSwap = useCallback(async () => {
    const v = parseFloat(amountIn);
    if (!Number.isFinite(v) || v <= 0) return;

    setExecuting(true);
    setFeedback(null);
    try {
      const callAid1 = receive.aid;
      const callAid2 = pay.aid;
      const val2_pay = confirmedQuote ? confirmedQuote.pay : GROTHS(v, pay.decimals);
      const val1_buy = confirmedQuote ? confirmedQuote.buy : 0;
      const res = await invokeTrade({
        aid1: callAid1,
        aid2: callAid2,
        kind: pair.kind,
        val1_buy,
        val2_pay,
        bPredictOnly: 0,
      });
      if (res?.txid) {
        setFeedback({ kind: 'success', text: 'Swap submitted' });
        setAmountIn('');
        setConfirmedQuote(null);
      } else {
        setFeedback({ kind: 'error', text: 'Swap cancelled' });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setFeedback({ kind: 'error', text: msg.slice(0, 80) });
    } finally {
      setExecuting(false);
      // Auto-clear after a few seconds.
      setTimeout(() => setFeedback(null), 4000);
    }
  }, [amountIn, confirmedQuote, pair.kind, pay.aid, pay.decimals, receive.aid]);

  // Headless → ask the wallet to connect on demand. The button only requests a
  // connection when the user actually wants to trade; browsing needs no wallet.
  const onConnect = useCallback(async () => {
    await connect();
  }, [connect]);

  const displayedOut = confirmedQuote
    ? fromGroths(confirmedQuote.buy, receive.decimals)
    : estimatedOut;
  const ratePerUnit = displayedOut !== null && parseFloat(amountIn) > 0
    ? displayedOut / parseFloat(amountIn)
    : null;

  // Button state machine.
  const v = parseFloat(amountIn);
  const hasAmount = Number.isFinite(v) && v > 0;
  const btn = (() => {
    if (feedback?.kind === 'success') {
      return { text: feedback.text, variant: 'success' as const, disabled: true };
    }
    if (feedback?.kind === 'error') {
      return { text: feedback.text, variant: 'error' as const, disabled: true };
    }
    if (headless) {
      if (connecting) return { text: 'Connecting…', variant: 'muted' as const, disabled: true };
      return { text: 'Connect Wallet to Swap', variant: 'primary' as const, disabled: false };
    }
    if (executing) return { text: 'Swapping…', variant: 'muted' as const, disabled: true };
    if (!hasAmount) return { text: 'Enter amount', variant: 'muted' as const, disabled: true };
    if (quoting && !confirmedQuote) return { text: 'Fetching quote…', variant: 'muted' as const, disabled: true };
    return { text: 'Swap', variant: 'primary' as const, disabled: false };
  })();

  return (
    <Panel>
      <h4>Trade</h4>

      <Box>
        <BoxHeader>
          <span>You Pay</span>
          <UsdHint>
            {pay.aid === 0 && pair.aid1 === 0 && pair.price_usd !== null && hasAmount
              ? fmt$(v * (pair.price_usd / (pair.price_native ?? 1)))
              : ''}
          </UsdHint>
        </BoxHeader>
        <Row>
          <Input
            type="text"
            inputMode="decimal"
            placeholder="0"
            value={amountIn}
            onChange={(e) => setAmountIn(e.target.value.replace(/[^0-9.]/g, ''))}
          />
          <TokenBadge>
            <BadgeAssetIcon asset_id={pay.aid} />
            <div>
              {pay.symbol}
              {' '}
              <small>
                #
                {pay.aid}
              </small>
            </div>
          </TokenBadge>
        </Row>
      </Box>

      <FlipWrap>
        <FlipBtn type="button" onClick={flip} title="Flip direction" aria-label="Flip swap direction">
          ↕
        </FlipBtn>
      </FlipWrap>

      <Box>
        <BoxHeader>
          <span>You Receive</span>
          <UsdHint />
        </BoxHeader>
        <Row>
          <Input
            type="text"
            readOnly
            placeholder="0"
            value={displayedOut !== null
              ? (confirmedQuote ? '' : '~') + (displayedOut >= 1 ? displayedOut.toFixed(4) : displayedOut.toFixed(8))
              : ''}
          />
          <TokenBadge>
            <BadgeAssetIcon asset_id={receive.aid} />
            <div>
              {receive.symbol}
              {' '}
              <small>
                #
                {receive.aid}
              </small>
            </div>
          </TokenBadge>
        </Row>
      </Box>

      {ratePerUnit !== null && (
        <div style={{ padding: '8px 0' }}>
          <InfoRow>
            <span>
              Rate
              {' '}
              <button
                type="button"
                onClick={() => setFlipRate((f) => !f)}
                style={{
                  background: 'rgba(255,255,255,0.08)',
                  color: 'rgba(255,255,255,0.6)',
                  border: 'none',
                  width: 18,
                  height: 18,
                  borderRadius: '50%',
                  fontSize: 10,
                  cursor: 'pointer',
                  marginLeft: 4,
                }}
                title="Flip"
              >
                ⇄
              </button>
            </span>
            <span>
              {flipRate
                ? `1 ${receive.symbol} ${confirmedQuote ? '=' : '≈'} ${fmtPrice(ratePerUnit > 0 ? 1 / ratePerUnit : 0)} ${pay.symbol}`
                : `1 ${pay.symbol} ${confirmedQuote ? '=' : '≈'} ${fmtPrice(ratePerUnit)} ${receive.symbol}`}
            </span>
          </InfoRow>
          <InfoRow>
            <span>Fee tier</span>
            <span>
              {(fee * 100).toFixed(2)}
              %
            </span>
          </InfoRow>
          {confirmedQuote?.fee_dao !== undefined && confirmedQuote.fee_dao > 0 && (
            <InfoRow>
              <span>DAO fee</span>
              <span>
                {fromGroths(confirmedQuote.fee_dao, pay.decimals).toFixed(Math.min(pay.decimals, 6))}
                {' '}
                {pay.symbol}
              </span>
            </InfoRow>
          )}
          {confirmedQuote?.fee_pool !== undefined && confirmedQuote.fee_pool > 0 && (
            <InfoRow>
              <span>LP fee</span>
              <span>
                {fromGroths(confirmedQuote.fee_pool, pay.decimals).toFixed(Math.min(pay.decimals, 6))}
                {' '}
                {pay.symbol}
              </span>
            </InfoRow>
          )}
        </div>
      )}

      <Btn
        type="button"
        variant={btn.variant}
        disabled={btn.disabled}
        onClick={headless ? onConnect : onSwap}
      >
        {btn.text}
      </Btn>
    </Panel>
  );
};
