import React from 'react';
import { styled } from '@linaria/react';

interface SectionProps {
  variant?: 'center' | 'space-between';
}
const SectionStyled = styled.div<SectionProps>`
  display: flex;
  justify-content: ${({ variant }) => variant || 'space-between'};
  max-width: 954px;
  width: 100%;
  position: relative;
  @media (max-width: 913px) {
    flex-direction: column;
    justify-content: center;
    align-items: center;
  }
`;
const AssetsContainer: React.FC<SectionProps> = ({ children, variant = 'space-between' }) => (
  <SectionStyled variant={variant}>{children}</SectionStyled>
);

export default AssetsContainer;
