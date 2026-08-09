import { request } from 'undici';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { etherscanEnabled, proxyCall } from './etherscan.js';

// ---------------------------------------------------------------------------
// Minimal Ethereum JSON-RPC client.
//
// Deliberately keyless-friendly. Measured against the free public endpoints:
// only dRPC serves eth_getLogs over a useful range without an API key (10 000
// blocks per query). publicnode refuses archive reads, 1rpc caps getLogs at 50
// blocks, ankr requires a key, and Alchemy's free tier is down to 10 blocks —
// so the windowing below is not a nicety, it's the only way this works without
// paying. A keyed endpoint can be dropped in via ETH_RPC_URL with no code
// change; raise ETH_LOG_WINDOW if it allows wider queries.
// ---------------------------------------------------------------------------

export const LOG_WINDOW = 10_000;

let nextId = 1;

/** Endpoint for an EVM chain id. Unknown chains fall back to mainnet rather
 *  than throwing, so adding a bridge on a new chain fails loudly at the query
 *  rather than at config load. */
export function rpcUrlFor(chainId: number): string {
  return chainId === 42161 ? config.ARB_RPC_URL : config.ETH_RPC_URL;
}

// Public endpoints return sporadic 500s ("Temporary internal error, please
// retry") that are pure noise — one of them aborted an entire bridge's sync.
const MAX_ATTEMPTS = 3;

async function rpc<T>(method: string, params: unknown[], chainId = 1): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await rpcOnce<T>(method, params, chainId);
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      const transient = /HTTP 5\d\d|Temporary internal error|timeout|ECONNRESET|socket hang up/i.test(msg);
      const throttled = /usage limit|rate limit|too many requests|HTTP 429/i.test(msg);
      // Public endpoints (notably Arbitrum's) proxy to rate-limited upstreams.
      // Etherscan's proxy module serves the same methods on every chain we use,
      // so fall over to it rather than dropping the bridge for the cycle.
      if (throttled && etherscanEnabled()) {
        const viaEtherscan = await proxyFallback<T>(method, params, chainId);
        if (viaEtherscan !== undefined) return viaEtherscan;
      }
      if ((!transient && !throttled) || attempt === MAX_ATTEMPTS) throw err;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => { setTimeout(r, 250 * attempt); });
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Serves the read-only subset we need through Etherscan. Returns undefined for
 *  anything it can't express, so the caller falls back to normal retries. */
async function proxyFallback<T>(method: string, params: unknown[], chainId: number): Promise<T | undefined> {
  try {
    if (method === 'eth_blockNumber') {
      return (await proxyCall(chainId, { action: 'eth_blockNumber' })) as unknown as T;
    }
    if (method === 'eth_call') {
      const call = params[0] as { to?: string; data?: string } | undefined;
      if (!call?.to || !call.data) return undefined;
      return (await proxyCall(chainId, {
        action: 'eth_call', to: call.to, data: call.data, tag: 'latest',
      })) as unknown as T;
    }
    if (method === 'eth_getBalance') {
      const addr = params[0] as string | undefined;
      if (!addr) return undefined;
      return (await proxyCall(chainId, {
        action: 'eth_getBalance', address: addr, tag: 'latest',
      })) as unknown as T;
    }
    return undefined;
  } catch (err) {
    logger.debug({ method, err: err instanceof Error ? err.message : err },
      'bridge: etherscan proxy fallback failed');
    return undefined;
  }
}

async function rpcOnce<T>(method: string, params: unknown[], chainId = 1): Promise<T> {
  const body = JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params });
  const { statusCode, body: respBody } = await request(rpcUrlFor(chainId), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  const text = await respBody.text();
  if (statusCode >= 400) {
    throw new Error(`eth rpc ${method}: HTTP ${statusCode}: ${text.slice(0, 200)}`);
  }
  let parsed: { result?: T; error?: { message?: string } };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`eth rpc ${method}: non-JSON response: ${text.slice(0, 200)}`);
  }
  if (parsed.error) {
    throw new Error(`eth rpc ${method}: ${parsed.error.message ?? JSON.stringify(parsed.error)}`);
  }
  return parsed.result as T;
}

export async function blockNumber(chainId = 1): Promise<number> {
  return parseInt(await rpc<string>('eth_blockNumber', [], chainId), 16);
}

export interface EthLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
}

export async function getLogs(
  address: string,
  topic0: string,
  fromBlock: number,
  toBlock: number,
  chainId = 1,
): Promise<EthLog[]> {
  return rpc<EthLog[]>('eth_getLogs', [
    { address, topics: [topic0], fromBlock: `0x${fromBlock.toString(16)}`, toBlock: `0x${toBlock.toString(16)}` },
  ], chainId);
}

export async function getBlockTimestamp(block: number, chainId = 1): Promise<Date | null> {
  const b = await rpc<{ timestamp?: string } | null>('eth_getBlockByNumber', [
    `0x${block.toString(16)}`,
    false,
  ], chainId);
  if (!b?.timestamp) return null;
  return new Date(parseInt(b.timestamp, 16) * 1000);
}

export async function getBalance(address: string, chainId = 1): Promise<bigint> {
  return BigInt(await rpc<string>('eth_getBalance', [address, 'latest'], chainId));
}

/** ERC20 balanceOf(address) — selector 0x70a08231. */
export async function erc20BalanceOf(token: string, holder: string, chainId = 1): Promise<bigint> {
  const data = `0x70a08231${'0'.repeat(24)}${holder.replace(/^0x/, '').toLowerCase()}`;
  const out = await rpc<string>('eth_call', [{ to: token, data }, 'latest'], chainId);
  if (!out || out === '0x') return 0n;
  return BigInt(out);
}

// ---------------------------------------------------------------------------
// NewLocalMessage(uint64 msgId, uint256 amount, uint256 relayerFee, bytes receiver)
//
// All four parameters are non-indexed, so everything lives in `data` and the
// only topic is the signature hash — msgId can't be filtered on-chain.
// Layout: three 32-byte words, then a 32-byte offset to the `bytes` tail
// (length word + padded payload). `receiver` is a 33-byte Beam pubkey.
// ---------------------------------------------------------------------------

export const NEW_LOCAL_MESSAGE_TOPIC =
  '0x5f52670be4e2f3d7b079180b485ab44712641a10d1c77e843355f96036608ac7';

export interface NewLocalMessage {
  msgId: number;
  amount: bigint;
  relayerFee: bigint;
  receiver: string;
  block: number;
  txHash: string;
}

export function decodeNewLocalMessage(log: EthLog): NewLocalMessage | null {
  const hex = log.data.replace(/^0x/, '');
  const words: string[] = [];
  for (let i = 0; i + 64 <= hex.length; i += 64) words.push(hex.slice(i, i + 64));
  if (words.length < 5) return null;
  try {
    const msgId = Number(BigInt(`0x${words[0]}`));
    const amount = BigInt(`0x${words[1]}`);
    const relayerFee = BigInt(`0x${words[2]}`);
    const tailWord = Number(BigInt(`0x${words[3]}`)) / 32;
    const lenWord = words[tailWord];
    if (!lenWord) return null;
    const len = Number(BigInt(`0x${lenWord}`));
    const receiver = words.slice(tailWord + 1).join('').slice(0, len * 2);
    return { msgId, amount, relayerFee, receiver, block: parseInt(log.blockNumber, 16), txHash: log.transactionHash };
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err, tx: log.transactionHash },
      'bridge: undecodable NewLocalMessage log');
    return null;
  }
}

/** ERC20 totalSupply() — selector 0x18160ddd. */
export async function erc20TotalSupply(token: string, chainId = 1): Promise<bigint> {
  const out = await rpc<string>('eth_call', [{ to: token, data: '0x18160ddd' }, 'latest'], chainId);
  if (!out || out === '0x') return 0n;
  return BigInt(out);
}
