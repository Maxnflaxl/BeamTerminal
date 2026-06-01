import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { css } from '@linaria/core';
import { api } from '@app/containers/Screener/api/client';
import type { ApiSearch, SearchItem } from '@app/containers/Screener/api/types';
import AssetIcon from '@app/shared/components/AssetsIcon';

const TYPE_ICON: Record<string, string> = {
  asset: '🪙', pool: '🔁', dapp: '🧩', publisher: '🪪',
  block: '🧱', kernel: '🔑', contract: '📜', bans: '🏷️', chart: '📈', ipfs: '🌐',
  page: '🧭',
};

const backdrop = css`
  position: fixed;
  top: 0; left: 0; right: 0; bottom: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  justify-content: center;
  align-items: flex-start;
  z-index: 1000;
`;
const panel = css`
  width: 100%;
  max-width: 560px;
  margin-top: 12vh;
  background: var(--color-darkest-blue);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5);
`;
const input = css`
  width: 100%;
  box-sizing: border-box;
  border: none;
  outline: none;
  background: transparent;
  color: inherit;
  font-size: 16px;
  padding: 16px 18px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
`;
const results = css`
  max-height: 56vh;
  overflow-y: auto;
`;
const groupLabel = css`
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  opacity: 0.55;
  padding: 10px 16px 4px;
`;
const row = css`
  display: flex;
  align-items: center;
  padding: 8px 16px;
  cursor: pointer;
  &[data-active='true'] { background: rgba(255, 255, 255, 0.08); }
`;
const icon = css` margin-right: 10px; font-size: 16px; `;
const tag = css`
  margin-left: 8px;
  font-size: 9px;
  font-weight: 700;
  padding: 2px 6px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.12);
  text-transform: uppercase;
`;
const titleCss = css` font-size: 14px; `;
const subCss = css` font-size: 12px; opacity: 0.6; `;
const empty = css` padding: 22px 16px; opacity: 0.6; font-size: 14px; text-align: center; `;
const note = css` padding: 6px 16px 12px; font-size: 11px; opacity: 0.5; `;

// Icons ported from beam-ui (recoloured via currentColor):
// icon-swap-currencies (pools), icon-atomic_swap, icon-assets_swap (gavel).
const SwapIcon: React.FC = () => (
  <svg width={16} height={16} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style={{ display: 'block' }}>
    <path transform="translate(5 6)" d="M.605 3.327h11.848L11.37 4.412c-.237.236-.237.619 0 .855.118.118.272.177.427.177.155 0 .31-.059.428-.177l2.117-2.117c.237-.236.237-.62 0-.855L12.224.177c-.236-.236-.62-.236-.855 0-.237.236-.237.62 0 .856l1.084 1.084H.605c-.334 0-.605.271-.605.605 0 .334.271.605.605.605zM13.914 7.976H2.065L3.15 6.892c.236-.236.236-.62 0-.856s-.62-.236-.855 0L.177 8.154c-.236.236-.236.619 0 .855l2.118 2.117c.117.119.272.178.427.178.155 0 .31-.06.428-.178.236-.236.236-.619 0-.855L2.065 9.186h11.849c.334 0 .605-.27.605-.605 0-.334-.271-.605-.605-.605z" />
  </svg>
);
const AtomicSwapIcon: React.FC = () => (
  <svg width={16} height={16} viewBox="0 0 28 28" fill="none" aria-hidden="true" style={{ display: 'block' }}>
    <g transform="translate(0 1)">
      <circle cx="23.7" cy="21.727" r="3.5" fill="currentColor" />
      <circle cx="4.3" cy="4" r="3.5" fill="currentColor" />
      <g stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2">
        <path d="M0 0h6.258c3.263 0 5.909 2.646 5.909 5.91v5.52" transform="rotate(180 8.182 11.762)" />
        <path d="M10.425 7.885L10.425 11.431 13.971 11.431" transform="rotate(180 8.182 11.762) rotate(-45 12.198 9.658)" />
      </g>
      <g stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2">
        <path d="M0 0h6.258c3.263 0 5.909 2.646 5.909 5.91v5.52" transform="translate(11.636 2.251)" />
        <path d="M10.425 7.885L10.425 11.431 13.971 11.431" transform="translate(11.636 2.251) rotate(-45 12.198 9.658)" />
      </g>
    </g>
  </svg>
);
const AuctionIcon: React.FC = () => (
  <svg width={16} height={16} viewBox="0 0 28 28" fill="none" aria-hidden="true" style={{ display: 'block' }}>
    <g fillRule="nonzero" stroke="currentColor" strokeWidth="1.8">
      <path transform="translate(2 2)" d="M13.784 18.002c.746 0 1.421.302 1.91.79.488.49.79 1.165.79 1.91h0v4.174H-.9v-4.174c0-.745.302-1.42.791-1.91.489-.488 1.164-.79 1.91-.79h0zM10.86-.899c.46 0 .918.176 1.262.525h0l4.56 4.556c.346.35.518.805.518 1.26 0 .455-.172.91-.522 1.264-.332.332-.767.507-1.207.52h0l-1.483.99L24.291 18.52c.391.391.587.904.587 1.416 0 .512-.196 1.024-.587 1.415-.391.391-.904.587-1.418.587-.513 0-1.026-.196-1.417-.587h0l-10.3-10.3-1.029 1.027c.028.877-.143 1.32-.484 1.665-.348.347-.805.522-1.263.522-.456 0-.912-.173-1.265-.523h0L2.566 9.19c-.352-.348-.528-.807-.528-1.265 0-.458.176-.917.522-1.259.348-.352.807-.528 1.265-.528h0l5.288-4.842c-.03-.886.145-1.332.482-1.665.349-.353.807-.529 1.266-.529z" />
    </g>
  </svg>
);

// The icon for a result: real asset glyph, beam-ui swap/atomic/gavel icons for
// pools and the swap pages, else the per-type emoji.
function itemIcon(item: SearchItem): JSX.Element {
  if (item.type === 'asset') {
    return <AssetIcon asset_id={Number(item.id)} color={item.color} logoUrl={item.logoUrl} size={18} className={icon} />;
  }
  let svg: JSX.Element | null = null;
  if (item.type === 'pool') svg = <SwapIcon />;
  else if (item.type === 'page' && item.href === '/atomic-swaps') svg = <AtomicSwapIcon />;
  else if (item.type === 'page' && item.href === '/asset-swaps') svg = <AuctionIcon />;
  if (svg) return <span className={icon} style={{ display: 'inline-flex', alignItems: 'center' }}>{svg}</span>;
  return <span className={icon}>{TYPE_ICON[item.type] ?? '•'}</span>;
}

interface Props { onClose: () => void }

export const SearchOverlay: React.FC<Props> = ({ onClose }) => {
  const navigate = useNavigate();
  const [value, setValue] = useState('');
  const [data, setData] = useState<ApiSearch | null>(null);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  // Flat list of items in display order, for keyboard navigation.
  const flat = useMemo<SearchItem[]>(
    () => (data ? data.groups.flatMap((g) => g.items) : []),
    [data],
  );

  // Debounced fetch. Numeric/hex fire at >=1 char; free text at >=2.
  useEffect(() => {
    const s = value.trim();
    const minLen = /^[0-9a-fA-F]+$/.test(s) ? 1 : 2;
    if (s.length < minLen) { setData(null); setLoading(false); return; }
    setLoading(true);
    // Guard against out-of-order responses: ignore a resolved request whose
    // effect run has been superseded by a newer keystroke.
    let cancelled = false;
    const handle = setTimeout(() => {
      api.search(s)
        .then((res) => { if (!cancelled) { setData(res); setActive(0); } })
        .catch(() => { if (!cancelled) setData(null); })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, 200);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [value]);

  const openItem = useCallback((item: SearchItem) => {
    onClose();
    // Gateway / external resources aren't SPA routes — open them directly in a
    // new tab instead of handing them to the router.
    if (/^https?:\/\//.test(item.href) || item.href.startsWith('/ipfs/')) {
      window.open(item.href, '_blank', 'noopener');
    } else {
      navigate(item.href);
    }
  }, [navigate, onClose]);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { onClose(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(i + 1, flat.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter' && flat[active]) { e.preventDefault(); openItem(flat[active]); }
  }, [active, flat, openItem, onClose]);

  let idx = -1;
  const explorerDegraded = data?.sources.explorer === 'timeout' || data?.sources.explorer === 'error';

  return (
    <div className={backdrop} onMouseDown={onClose}>
      <div className={panel} onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <input
          ref={inputRef}
          className={input}
          placeholder="Search blocks, assets, pairs, dapps, kernels, contracts…"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <div className={results}>
          {data && data.groups.map((g) => (
            <div key={g.type}>
              <div className={groupLabel}>{g.label}</div>
              {g.items.map((item) => {
                idx += 1;
                const myIdx = idx;
                return (
                  <div
                    key={`${item.type}:${item.id}`}
                    className={row}
                    data-active={myIdx === active}
                    onMouseEnter={() => setActive(myIdx)}
                    onClick={() => openItem(item)}
                  >
                    {itemIcon(item)}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className={titleCss}>
                        <span style={item.flags.includes('imposter') ? { color: 'var(--color-red)' } : undefined}>
                          {item.title}
                        </span>
                        {item.flags.includes('imposter') && (
                          <span
                            className={tag}
                            style={{ color: 'var(--color-red)', border: '1px solid var(--color-red)', background: 'rgba(242, 95, 91, 0.12)' }}
                          >imposter</span>
                        )}
                        {item.flags.includes('destroyed') && <span className={tag}>destroyed</span>}
                      </div>
                      <div className={subCss}>{item.subtitle}</div>
                    </div>
                    <span className={tag}>{item.type}</span>
                  </div>
                );
              })}
            </div>
          ))}
          {data && data.groups.length === 0 && !loading && (
            <div className={empty}>No results for "{value.trim()}"</div>
          )}
          {explorerDegraded && <div className={note}>Live chain lookups unavailable right now.</div>}
        </div>
      </div>
    </div>
  );
};
