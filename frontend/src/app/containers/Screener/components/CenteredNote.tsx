import { styled } from '@linaria/react';

/** Centered muted placeholder for loading / empty / error states. Defaults to
 *  the list-page metrics; denser surfaces pass `pad` / `size`. */
export const CenteredNote = styled.div<{ pad?: string; size?: number }>`
  text-align: center;
  padding: ${(p) => p.pad ?? '60px 20px'};
  color: rgba(255, 255, 255, 0.5);
  font-size: ${(p) => (p.size ? `${p.size}px` : 'inherit')};
`;
