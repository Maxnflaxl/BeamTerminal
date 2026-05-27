import { useEffect, useRef, useState, type RefObject } from 'react';

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
