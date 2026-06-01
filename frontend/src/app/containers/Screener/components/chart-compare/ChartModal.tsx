import React, { useEffect } from 'react';

const C = {
  panel: '#042548',
  border: 'rgba(255,255,255,0.08)',
  borderDim: 'rgba(255,255,255,0.06)',
  close: 'rgba(255,255,255,0.7)',
  accent: '#00f6d2',
};

export const ChartModal: React.FC<{
  onClose: () => void;
  toolbar?: React.ReactNode;
  children: React.ReactNode;
}> = ({ onClose, toolbar, children }) => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', top: 0, right: 0, bottom: 0, left: 0,
        background: 'rgba(0,0,0,0.65)', display: 'flex', alignItems: 'center',
        justifyContent: 'center', zIndex: 100, padding: 24,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10,
          width: '100%', maxWidth: 1200, height: '100%', maxHeight: 760,
          display: 'flex', flexDirection: 'column', padding: 16, position: 'relative',
        }}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          style={{
            position: 'absolute', top: 12, right: 12, width: 28, height: 28,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            background: 'transparent', color: C.close, border: '1px solid rgba(255,255,255,0.15)',
            borderRadius: 6, cursor: 'pointer', fontSize: 16, lineHeight: 1,
          }}
        >
          ×
        </button>
        {toolbar && (
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12, paddingRight: 36, flexWrap: 'wrap' }}>
            {toolbar}
          </div>
        )}
        <div style={{ flex: 1, minHeight: 0, border: `1px solid ${C.borderDim}`, borderRadius: 8, padding: 8, overflow: 'auto' }}>
          {children}
        </div>
      </div>
    </div>
  );
};
