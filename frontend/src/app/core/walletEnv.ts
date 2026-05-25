import connector from '@core/connector';
import { start } from '@app/shared/store/saga';

/**
 * True when the page is being rendered inside a BEAM wallet's WebView
 * (desktop Qt WebEngine, the mobile wallet's bridge, or any UA tagged as
 * such). Mirrors BeamScreener's detection so wallet auto-connect only fires
 * in environments where it can actually succeed.
 */
export function isInsideWallet(): boolean {
  if (typeof window === 'undefined') return false;
  const ua = navigator.userAgent || '';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  return (
    /QtWebEngine/i.test(ua)
    || typeof w.qt !== 'undefined'
    || !!w.BEAM
    || /beam.*wallet/i.test(ua)
  );
}

let connectPromise: Promise<boolean> | null = null;

/**
 * Idempotently connect to a wallet on demand. Returns true when a connection
 * exists. Safe to call repeatedly from UI handlers — concurrent callers share
 * a single in-flight connect.
 */
export async function ensureConnected(): Promise<boolean> {
  if (connector.isConnected()) return true;
  if (connectPromise) return connectPromise;

  connectPromise = (async () => {
    try {
      await connector.connect();
      await start();
      return true;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[wallet] connect failed:', err);
      return false;
    } finally {
      connectPromise = null;
    }
  })();

  return connectPromise;
}
