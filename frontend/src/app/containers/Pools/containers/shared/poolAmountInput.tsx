import React, { useLayoutEffect, useRef } from 'react';
import { caretAfterGroupingFormat, emptyPredict, fromGroths } from '@core/appUtils';
import { IPredict } from '@core/types';

function stripCommas(v: string | number): string {
  return String(v).replace(/,/g, '');
}

export const parseAmount = (v: string | number) => Number(stripCommas(v));

export const isAmountInputEmpty = (value: string | number) => stripCommas(value).trim() === '';

export const formatPredictAmount = (v: string | number) => {
  const [int, frac] = String(v).split('.');
  const intFormatted = Number(int).toLocaleString('en-US');
  return frac !== undefined ? `${intFormatted}.${frac}` : intFormatted;
};

export const formatUserInput = (v: string) => {
  const stripped = stripCommas(v);
  return stripped ? formatPredictAmount(stripped) : '';
};

type CaretRange = { start: number; end: number };

export type TradeAmountInputSide = 1 | 2;

export type AmountInputCaretBinding = {
  inputRef: React.RefObject<HTMLInputElement>;
  handleChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
};

export function useAmountInputCaret(
  formattedValue: string | number,
  onPredict: (next: string) => void,
): AmountInputCaretBinding;
export function useAmountInputCaret(
  formattedValue: string | number,
  onPredict: (next: string) => void,
  lastChangedSide: TradeAmountInputSide,
  setLastChangedInput: React.Dispatch<React.SetStateAction<number>>,
): AmountInputCaretBinding;
export function useAmountInputCaret(
  formattedValue: string | number,
  onPredict: (next: string) => void,
  lastChangedSide?: TradeAmountInputSide,
  setLastChangedInput?: React.Dispatch<React.SetStateAction<number>>,
): AmountInputCaretBinding {
  const inputRef = useRef<HTMLInputElement>(null);
  const pendingCaretRef = useRef<CaretRange | null>(null);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const el = e.target;
    const raw = el.value;
    const next = formatUserInput(raw);
    pendingCaretRef.current = caretAfterGroupingFormat(
      raw,
      next,
      el.selectionStart,
      el.selectionEnd,
    );
    onPredict(next);
    if (lastChangedSide !== undefined && setLastChangedInput !== undefined) {
      setLastChangedInput(lastChangedSide);
    }
  };

  useLayoutEffect(() => {
    const pending = pendingCaretRef.current;
    if (pending === null) return;
    pendingCaretRef.current = null;
    const node = inputRef.current;
    if (!node) return;
    node.setSelectionRange(pending.start, pending.end);
  }, [formattedValue]);

  return { inputRef, handleChange };
}

export type AmountFieldInput = {
  value: number | string;
  onPredict: (v: number | string) => void;
};

export function createAmountFieldHandlers(
  predictData: IPredict | null,
  input: AmountFieldInput,
  peerValue: number | string,
) {
  return {
    onFocus: () => {
      if (
        emptyPredict(predictData, peerValue)
        && (input.value === 0 || input.value === '0')
      ) {
        input.onPredict('');
      }
    },
    onBlur: () => {
      if (isAmountInputEmpty(input.value)) {
        input.onPredict(0);
      }
    },
  };
}

/** Formatted predicted token amount for read-only rows (e.g. withdraw “You receive”). */
export function formatPredictedFieldDisplay(
  predictData: IPredict | null,
  amountValue: string | number,
  field: 'tok1' | 'tok2',
): string {
  if (!predictData || emptyPredict(predictData, amountValue)) return '0';
  return formatPredictAmount(fromGroths(predictData[field] ?? 0));
}
