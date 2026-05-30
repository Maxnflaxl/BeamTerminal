// Lightweight wallet-state hook + invoke wrapper used by the SwapPanel.
//
// The connector singleton (`@core/connector`) does NOT auto-connect on page
// load; that only happens when the page is opened inside a BEAM wallet (see
// `shared/store/saga.ts`). In a plain browser the wallet stays disconnected
// until the user explicitly clicks "Connect" via `connectWallet()` below.

import { useCallback, useEffect, useState } from 'react';
import connector from '@core/connector';
import { ensureConnected, isInsideWallet } from '@core/walletEnv';
import {
  AddLiquidityApi, CreatePoolApi, LoadPoolsList, TradePoolApi, WithdrawApi,
} from '@core/api';
import { pairKey } from './components/format';

interface WalletState {
  /** True when no wallet API is currently reachable. */
  headless: boolean;
  /** True when running inside the BEAM wallet's webview. */
  inWallet: boolean;
  /** True while a connect attempt is in flight. */
  connecting: boolean;
}

let cached: WalletState = {
  headless: true,
  inWallet: isInsideWallet(),
  connecting: false,
};

function snapshot(connecting: boolean): WalletState {
  return {
    headless: !connector.isConnected(),
    inWallet: isInsideWallet(),
    connecting,
  };
}

export function useWallet(): WalletState & { connect: () => Promise<boolean> } {
  const [state, setState] = useState<WalletState>(() => {
    cached = snapshot(false);
    return cached;
  });

  useEffect(() => {
    const tick = (): void => {
      const next = snapshot(state.connecting);
      if (next.headless !== cached.headless || next.inWallet !== cached.inWallet) {
        cached = next;
        setState(next);
      }
    };
    tick();
    const t = setInterval(tick, 3000);
    return () => clearInterval(t);
  }, [state.connecting]);

  const connect = useCallback(async (): Promise<boolean> => {
    setState((s) => ({ ...s, connecting: true }));
    const ok = await ensureConnected();
    setState(snapshot(false));
    return ok;
  }, []);

  return { ...state, connect };
}

// Shape of a row from the AMM `pools_view` shader. The contract stamps
// `creator: 1` only on pools the calling wallet created (contract-side
// IsCreator), which is what the "MY" filter keys off.
interface ShaderPool {
  aid1: number;
  aid2: number;
  kind: number;
  creator?: number;
}

/**
 * Pair keys ("<aid1>_<aid2>") of pools the connected wallet created, for the
 * DEX page's "MY" filter. Only fetches while `enabled` (the MY filter is
 * active) and a wallet is connected — so it never polls the shader on the
 * public web, nor in the background when the user isn't looking at MY.
 * Refreshes on the same 30s cadence as the pairs list while active.
 */
export function useMyCreatedPairs(enabled: boolean): { createdKeys: Set<string>; loading: boolean } {
  const { headless } = useWallet();
  const [createdKeys, setCreatedKeys] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setCreatedKeys(new Set());
      return undefined;
    }
    // Fetch as soon as MY is selected. When not yet connected the shader call
    // fails gracefully (empty set); `headless` is a dep, so the effect re-runs
    // and re-fetches the moment a connection is established — no 3s poll lag.
    let cancelled = false;
    const fetchPools = async (): Promise<void> => {
      setLoading(true);
      try {
        const pools = (await LoadPoolsList<ShaderPool[]>()) || [];
        if (cancelled) return;
        const keys = new Set<string>();
        for (const p of pools) {
          if (p && p.creator) keys.add(pairKey(p.aid1, p.aid2));
        }
        setCreatedKeys(keys);
      } catch {
        if (!cancelled) setCreatedKeys(new Set());
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void fetchPools();
    const t = setInterval(() => { void fetchPools(); }, 30_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [headless, enabled]);

  return { createdKeys, loading };
}

export interface TradeArgs {
  aid1: number; // canonical lower-AID side of the pool
  aid2: number;
  kind: 0 | 1 | 2;
  val1_buy: number; // groths of aid1 the user wants to receive (0 if direction is reversed)
  val2_pay: number; // groths of aid2 the user is willing to pay
  bPredictOnly: 0 | 1;
}

export interface TradeResult {
  // Predict-only fields (echoed from the shader):
  buy?: number;
  pay?: number;
  fee?: number;
  // Execute fields:
  txid?: string;
  // Anything else the shader returns:
  [k: string]: unknown;
}

export async function invokeTrade(args: TradeArgs): Promise<TradeResult> {
  // Ensure a wallet is connected before invoking. No-op when already connected.
  const ok = await ensureConnected();
  if (!ok) throw new Error('Wallet not connected');
  return TradePoolApi<TradeResult>(args);
}

export interface AddLiquidityArgs {
  aid1: number; // canonical lower-AID side of the pool
  aid2: number;
  kind: 0 | 1 | 2;
  // Groth amounts as exact strings (format.toGrothsStr) so large deposits keep
  // full precision; '0' lets the contract derive that side.
  val1: number | string;
  val2: number | string;
  bPredictOnly: 0 | 1;
}

export interface WithdrawArgs {
  aid1: number;
  aid2: number;
  kind: 0 | 1 | 2;
  ctl: number | string; // groths of the pool's LP token to burn (exact string)
  bPredictOnly: 0 | 1;
}

// Shared shape for add/withdraw. Predict (bPredictOnly=1) echoes the shader's
// `res` ({ tok1, tok2, ctl } in groths); execute (bPredictOnly=0) returns txid.
export interface LiquidityResult {
  res?: { tok1?: number; tok2?: number; ctl?: number };
  txid?: string;
  [k: string]: unknown;
}

export async function invokeAddLiquidity(args: AddLiquidityArgs): Promise<LiquidityResult> {
  const ok = await ensureConnected();
  if (!ok) throw new Error('Wallet not connected');
  return AddLiquidityApi<LiquidityResult>(args);
}

export async function invokeWithdraw(args: WithdrawArgs): Promise<LiquidityResult> {
  const ok = await ensureConnected();
  if (!ok) throw new Error('Wallet not connected');
  return WithdrawApi<LiquidityResult>(args);
}

export interface CreatePoolArgs {
  aid1: number; // must be < aid2 (the contract pool-key invariant)
  aid2: number;
  kind: 0 | 1 | 2;
}

// Registers an empty pool for (aid1, aid2, kind). It must then be seeded via
// Add Liquidity. CreatePoolApi takes a single-element array.
export async function invokeCreatePool(args: CreatePoolArgs): Promise<{ txid?: string }> {
  const ok = await ensureConnected();
  if (!ok) throw new Error('Wallet not connected');
  return CreatePoolApi<{ txid?: string }>([args]);
}
