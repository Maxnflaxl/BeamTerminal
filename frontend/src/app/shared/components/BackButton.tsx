import React from 'react';
import { css, cx } from '@linaria/core';
import { Link } from 'react-router-dom';

// Uniform back button used across the app: a bordered pill matching the app's
// control vocabulary (fee-tier / timeframe buttons, DAO explorer back link).
// Renders a react-router <Link> when `to` is given, otherwise a <button>.
const pill = css`
  display: inline-flex;
  align-items: center;
  font-size: 11px;
  font-weight: 600;
  padding: 6px 14px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  background: rgba(255, 255, 255, 0.05);
  color: var(--color-green);
  text-decoration: none;
  cursor: pointer;
  transition: background 0.15s ease, border-color 0.15s ease;
  &:hover {
    background: rgba(255, 255, 255, 0.08);
    border-color: var(--color-green);
  }
`;

interface BackButtonProps {
  to?: string;
  onClick?: () => void;
  label?: string;
  className?: string;
}

// Arrow spacing via inline margin (not flex `gap` — the wallet's QtWebEngine is
// Chrome 83, which predates flex-gap).
const arrowStyle: React.CSSProperties = { marginRight: 5, fontSize: 13, lineHeight: 1 };

export const BackButton: React.FC<BackButtonProps> = ({ to, onClick, label = 'Back', className }) => {
  const cls = cx(pill, className);
  const inner = (
    <>
      <span aria-hidden="true" style={arrowStyle}>
        ←
      </span>
      {label}
    </>
  );
  return to ? (
    <Link to={to} className={cls}>
      {inner}
    </Link>
  ) : (
    <button type="button" className={cls} onClick={onClick}>
      {inner}
    </button>
  );
};

export default BackButton;
