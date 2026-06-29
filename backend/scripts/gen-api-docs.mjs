// Generates backend/src/api/apiDocs.generated.ts — a single HTML string rendered
// from docs/api.md + docs/CoinGecko.md. Run via `yarn gen:apidocs` whenever those
// docs change. The HTML is embedded (JSON.stringify) so it ships in the API image
// with no runtime markdown dep and no Docker build-context dependency on docs/.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { marked } from 'marked';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');              // backend/scripts -> repo root
const docsDir = join(repoRoot, 'docs');
const outFile = join(here, '..', 'src', 'api', 'apiDocs.generated.ts');

function readDoc(name) {
  try { return readFileSync(join(docsDir, name), 'utf8'); }
  catch { console.error(`gen-api-docs: missing docs/${name}`); process.exit(1); }
}

marked.setOptions({ gfm: true });

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

// Render one markdown doc; inject ids into h2/h3 and collect a TOC.
async function render(md, sectionId) {
  let html = await marked.parse(md);
  const toc = [];
  const seen = new Set();
  html = html.replace(/<h([23])[^>]*>([\s\S]*?)<\/h\1>/g, (_m, lvl, inner) => {
    const text = inner.replace(/<[^>]+>/g, '').trim();
    let id = `${sectionId}-${slug(text)}`;
    while (seen.has(id)) id += '-x';
    seen.add(id);
    toc.push({ lvl: Number(lvl), id, text });
    return `<h${lvl} id="${id}">${inner}</h${lvl}>`;
  });
  return { html, toc };
}

const api = await render(readDoc('api.md'), 'api');
const cg  = await render(readDoc('CoinGecko.md'), 'cg');

const tocHtml = (title, toc) =>
  `<div class="toc-group"><div class="toc-title">${title}</div>` +
  toc.map((t) => `<a class="toc-l${t.lvl}" href="#${t.id}">${t.text}</a>`).join('') +
  `</div>`;

const page = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>BeamTerminal API</title>
<style>
:root{--bg:#042548;--surface:rgba(255,255,255,.04);--border:rgba(255,255,255,.12);--text:#e8f0f7;--muted:rgba(232,240,247,.6);--accent:#00f6d2;--link:#4f9dff}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.6 -apple-system,Segoe UI,Roboto,sans-serif}
a{color:var(--link);text-decoration:none}a:hover{text-decoration:underline}
.wrap{display:grid;grid-template-columns:260px 1fr;gap:24px;max-width:1200px;margin:0 auto;padding:24px}
.sidebar{position:sticky;top:24px;align-self:start;max-height:calc(100vh - 48px);overflow:auto;border-right:1px solid var(--border);padding-right:12px}
.toc-group{margin-bottom:18px}
.toc-title{font-weight:700;color:var(--accent);text-transform:uppercase;font-size:11px;letter-spacing:.05em;margin-bottom:6px}
.sidebar a{display:block;padding:2px 0;color:var(--muted);font-size:13px}
.sidebar a.toc-l3{padding-left:12px;font-size:12px}
.sidebar a:hover{color:var(--text)}
.content{min-width:0}
.content h1{color:var(--accent)} .content h2{border-top:1px solid var(--border);padding-top:18px;margin-top:28px}
.content code{background:var(--surface);padding:2px 5px;border-radius:4px;font-family:ui-monospace,Menlo,monospace;font-size:12.5px}
.content pre{background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:12px;overflow:auto}
.content pre code{background:none;padding:0}
.content table{border-collapse:collapse;width:100%;margin:12px 0}
.content th,.content td{border:1px solid var(--border);padding:6px 10px;text-align:left}
.content th{background:var(--surface)}
@media(max-width:820px){.wrap{grid-template-columns:1fr}.sidebar{position:static;max-height:none;border-right:none;border-bottom:1px solid var(--border);padding-bottom:12px}}
.site-footer{border-top:1px solid var(--border)}
.site-footer-inner{max-width:1200px;margin:0 auto;padding:24px;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:24px}
.site-footer .fcol-title{font-weight:700;color:var(--accent);text-transform:uppercase;font-size:11px;letter-spacing:.05em;margin-bottom:8px}
.site-footer a{display:block;color:var(--muted);font-size:13px;padding:2px 0}
.site-footer a:hover{color:var(--text)}
@media(max-width:820px){.site-footer-inner{grid-template-columns:1fr 1fr}}
</style></head>
<body><div class="wrap">
<nav class="sidebar">${tocHtml('Internal /api', api.toc)}${tocHtml('CoinGecko /cg', cg.toc)}</nav>
<main class="content">
<h1>BeamTerminal API</h1>
<p class="muted">Read-only reference, generated from <code>docs/api.md</code> and <code>docs/CoinGecko.md</code>. All endpoints are open, GET-only. Base URL: <code>https://beamterminal.0xmx.net</code>.</p>
${api.html}
<hr>
<h1>CoinGecko endpoints</h1>
${cg.html}
</main></div>
<footer class="site-footer"><div class="site-footer-inner">
<div><div class="fcol-title">BEAM</div><a href="https://beam.mw" target="_blank" rel="noopener noreferrer">beam.mw</a></div>
<div><div class="fcol-title">Community</div><a href="https://x.com/beamprivacy" target="_blank" rel="noopener noreferrer">X (Twitter)</a><a href="https://t.me/beamprivacy" target="_blank" rel="noopener noreferrer">Telegram</a><a href="https://discord.gg/fwfArUqpfh" target="_blank" rel="noopener noreferrer">Discord</a></div>
<div><div class="fcol-title">BeamTerminal</div><a href="https://github.com/Maxnflaxl/BeamTerminal" target="_blank" rel="noopener noreferrer">GitHub</a><a href="https://beamterminal.0xmx.net/api/">API</a><a href="https://beamterminal.0xmx.net/#/privacy" target="_blank" rel="noopener noreferrer">Privacy Policy</a></div>
<div><div class="fcol-title">Contact</div><a href="mailto:me@maxnflaxl.dev">me@maxnflaxl.dev</a><a href="https://t.me/maxnflaxl" target="_blank" rel="noopener noreferrer">Telegram (@maxnflaxl)</a></div>
</div></footer>
</body></html>`;

const banner = '// AUTO-GENERATED by backend/scripts/gen-api-docs.mjs from docs/api.md + docs/CoinGecko.md.\n// Do not edit by hand — run `yarn gen:apidocs` after changing those docs.\n';
writeFileSync(outFile, `${banner}export const API_DOCS_HTML = ${JSON.stringify(page)};\n`);
console.log(`gen-api-docs: wrote ${outFile} (${page.length} bytes of HTML)`);
