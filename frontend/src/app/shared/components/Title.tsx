import React from 'react';
import { styled } from '@linaria/react';

interface TitleProps {
  variant?: 'regular' | 'subtitle' | 'heading';
}

const STYLE_BASE = {
  margin: 0,
  fontSize: 14,
  fontWeight: 700,
  textTransform: 'uppercase',
  textAlign: 'left',
  letterSpacing: 3.11111,
  // lineHeight: 17,
  color: 'white',
};

const HeadingStyled = styled.h2`
  line-height: 17px;
  margin: 0;
  font-size: 14px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 3px;
`;

const TitleStyled = styled.h3`
  ${STYLE_BASE}
  margin-bottom: 20px;

  &:last-child {
    margin-bottom: 0;
  }
`;

const SubtitleStyled = styled.h4`
  ${STYLE_BASE}
  opacity: 0.5;
  margin-bottom: 10px;
`;

const VARIANTS = {
  regular: TitleStyled,
  subtitle: SubtitleStyled,
  heading: HeadingStyled,
};

const Title: React.FC<TitleProps> = ({ variant = 'regular', children }) => {
  const TitleComponent = VARIANTS[variant];
  return <TitleComponent>{children}</TitleComponent>;
};

export default Title;
