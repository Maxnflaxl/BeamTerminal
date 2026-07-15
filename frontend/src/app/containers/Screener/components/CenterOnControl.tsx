import React, { useState } from 'react';
import { styled } from '@linaria/react';

// Custom-styled "center chart on date" selector, shared by the price chart and
// the pool-history (LP) chart: a real text input on the left (placeholder
// "CENTER ON YYYY-MM-DD") that the user types into, plus a calendar-icon button
// on the right that opens the native picker as an alternative. The picker button
// hosts a transparent <input type="date"> overlay sized to the icon's hit area,
// so clicking the icon — and only the icon — opens the browser's date picker.
// That keeps the body typeable while still giving a one-click picker on Chrome 83,
// where input.showPicker() doesn't exist yet.
const Wrap = styled.div`
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  padding: 3px 3px 3px 10px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 4px;
  font-size: 12px;
  font-family: inherit;
  color-scheme: dark;
  transition: background 120ms, border-color 120ms;
  &:focus-within {
    background: rgba(255, 255, 255, 0.08);
    border-color: var(--color-green);
  }
  input[type='text'] {
    background: transparent;
    border: none;
    color: var(--color-green);
    font: inherit;
    font-weight: 600;
    letter-spacing: 0.4px;
    outline: none;
    padding: 1px 0;
    width: 160px;
    text-transform: uppercase;
    &::placeholder {
      color: rgba(255, 255, 255, 0.4);
      font-weight: 400;
      letter-spacing: 0.4px;
    }
  }
  .pickerBtn {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    margin-left: 4px;
    border-radius: 3px;
    color: rgba(255, 255, 255, 0.5);
    cursor: pointer;
    transition: background 120ms, color 120ms;
    &:hover {
      background: rgba(255, 255, 255, 0.08);
      color: var(--color-green);
    }
    svg {
      width: 13px;
      height: 13px;
      pointer-events: none;
    }
    input[type='date'] {
      position: absolute;
      top: 0;
      right: 0;
      bottom: 0;
      left: 0;
      width: 100%;
      height: 100%;
      opacity: 0;
      border: none;
      padding: 0;
      margin: 0;
      background: transparent;
      color: transparent;
      font: inherit;
      cursor: pointer;
      color-scheme: dark;
      &::-webkit-calendar-picker-indicator {
        position: absolute;
        top: 0;
        right: 0;
        bottom: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: transparent;
        cursor: pointer;
      }
      &::-webkit-datetime-edit,
      &::-webkit-inner-spin-button,
      &::-webkit-clear-button {
        display: none;
      }
    }
  }
`;

interface Props {
  /** Called with unix seconds when a valid YYYY-MM-DD is entered or picked. */
  onCenter: (ts: number) => void;
  /** Called when the field is cleared (stop centering). */
  onClear?: () => void;
  /** Called when Enter is pressed on an empty field (reset zoom / refit). */
  onReset?: () => void;
  className?: string;
}

export const CenterOnControl: React.FC<Props> = ({ onCenter, onClear, onReset, className }) => {
  const [value, setValue] = useState<string>('');

  // Update the display string and, when it's a full date, emit the timestamp;
  // an empty value clears. Text passes a sanitized string; the date input passes
  // its own already-valid value.
  const commit = (raw: string): void => {
    setValue(raw);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      if (!raw) onClear?.();
      return;
    }
    const ms = Date.parse(`${raw}T00:00:00Z`);
    if (!Number.isNaN(ms)) onCenter(Math.floor(ms / 1000));
  };

  return (
    <Wrap className={className}>
      <input
        type="text"
        inputMode="numeric"
        spellCheck={false}
        autoComplete="off"
        placeholder="CENTER ON YYYY-MM-DD"
        value={value}
        aria-label="Center chart on date (YYYY-MM-DD)"
        onChange={(e) => {
          // Keep digits + dashes only; cap at YYYY-MM-DD length.
          commit(e.target.value.replace(/[^0-9-]/g, '').slice(0, 10));
        }}
        onKeyDown={(e) => {
          // Empty + Enter → reset the chart zoom to its default fit.
          if (e.key === 'Enter' && value === '') onReset?.();
        }}
      />
      <span className="pickerBtn" title="Open date picker">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="3" y="4" width="18" height="17" rx="2" />
          <line x1="3" y1="9" x2="21" y2="9" />
          <line x1="8" y1="2" x2="8" y2="6" />
          <line x1="16" y1="2" x2="16" y2="6" />
        </svg>
        <input type="date" value={value} tabIndex={-1} aria-hidden="true" onChange={(e) => commit(e.target.value)} />
      </span>
    </Wrap>
  );
};

export default CenterOnControl;
