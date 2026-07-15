import React from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { styled } from '@linaria/react';
import { css } from '@linaria/core';
import { ROUTES } from '@app/shared/constants';

// Tertiary nav for the DAO section, nested under ExplorerLayout. Mirrors the
// explorer sub-nav one level down. Emission / Farming append here later.
const SubNav = styled.nav`
  width: 100%;
  display: flex;
  justify-content: center;
  margin: 0 0 16px;
`;

const SubNavInner = styled.div`
  width: 100%;
  max-width: 980px;
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  & > * {
    margin-bottom: 4px;
  }
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  padding-bottom: 2px;
`;

const subLink = css`
  text-decoration: none;
  font-family: var(--font-mono);
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
  { to: ROUTES.NAV.EXPLORER_DAO, label: 'Overview', end: true },
  { to: ROUTES.NAV.EXPLORER_DAO_TREASURY, label: 'Treasury', end: false },
  { to: ROUTES.NAV.EXPLORER_DAO_REVENUE, label: 'Revenue', end: false },
  { to: ROUTES.NAV.EXPLORER_DAO_GOVERNANCE, label: 'Governance', end: false },
];

export const DaoLayout: React.FC = () => (
  <>
    <SubNav>
      <SubNavInner>
        {items.map((item) => (
          <NavLink key={item.to} to={item.to} end={item.end} className={subLink}>
            {item.label}
          </NavLink>
        ))}
      </SubNavInner>
    </SubNav>
    <Outlet />
  </>
);

export default DaoLayout;
