import React from 'react';
import { Container, Window } from '@app/shared/components/index';
import { IconLoader, IconSearchResult } from '@app/shared/icons';
import { styled } from '@linaria/react';

interface ILoader {
  isSearchable?: boolean;
}

const Description = styled.div<ILoader>`
  font-style: italic;
  font-weight: 400;
  font-size: 14px;
  line-height: 17px;
  text-align: center;
  color: rgba(255, 255, 255, 0.5);
  width: ${({ isSearchable }) => (isSearchable ? '256px' : '281px')} 256px;
  margin-top: ${({ isSearchable }) => (isSearchable ? '40px' : '54px')};
`;

const Loader = ({ isSearchable }: ILoader) => (
  <Window>
    <Container variant="center" jystify="center" main>
      {isSearchable ? (
        <>
          <IconSearchResult />
          <Description isSearchable={isSearchable}>
            No pools were found. Please check the asset or create the pool.
          </Description>
        </>
      ) : (
        <>
          <IconLoader />
          <Description isSearchable={isSearchable}>Please wait, Beam DEX is loading...</Description>
        </>
      )}
    </Container>
  </Window>
);

export default Loader;
