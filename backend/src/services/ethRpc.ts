import { request } from 'undici';
import { config } from '../config.js';
import { logger } from '../logger.js';

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

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const body = JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params });
  const { statusCode, body: respBody } = await request(config.ETH_RPC_URL, {
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

export async function blockNumber(): Promise<number> {
  return parseInt(await rpc<string>('eth_blockNumber', []), 16);
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
): Promise<EthLog[]> {
  return rpc<EthLog[]>('eth_getLogs', [
    { address, topics: [topic0], fromBlock: `0x${fromBlock.toString(16)}`, toBlock: `0x${toBlock.toString(16)}` },
  ]);
}

export async function getBlockTimestamp(block: number): Promise<Date | null> {
  const b = await rpc<{ timestamp?: string } | null>('eth_getBlockByNumber', [
    `0x${block.toString(16)}`,
    false,
  ]);
  if (!b?.timestamp) return null;
  return new Date(parseInt(b.timestamp, 16) * 1000);
}

export async function getBalance(address: string): Promise<bigint> {
  return BigInt(await rpc<string>('eth_getBalance', [address, 'latest']));
}

/** ERC20 balanceOf(address) — selector 0x70a08231. */
export async function erc20BalanceOf(token: string, holder: string): Promise<bigint> {
  const data = `0x70a08231${'0'.repeat(24)}${holder.replace(/^0x/, '').toLowerCase()}`;
  const out = await rpc<string>('eth_call', [{ to: token, data }, 'latest']);
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
