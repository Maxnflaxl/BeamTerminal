import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { q } from '../db.js';
import { logger } from '../logger.js';
import { invokeContract } from '../walletApi.js';
import { getBlockTsMap } from './blockTimestamps.js';
import { getContractFullHistory, type ContractResponse } from '../explorer.js';
import {
  LOG_WINDOW,
  NEW_LOCAL_MESSAGE_TOPIC,
  blockNumber,
  decodeNewLocalMessage,
  erc20BalanceOf,
  getBalance,
  getBlockTimestamp,
  getLogs,
  erc20TotalSupply,
} from './ethRpc.js';
import { etherscanEnabled, getLogsPaged, scanSettlements } from './etherscan.js';

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

/**
 * Shader method numbers for the three Pipe calls we key on. Two families are in
 * play and they do not agree, so the numbers belong to the bridge, not to the
 * module.
 */
export interface PipeMethods {
  /** Beam -> Ethereum send: locks or burns on the Beam side. */
  pushLocal: number;
  /** Relayer delivers an Ethereum message to Beam; pays itself the relayer fee. */
  pushRemote: number;
  /** Recipient claims a delivered message; releases the amount. */
  receiveFunds: number;
}

/**
 * The b-asset Pipes (bETH, bUSDT, bWBTC, bDAI) — pipe_contract.cpp, called
 * directly. Their arguments survive into the explorer, and each call group
 * nests the paired mint or burn on the asset's token contract.
 */
const B_ASSET_METHODS: PipeMethods = { pushLocal: 3, pushRemote: 5, receiveFunds: 4 };

/**
 * The BEAM-custody Pipes — a different shader, reached through an upgradable2
 * wrapper. Same three operations, different numbering, and the explorer reports
 * each primary row as "Passthrough" with the arguments stripped, so these
 * numbers appear only on the nested row.
 */
const BEAM_CUSTODY_METHODS: PipeMethods = { pushLocal: 4, pushRemote: 5, receiveFunds: 6 };

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
   * Decimals of the *Ethereum* asset. Not always the same as `decimals`: bUSDT
   * is 8 on Beam but USDT is 6 on Ethereum, bDAI is 8 against DAI's 18. Amounts
   * crossing the bridge are denominated in the side they were observed on, so
   * both scales are needed to compare supply against collateral.
   */
  ethDecimals: number;
  /** First block with code at `ethPipe`; floor for the log sweep. */
  ethDeployBlock: number;
  /**
   * Which chain holds the collateral.
   *   'eth'  — locked on Ethereum, wrapped asset minted on Beam (the b-assets).
   *   'beam' — locked in the Beam Pipe (native BEAM), WBEAM minted on Ethereum.
   * Reading the Ethereum Pipe's balance for a 'beam' bridge returns 0: it mints
   * rather than escrows. Getting this backwards silently reports an unbacked peg.
   */
  custody: 'eth' | 'beam';
  /** Which method numbering this Pipe's shader uses. */
  methods: PipeMethods;
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
    ethDecimals: 8,
    ethDeployBlock: 18190064,
    custody: 'beam',
    methods: BEAM_CUSTODY_METHODS,
    noViewParams: true,
  },
  {
    // Same Pipe/token addresses as mainnet (one deployer replaying nonces across
    // chains) but a *different* Beam-side Pipe: msgIds are per-Pipe, so the two
    // chains cannot share one. Verified by collateral — this Pipe locks 74.93
    // BEAM against Arbitrum's 74.49 WBEAM supply.
    key: 'beam-wbeam-arb',
    label: 'BEAM / WBEAM (Arbitrum)',
    cid: 'd2505213880d87a4747d23036a02d8919be211d26266cd6f3e591536e44f27fe',
    chainId: 42161,
    ethPipe: '0x6063024646E8A1561970840a4b0e0f1082f5a670',
    ethToken: '0xE5AcBB03D73267c03349c76EaD672Ee4d941F499',
    aid: 0,
    decimals: 8,
    ethDecimals: 8,
    ethDeployBlock: 322082726,
    custody: 'beam',
    methods: BEAM_CUSTODY_METHODS,
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
    ethDecimals: 18,
    ethDeployBlock: 16590872,
    custody: 'eth',
    methods: B_ASSET_METHODS,
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
    ethDecimals: 6,
    ethDeployBlock: 16590881,
    custody: 'eth',
    methods: B_ASSET_METHODS,
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
    ethDecimals: 8,
    ethDeployBlock: 16590894,
    custody: 'eth',
    methods: B_ASSET_METHODS,
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
    ethDecimals: 18,
    ethDeployBlock: 16590911,
    custody: 'eth',
    methods: B_ASSET_METHODS,
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

/**
 * Exact digits of a numeric field, read from the response text before
 * JSON.parse sees it. Amounts arrive as bare JSON numbers and a Beam Amount is
 * a uint64, so anything past 2^53 groths loses digits as a double — enough to
 * turn an exact -50 BEAM overshoot into -49.99999616.
 */
function rawIntField(raw: string, field: string): string | null {
  const m = new RegExp(`"${field}"\\s*:\\s*"?(\\d+)"?`).exec(raw);
  return m?.[1] ?? null;
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

async function getLocalMsgCount(cid: string): Promise<number> {
  const out = await pipeCall<LocalMsgCountOut>(`role=manager,action=local_msg_count,cid=${cid}`);
  return typeof out?.count === 'number' ? out.count : 0;
}

async function getLocalMsg(cid: string, msgId: number): Promise<LocalMsgOut | null> {
  const contract = await loadWasm();
  const args = `role=manager,action=local_msg,cid=${cid},msgId=${msgId}`;
  let res;
  try {
    res = await invokeContract<LocalMsgOut>({ args, contract });
  } catch (err) {
    // The shader reports "no such message" as a JSON `error` field rather than
    // an RPC error, and invokeContract() turns that into a throw. Absence is an
    // expected answer for the boundary probes above, so it maps to null — but
    // only for that one message; any other failure still propagates.
    const msg = err instanceof Error ? err.message : String(err);
    if (/shader error:.*absent/i.test(msg)) return null;
    throw err;
  }
  const out = res.output;
  if (!out || typeof out !== 'object') return out;
  // Prefer the untouched digits; fall back to the parsed value if the field
  // isn't a plain integer in the response.
  const amount = rawIntField(res.rawOutput, 'amount') ?? out.amount;
  const relayerFee = rawIntField(res.rawOutput, 'relayerFee') ?? out.relayerFee;
  return {
    ...out,
    ...(amount === undefined ? {} : { amount }),
    ...(relayerFee === undefined ? {} : { relayerFee }),
  };
}

/** Raw contract status: 0 not delivered, 1 complete, 2 delivered-unclaimed. */
async function getMsgStatus(cid: string, msgId: number): Promise<number | null> {
  const out = await pipeCall<MsgStatusOut>(`role=manager,action=msg_status,cid=${cid},msgId=${msgId}`);
  return typeof out?.status === 'number' ? out.status : null;
}

// Per §5.2 of the spec: 0/1/2 are three genuinely different situations and the
// mapping must never collapse them. `unknown` is reserved for read failures.
function mapIncomingStatus(raw: number | null): string {
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

interface CursorRow {
  beam_msg_hi: string;
  eth_scanned_to_block: string;
  eth_tx_scanned_to_block: string;
}

interface Cursors { beamMsgHi: number; ethLogBlock: number; ethTxBlock: number }

async function readCursor(b: BridgeDef): Promise<Cursors> {
  const { rows } = await q<CursorRow>(
    `SELECT beam_msg_hi, eth_scanned_to_block, eth_tx_scanned_to_block
       FROM bridge_cursors WHERE bridge = $1`,
    [b.key],
  );
  const row = rows[0];
  if (!row) {
    await q(
      'INSERT INTO bridge_cursors (bridge, chain_id) VALUES ($1, $2) ON CONFLICT (bridge) DO NOTHING',
      [b.key, b.chainId],
    );
    return { beamMsgHi: 0, ethLogBlock: 0, ethTxBlock: 0 };
  }
  // A zero cursor means "never scanned" — start at the Pipe's deploy block
  // rather than genesis, which would waste ~1 600 windows per bridge.
  return {
    beamMsgHi: Number(row.beam_msg_hi),
    ethLogBlock: Math.max(Number(row.eth_scanned_to_block), b.ethDeployBlock),
    ethTxBlock: Math.max(Number(row.eth_tx_scanned_to_block), b.ethDeployBlock),
  };
}

async function writeEthLogCursor(bridge: string, block: number): Promise<void> {
  await q(
    `UPDATE bridge_cursors
        SET eth_scanned_to_block = $2, updated_at = now()
      WHERE bridge = $1 AND eth_scanned_to_block < $2`,
    [bridge, block],
  );
}

async function writeEthTxCursor(bridge: string, block: number): Promise<void> {
  await q(
    `UPDATE bridge_cursors
        SET eth_tx_scanned_to_block = $2, updated_at = now()
      WHERE bridge = $1 AND eth_tx_scanned_to_block < $2`,
    [bridge, block],
  );
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
// `msg_status` is the only readable signal: `remote_msg` returns "absent" for
// completed messages, because ReceiveFunds deletes the header
// (pipe_contract.cpp Method_4).
//
// A message only ever moves 0 -> 2 -> 1, and the claim that produces 1 releases
// the funds, so `complete` is the one state the contract has no path out of.
// A cycle therefore re-reads just the ids still in flight plus the tail above
// the highest id on record, a few probes at a time. Every FULL_SWEEP_EVERY
// cycles the whole range is re-read from 0 instead, so a state that changed
// underneath us — a shallow reorg undoing a claim, a row written from a bad
// read — is corrected within the hour rather than never.
// ---------------------------------------------------------------------------

const PROBE_TAIL = 32; // consecutive status-0 ids that end the tail scan
const PROBE_CEILING = 4096; // hard stop; current max across bridges is ~220
const PROBE_CONCURRENCY = 8; // msg_status reads in flight per bridge
const FULL_SWEEP_EVERY = 12; // cycles between full re-reads; 5-min cycles → hourly
const TERMINAL_INCOMING_STATUS = 'complete';

let cycleCount = 0;

/** Run `fn` over `items` with at most `limit` calls in flight; results keep item order. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next;
      next += 1;
      // eslint-disable-next-line no-await-in-loop
      results[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function range(from: number, toInclusive: number): number[] {
  const out: number[] = [];
  for (let i = from; i <= toInclusive; i += 1) out.push(i);
  return out;
}

/**
 * Incoming ids already on record for a bridge: the highest one, and those whose
 * status can still change.
 */
async function knownIncoming(b: BridgeDef): Promise<{ maxId: number; inFlight: number[] }> {
  const { rows } = await q<{ msg_id: string; status: string }>(
    `SELECT msg_id::text, status
       FROM bridge_messages
      WHERE bridge = $1 AND direction = 'eth2beam'
      ORDER BY msg_id`,
    [b.key],
  );
  let maxId = -1;
  const inFlight: number[] = [];
  for (const r of rows) {
    const id = Number(r.msg_id);
    if (id > maxId) maxId = id;
    if (r.status !== TERMINAL_INCOMING_STATUS) inFlight.push(id);
  }
  return { maxId, inFlight };
}

/**
 * Highest incoming msgId the Ethereum log ingest has recorded, or -1 before it
 * has recorded any. Ids at or below it exist on the far side whatever the Beam
 * contract says about them.
 */
async function highestIncomingFromLogs(b: BridgeDef): Promise<number> {
  const { rows } = await q<{ hi: string | null }>(
    `SELECT max(msg_id)::text AS hi
       FROM bridge_messages
      WHERE bridge = $1 AND direction = 'eth2beam' AND src_tx IS NOT NULL`,
    [b.key],
  );
  const hi = rows[0]?.hi;
  return hi === null || hi === undefined ? -1 : Number(hi);
}

async function refreshIncoming(b: BridgeDef, fullSweep: boolean): Promise<{ scanned: number; open: number }> {
  const known = await knownIncoming(b);
  const probe = async (msgId: number): Promise<{ msgId: number; status: string }> => ({
    msgId,
    status: mapIncomingStatus(await getMsgStatus(b.cid, msgId)),
  });

  // Ids start at 0, not 1: the b-asset Pipes' first NewLocalMessage carries
  // msgId 0, and probing from 1 silently skipped it on every bridge.
  const onRecord = fullSweep ? range(0, known.maxId) : known.inFlight;
  const found = await mapLimit(onRecord, PROBE_CONCURRENCY, probe);
  let scanned = onRecord.length;

  // Tail above anything on record, in small batches until a run of PROBE_TAIL
  // status-0 ids says the contract knows nothing further. The 0s are kept for
  // now: a gap under the far side's high-water mark is itself the interesting
  // signal (relayer never delivered it); the trailing run past the mark is
  // trimmed below.
  let consecutiveAbsent = 0;
  let msgId = known.maxId + 1;
  while (msgId < PROBE_CEILING && consecutiveAbsent < PROBE_TAIL) {
    const batch = range(msgId, Math.min(msgId + PROBE_CONCURRENCY, PROBE_CEILING) - 1);
    // eslint-disable-next-line no-await-in-loop
    const results = await mapLimit(batch, PROBE_CONCURRENCY, probe);
    scanned += batch.length;
    for (const r of results) {
      found.push(r);
      consecutiveAbsent = r.status === 'not_delivered' ? consecutiveAbsent + 1 : 0;
    }
    msgId += batch.length;
  }
  found.sort((x, y) => x.msgId - y.msgId);

  // Drop the trailing not_delivered run, but only above the highest id the
  // Ethereum side has actually seen. A message that exists in the logs and
  // reads status 0 is genuinely undelivered, and that is the whole point of the
  // page; trimming it unconditionally left the newest message stuck on the
  // 'unknown' placeholder that upsertIncoming inserts, because the update below
  // refuses to overwrite a known state with 'unknown' and never got the chance
  // to write the real one.
  const knownHi = await highestIncomingFromLogs(b);
  while (found.length > 0) {
    const last = found[found.length - 1]!;
    if (last.status !== 'not_delivered' || last.msgId <= knownHi) break;
    found.pop();
  }
  if (found.length === 0) return { scanned, open: 0 };

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

  const open = found.filter((f) => f.status !== TERMINAL_INCOMING_STATUS).length;
  return { scanned, open };
}

// ---------------------------------------------------------------------------
// Beam-side blocks, from the Pipe's own call history
//
// Two things the message state can't tell us, both sitting in /contract:
//
//  - Outgoing: `local_msg` reports Env::get_Height() — the chain tip the wallet
//    saw when it built the transaction — not the block the call ended up in.
//    Looking that height up in the explorer shows nothing, which is exactly
//    what a user chasing a pending transfer runs into. The reported height is
//    mapped to the first call at or after it rather than assuming a fixed +1
//    offset.
//  - Incoming: `msg_status` is a tri-state with no height and no timestamp. The
//    delivery and the claim are ordinary calls, and on the b-asset Pipes the
//    explorer exposes their raw arguments, so each one's message id is readable
//    straight off the call list.
//
// One /contract fetch per bridge covers both — a few dozen to a few hundred
// rows — and, on the BEAM-custody Pipes, the locked-funds read as well. It is
// fetched without a height floor on purpose: the incoming resolver stamps the
// *earliest* delivery per message and rewrites the column wholesale, and the
// outgoing one maps reported heights that may sit anywhere in history, so a
// truncated call list would null or shift heights already resolved.
// ---------------------------------------------------------------------------

interface PipeCall {
  height: number;
  /** Numeric shader method, or a decoded name ("Create", "Passthrough"). */
  method: number | string;
  /** Raw little-endian argument blob, hex, no 0x. Empty when undecoded. */
  args: string;
}

function pipeCalls(contract: ContractResponse): PipeCall[] {
  const table = (contract as unknown as Record<string, unknown>)['Calls history'];
  const rows = (table as { value?: unknown[] } | undefined)?.value;
  if (!Array.isArray(rows)) return [];
  const calls: PipeCall[] = [];
  for (const row of rows.slice(1)) {
    // A group is a primary call plus the nested calls it made; only the primary
    // one is a call *into* this contract.
    const r = (row && typeof row === 'object' && (row as { type?: string }).type === 'group')
      ? ((row as { value: unknown[] }).value[0] as unknown[])
      : (row as unknown[]);
    if (!Array.isArray(r) || r.length === 0) continue;
    const cell = r[0] as { value?: unknown } | number | undefined;
    const height = typeof cell === 'number' ? cell : Number((cell as { value?: unknown })?.value);
    if (!Number.isFinite(height)) continue;
    const method = r[3] as number | string;
    const args = typeof r[4] === 'string' ? r[4] : '';
    calls.push({ height, method, args });
  }
  return calls;
}

/** Leading little-endian uint64 of a raw argument blob. */
function leadingMsgId(args: string): number | null {
  if (args.length < 16) return null;
  const bytes = args.slice(0, 16).match(/../g);
  if (!bytes) return null;
  const id = Number(BigInt(`0x${bytes.reverse().join('')}`));
  return Number.isSafeInteger(id) ? id : null;
}

// Largest integer a double holds exactly; above it, stored digits may be rounded.
const DOUBLE_EXACT_MAX = 9007199254740992n; // 2^53

/**
 * Rewrite outgoing rows stored before getLocalMsg read the response text. The
 * ingest cursor only moves forward, so a rounded row would keep its lost digits
 * forever. Bounded: ordinary transfers stay far below 2^53 groths (90M BEAM),
 * so in practice only underflowed amounts match.
 */
async function repairImpreciseOutgoing(b: BridgeDef): Promise<number> {
  const { rows } = await q<{ msg_id: string }>(
    `SELECT msg_id::text
       FROM bridge_messages
      WHERE bridge = $1 AND direction = 'beam2eth'
        AND (amount > $2::numeric OR relayer_fee > $2::numeric)`,
    [b.key, DOUBLE_EXACT_MAX.toString()],
  );
  let repaired = 0;
  for (const r of rows) {
    // eslint-disable-next-line no-await-in-loop
    const msg = await getLocalMsg(b.cid, Number(r.msg_id));
    if (!msg) continue;
    // eslint-disable-next-line no-await-in-loop
    const { rowCount } = await q(
      `UPDATE bridge_messages
          SET amount = $3::numeric, relayer_fee = $4::numeric, updated_at = now()
        WHERE bridge = $1 AND direction = 'beam2eth' AND msg_id = $2
          AND (amount IS DISTINCT FROM $3::numeric
            OR relayer_fee IS DISTINCT FROM $4::numeric)`,
      [b.key, Number(r.msg_id), String(msg.amount ?? 0), String(msg.relayerFee ?? 0)],
    );
    repaired += rowCount ?? 0;
  }
  if (repaired > 0) logger.info({ bridge: b.key, repaired }, 'bridge: rewrote imprecise outgoing amounts');
  return repaired;
}

async function resolveOutgoingHeights(b: BridgeDef, calls: PipeCall[]): Promise<number> {
  const { rows } = await q<{ msg_id: string; src_height: string }>(
    `SELECT msg_id::text, src_height::text
       FROM bridge_messages
      WHERE bridge = $1 AND direction = 'beam2eth'
        AND src_height IS NOT NULL AND src_call_height IS NULL`,
    [b.key],
  );
  if (rows.length === 0) return 0;

  const heights = calls.map((c) => c.height).sort((x, y) => x - y);
  if (heights.length === 0) return 0;

  let resolved = 0;
  for (const r of rows) {
    const reported = Number(r.src_height);
    // First call at or after the reported height. A message's call can never
    // precede the tip its transaction was built against.
    const hit = heights.find((h) => h >= reported);
    if (hit === undefined) continue;
    // eslint-disable-next-line no-await-in-loop
    await q(
      `UPDATE bridge_messages SET src_call_height = $3, updated_at = now()
        WHERE bridge = $1 AND direction = 'beam2eth' AND msg_id = $2`,
      [b.key, Number(r.msg_id), hit],
    );
    resolved += 1;
  }
  return resolved;
}

/**
 * Stamp each incoming message with the block it was delivered in and the block
 * it was claimed in.
 *
 * Both come from calls into the Pipe keyed by message id, so a message that was
 * relayed twice (the first attempt reverting) takes the earliest block that
 * carried it.
 *
 * Only the b-asset Pipes yield anything. The BEAM-custody Pipes sit behind an
 * upgradable2 wrapper, so the explorer decodes every primary row as
 * "Passthrough" with no method and no arguments; the real method number sits on
 * the nested row, which carries no message id either. Their heights stay null
 * until the parser exposes the wrapped call.
 */
async function resolveIncomingHeights(b: BridgeDef, calls: PipeCall[]): Promise<number> {
  const delivered = new Map<number, number>();
  const claimed = new Map<number, number>();
  for (const c of calls) {
    if (typeof c.method !== 'number') continue;
    const target = c.method === b.methods.pushRemote ? delivered
      : c.method === b.methods.receiveFunds ? claimed : null;
    if (target === null) continue;
    // ReceiveFunds carries nothing but the id; anything longer is a different
    // shape and not ours to read. PushRemote leads with the id and follows it
    // with the receiver, amount and relayer fee.
    if (c.method === b.methods.receiveFunds && c.args.length !== 16) continue;
    const msgId = leadingMsgId(c.args);
    if (msgId === null) continue;
    const prev = target.get(msgId);
    if (prev === undefined || c.height < prev) target.set(msgId, c.height);
  }
  if (delivered.size === 0 && claimed.size === 0) return 0;

  const ids = [...new Set([...delivered.keys(), ...claimed.keys()])];
  const { rowCount } = await q(
    `UPDATE bridge_messages m SET
       delivered_height = v.delivered,
       claimed_height   = v.claimed,
       updated_at       = now()
     FROM (
       SELECT unnest($2::bigint[]) AS msg_id,
              unnest($3::bigint[]) AS delivered,
              unnest($4::bigint[]) AS claimed
     ) v
     WHERE m.bridge = $1 AND m.direction = 'eth2beam' AND m.msg_id = v.msg_id
       AND (m.delivered_height IS DISTINCT FROM v.delivered
         OR m.claimed_height   IS DISTINCT FROM v.claimed)`,
    [
      b.key,
      ids,
      ids.map((id) => delivered.get(id) ?? null),
      ids.map((id) => claimed.get(id) ?? null),
    ],
  );
  return rowCount ?? 0;
}

async function resolveBeamHeights(
  b: BridgeDef,
  contract: ContractResponse,
): Promise<{ outgoing: number; incoming: number }> {
  const calls = pipeCalls(contract);
  if (calls.length === 0) return { outgoing: 0, incoming: 0 };
  return {
    outgoing: await resolveOutgoingHeights(b, calls),
    incoming: await resolveIncomingHeights(b, calls),
  };
}

// ---------------------------------------------------------------------------
// Ethereum -> Beam: ingest NewLocalMessage logs
//
// The authoritative list of incoming messages, and the only source of their
// amounts: once a recipient claims, ReceiveFunds deletes the Beam-side header
// (pipe_contract.cpp Method_4), so `remote_msg` reports "absent" and the amount
// is gone from Beam entirely.
//
// Walks in LOG_WINDOW-block steps because the free RPC caps ranges there, and
// stops after BRIDGE_LOG_WINDOWS_PER_CYCLE so the ~9.1M-block cold backfill
// spreads across ticks instead of stalling one. Status is left alone here —
// refreshIncoming owns that.
// ---------------------------------------------------------------------------

async function upsertIncoming(
  b: BridgeDef,
  msgs: Array<{ msgId: number; amount: bigint; relayerFee: bigint; receiver: string; block: number; txHash: string; ts: Date | null }>,
): Promise<void> {
  if (msgs.length === 0) return;
  const placeholders: string[] = [];
  const params: Array<string | number | Date | null> = [];
  for (const m of msgs) {
    const i = params.length;
    placeholders.push(
      `($${i + 1}, $${i + 2}, 'eth2beam', $${i + 3}, 'unknown', $${i + 4}, $${i + 5}, $${i + 6}, $${i + 7}, $${i + 8}, $${i + 9})`,
    );
    params.push(
      b.key, b.chainId, m.msgId, m.amount.toString(), m.relayerFee.toString(),
      m.receiver, m.block, m.ts, m.txHash,
    );
  }
  await q(
    `INSERT INTO bridge_messages
       (bridge, chain_id, direction, msg_id, status, amount, relayer_fee, receiver,
        src_block, src_ts, src_tx)
     VALUES ${placeholders.join(',')}
     ON CONFLICT (bridge, chain_id, direction, msg_id) DO UPDATE SET
       -- Ethereum provenance wins; status stays whatever the Beam side said.
       amount      = EXCLUDED.amount,
       relayer_fee = EXCLUDED.relayer_fee,
       receiver    = EXCLUDED.receiver,
       src_block   = EXCLUDED.src_block,
       src_ts      = COALESCE(EXCLUDED.src_ts, bridge_messages.src_ts),
       src_tx      = EXCLUDED.src_tx,
       updated_at  = now()`,
    params,
  );
}

async function ingestIncomingLogs(b: BridgeDef): Promise<{ found: number; caughtUp: boolean }> {
  const { ethLogBlock } = await readCursor(b);
  const head = await blockNumber(b.chainId);
  if (ethLogBlock >= head) return { found: 0, caughtUp: true };

  // Preferred path. Etherscan's logs endpoint has no block-range cap, so one
  // request covers 1 000 logs no matter how far apart they are. That is the
  // only workable option on Arbitrum (~492M blocks: windowing would need
  // ~49 000 requests for a single Pipe) and it collapses Ethereum's cold
  // backfill from thousands of requests to a handful.
  if (etherscanEnabled()) {
    const logs = await getLogsPaged(b.chainId, b.ethPipe, NEW_LOCAL_MESSAGE_TOPIC, ethLogBlock);
    const msgs = logs
      .map((l) => {
        const decoded = decodeNewLocalMessage({
          address: l.address, topics: l.topics, data: l.data,
          blockNumber: l.blockNumber, transactionHash: l.transactionHash,
        });
        if (!decoded) return null;
        // Etherscan returns the block timestamp with the log, so unlike the RPC
        // path there's no second round-trip per block.
        const ts = l.timeStamp ? new Date(parseInt(l.timeStamp, 16) * 1000) : null;
        return { ...decoded, ts };
      })
      .filter((m): m is NonNullable<typeof m> => m !== null);

    await upsertIncoming(b, msgs);
    await writeEthLogCursor(b.key, head);
    return { found: msgs.length, caughtUp: true };
  }

  // Keyless fallback: walk in LOG_WINDOW steps, bounded per cycle so the cold
  // backfill spreads across ticks instead of stalling one.
  let from = ethLogBlock;
  let windows = 0;
  let found = 0;

  while (from < head && windows < config.BRIDGE_LOG_WINDOWS_PER_CYCLE) {
    const to = Math.min(from + LOG_WINDOW - 1, head);
    // eslint-disable-next-line no-await-in-loop
    const logs = await getLogs(b.ethPipe, NEW_LOCAL_MESSAGE_TOPIC, from, to, b.chainId);
    windows += 1;

    const decoded = logs.map(decodeNewLocalMessage).filter((m): m is NonNullable<typeof m> => m !== null);
    if (decoded.length > 0) {
      const blocks = Array.from(new Set(decoded.map((m) => m.block)));
      // eslint-disable-next-line no-await-in-loop
      const tsEntries = await Promise.all(
        blocks.map(async (blk) => [blk, await getBlockTimestamp(blk, b.chainId)] as const),
      );
      const tsMap = new Map(tsEntries);
      // eslint-disable-next-line no-await-in-loop
      await upsertIncoming(b, decoded.map((m) => ({ ...m, ts: tsMap.get(m.block) ?? null })));
      found += decoded.length;
    }

    from = to + 1;
    // eslint-disable-next-line no-await-in-loop
    await writeEthLogCursor(b.key, to);
  }

  return { found, caughtUp: from >= head };
}

// ---------------------------------------------------------------------------
// Beam -> Ethereum: settle outgoing messages
//
// Requires Etherscan: processRemoteMessage emits no event, so the contract's
// transaction list is the only place a settlement is visible. Without a key the
// rows stay 'pending' rather than being mislabelled failed.
// ---------------------------------------------------------------------------

async function settleOutgoing(b: BridgeDef): Promise<number> {
  if (!etherscanEnabled()) return 0;

  const { ethTxBlock } = await readCursor(b);

  const { rows: pendingRows } = await q<{ n: string }>(
    `SELECT count(*)::text AS n FROM bridge_messages
      WHERE bridge = $1 AND direction = 'beam2eth' AND status = 'pending'`,
    [b.key],
  );
  const pending = Number(pendingRows[0]?.n ?? 0);

  let { settlements, highestBlock } = await scanSettlements(b.chainId, b.ethPipe, ethTxBlock);

  // Etherscan's `startblock` filter misbehaves on Arbitrum: querying from the
  // contract's own deploy block returns "No transactions found", while querying
  // from 0 returns the very same transactions starting at that block. So when a
  // bridge still has unsettled messages and a cursor-based scan comes back
  // empty, retry from zero before believing there's nothing there. Gated on
  // `pending` so caught-up bridges don't re-walk their history every cycle.
  if (settlements.size === 0 && pending > 0 && ethTxBlock > 0) {
    ({ settlements, highestBlock } = await scanSettlements(b.chainId, b.ethPipe, 0));
    if (settlements.size > 0) {
      logger.info({ bridge: b.key, found: settlements.size },
        'bridge: settlement scan recovered by restarting from block 0');
    }
  }

  if (settlements.size === 0) {
    if (highestBlock > ethTxBlock) await writeEthTxCursor(b.key, highestBlock);
    return 0;
  }

  let updated = 0;
  for (const s2 of settlements.values()) {
    // eslint-disable-next-line no-await-in-loop
    const { rowCount } = await q(
      `UPDATE bridge_messages
          SET status       = $4,
              settle_tx    = $5,
              settle_block = $6,
              settle_ts    = $7,
              updated_at   = now()
        WHERE bridge = $1 AND direction = 'beam2eth' AND msg_id = $2 AND chain_id = $3
          -- Never downgrade a relayed message: the relayer re-submits settled
          -- messages and those retries revert.
          AND status IS DISTINCT FROM 'relayed'`,
      [b.key, s2.msgId, b.chainId, s2.success ? 'relayed' : 'failed', s2.txHash, s2.block, s2.ts],
    );
    updated += rowCount ?? 0;
  }

  if (highestBlock > ethTxBlock) await writeEthTxCursor(b.key, highestBlock);
  return updated;
}

// ---------------------------------------------------------------------------
// Escrow: what actually backs the minted supply
// ---------------------------------------------------------------------------

/** Native BEAM (aid 0) locked in a Beam-side Pipe, read from the explorer's
 *  "Locked Funds" table. Raw groths — the response must come from a request
 *  without `exp_am`, which would return a formatted string like
 *  "1,736,549.28438526". */
function beamLockedFunds(contract: ContractResponse): bigint | null {
  const table = (contract as unknown as Record<string, unknown>)['Locked Funds'];
  const rows = (table as { value?: unknown[] } | undefined)?.value;
  if (!Array.isArray(rows)) return null;
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 2) continue;
    const key = row[0] as { type?: string; value?: unknown } | undefined;
    const val = row[1] as { type?: string; value?: unknown } | undefined;
    if (key?.type === 'aid' && Number(key.value) === 0 && val?.value !== undefined) {
      try {
        return BigInt(String(val.value).replace(/[,\s]/g, ''));
      } catch {
        return null;
      }
    }
  }
  return null;
}

async function snapshotEscrow(b: BridgeDef, contract: ContractResponse): Promise<void> {
  const block = await blockNumber(b.chainId);
  let locked: bigint;
  let lockedDecimals: number;
  let minted: bigint | null = null;
  let mintedDecimals: number | null = null;

  if (b.custody === 'beam') {
    // Collateral is native BEAM held by the Beam Pipe; the wrapped asset is the
    // ERC20 minted on Ethereum. Asking the Ethereum Pipe for a balance here
    // yields 0 — it mints rather than escrows.
    const beamLocked = beamLockedFunds(contract);
    if (beamLocked === null) {
      logger.warn({ bridge: b.key }, 'bridge: could not read Beam-side locked funds; skipping escrow snapshot');
      return;
    }
    locked = beamLocked;
    lockedDecimals = b.decimals;
    minted = b.ethToken ? await erc20TotalSupply(b.ethToken, b.chainId) : 0n;
    mintedDecimals = b.ethDecimals;
  } else {
    locked = b.ethToken
      ? await erc20BalanceOf(b.ethToken, b.ethPipe, b.chainId)
      : await getBalance(b.ethPipe, b.chainId);
    lockedDecimals = b.ethDecimals;
    // minted stays null: the repo derives it from the Beam asset's emission.
  }

  await q(
    `INSERT INTO bridge_escrow
       (bridge, chain_id, token, locked, decimals, minted, minted_decimals, block_number, observed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
     ON CONFLICT (bridge) DO UPDATE SET
       chain_id = EXCLUDED.chain_id, token = EXCLUDED.token, locked = EXCLUDED.locked,
       decimals = EXCLUDED.decimals, minted = EXCLUDED.minted,
       minted_decimals = EXCLUDED.minted_decimals, block_number = EXCLUDED.block_number,
       observed_at = now()`,
    [
      b.key, b.chainId, b.ethToken, locked.toString(), lockedDecimals,
      minted === null ? null : minted.toString(), mintedDecimals, block,
    ],
  );

  await q(
    `INSERT INTO bridge_escrow_snapshots
       (bridge, chain_id, locked, decimals, minted, minted_decimals, block_number)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT DO NOTHING`,
    [
      b.key, b.chainId, locked.toString(), lockedDecimals,
      minted === null ? null : minted.toString(), mintedDecimals, block,
    ],
  );
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface BridgeSyncResult {
  bridges: number;
  outgoingIngested: number;
  incomingOpen: number;
  shaderCalls: number;
  logsIngested: number;
  settled: number;
  logsCaughtUp: number;
  heightsResolved: number;
  /** Incoming messages stamped with their Beam delivery/claim block. */
  beamSideResolved: number;
}

export async function syncBridges(): Promise<BridgeSyncResult> {
  const res: BridgeSyncResult = {
    bridges: 0, outgoingIngested: 0, incomingOpen: 0, shaderCalls: 0,
    logsIngested: 0, settled: 0, logsCaughtUp: 0, heightsResolved: 0,
    beamSideResolved: 0,
  };
  const fullSweep = cycleCount % FULL_SWEEP_EVERY === 0;
  cycleCount += 1;

  for (const b of BRIDGES) {
    try {
      // Ethereum log ingest first: it establishes which incoming msgIds exist,
      // which is what makes the Beam-side status sweep meaningful.
      // eslint-disable-next-line no-await-in-loop
      const { found, caughtUp } = await ingestIncomingLogs(b);
      // eslint-disable-next-line no-await-in-loop
      const ingested = await ingestOutgoing(b);
      // eslint-disable-next-line no-await-in-loop
      await repairImpreciseOutgoing(b);
      // One explorer read of the Pipe serves both the call-history resolvers
      // and the locked-funds read. Paged: the resolvers map heights anywhere in
      // history, and the explorer caps a single response at 2000 calls — the
      // BEAM/WBEAM Pipe is past that, so a single fetch loses its oldest calls.
      // eslint-disable-next-line no-await-in-loop
      const contract = await getContractFullHistory({ id: b.cid });
      // eslint-disable-next-line no-await-in-loop
      const resolvedHeights = await resolveBeamHeights(b, contract);
      // eslint-disable-next-line no-await-in-loop
      const { scanned, open } = await refreshIncoming(b, fullSweep);
      // eslint-disable-next-line no-await-in-loop
      const settled = await settleOutgoing(b);
      // eslint-disable-next-line no-await-in-loop
      await snapshotEscrow(b, contract);
      res.bridges += 1;
      res.outgoingIngested += ingested;
      res.incomingOpen += open;
      res.shaderCalls += scanned + ingested + 1;
      res.logsIngested += found;
      res.heightsResolved += resolvedHeights.outgoing;
      res.beamSideResolved += resolvedHeights.incoming;
      res.settled += settled;
      if (caughtUp) res.logsCaughtUp += 1;
      logger.debug({ bridge: b.key, ingested, scanned, open, fullSweep }, 'bridge synced');
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
