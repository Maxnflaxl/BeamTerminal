import React from 'react';
import { NavLink } from 'react-router-dom';
import { css } from '@linaria/core';
import { ROUTES } from '@app/shared/constants';

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
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);

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

const items = [
  { to: ROUTES.NAV.PAIRS, label: 'Trade' },
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

export const TopNav = () => (
  <nav className={navRoot}>
    <div className={navInner}>
      <NavLink to={ROUTES.NAV.PAIRS} end className={brand}>
        <TerminalLogo />
        <span className={wordmark}>BeamTerminal</span>
      </NavLink>

      <div className={linksWrap}>
        {items.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === ROUTES.NAV.PAIRS}
            className={navLink}
          >
            {item.label}
          </NavLink>
        ))}
      </div>

      <div className={actions}>
        <a className={downloadBtn} href="/beamterminal.dapp" download="beamterminal.dapp">
          <DownloadIcon />
          Download DApp
        </a>
      </div>
    </div>
  </nav>
);

export default TopNav;
