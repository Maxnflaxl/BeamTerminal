import { useEffect, useRef, useState, type RefObject } from 'react';
import { styled } from '@linaria/react';

/** Tracks an element's pixel width so SVG charts can lay out responsively
 *  (mirrors the original tool's `Math.max(300, container.clientWidth)`). */
export function useContainerWidth(min = 300): [RefObject<HTMLDivElement>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(min);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? min;
      setWidth(Math.max(min, Math.round(w)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [min]);
  return [ref, width];
}

export const CHART = {
  height: 200,
  line: '#00f6d2',
  principal: 'rgba(0, 246, 210, 0.55)',
  fees: 'rgba(123, 97, 255, 0.7)',
  initial: 'rgba(255, 255, 255, 0.45)',
  current: '#00f6d2',
  hypo: 'rgba(255, 255, 255, 0.22)',
  grid: 'rgba(255, 255, 255, 0.08)',
  gridBold: 'rgba(255, 255, 255, 0.22)',
  axis: 'rgba(255, 255, 255, 0.25)',
  label: 'rgba(255, 255, 255, 0.5)',
  labelBold: 'rgba(255, 255, 255, 0.8)',
  ref: 'rgba(255, 255, 255, 0.3)',
  areaPrincipal: 'rgba(0, 246, 210, 0.12)',
  areaFees: 'rgba(123, 97, 255, 0.18)',
} as const;

/** Shared chrome for the hand-rolled SVG charts: relative wrapper plus the
 *  hover tooltip card (each chart positions it via inline left/top). */
export const Wrap = styled.div`
  position: relative;
  width: 100%;
`;

export const Tip = styled.div<{ maxW?: number }>`
  position: absolute;
  z-index: 30;
  pointer-events: none;
  transform: translate(-50%, -100%);
  background: #021b35;
  border: 1px solid rgba(0, 246, 210, 0.4);
  border-radius: 6px;
  padding: 6px 8px;
  font-size: 11px;
  line-height: 1.5;
  color: rgba(255, 255, 255, 0.85);
  white-space: nowrap;
  max-width: ${(p) => (p.maxW ? `${p.maxW}px` : 'none')};
  & b {
    color: #00f6d2;
  }
`;
