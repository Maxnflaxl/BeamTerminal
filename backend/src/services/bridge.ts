import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { q } from '../db.js';
import { logger } from '../logger.js';
import { invokeContract } from '../walletApi.js';
import { getBlockTsMap } from './blockTimestamps.js';

// ---------------------------------------------------------------------------
// Beam <-> Ethereum Pipe bridge monitoring, Beam side.
//
// The explorer decodes every Pipe call as `Passthrough` with empty args (its
// Parser.wasm doesn't know the Pipe contract), so the Beam side is read by
// running the Pipe app-shader inside our wallet-api daemon — the same trick
// dappStore.ts uses for the upgradable2-wrapped DApp Store.
//
// Ethereum-side ingest (NewLocalMessage logs + processRemoteMessage settlement)
// lands in a follow-up; this module owns only what Beam itself can answer.
//
// Reference implementation for the protocol: roman-strilets/bridge-monitor.
// ---------------------------------------------------------------------------

const EXPECTED_WASM_SHA256 = 'a53ae07a8a13aca6736bc3b6a5daf608fa4c4c7b25edf2b4a18fd80269c75f83';

export interface BridgeDef {
  /** Stable key used in the DB and the public API. */
  key: string;
  label: string;
  /** Beam-side Pipe contract. */
  cid: string;
  /** EVM chain the far side lives on. */
  chainId: number;
  /** Ethereum Pipe contract (checksummed). */
  ethPipe: string;
  /** Escrowed ERC20 on the Ethereum side; null when the Pipe holds native ETH. */
  ethToken: string | null;
  /** Beam asset id minted by the paired token contract; 0 = native BEAM. */
  aid: number;
  /** Decimals of the Beam-side asset (all Pipe amounts are in these units). */
  decimals: number;
  /**
   * `view_params` misreads this Pipe's Params record — it locks aid 0 directly
   * instead of pairing with a token_contract, so the layout differs and the
   * action returns garbage. Every other action works.
   */
  noViewParams?: boolean;
}

// Verified on mainnet, not copied from the dapp repos — `beam-bridge-app` and
// `beam-bridge-ethapp` ship *testnet* addresses whose contracts have no code on
// mainnet. Beam CIDs come from a Pipe-SID scan of the explorer's /contracts;
// Ethereum addresses from a keyless topic0 sweep for NewLocalMessage, with each
// escrow confirmed by balanceOf. Pipe<->token pairing confirmed via view_params.
export const BRIDGES: readonly BridgeDef[] = [
  {
    key: 'beam-wbeam',
    label: 'BEAM / WBEAM',
    cid: 'e63bd26ca5b226558686dd191122a8e5d6861a97597db9f40bda48aef6dbe835',
    chainId: 1,
    ethPipe: '0x6063024646E8A1561970840a4b0e0f1082f5a670',
    ethToken: '0xE5AcBB03D73267c03349c76EaD672Ee4d941F499',
    aid: 0,
    decimals: 8,
    noViewParams: true,
  },
  {
    key: 'beth',
    label: 'bETH',
    cid: '8872509d36a8e2aa7a60839a1828c372af47c0a5309f3f6186379cddec847369',
    chainId: 1,
    ethPipe: '0xb1d7ff9d3acaf30e282c5f6eb1f2a6503f516a96',
    ethToken: null, // native ETH
    aid: 36,
    decimals: 8,
  },
  {
    key: 'busdt',
    label: 'bUSDT',
    cid: '8af23fe6338e3e67574f4548c9acf3d269756ae9b25ab025fd4268a07b8a3c29',
    chainId: 1,
    ethPipe: '0x7c3fe09e86b0d8661d261a49bfa385536b7077f9',
    ethToken: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    aid: 37,
    decimals: 8,
  },
  {
    key: 'bwbtc',
    label: 'bWBTC',
    cid: '7c66181ba4625202aae6e46afe89acbf1f839523344b0b371fc7988ac2e8c056',
    chainId: 1,
    ethPipe: '0x604422d7ec88c45b82b71851d073efeaa928dcef',
    ethToken: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
    aid: 38,
    decimals: 8,
  },
  {
    key: 'bdai',
    label: 'bDAI',
    cid: '02fb908e55a59ab5acc5bf6f1707a8dcdb70a944d6f2a7bff3c7af18c8e278da',
    chainId: 1,
    ethPipe: '0xacdc8f4559741a3c8caab0ba74c57807a9fe2d73',
    ethToken: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
    aid: 39,
    decimals: 8,
  },
];

// ---------------------------------------------------------------------------
// Shader plumbing
// ---------------------------------------------------------------------------

function resolveWasmPath(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return [
    path.resolve(here, '..', '..', 'resources', 'pipe_app.wasm'),       // dist/src/services → backend/
    path.resolve(here, '..', '..', '..', 'resources', 'pipe_app.wasm'), // src/services      → backend/
  ];
}

let cachedWasm: Uint8Array | null = null;
async function loadWasm(): Promise<Uint8Array> {
  if (cachedWasm) return cachedWasm;
  let lastErr: unknown;
  for (const candidate of resolveWasmPath()) {
    try {
      const bytes = await readFile(candidate);
      const sha = createHash('sha256').update(bytes).digest('hex');
      if (sha !== EXPECTED_WASM_SHA256) {
        throw new Error(`pipe_app.wasm sha256 mismatch at ${candidate}: got ${sha}, expected ${EXPECTED_WASM_SHA256}`);
      }
      cachedWasm = new Uint8Array(bytes);
      logger.info({ candidate, bytes: bytes.length }, 'pipe_app.wasm loaded');
      return cachedWasm;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`pipe_app.wasm not found; tried ${resolveWasmPath().join(', ')}: ${lastErr instanceof Error ? lastErr.message : lastErr}`);
}

async function pipeCall<T>(args: string): Promise<T> {
  const contract = await loadWasm();
  const { output } = await invokeContract<T>({ args, contract });
  return output;
}

// The shader reports "no such message" as a JSON `error` field rather than an
// RPC error, and invokeContract() turns that into a throw. Absence is an
// expected answer for the boundary probes below, so it maps to null — but only
// for that one message; any other failure still propagates.
async function pipeCallAllowAbsent<T>(args: string): Promise<T | null> {
  try {
    return await pipeCall<T>(args);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/shader error:.*absent/i.test(msg)) return null;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Shader response shapes (pipe_app.cpp, manager namespace)
// ---------------------------------------------------------------------------

interface LocalMsgCountOut { count?: number }
interface LocalMsgOut {
  amount?: number | string;
  relayerFee?: number | string;
  receiver?: string;
  height?: number;
}
interface MsgStatusOut { status?: number }
interface ViewParamsOut {
  'relayer pubkey'?: string;
  // Yes, the shader really spells it "tocken CID".
  'tocken CID'?: string;
  'token asset ID'?: number;
}

export async function getLocalMsgCount(cid: string): Promise<number> {
  const out = await pipeCall<LocalMsgCountOut>(`role=manager,action=local_msg_count,cid=${cid}`);
  return typeof out?.count === 'number' ? out.count : 0;
}

export async function getLocalMsg(cid: string, msgId: number): Promise<LocalMsgOut | null> {
  return pipeCallAllowAbsent<LocalMsgOut>(`role=manager,action=local_msg,cid=${cid},msgId=${msgId}`);
}

/** Raw contract status: 0 not delivered, 1 complete, 2 delivered-unclaimed. */
export async function getMsgStatus(cid: string, msgId: number): Promise<number | null> {
  const out = await pipeCall<MsgStatusOut>(`role=manager,action=msg_status,cid=${cid},msgId=${msgId}`);
  return typeof out?.status === 'number' ? out.status : null;
}

export async function getViewParams(cid: string): Promise<ViewParamsOut> {
  return pipeCall<ViewParamsOut>(`role=manager,action=view_params,cid=${cid}`);
}

// Per §5.2 of the spec: 0/1/2 are three genuinely different situations and the
// mapping must never collapse them. `unknown` is reserved for read failures.
export function mapIncomingStatus(raw: number | null): string {
  switch (raw) {
    case 0: return 'not_delivered';
    case 1: return 'complete';
    case 2: return 'unclaimed';
    default: return 'unknown';
  }
}

// ---------------------------------------------------------------------------
// Cursors
// ---------------------------------------------------------------------------

interface CursorRow { beam_msg_hi: string; eth_scanned_to_block: string }

async function readCursor(b: BridgeDef): Promise<{ beamMsgHi: number; ethBlock: number }> {
  const { rows } = await q<CursorRow>(
    'SELECT beam_msg_hi, eth_scanned_to_block FROM bridge_cursors WHERE bridge = $1',
    [b.key],
  );
  const row = rows[0];
  if (!row) {
    await q(
      'INSERT INTO bridge_cursors (bridge, chain_id) VALUES ($1, $2) ON CONFLICT (bridge) DO NOTHING',
      [b.key, b.chainId],
    );
    return { beamMsgHi: 0, ethBlock: 0 };
  }
  return {
    beamMsgHi: Number(row.beam_msg_hi),
    ethBlock: Number(row.eth_scanned_to_block),
  };
}

async function writeBeamCursor(bridge: string, msgHi: number): Promise<void> {
  await q(
    `UPDATE bridge_cursors
        SET beam_msg_hi = $2, updated_at = now()
      WHERE bridge = $1 AND beam_msg_hi < $2`,
    [bridge, msgHi],
  );
}

// ---------------------------------------------------------------------------
// Beam -> Ethereum: enumerate outgoing messages
//
// Each message is read exactly once, ever — they're immutable on the Beam side
// once created, and the cursor only moves forward. Settlement state is filled
// in later from Ethereum, so rows start at 'pending'.
// ---------------------------------------------------------------------------

async function ingestOutgoing(b: BridgeDef): Promise<number> {
  const count = await getLocalMsgCount(b.cid);
  const { beamMsgHi } = await readCursor(b);
  if (count <= beamMsgHi) return 0;

  const heights: number[] = [];
  const rows: Array<{
    msgId: number; amount: string; relayerFee: string; receiver: string; height: number | null;
  }> = [];

  for (let msgId = beamMsgHi + 1; msgId <= count; msgId += 1) {
    // eslint-disable-next-line no-await-in-loop
    const msg = await getLocalMsg(b.cid, msgId);
    if (!msg) {
      // A hole below the counter shouldn't happen (ids are dense and messages
      // are never deleted on the outgoing side). Stop rather than skip, so the
      // cursor can't advance past something we failed to read.
      logger.warn({ bridge: b.key, msgId }, 'bridge: local_msg absent below counter, halting ingest');
      break;
    }
    const height = typeof msg.height === 'number' ? msg.height : null;
    if (height) heights.push(height);
    rows.push({
      msgId,
      amount: String(msg.amount ?? 0),
      relayerFee: String(msg.relayerFee ?? 0),
      receiver: String(msg.receiver ?? ''),
      height,
    });
  }
  if (rows.length === 0) return 0;

  const tsMap = heights.length > 0 ? await getBlockTsMap(heights) : new Map<number, Date>();

  const placeholders: string[] = [];
  const params: Array<string | number | Date | null> = [];
  for (const r of rows) {
    const i = params.length;
    placeholders.push(
      `($${i + 1}, $${i + 2}, 'beam2eth', $${i + 3}, 'pending', $${i + 4}, $${i + 5}, $${i + 6}, $${i + 7}, $${i + 8})`,
    );
    params.push(
      b.key, b.chainId, r.msgId, r.amount, r.relayerFee, r.receiver,
      r.height, r.height ? tsMap.get(r.height) ?? null : null,
    );
  }

  await q(
    `INSERT INTO bridge_messages
       (bridge, chain_id, direction, msg_id, status, amount, relayer_fee, receiver, src_height, src_ts)
     VALUES ${placeholders.join(',')}
     ON CONFLICT (bridge, chain_id, direction, msg_id) DO UPDATE SET
       amount      = EXCLUDED.amount,
       relayer_fee = EXCLUDED.relayer_fee,
       receiver    = EXCLUDED.receiver,
       src_height  = EXCLUDED.src_height,
       src_ts      = COALESCE(EXCLUDED.src_ts, bridge_messages.src_ts),
       updated_at  = now()`,
    params,
  );

  const last = rows[rows.length - 1];
  if (last) await writeBeamCursor(b.key, last.msgId);
  return rows.length;
}

// ---------------------------------------------------------------------------
// Ethereum -> Beam: refresh the Beam-side view of incoming messages
//
// Until the Ethereum log ingest lands there's no authoritative list of incoming
// msgIds, so we probe upward from 1 until we're past the highest id the
// contract knows about. `msg_status` is the only readable signal: `remote_msg`
// returns "absent" for completed messages, because ReceiveFunds deletes the
// header (pipe_contract.cpp Method_4).
//
// Cheap enough to redo in full each cycle at current volumes (646 calls swept
// every bridge in 27s), and it self-corrects if a status changes. Once the
// Ethereum side is ingested this is driven by the known msgId set instead.
// ---------------------------------------------------------------------------

const PROBE_TAIL = 32; // consecutive status-0 ids that end the scan
const PROBE_CEILING = 4096; // hard stop; current max across bridges is ~220

async function refreshIncoming(b: BridgeDef): Promise<{ scanned: number; open: number }> {
  const found: Array<{ msgId: number; status: string }> = [];
  let consecutiveAbsent = 0;
  let msgId = 0;

  while (msgId < PROBE_CEILING && consecutiveAbsent < PROBE_TAIL) {
    msgId += 1;
    // eslint-disable-next-line no-await-in-loop
    const raw = await getMsgStatus(b.cid, msgId);
    const status = mapIncomingStatus(raw);
    if (raw === 0) {
      consecutiveAbsent += 1;
    } else {
      consecutiveAbsent = 0;
    }
    // Persist everything below the high-water mark, including the 0s: a gap
    // under the mark is itself the interesting signal (relayer never delivered
    // it). Trailing 0s past the mark are just "doesn't exist yet" and are
    // trimmed after the loop.
    found.push({ msgId, status });
  }

  // Drop the trailing not_delivered run — those ids don't exist on either side.
  while (found.length > 0 && found[found.length - 1]?.status === 'not_delivered') {
    found.pop();
  }
  if (found.length === 0) return { scanned: msgId, open: 0 };

  const placeholders: string[] = [];
  const params: Array<string | number> = [];
  for (const f of found) {
    const i = params.length;
    placeholders.push(`($${i + 1}, $${i + 2}, 'eth2beam', $${i + 3}, $${i + 4})`);
    params.push(b.key, b.chainId, f.msgId, f.status);
  }

  await q(
    `INSERT INTO bridge_messages (bridge, chain_id, direction, msg_id, status)
     VALUES ${placeholders.join(',')}
     ON CONFLICT (bridge, chain_id, direction, msg_id) DO UPDATE SET
       -- Never let a read failure overwrite a known state.
       status     = CASE WHEN EXCLUDED.status = 'unknown'
                         THEN bridge_messages.status
                         ELSE EXCLUDED.status END,
       updated_at = now()`,
    params,
  );

  const open = found.filter((f) => f.status !== 'complete').length;
  return { scanned: msgId, open };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface BridgeSyncResult {
  bridges: number;
  outgoingIngested: number;
  incomingOpen: number;
  shaderCalls: number;
}

export async function syncBridges(): Promise<BridgeSyncResult> {
  const res: BridgeSyncResult = { bridges: 0, outgoingIngested: 0, incomingOpen: 0, shaderCalls: 0 };

  for (const b of BRIDGES) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const ingested = await ingestOutgoing(b);
      // eslint-disable-next-line no-await-in-loop
      const { scanned, open } = await refreshIncoming(b);
      res.bridges += 1;
      res.outgoingIngested += ingested;
      res.incomingOpen += open;
      res.shaderCalls += scanned + ingested + 1;
      logger.debug({ bridge: b.key, ingested, scanned, open }, 'bridge synced');
    } catch (err) {
      // One unreachable Pipe must not stop the others.
      logger.warn(
        { bridge: b.key, err: err instanceof Error ? err.message : err },
        'bridge sync failed; other bridges continue',
      );
    }
  }
  return res;
}
