import React from 'react';
import { NavLink } from 'react-router-dom';
import { css } from '@linaria/core';
import { ROUTES } from '@app/shared/constants';

const navRoot = css`
  width: 100%;
  display: flex;
  justify-content: center;
  margin: 18px 0 10px;
`;

const navInner = css`
  width: 100%;
  max-width: 980px;
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  & > * { margin-bottom: 4px; }
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
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

const items = [
  { to: ROUTES.NAV.PAIRS, label: 'Trade' },
  { to: ROUTES.NAV.ASSETS, label: 'Assets' },
  { to: ROUTES.NAV.ATOMIC_SWAPS, label: 'Atomic swaps' },
  { to: ROUTES.NAV.ASSET_SWAPS, label: 'Asset swaps' },
  { to: ROUTES.NAV.DAPPS, label: 'DApps' },
  { to: ROUTES.NAV.EXPLORER, label: 'Explorer' },
];

export const TopNav = () => (
  <nav className={navRoot}>
    <div className={navInner}>
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
  </nav>
);

export default TopNav;
