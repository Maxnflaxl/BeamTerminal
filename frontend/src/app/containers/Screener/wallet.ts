// Lightweight wallet-state hook + invoke wrapper used by the SwapPanel.
//
// The connector singleton (`@core/connector`) does NOT auto-connect on page
// load; that only happens when the page is opened inside a BEAM wallet (see
// `shared/store/saga.ts`). In a plain browser the wallet stays disconnected
// until the user explicitly clicks "Connect" via `connectWallet()` below.

import { useCallback, useEffect, useState } from 'react';
import connector from '@core/connector';
import { ensureConnected, isInsideWallet } from '@core/walletEnv';
import { TradePoolApi } from '@core/api';

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
