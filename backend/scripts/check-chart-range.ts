import { alignRange, tilesFor, tileSpan } from '../src/api/routes/chart-range.js';
import assert from 'node:assert';

// 1h tile span = 256h
assert.equal(tileSpan('1h'), 256 * 3600);
// floor/ceil superset: a mid-bucket window widens outward, never inward
const a = alignRange(12 * 3600 + 29, 13 * 3600 + 29, '1h');
assert.equal(a.from, 12 * 3600);
assert.equal(a.to, 14 * 3600); // ceil past 13:00:29 -> 14:00
// tiles cover the window, ascending, tile-aligned
const t = tilesFor(0, tileSpan('1m') * 2 + 5, '1m');
assert.deepEqual(t, [0, tileSpan('1m'), tileSpan('1m') * 2]);
console.log('chart-range math OK');
