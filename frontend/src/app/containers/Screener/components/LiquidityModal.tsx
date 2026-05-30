import React, {
  useEffect, useState,
} from 'react';
import { styled } from '@linaria/react';
import AssetIcon from '@app/shared/components/AssetsIcon';
import type { ApiPair } from '../api/types';
import {
  useWallet, invokeAddLiquidity, invokeWithdraw, type LiquidityResult,
} from '../wallet';
import { useAssetColor } from '../assetColors';
import { fromGroths, toGrothsStr } from './format';
import {
  Overlay, Card, CloseBtn, Btn, tierLabel, actionButtonState,
} from './modalChrome';

// The AMM LP token ("AMML") is an 8-decimal groth asset, like BEAM. Token1/2
// use their own metadata decimals (carried on the pair).
const LP_DECIMALS = 8;

function fmtAmt(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '0';
  return n >= 1 ? n.toFixed(4) : n.toFixed(8);
}

// Pull the predict body out of either shape the api wrapper may return.
function predictBody(res: LiquidityResult | null): { tok1?: number; tok2?: number; ctl?: number } | null {
  if (!res) return null;
  return (res.res ?? (res as { tok1?: number; tok2?: number; ctl?: number })) || null;
}

const Head = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 4px;
  h3 {
    margin: 0;
    font-size: 16px;
    font-weight: 700;
    color: #fff;
  }
`;

const Sub = styled.div`
  font-size: 12px;
  color: rgba(255, 255, 255, 0.5);
  margin-bottom: 14px;
`;

const Hint = styled.div`
  font-size: 12px;
  color: #f0c14b;
  background: rgba(240, 193, 75, 0.08);
  border: 1px solid rgba(240, 193, 75, 0.25);
  border-radius: 8px;
  padding: 8px 10px;
  margin-bottom: 12px;
`;

const Box = styled.div`
  background: rgba(0, 0, 0, 0.25);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 10px;
  padding: 12px;
  margin-bottom: 8px;
  transition: border-color 0.15s;
  &:focus-within { border-color: var(--color-green); }
`;

const BoxHeader = styled.div`
  font-size: 11px;
  color: rgba(255, 255, 255, 0.5);
  margin-bottom: 6px;
`;

const Row = styled.div`
  display: flex;
  align-items: center;
  & > * + * { margin-left: 8px; }
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
  &::placeholder { color: rgba(255, 255, 255, 0.3); }
  &:read-only { color: rgba(255, 255, 255, 0.7); }
`;

const TokenBadge = styled.div`
  display: flex;
  align-items: center;
  & > * + * { margin-left: 6px; }
  background: rgba(255, 255, 255, 0.06);
  padding: 6px 10px;
  border-radius: 20px;
  flex-shrink: 0;
  font-weight: 600;
  font-size: 13px;
  white-space: nowrap;
  small {
    font-size: 10px;
    color: rgba(255, 255, 255, 0.4);
    font-weight: 400;
  }
`;

const BadgeAssetIcon = styled(AssetIcon)`
  && { margin-right: 0; }
`;

const InfoRow = styled.div`
  display: flex;
  justify-content: space-between;
  padding: 4px 0;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.5);
  span:last-child {
    font-family: 'SFProDisplay', monospace;
    color: rgba(255, 255, 255, 0.8);
  }
`;

interface Props {
  mode: 'add' | 'withdraw';
  pair: ApiPair;
  kind: 0 | 1 | 2;
  /** Reserves of the selected tier (groths→human). Used only to detect an
   *  empty pool, where Add requires both tokens to set the initial ratio. */
  reserve1Human: number | null;
  reserve2Human: number | null;
  onClose: () => void;
}

// Keep digits and a single decimal point — '1.2.3' must not display one value
// while parseFloat submits another to the shader.
const sanitize = (s: string): string => {
  const cleaned = s.replace(/[^0-9.]/g, '');
  const dot = cleaned.indexOf('.');
  if (dot === -1) return cleaned;
  return cleaned.slice(0, dot + 1) + cleaned.slice(dot + 1).replace(/\./g, '');
};

export const LiquidityModal: React.FC<Props> = ({
  mode, pair, kind, reserve1Human, reserve2Human, onClose,
}) => {
  const { headless, connecting, connect } = useWallet();

  const aid1 = pair.aid1;
  const aid2 = pair.aid2;
  const dec1 = pair.decimals1;
  const dec2 = pair.decimals2;
  const sym1 = pair.symbol1 ?? `aid${aid1}`;
  const sym2 = pair.symbol2 ?? `aid${aid2}`;
  const color1 = useAssetColor(aid1);
  const color2 = useAssetColor(aid2);
  // Empty only when BOTH reserves are 0/absent (the AMM holds both sides or
  // neither). Using && avoids treating a funded tier whose reserves momentarily
  // came back null as "empty" and forcing a both-sides deposit.
  const poolEmpty = !reserve1Human && !reserve2Human;

  const [amount1, setAmount1] = useState('');
  const [amount2, setAmount2] = useState('');
  const [lpAmount, setLpAmount] = useState('');
  // Which side the user last edited — the other side is derived by the shader.
  const [lastEdited, setLastEdited] = useState<'1' | '2'>('1');
  const [ctlEstimate, setCtlEstimate] = useState<number | null>(null);
  const [recv, setRecv] = useState<{ tok1: number; tok2: number } | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  const a1 = parseFloat(amount1);
  const a2 = parseFloat(amount2);
  const lp = parseFloat(lpAmount);

  // Shader args for the current inputs, shared by the predict effect and the
  // execute path so the val1/val2 routing can't drift between them. Add: empty
  // pools take both sides; non-empty pools send only the edited side (0 lets the
  // shader derive the matching amount). Only bPredictOnly differs per caller.
  const buildWithdrawArgs = (bPredictOnly: 0 | 1) => ({
    aid1, aid2, kind, ctl: toGrothsStr(lpAmount, LP_DECIMALS), bPredictOnly,
  });
  const buildAddArgs = (bPredictOnly: 0 | 1) => {
    if (poolEmpty) {
      return {
        aid1, aid2, kind, val1: toGrothsStr(amount1, dec1), val2: toGrothsStr(amount2, dec2), bPredictOnly,
      };
    }
    const editing1 = lastEdited === '1';
    return {
      aid1,
      aid2,
      kind,
      val1: editing1 ? toGrothsStr(amount1, dec1) : '0',
      val2: editing1 ? '0' : toGrothsStr(amount2, dec2),
      bPredictOnly,
    };
  };

  // ---- Debounced predict (only with a reachable wallet) -------------------
  useEffect(() => {
    if (headless) return undefined;
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        if (mode === 'withdraw') {
          if (!Number.isFinite(lp) || lp <= 0) { setRecv(null); return; }
          setQuoting(true);
          const res = await invokeWithdraw(buildWithdrawArgs(1));
          if (cancelled) return;
          const r = predictBody(res);
          setRecv(r ? { tok1: fromGroths(r.tok1 ?? 0, dec1), tok2: fromGroths(r.tok2 ?? 0, dec2) } : null);
          return;
        }

        // Add liquidity.
        if (poolEmpty) {
          // Both sides are user-set; predict only to surface the LP estimate.
          if (!(a1 > 0 && a2 > 0)) { setCtlEstimate(null); return; }
          setQuoting(true);
          const res = await invokeAddLiquidity(buildAddArgs(1));
          if (cancelled) return;
          setCtlEstimate(predictBody(res)?.ctl ?? null);
          return;
        }

        // Non-empty: the shader fills the matching amount + LP estimate.
        const editing1 = lastEdited === '1';
        const editVal = editing1 ? a1 : a2;
        if (!Number.isFinite(editVal) || editVal <= 0) { setCtlEstimate(null); return; }
        setQuoting(true);
        const res = await invokeAddLiquidity(buildAddArgs(1));
        if (cancelled) return;
        const r = predictBody(res);
        if (r) {
          if (editing1) setAmount2(fmtAmt(fromGroths(r.tok2 ?? 0, dec2)));
          else setAmount1(fmtAmt(fromGroths(r.tok1 ?? 0, dec1)));
          setCtlEstimate(r.ctl ?? null);
        }
      } catch {
        if (!cancelled) { setCtlEstimate(null); setRecv(null); }
      } finally {
        if (!cancelled) setQuoting(false);
      }
    }, 400);
    return () => { cancelled = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, headless, poolEmpty, lastEdited, amount1, amount2, lpAmount, aid1, aid2, kind, dec1, dec2]);

  const canSubmit = mode === 'withdraw' ? lp > 0 : a1 > 0 && a2 > 0;

  const execute = async (): Promise<void> => {
    setExecuting(true);
    setFeedback(null);
    try {
      const res = mode === 'withdraw'
        ? await invokeWithdraw(buildWithdrawArgs(0))
        : await invokeAddLiquidity(buildAddArgs(0));
      if (res?.txid) {
        setFeedback({ kind: 'success', text: mode === 'withdraw' ? 'Withdrawal submitted' : 'Liquidity submitted' });
        setAmount1(''); setAmount2(''); setLpAmount('');
        setTimeout(() => onClose(), 1200);
      } else {
        setFeedback({ kind: 'error', text: 'Cancelled' });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setFeedback({ kind: 'error', text: msg.slice(0, 90) });
    } finally {
      setExecuting(false);
    }
  };

  const btn = actionButtonState({
    feedback,
    headless,
    connecting,
    executing,
    busyLabel: 'Submitting…',
    disabledReason: !canSubmit ? 'Enter amount' : quoting ? 'Fetching quote…' : null,
    actionLabel: mode === 'withdraw' ? 'Withdraw' : 'Add liquidity',
  });

  const title = mode === 'withdraw' ? 'Withdraw Liquidity' : 'Add Liquidity';

  return (
    <Overlay onClick={onClose}>
      <Card onClick={(e) => e.stopPropagation()}>
        <Head>
          <h3>{title}</h3>
          <CloseBtn type="button" aria-label="Close" onClick={onClose}>×</CloseBtn>
        </Head>
        <Sub>
          {sym1}
          /
          {sym2}
          {' · '}
          {tierLabel(kind)}
        </Sub>

        {mode === 'add' && poolEmpty && (
          <Hint>This pool is empty — deposit both tokens to set the initial price.</Hint>
        )}

        {mode === 'withdraw' ? (
          <>
            <Box>
              <BoxHeader>LP tokens to burn</BoxHeader>
              <Row>
                <Input
                  type="text"
                  inputMode="decimal"
                  placeholder="0"
                  value={lpAmount}
                  onChange={(e) => setLpAmount(sanitize(e.target.value))}
                />
                <TokenBadge>LP</TokenBadge>
              </Row>
            </Box>
            <InfoRow>
              <span>You receive</span>
              <span>{recv ? `${fmtAmt(recv.tok1)} ${sym1}` : '—'}</span>
            </InfoRow>
            <InfoRow>
              <span>{' '}</span>
              <span>{recv ? `${fmtAmt(recv.tok2)} ${sym2}` : '—'}</span>
            </InfoRow>
          </>
        ) : (
          <>
            <Box>
              <BoxHeader>{sym1}</BoxHeader>
              <Row>
                <Input
                  type="text"
                  inputMode="decimal"
                  placeholder="0"
                  value={amount1}
                  onChange={(e) => { setLastEdited('1'); setAmount1(sanitize(e.target.value)); }}
                />
                <TokenBadge>
                  <BadgeAssetIcon asset_id={aid1} color={color1} />
                  <div>
                    {sym1}
                    {' '}
                    <small>
                      #
                      {aid1}
                    </small>
                  </div>
                </TokenBadge>
              </Row>
            </Box>
            <Box>
              <BoxHeader>{sym2}</BoxHeader>
              <Row>
                <Input
                  type="text"
                  inputMode="decimal"
                  placeholder="0"
                  value={amount2}
                  onChange={(e) => { setLastEdited('2'); setAmount2(sanitize(e.target.value)); }}
                />
                <TokenBadge>
                  <BadgeAssetIcon asset_id={aid2} color={color2} />
                  <div>
                    {sym2}
                    {' '}
                    <small>
                      #
                      {aid2}
                    </small>
                  </div>
                </TokenBadge>
              </Row>
            </Box>
            <InfoRow>
              <span>You receive (est.)</span>
              <span>{ctlEstimate !== null ? `${fmtAmt(fromGroths(ctlEstimate, LP_DECIMALS))} LP` : '—'}</span>
            </InfoRow>
          </>
        )}

        <Btn
          type="button"
          variant={btn.variant}
          disabled={btn.disabled}
          onClick={headless ? () => { void connect(); } : () => { void execute(); }}
        >
          {btn.text}
        </Btn>
      </Card>
    </Overlay>
  );
};

export default LiquidityModal;
