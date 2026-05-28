import React from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { styled } from '@linaria/react';
import { css } from '@linaria/core';
import { ROUTES } from '@app/shared/constants';

const SubNav = styled.nav`
  width: 100%;
  display: flex;
  justify-content: center;
  margin: 4px 0 16px;
`;

const SubNavInner = styled.div`
  width: 100%;
  max-width: 980px;
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  & > * { margin-bottom: 4px; }
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  padding-bottom: 2px;
`;

const subLink = css`
  text-decoration: none;
  font-family: 'SFProDisplay', monospace;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 6px 12px;
  color: rgba(255, 255, 255, 0.5);
  border-bottom: 2px solid transparent;

  &[aria-current='page'] {
    color: white;
    border-bottom-color: var(--color-green);
  }

  &:hover {
    color: rgba(255, 255, 255, 0.85);
  }

  @media (max-width: 600px) {
    font-size: 11px;
    padding: 5px 9px;
  }
`;

const items = [
  { to: ROUTES.NAV.EXPLORER_CHARTS,    label: 'Charts' },
  { to: ROUTES.NAV.EXPLORER_BEAM,      label: 'Block Explorer' },
  { to: ROUTES.NAV.EXPLORER_COUNTDOWN, label: 'Halving' },
  { to: ROUTES.NAV.EXPLORER_SUPPLY,    label: 'Supply' },
  { to: ROUTES.NAV.EXPLORER_HEALTH,    label: 'Health' },
  { to: ROUTES.NAV.EXPLORER_BANS,      label: 'BANS' },
  { to: ROUTES.NAV.EXPLORER_BRIDGE,    label: 'Bridge' },
];

export const ExplorerLayout: React.FC = () => (
  <>
    <SubNav>
      <SubNavInner>
        {items.map((item) => (
          <NavLink key={item.to} to={item.to} className={subLink}>{item.label}</NavLink>
        ))}
      </SubNavInner>
    </SubNav>
    <Outlet />
  </>
);

export default ExplorerLayout;
