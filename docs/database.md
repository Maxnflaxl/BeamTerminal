# Database — PostgreSQL + TimescaleDB

Single Postgres instance. TimescaleDB extension. One database: `beamterminal`. Schema lives in `backend/migrations/*.sql` and is applied in lexical order by `backend/scripts/migrate.ts`, which tracks applied files in a `schema_migrations` table.

**Conventions across every table**:

* Times — `TIMESTAMPTZ`, stored as UTC.
* Token amounts — `NUMERIC(40, 0)`, representing **groths** (BEAM-native 8 decimals). Always parse as BigInt in the indexer; many values exceed `Number.MAX_SAFE_INTEGER`.
* USD numbers — `NUMERIC(20, 8)`.
* Block heights — `BIGINT`.

## Tables

### `assets` — token metadata cache

`migrations/002_assets.sql` + `016_asset_minter.sql`.

```sql
CREATE TABLE assets (
  aid                BIGINT PRIMARY KEY,
  name               TEXT,           -- N
  short_name         TEXT,           -- SN
  unit_name          TEXT,           -- UN
  description        TEXT,           -- OPT_SHORT_DESC
  decimals           SMALLINT NOT NULL DEFAULT 8,
  is_imposter        BOOLEAN  NOT NULL DEFAULT FALSE,
  imposter_reason    TEXT,
  emission           NUMERIC(40, 0),
  first_seen_height  BIGINT,
  last_updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- added by 016_asset_minter.sql:
  minter_cid         TEXT,
  max_supply         NUMERIC(40, 0)  -- NULL = no cap (or non-minter asset)
);
CREATE INDEX assets_short_name_lower_idx ON assets (lower(short_name));

-- Seeded by the migration: BEAM (aid 0). Native chain asset, no /assets entry.
INSERT INTO assets (aid, name, short_name, unit_name, description, decimals)
VALUES (0, 'Beam', 'BEAM', 'BEAM', 'Native BEAM asset', 8);
```

`max_supply IS NULL` means either: not minter-issued, or the minter's `Limit` is the contract's UINT64_MAX "unlimited" sentinel. BEAM (aid 0) gets `emission` and `max_supply` populated from `/status?exp_am=1` totals by `syncBeamSupply` — not from the minter contract.

### `pools` — pool registry

`migrations/005_pools.sql`.

```sql
CREATE TABLE pools (
  pool_id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  aid1                 BIGINT NOT NULL REFERENCES assets(aid),
  aid2                 BIGINT NOT NULL REFERENCES assets(aid),
  kind                 SMALLINT NOT NULL CHECK (kind IN (0, 1, 2)),  -- 0=Low(0.05%), 1=Medium(0.30%), 2=High(1.00%)
  aid_ctl              BIGINT NOT NULL REFERENCES assets(aid),       -- LP token AID
  created_at_height    BIGINT NOT NULL,
  created_at_ts        TIMESTAMPTZ,
  destroyed_at_height  BIGINT,
  UNIQUE (aid1, aid2, kind)
);
CREATE INDEX pools_aid1_idx    ON pools (aid1);
CREATE INDEX pools_aid2_idx    ON pools (aid2);
CREATE INDEX pools_aid_ctl_idx ON pools (aid_ctl);
```

Pool identity is `(aid1, aid2, kind)` with the contract's well-ordering `aid1 < aid2`. The indexer normalizes call arguments to this ordering before lookup; the unique constraint locks it in.

### `trades` — hypertable

`migrations/007_trades_hypertable.sql` + `010_trades_price_volume.sql` + `014_dedupe_and_unique.sql`.

```sql
CREATE TABLE trades (
  trade_id      BIGINT GENERATED ALWAYS AS IDENTITY,
  pool_id       BIGINT NOT NULL REFERENCES pools(pool_id),
  height        BIGINT NOT NULL,
  block_ts      TIMESTAMPTZ NOT NULL,
  aid_in        BIGINT NOT NULL,
  aid_out       BIGINT NOT NULL,
  amount_in     NUMERIC(40, 0) NOT NULL,  -- positive magnitudes; direction lives in (aid_in, aid_out)
  amount_out    NUMERIC(40, 0) NOT NULL,
  confirmed     BOOLEAN NOT NULL DEFAULT FALSE,
  -- added by 010_trades_price_volume.sql (pre-computed for candle aggregates):
  price_native  NUMERIC(40, 20),          -- aid2 per 1 aid1, in canonical pool ordering
  volume_aid1   NUMERIC(40, 0),           -- aid1 groths that moved on this trade
  volume_aid2   NUMERIC(40, 0),           -- aid2 groths that moved
  PRIMARY KEY (trade_id, block_ts)
);
SELECT create_hypertable('trades', 'block_ts', chunk_time_interval => INTERVAL '7 days');

CREATE INDEX trades_pool_ts_idx ON trades (pool_id, block_ts DESC);
CREATE INDEX trades_height_idx  ON trades (height);
-- Cheap "promote to confirmed" updates:
CREATE INDEX trades_unconfirmed_height_idx
  ON trades (height) WHERE confirmed = FALSE;

-- Natural-key dedupe (migration 014):
CREATE UNIQUE INDEX trades_natural_key_idx
  ON trades (pool_id, height, aid_in, aid_out, amount_in, amount_out, block_ts);
```

**Why no `tx_kernel` column**: the explorer's `Calls history` rows expose an empty `Keys` cell on the build we deploy. We can't extract a kernel hash, so idempotency uses the natural key (pool + height + direction + magnitudes + timestamp). Limitation: two legitimately-identical trades in the same block collapse to one row — vanishingly rare for AMMs (slippage tolerances make exact-match duplicates almost impossible) and the alternative corrupted every downstream aggregate.

**Why `price_native` / `volume_aid1` / `volume_aid2` are pre-computed**: continuous aggregates over `trades` would otherwise need to join `pools` to map (aid_in, aid_out) → canonical (aid1, aid2). The indexer does this once at insert time so the aggregates can be plain `SUM`/`first`/`last` on indexed columns.

### `lp_events` — hypertable

`migrations/008_lp_events_hypertable.sql` + `014_dedupe_and_unique.sql`.

```sql
CREATE TABLE lp_events (
  event_id    BIGINT GENERATED ALWAYS AS IDENTITY,
  pool_id     BIGINT NOT NULL REFERENCES pools(pool_id),
  height      BIGINT NOT NULL,
  block_ts    TIMESTAMPTZ NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('Deposit', 'Withdraw')),
  amount1     NUMERIC(40, 0) NOT NULL,
  amount2     NUMERIC(40, 0) NOT NULL,
  amount_ctl  NUMERIC(40, 0) NOT NULL,   -- LP tokens minted (Deposit) or burned (Withdraw)
  confirmed   BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (event_id, block_ts)
);
SELECT create_hypertable('lp_events', 'block_ts', chunk_time_interval => INTERVAL '7 days');

CREATE INDEX lp_events_pool_ts_idx ON lp_events (pool_id, block_ts DESC);
CREATE INDEX lp_events_height_idx  ON lp_events (height);
CREATE INDEX lp_events_unconfirmed_height_idx
  ON lp_events (height) WHERE confirmed = FALSE;

CREATE UNIQUE INDEX lp_events_natural_key_idx
  ON lp_events (pool_id, height, kind, amount1, amount2, amount_ctl, block_ts);
```

### `pool_state_snapshots` — hypertable

`migrations/009_pool_state_snapshots.sql`.

```sql
CREATE TABLE pool_state_snapshots (
  pool_id     BIGINT NOT NULL REFERENCES pools(pool_id),
  height      BIGINT NOT NULL,
  ts          TIMESTAMPTZ NOT NULL,
  reserve1    NUMERIC(40, 0) NOT NULL,  -- groths of aid1 in pool
  reserve2    NUMERIC(40, 0) NOT NULL,
  ctl_supply  NUMERIC(40, 0) NOT NULL,  -- LP token total supply
  PRIMARY KEY (pool_id, ts)
);
SELECT create_hypertable('pool_state_snapshots', 'ts', chunk_time_interval => INTERVAL '7 days');
CREATE INDEX pool_state_snapshots_height_idx ON pool_state_snapshots (height);
```

One row per pool per indexer tick. The hourly continuous aggregate `liquidity_1h` (below) is the long-term backing store for TVL charts.

### `oracle_snapshots` — hypertable

`migrations/004_oracle_snapshots.sql`.

```sql
CREATE TABLE oracle_snapshots (
  ts        TIMESTAMPTZ NOT NULL PRIMARY KEY,
  height    BIGINT NOT NULL,
  beam_usd  NUMERIC(20, 8) NOT NULL,
  h_end     BIGINT NOT NULL                -- highest active feed height (approximates on-chain m_hEnd)
);
SELECT create_hypertable('oracle_snapshots', 'ts', chunk_time_interval => INTERVAL '30 days');
CREATE INDEX oracle_snapshots_height_idx ON oracle_snapshots (height DESC);
```

### `block_timestamps` — height cache

`migrations/006_block_timestamps.sql`.

```sql
CREATE TABLE block_timestamps (
  height  BIGINT PRIMARY KEY,
  ts      TIMESTAMPTZ NOT NULL
);
```

Populated lazily by the indexer (one `GET /block?height=H` per uncached height; an in-process LRU sits in front of this table). Reorg rewinds delete past-ancestor rows from here too so re-ingest re-fetches the chain's authoritative timestamp.

### `cursor` — single-row indexer state

`migrations/003_cursor.sql` + `013_aggregates_marker.sql`.

```sql
CREATE TABLE cursor (
  id                              INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_indexed_height             BIGINT NOT NULL DEFAULT 0,
  last_indexed_hash               BYTEA,
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
  aggregates_refreshed_at_height  BIGINT NOT NULL DEFAULT 0
);
INSERT INTO cursor (id, last_indexed_height) VALUES (1, 0);
```

The `aggregates_refreshed_at_height` field is how the indexer recovers from a crash mid-backfill: if it lags `last_indexed_height` on startup, `catchUpAggregatesIfNeeded()` re-runs `refresh_continuous_aggregate(view, NULL, NULL)` for every candle/liquidity view.

### `dex_stats` — slow-aggregate cache

`migrations/015_dex_stats.sql`.

```sql
CREATE TABLE dex_stats (
  id                INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  total_volume_usd  NUMERIC,
  refreshed_at      TIMESTAMPTZ
);
INSERT INTO dex_stats (id) VALUES (1);
```

`/api/stats.total_volume_usd` is precomputed by the indexer because the underlying query — hourly buckets of every trade, each priced against the nearest oracle snapshot and the deepest BEAM-quoted pool of each side — exceeded Cloudflare Tunnel's ~100 s edge timeout on production data. The indexer refreshes this every 5 minutes via `maybeKickDexStatsRefresh()`; the API reads it instantly.

### `schema_migrations` — migration runner

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  name        TEXT PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Created on demand by `scripts/migrate.ts`. Each migration runs inside a transaction; success records the filename, failure rolls back.

## Continuous aggregates (candles)

`migrations/011_candle_aggregates.sql`. One materialized view per chart timeframe.

```sql
CREATE MATERIALIZED VIEW candles_1m
WITH (timescaledb.continuous) AS
SELECT pool_id,
       time_bucket(INTERVAL '1 minute', block_ts) AS bucket,
       first(price_native, block_ts) AS open,
       max(price_native)              AS high,
       min(price_native)              AS low,
       last(price_native, block_ts)  AS close,
       sum(volume_aid1)               AS volume_aid1,
       sum(volume_aid2)               AS volume_aid2,
       count(*)                       AS trade_count
FROM trades
WHERE confirmed = TRUE AND price_native IS NOT NULL AND price_native > 0
GROUP BY pool_id, bucket
WITH NO DATA;

SELECT add_continuous_aggregate_policy('candles_1m',
  start_offset      => INTERVAL '6 hours',
  end_offset        => INTERVAL '1 minute',
  schedule_interval => INTERVAL '1 minute');
```

Repeated for 5m, 15m, 1h, 4h, 1d with these refresh windows:

| View | Bucket | `start_offset` | `schedule_interval` |
|---|---|---|---|
| `candles_1m`  | 1 min  | 6 hours  | 1 min |
| `candles_5m`  | 5 min  | 24 hours | 5 min |
| `candles_15m` | 15 min | 3 days   | 15 min |
| `candles_1h`  | 1 hour | 14 days  | 1 hour |
| `candles_4h`  | 4 hours| 30 days  | 4 hours |
| `candles_1d`  | 1 day  | 90 days  | 1 day |

Notes:

* `WHERE confirmed = TRUE` keeps unconfirmed trades out of candles. When the indexer flips `confirmed → TRUE` (80 blocks ≈ 80 min later), the next refresh re-materializes that bucket — the 80-block window sits inside every `start_offset`.
* `WITH NO DATA` means the initial backfill must be triggered manually; `indexer.ts:refreshAllAggregates()` calls `CALL refresh_continuous_aggregate(view, NULL, NULL)` once the historical backfill finishes.
* `price_native` is already in canonical pool ordering (aid2 per aid1) and `volume_aid1` / `volume_aid2` are pre-computed at insert time (see `010_trades_price_volume.sql`), so the aggregates need no joins.

## Liquidity continuous aggregate

`migrations/012_liquidity_aggregate.sql`.

```sql
CREATE MATERIALIZED VIEW liquidity_1h
WITH (timescaledb.continuous) AS
SELECT pool_id,
       time_bucket(INTERVAL '1 hour', ts) AS bucket,
       last(reserve1, ts)   AS reserve1,
       last(reserve2, ts)   AS reserve2,
       last(ctl_supply, ts) AS ctl_supply
FROM pool_state_snapshots
GROUP BY pool_id, bucket
WITH NO DATA;

SELECT add_continuous_aggregate_policy('liquidity_1h',
  start_offset      => INTERVAL '14 days',
  end_offset        => INTERVAL '1 hour',
  schedule_interval => INTERVAL '1 hour');
```

USD valuation happens at query time, not in the view — the BEAM/USD reference moves and we want recomputation on every oracle update rather than baking in a stale value.

## Common query shapes

### `/api/pairs` — the big pair list query

A single SQL statement with five `LATERAL` joins per pool: current snapshot, latest trade, 24h aggregates, 24h-ago reference trade, and last-trade timestamp. Full source: `backend/src/api/repos/pairs.ts:listPairs`.

The query materializes the whole CTE then sorts on a derived column. Acceptable at ~100 pools today; switch to a covering index or a periodically-refreshed materialized view if pair count grows by 10×.

USD-denominated sorts (`tvl_usd`, `volume_24h_usd`) are computed app-side, not in SQL — see [api.md §Sort routing](api.md#sort-routing).

### `/api/pairs/{id}/ohlcv` — chart candles

```sql
SELECT bucket, open, high, low, close, volume_aid1, trade_count
  FROM candles_<interval>
 WHERE pool_id = $1 AND bucket < $2
 ORDER BY bucket DESC
 LIMIT $3
```

The continuous aggregate makes this O(rows-returned). USD conversion is applied in the route handler when `denom=usd`, looking up the BEAM/USD reference per-candle from `oracle_snapshots`.

### `/cg/tickers` — CoinGecko-spec tickers

One row per non-imposter, non-destroyed pool. Joined with `latest_snap`, `latest_trade`, `window_24h` CTEs and the BEAM/USD valuation table. Full source: `backend/src/api/routes/cg/tickers.ts`.

## USD valuation strategy

`backend/src/api/repos/usd.ts:loadUsdTable` builds a per-AID USD rate table:

1. BEAM (aid 0) — direct: `1 BEAM = beam_usd USD` from the latest `oracle_snapshots` row.
2. Every other AID — routed through its deepest BEAM-quoted pool: `usd_per_whole_aid = beam_usd × (beam_reserve / other_reserve)`, taking the highest-reserve BEAM-quoted pool per AID.
3. Assets that aren't reachable via any BEAM-quoted pool get no USD rate (the Map omits them); callers treat that as "no USD valuation possible".

This routing is what enables USD figures for non-BEAM pairs (e.g. `USDT/BeamX`) without depending on an external price API.

## Backup

```sh
docker compose exec postgres \
  pg_dump -Fc -U beamterminal beamterminal > backups/$(date +%F).dump
```

Daily, kept 30 days, replicated off-host. The indexer can fully rebuild from chain history if backups are lost, so backups are a convenience, not a hard requirement.

## Sizing

Rough order-of-magnitude, measured against production.

| Item | Per row | Rows/year (est.) | Bytes/year |
|---|---|---|---|
| trades | ~140 bytes | ~500K | ~70 MB |
| lp_events | ~120 bytes | ~50K | ~6 MB |
| pool_state_snapshots | ~80 bytes | ~525K (≈1/min × 100 pools) | ~40 MB |
| oracle_snapshots | ~80 bytes | ~525K | ~40 MB |
| candles (all timeframes) | ~120 bytes | dominated by retained-forever 1d × 100 pools | small |
| block_timestamps | ~24 bytes | ~525K | ~13 MB |

Under 200 MB/year uncompressed for the indexer's own tables. Timescale's native chunk compression shrinks closed chunks ~10× when enabled. The bigger disk consumer is the `explorer-node`'s chain DB (single-digit GB and growing slowly).
