// Single source of truth for the /explorer/* color palette and metrics.
// Values mirror the canonical BeamTerminal palette in styles.ts (CSS vars
// like --color-dark-blue / --color-green / --color-red) so the explorer
// surface matches TRADE / ASSETS rather than inventing its own theme.

export const theme = {
  color: {
    // Surfaces
    bg:        '#042548',                       // var(--color-dark-blue) — page background
    surface:   'rgba(255, 255, 255, 0.03)',     // card / row background (used by Pairs table)
    surface2:  'rgba(255, 255, 255, 0.05)',     // elevated card / input
    surface3:  'rgba(0, 0, 0, 0.4)',            // popovers / select options
    rowHover:  'rgba(255, 255, 255, 0.03)',
    // Accents
    accent:    '#00f6d2',                       // var(--color-green)
    accentDim: 'rgba(0, 246, 210, 0.18)',
    accentGlow:'rgba(0, 246, 210, 0.35)',
    // Text
    text:      '#ffffff',
    textDim:   'rgba(255, 255, 255, 0.8)',
    muted:     'rgba(255, 255, 255, 0.5)',
    muted2:    'rgba(255, 255, 255, 0.4)',
    // Status — pulled from styles.ts CSS vars
    danger:    '#f25f5b',                       // var(--color-red)
    success:   '#00f6d2',                       // success folds into the accent green
    warn:      '#f4ce4a',                       // var(--color-yellow)
    info:      '#0bccf7',                       // var(--color-blue)
    purple:    '#da68f5',                       // var(--color-purple)
    // Lines & borders
    border:    'rgba(255, 255, 255, 0.1)',
    borderDim: 'rgba(255, 255, 255, 0.06)',
    divider:   'rgba(255, 255, 255, 0.08)',
  },
  font: {
    mono:    "'SFProDisplay', monospace",
    display: "'SFProDisplay', monospace",
  },
  radius: {
    sm: '4px',
    md: '6px',
    lg: '8px',
  },
  spacing: {
    cardPad: '16px',
    page:    '8px 0 40px',
  },
} as const;

export type ExplorerTheme = typeof theme;
