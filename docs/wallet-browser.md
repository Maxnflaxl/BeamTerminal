# BEAM Wallet embedded browser — limitations & workarounds

The same React bundle that serves the public website also runs as a `.dapp`
inside the **BEAM desktop wallet**, whose embedded browser is **QtWebEngine
5.15.2 ≈ Chromium/Chrome 83** (≈ 2020). Any CSS/JS newer than Chrome 83 is either
silently ignored or throws — and because the wallet is our primary target, a
feature that "works on the website" can still break the DApp.

This is the single reference for what's unavailable and the patterns we use
instead. When you reach for a modern CSS/JS feature, check it here first.

## Version cheat-sheet

| Feature | Min Chrome | Available in wallet (83)? |
|---|---|---|
| flexbox / grid `gap` | 84 | ❌ (silently ignored) |
| `inset` shorthand | 87 | ❌ (overlay collapses to 0×0) |
| `:has()` selector | 105 | ❌ |
| `Element.replaceChildren()` | 86 | ❌ |
| `HTMLInputElement.showPicker()` | 99 | ❌ |
| `clamp()` / `min()` / `max()` | 79 | ✅ (but treated as web-only, see below) |
| `IntersectionObserver` | 51 | ✅ |
| `window.matchMedia` | ✅ | ✅ (legacy `addListener` path) |

## Detecting the wallet

Two helpers gate wallet-only behaviour, both keying off the UA and injected
globals:

- `core/walletEnv.ts` `isInsideWallet()` — true if UA matches `/QtWebEngine/i`,
  or `window.qt` is defined, or `window.BEAM` is truthy, or UA matches
  `/beam.*wallet/i`.
- `core/BeamDappConnector.js` `_detectEnvironment()` / `static isDesktop()` —
  desktop wallet iff `/QtWebEngine/i` in the UA. The desktop transport is a **Qt
  WebChannel** exposing `channel.objects.BEAM` (`.api`, `.style`).

Use `isDesktop()` to hide UI that can't work in the wallet (see downloads below).

## CSS: unsupported features & the patterns we use instead

### `gap` (flexbox and grid) — UNSUPPORTED

The single most common trap. `gap` is silently ignored, so spacing just
disappears in the wallet. Never use `gap` on a flex/grid container in
wallet-facing components. Instead:

- **Fixed-order rows/columns** — the "lobotomized owl" selector:
  ```css
  & > * + * { margin-left: 12px; }   /* or margin-top for columns */
  ```
- **`flex-wrap` containers** (chips, tag rows) — negative-outer-margin so wrapped
  rows also space correctly (see `explorer/Dapps.tsx`):
  ```css
  .container { margin: -3px; }
  .container > * { margin: 3px; }
  ```
- **Single adjacent element** — a plain `margin-right`/`margin-left`
  (`Footer.tsx`, `shared/components/BackButton.tsx`).
- **Grids** — use the legacy `grid-gap` (Chrome-83-supported), not `gap`
  (`StatsBar.tsx`).

Documented at: `BackButton.tsx:34`, `Footer.tsx:96`, `SimpleChart.tsx:17`,
`BlackholeChart.tsx:89`, `explorer/Dapps.tsx:61`, `explorer/dao/DaoTreasury.tsx:158`,
`explorer/Mining.tsx:326`, `explorer/ActionTimeline.tsx:150`.

> ⚠️ **`gap:` audit:** the core DEX paths — `Footer` grid, `LiquidityBanner`
> tiers grid, and the `PairsList` mobile card/stats grids — have been converted to
> `grid-gap`. A broader grep still finds ~20 non-zero `gap:` usages across the
> explorer/DAO pages and a few inline styles that would also lose their spacing in
> the wallet (grids → `grid-gap`, flex → owl-margins). Sweeping those is tracked
> in the root `TODO.md`. (`gap: 0` is harmless — no spacing either way.)

### `inset` shorthand — UNSUPPORTED (needs Chromium ≥ 87)

`inset: 0` collapses a fixed/absolute overlay to 0×0, so backdrops vanish and
modals appear not to open. Always spell out the four edges:
```css
top: 0; right: 0; bottom: 0; left: 0;
```
Documented at: `components/modalChrome.tsx:24`, `ConfidentialAssetsChart.tsx:55`,
`BlackholeChart.tsx:147`, `explorer/Dapps.tsx:250`.

### `:has()` — UNSUPPORTED

Avoid entirely in wallet-facing components (`BeamExplorer.tsx:1951` restyles a
swatch without it). It's used only in the **web/mobile shell** selectors
(`styles.ts:128` `html:has(body.web)` / `html:has(body.mobile)`), which never run
in the wallet.

### `clamp()` / `min()` / `max()` — web-only by convention

Supported in Chrome 83, but the codebase keeps them out of wallet-critical layout
and confines them to the web/mobile shell (`styles.ts:27`, `Countdown.tsx:156`).
Prefer fixed values / media queries in DApp paths.

### Multi-line clamp & box layout — use legacy `-webkit-box`

For line-clamping and some flex box models, use the old prefixed properties
(`display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: N;` and
`-webkit-box-align/-pack/-flex/-direction`). Seen across `explorer/Mining.tsx`,
`AssetsList.tsx`, `MiningCalculator.tsx`, `ConfidentialAssetsChart.tsx`,
`BlackholeChart.tsx`.

## JS / DOM APIs: unavailable & workarounds

| API | Problem | Workaround |
|---|---|---|
| `Element.replaceChildren()` (Chrome 86+) | Not a function | `chartTheme.ts` `clearChildren()` loops `removeChild`; build DOM with `appendChild` loops (all chart legend builders) |
| `HTMLInputElement.showPicker()` (Chrome 99+) | Doesn't exist | `CenterOnControl.tsx` overlays a transparent `<input type="date">` sized to the icon to trigger the native picker |
| QtWebEngine `downloadRequested` handler | Absent in the wallet profile → browser downloads are silently dropped | Hide download UI when `BeamDappConnector.isDesktop()` (`explorer/Dapps.tsx:558`) |
| Native `<datalist>` popup | Unthemeable and won't reliably open on click in QtWebEngine | Custom themed dropdown combobox (`BeamExplorer.tsx:2874`) |
| `IntersectionObserver` | **Available** | Used for chart-cell virtualization (caps canvas/WebGL memory) with an always-mounted fallback (`NetworkCharts.tsx:808`) |
| `window.matchMedia` | **Available** | Used with a `typeof` guard + legacy `addListener` path (`PairsList.tsx:131`) |

## Rule of thumb

Before using any CSS/JS feature in a component that renders inside the wallet:
if it shipped in Chrome **after 83** (mid-2020), assume it's unavailable and use
the patterns above. When in doubt, add a short comment citing "Chrome 83 /
QtWebEngine 5.15.2" next to the workaround so the constraint stays discoverable.
