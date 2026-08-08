import { request } from 'undici';
import { config } from '../config.js';
import { logger } from '../logger.js';

// ---------------------------------------------------------------------------
// Etherscan V2 client, server-side.
//
// Needed for exactly one thing the chain can't tell us cheaply: whether a
// Beam->Ethereum message was settled. `processRemoteMessage` emits **no event**
// (see utils/EthPipe.json in BeamMW/beam-bridge-ethrelay), so there is no log to
// scan — the only way to find the settling transaction is to walk the Pipe
// contract's transaction list and match the method id.
//
// Free-tier limits, verified against the docs (2026-08):
//   - 3 calls/sec, shared across every chain on the key. Not 5; the
//     bridge-monitor README is stale on this.
//   - 100 000 calls/day. We use a few thousand.
//   - Max 1 000 records per request since 2026-07-01 (was 10 000).
// ---------------------------------------------------------------------------

const BASE = 'https://api.etherscan.io/v2/api';

// Etherscan truncates a page to this many records regardless of `offset`...
const PAGE_SIZE = 1000;
// ...and rejects any request where page * offset exceeds this window. Once the
// last page of a window is consumed the scan must restart from the highest
// block seen rather than asking for a page the API will refuse. Without the
// restart, everything past the window is invisible and its messages look
// pending forever.
const MAX_WINDOW = 10_000;

// 3 req/s ceiling with headroom. Every call funnels through one promise chain
// so concurrent bridges can't burst past it.
const MIN_INTERVAL_MS = 350;
let chain: Promise<unknown> = Promise.resolve();
let lastStart = 0;

export class EtherscanDisabledError extends Error {
  constructor() {
    super('ETHERSCAN_API_KEY is not set; Beam->Ethereum settlement lookups are disabled');
    this.name = 'EtherscanDisabledError';
  }
}

export function etherscanEnabled(): boolean {
  return Boolean(config.ETHERSCAN_API_KEY);
}

interface EtherscanResponse<T> { status?: string; message?: string; result?: T | string }

async function call<T>(params: Record<string, string>): Promise<T> {
  if (!config.ETHERSCAN_API_KEY) throw new EtherscanDisabledError();

  const exec = async (): Promise<T> => {
    const wait = Math.max(0, MIN_INTERVAL_MS - (Date.now() - lastStart));
    if (wait > 0) await new Promise((r) => { setTimeout(r, wait); });
    lastStart = Date.now();

    const url = new URL(BASE);
    for (const [k, v] of Object.entries(params)) url.searchParams.append(k, v);
    url.searchParams.append('apikey', config.ETHERSCAN_API_KEY as string);

    const { statusCode, body } = await request(url.toString(), { method: 'GET' });
    const text = await body.text();
    if (statusCode >= 400) throw new Error(`etherscan HTTP ${statusCode}: ${text.slice(0, 200)}`);

    const json = JSON.parse(text) as EtherscanResponse<T>;
    if (json.status === '1') return json.result as T;

    const msg = typeof json.result === 'string' ? json.result : json.message ?? 'unknown error';
    // "No transactions found" is a normal end-of-pagination signal, not a fault.
    if (/no transactions found/i.test(msg)) return [] as unknown as T;
    if (/rate limit/i.test(msg)) throw new Error(`etherscan rate limited: ${msg}`);
    if (/invalid api key/i.test(msg)) throw new Error(`etherscan rejected the API key: ${msg}`);
    throw new Error(`etherscan: ${msg}`);
  };

  const p = chain.then(exec, exec);
  chain = p.catch(() => undefined);
  return p;
}

export interface EtherscanTx {
  hash: string;
  blockNumber: string;
  timeStamp: string;
  input: string;
  methodId?: string;
  isError?: string;
  txreceipt_status?: string;
}

/**
 * Every transaction sent to `address` from `fromBlock` onwards.
 *
 * Handles the result-window restart described above: page to the window edge,
 * then resume from the highest block seen, deduping by tx hash because the
 * boundary block is requested again by the next window.
 */
export async function* iterContractTxs(
  chainId: number,
  address: string,
  fromBlock: number,
): AsyncGenerator<EtherscanTx> {
  let start = fromBlock;
  const seen = new Set<string>();

  for (;;) {
    let lastBlock = start;
    let page = 1;

    while (page * PAGE_SIZE <= MAX_WINDOW) {
      // eslint-disable-next-line no-await-in-loop
      const txs = await call<EtherscanTx[]>({
        chainid: String(chainId),
        module: 'account',
        action: 'txlist',
        address,
        startblock: String(start),
        endblock: '99999999',
        sort: 'asc',
        offset: String(PAGE_SIZE),
        page: String(page),
      });
      if (!Array.isArray(txs) || txs.length === 0) return;

      for (const tx of txs) {
        if (seen.has(tx.hash)) continue;
        seen.add(tx.hash);
        lastBlock = Math.max(lastBlock, Number(tx.blockNumber) || 0);
        yield tx;
      }
      if (txs.length < PAGE_SIZE) return;
      page += 1;
    }

    if (lastBlock <= start) {
      logger.warn({ address, block: lastBlock },
        'etherscan: single block fills the result window; cannot paginate past it');
      return;
    }
    start = lastBlock;
  }
}

// processRemoteMessage(uint64 msgId, uint256 relayerFee, uint256 amount, address receiver)
export const PROCESS_REMOTE_METHOD_ID = '0x6efe7df5';

export interface Settlement {
  msgId: number;
  success: boolean;
  txHash: string;
  block: number;
  ts: Date;
}

/**
 * Scan the Pipe contract for `processRemoteMessage` calls and report each
 * message's settlement.
 *
 * A message is settled by its **first successful relay**. The relayer keeps
 * re-submitting afterwards and every one of those retries reverts (the contract
 * has already processed it), so a later failure must never overwrite an earlier
 * success — otherwise completed transfers get reported as failed.
 */
export async function scanSettlements(
  chainId: number,
  pipeAddress: string,
  fromBlock: number,
): Promise<{ settlements: Map<number, Settlement>; highestBlock: number }> {
  const settlements = new Map<number, Settlement>();
  let highestBlock = fromBlock;

  for await (const tx of iterContractTxs(chainId, pipeAddress, fromBlock)) {
    const block = Number(tx.blockNumber) || 0;
    if (block > highestBlock) highestBlock = block;

    const method = tx.methodId ?? tx.input.slice(0, 10);
    if (method !== PROCESS_REMOTE_METHOD_ID) continue;
    // 0x + 8 method chars + 64 for the first uint64 argument (left-padded).
    if (tx.input.length < 74) continue;

    let msgId: number;
    try {
      msgId = Number(BigInt(`0x${tx.input.slice(10, 74)}`));
    } catch {
      continue;
    }

    const prior = settlements.get(msgId);
    if (prior?.success) continue; // first success wins

    const success = (tx.txreceipt_status ?? '1') === '1' && (tx.isError ?? '0') === '0';
    settlements.set(msgId, {
      msgId,
      success,
      txHash: tx.hash,
      block,
      ts: new Date(Number(tx.timeStamp) * 1000),
    });
  }

  return { settlements, highestBlock };
}
