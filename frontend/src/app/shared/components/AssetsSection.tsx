import React from 'react';
import { styled } from '@linaria/react';

const SectionStyled = styled.div<{ error?: boolean }>`
  display: flex;
  align-items: center;
  margin-bottom: 10px;
  justify-content: space-between;
  width: 100%;
  min-width: 0;
  max-width: 100%;
  overflow-x: hidden;
  height: 56px;
  border: none;
  outline: none;
  border-radius: 10px;
  padding-right: 15px;
  background-color: rgba(255, 255, 255, 0.05);
  box-shadow: ${({ error }) => (error ? '0 0 0 2px rgba(255, 98, 92, 0.6)' : 'none')};
`;

const AssetsSection: React.FC<{ error?: boolean; children?: React.ReactNode }> = ({ children, error }) => (
  <SectionStyled error={error}>{children}</SectionStyled>
);

export default AssetsSection;
