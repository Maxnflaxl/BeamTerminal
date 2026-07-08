import React, { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { css } from '@linaria/core';
import { ROUTES } from '@app/shared/constants';
import { isInsideWallet } from '@core/walletEnv';
import { SearchOverlay } from './SearchOverlay';

const navRoot = css`
  width: 100%;
  display: flex;
  justify-content: center;
  margin: 14px 0 10px;
`;

const navInner = css`
  width: 100%;
  max-width: 1400px;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  justify-content: space-between;
  padding: 0 20px;

  @media (max-width: 600px) {
    padding: 0 12px;
  }
`;

// Logo + wordmark, links home. The terminal "_" cursor (.term-cursor) blinks
// while the brand is hovered — see the @keyframes below.
const brand = css`
  display: flex;
  align-items: center;
  flex-shrink: 0;
  text-decoration: none;
  padding: 6px 0;

  &:hover .term-cursor {
    animation: blink 1.1s infinite;
  }

  @keyframes blink {
    0%, 49.9% {
      opacity: 1;
    }
    50%, 100% {
      opacity: 0;
    }
  }
`;

const logoIcon = css`
  width: 28px;
  height: 28px;
  display: block;
  flex-shrink: 0;
`;

const wordmark = css`
  margin-left: 10px;
  font-size: 18px;
  font-weight: 700;
  letter-spacing: 0.2px;
  color: var(--color-white);
  white-space: nowrap;

  @media (max-width: 480px) {
    display: none;
  }
`;

// Centered links take the slack between brand (left) and actions (right). On
// narrow screens they drop to their own full-width row beneath both.
const linksWrap = css`
  flex: 1 1 auto;
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  & > * {
    margin-bottom: 4px;
  }

  @media (max-width: 768px) {
    order: 3;
    flex-basis: 100%;
  }
`;

const navLink = css`
  text-decoration: none;
  text-transform: uppercase;
  font-size: 13px;
  font-weight: 700;
  padding: 8px 18px;
  color: rgba(255, 255, 255, 0.6);
  border-bottom: 2px solid transparent;

  &[aria-current='page'] {
    color: white;
    border-bottom-color: var(--color-green);
  }

  @media (max-width: 600px) {
    font-size: 12px;
    padding: 6px 12px;
  }
`;

const actions = css`
  flex-shrink: 0;
  display: flex;
  align-items: center;
`;

// Filled accent button. Plain <a download> with a real path so it bypasses the
// HashRouter — the .dapp is shipped to the web root at deploy time.
const downloadBtn = css`
  display: inline-flex;
  align-items: center;
  text-decoration: none;
  text-transform: uppercase;
  font-size: 13px;
  font-weight: 700;
  white-space: nowrap;
  color: var(--color-dark-blue);
  background: var(--color-green);
  border-radius: 8px;
  padding: 8px 16px;
  transition: opacity 0.15s ease;

  svg {
    margin-right: 8px;
  }

  &:hover {
    opacity: 0.85;
  }

  @media (max-width: 600px) {
    font-size: 12px;
    padding: 6px 12px;
  }
`;

const searchPill = css`
  display: inline-flex;
  align-items: center;
  margin-left: 12px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 8px;
  /* 7px + 1px border == the Download button's 8px (no border) so both pills
     are the same height. */
  padding: 7px 14px;
  font-size: 13px;
  opacity: 0.85;
  cursor: pointer;
  background: transparent;
  color: inherit;
  &:hover { opacity: 1; }

  @media (max-width: 600px) {
    font-size: 12px;
    padding: 5px 12px;
  }
`;
const pillIcon = css`
  width: 13px;
  height: 13px;
  margin-right: 7px;
  flex-shrink: 0;
`;
const pillKbd = css`
  margin-left: 8px;
  font-size: 10px;
  opacity: 0.6;
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 4px;
  padding: 1px 5px;
`;

const items = [
  { to: ROUTES.NAV.DEX, label: 'DEX' },
  { to: ROUTES.NAV.ASSETS, label: 'Assets' },
  { to: ROUTES.NAV.ATOMIC_SWAPS, label: 'Atomic swaps' },
  { to: ROUTES.NAV.ASSET_SWAPS, label: 'Asset swaps' },
  { to: ROUTES.NAV.DAPPS, label: 'DApps' },
  { to: ROUTES.NAV.EXPLORER, label: 'Explorer' },
];

// Inline copy of favicon.svg, with the prompt's underscore split into its own
// .term-cursor path so it can blink independently (SVGR-imported icons can't be
// sub-targeted with CSS).
const TerminalLogo = () => (
  <svg className={logoIcon} viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
    <path
      fill="#fff"
      d="M0 26V6a6 6 0 0 1 6-6h20a6 6 0 0 1 6 6v20a6 6 0 0 1-6 6H6a6 6 0 0 1-6-6Zm4 0a2 2 0 0 0 2 2h20a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v20Z"
    />
    <path
      fill="#a69eff"
      d="M8 18h2v-2H8zm0-8h2V8H8zm2 6h2v-2h-2zm0-4h2v-2h-2zm2 2h2v-2h-2z"
    />
    <path className="term-cursor" fill="var(--color-green)" d="M14 18h6v-2h-6z" />
  </svg>
);

const DownloadIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M12 3v12m0 0-4-4m4 4 4-4M4 19h16" />
  </svg>
);

export const TopNav = () => {
  const [searchOpen, setSearchOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setSearchOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <>
      <nav className={navRoot}>
        <div className={navInner}>
          <NavLink to={ROUTES.NAV.DEX} end className={brand}>
            <TerminalLogo />
            <span className={wordmark}>BeamTerminal</span>
          </NavLink>

          <div className={linksWrap}>
            {items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === ROUTES.NAV.DEX}
                className={navLink}
              >
                {item.label}
              </NavLink>
            ))}
          </div>

          <div className={actions}>
            {!isInsideWallet() && (
              <a className={downloadBtn} href="/beamterminal.dapp" download="beamterminal.dapp">
                <DownloadIcon />
                Download DApp
              </a>
            )}
          </div>

          <button type="button" className={searchPill} onClick={() => setSearchOpen(true)}>
            {/* Magnifier from beam-ui (ui/view/assets/icon-search.svg), recoloured via currentColor. */}
            <svg className={pillIcon} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path fillRule="nonzero" d="M14.787 13.752l-3.451-3.466a5.519 5.519 0 0 0 1.373-3.634C12.71 3.536 10.083 1 6.855 1 3.626 1 1 3.536 1 6.652c0 3.117 2.626 5.653 5.855 5.653a5.936 5.936 0 0 0 3.354-1.023l3.477 3.492c.146.146.341.226.55.226a.774.774 0 0 0 .53-.206.72.72 0 0 0 .021-1.042zM6.855 2.475c2.386 0 4.327 1.874 4.327 4.177 0 2.304-1.941 4.178-4.327 4.178S2.527 8.956 2.527 6.652c0-2.303 1.942-4.177 4.328-4.177z" />
            </svg>
            Search…<span className={pillKbd}>⌘K</span>
          </button>
        </div>
      </nav>
      {searchOpen && <SearchOverlay onClose={() => setSearchOpen(false)} />}
    </>
  );
};

export default TopNav;
