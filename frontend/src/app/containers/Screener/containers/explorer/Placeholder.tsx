import React from 'react';
import { styled } from '@linaria/react';

const Box = styled.div`
  width: 95%;
  max-width: 720px;
  margin: 0 auto;
  padding: 40px 0;
  text-align: center;
  color: rgba(255, 255, 255, 0.5);
  font-family: 'SFProDisplay', monospace;
  font-size: 14px;
`;

export const Placeholder: React.FC<{ title: string }> = ({ title }) => (
  <Box>
    <p>{title} — port in progress.</p>
  </Box>
);

export default Placeholder;
