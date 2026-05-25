import ContentLoader from 'react-content-loader';
import React from 'react';
import { styled } from '@linaria/react';

const Section = styled.div`
  max-width: 430px;
  height: 301px;
  justify-self: center;
  display: flex;
  flex-direction: column;
  align-items: center;
    border-radius: 10px;
  border: 1px solid rgba(255,255,255,0.05);
`;

const LoadingSkileton = (props) => (
  <Section>
    <ContentLoader
      speed={2}
      width={430}
      height={301}
      viewBox="0 0 430 301"
      backgroundColor="rgba(255,255,255,0.05)"
      foregroundColor="rgba(255,255,255,0.05)"
      {...props}
    >
      <rect x="17" y="10" rx="5" ry="5" width="201" height="29" />
      <circle cx="296" cy="26" r="16" />
      <rect x="324" y="11" rx="5" ry="5" width="87" height="28" />
      <rect x="65" y="69" rx="5" ry="5" width="153" height="22" />
      <rect x="287" y="69" rx="5" ry="5" width="123" height="22" />
      <circle cx="34" cy="79" r="16" />
      <circle cx="452" cy="133" r="16" />
      <rect x="25" y="154" rx="5" ry="5" width="380" height="48" />
      <rect x="114" y="263" rx="0" ry="0" width="1" height="28" />
      <rect x="110" y="254" rx="20" ry="20" width="213" height="35" />
      <rect x="35" y="231" rx="5" ry="5" width="121" height="16" />
      <rect x="285" y="231" rx="5" ry="5" width="121" height="16" />
      <rect x="65" y="111" rx="5" ry="5" width="153" height="22" />
      <rect x="287" y="111" rx="5" ry="5" width="123" height="22" />
      <circle cx="34" cy="121" r="16" />
    </ContentLoader>
  </Section>
);

export default LoadingSkileton;
