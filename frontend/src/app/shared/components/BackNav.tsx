import React from 'react';
import { styled } from '@linaria/react';
import { AngleBackIcon } from '@app/shared/icons';

export const PageLayout = styled.div`
  display: flex;
  width: 100%;
`;

export const BackCol = styled.div`
  width: 80px;
  flex-shrink: 0;
  padding-top: 20px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  margin-right: 60px;
`;

export const MainCol = styled.div`
  flex: 1;
  min-width: 0;
`;

const BackButton = styled.button`
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 37px;
  padding: 0 14px;
  background: rgba(255, 255, 255, 0.1);
  border: none;
  border-radius: 19px;
  color: white;
  font-weight: 700;
  font-size: 14px;
  font-family: 'ProximaNova', 'SFProDisplay', sans-serif;
  cursor: pointer;
  white-space: nowrap;

  &:hover {
    background: rgba(255, 255, 255, 0.3);
  }
`;

interface BackNavProps {
  onClick: () => void;
}

const BackNav: React.FC<BackNavProps> = ({ onClick }) => (
  <BackCol>
    <BackButton type="button" onClick={onClick}>
      <AngleBackIcon />
      Back
    </BackButton>
  </BackCol>
);

export default BackNav;
