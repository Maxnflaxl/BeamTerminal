import { pickResolution } from './zoomResolution';
import assert from 'node:assert';
const H = 3600, D = 86_400, FULL: ('1m'|'1h'|'1d')[] = ['1m','1h','1d'];
assert.equal(pickResolution(12 * H, FULL), '1m');   // 12h → 720 min-pts ≤ 2000
assert.equal(pickResolution(5 * D, FULL), '1h');    // 5d → 120 h-pts (1m would be 7200 > 2000)
assert.equal(pickResolution(200 * D, FULL), '1d');  // 200d → 200 d-pts
assert.equal(pickResolution(5 * D, ['1d']), '1d');  // daily-only never goes finer
console.log('pickResolution OK');
