import React from 'react';
import { css, cx } from '@linaria/core';

import { ArrowLeftIcon } from '@app/shared/icons';

import Button from './Button';

interface BackButtonProps {
  className?: string;
  onClick: React.MouseEventHandler;
  title: string;
}

const backStyle = css`
  position: absolute;
  z-index: 3;
  left: 0;
`;

const BackButton: React.FC<BackButtonProps> = ({ className, onClick, title }) => (
  <Button variant="control" icon={ArrowLeftIcon} pallete="white" className={cx(backStyle, className)} onClick={onClick}>
    {title}
  </Button>
);

export default BackButton;
