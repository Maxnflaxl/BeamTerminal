import React from 'react';
import { styled } from '@linaria/react';

interface ContainerProps {
  variant?: 'center' | 'space-between';
  jystify?: 'center' | 'space-between';
  main?: boolean;
  /** Wider content cap (e.g. trade grid with asset selectors) */
  wide?: boolean;
}
const ContainerStyled = styled.div<ContainerProps>`
  display: flex;
  flex-direction: column;
  //align-items: center;
  margin: 30px 0;
  width: 100%;
  min-height: 600px;
  height: 100%;
  align-items: ${({ variant = 'center' }) => variant};
  justify-content: ${({ jystify = 'flex-start' }) => jystify};
  max-width: ${({ main, wide }) => {
    if (main) return 'none';
    if (wide) return '980px';
    return '914px';
  }};
  align-content: center;

  @media (max-width: 600px) {
    margin: 16px 0;
    min-height: 0;
  }
`;

const Container: React.FC<ContainerProps> = ({
  children, variant, main, jystify, wide,
}) => (
  <ContainerStyled variant={variant} jystify={jystify} main={main} wide={wide}>
    {children}
  </ContainerStyled>
);

export default Container;
