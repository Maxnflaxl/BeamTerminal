import React, { useEffect, useState } from 'react';
import { styled } from '@linaria/react';
import { api } from '../api/client';

interface HealthResp {
  status:              string;
  last_indexed_height: number;
  chain_head:          number | null;
  blocks_behind:       number | null;
  lag_seconds:         number;
}

const Wrap = styled.footer`
  width: 100%;
  margin-top: 48px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
  background: rgba(4, 37, 72, 0.4);
`;

const Inner = styled.div`
  max-width: 1200px;
  margin: 0 auto;
  padding: 28px 16px 20px;
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 24px;

  @media (max-width: 800px) {
    grid-template-columns: 1fr 1fr;
  }
`;

const Col = styled.div`
  display: flex;
  flex-direction: column;
  & > * + * { margin-top: 6px; }
`;

const ColTitle = styled.div`
  font-family: 'SFProDisplay', monospace;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: rgba(255, 255, 255, 0.4);
  margin-bottom: 2px;
`;

const FLink = styled.a`
  font-size: 13px;
  color: rgba(255, 255, 255, 0.7);
  text-decoration: none;
  transition: color 120ms;

  &:hover { color: #00f6d2; }
`;

const BottomBar = styled.div`
  max-width: 1200px;
  margin: 0 auto;
  padding: 12px 16px 18px;
  border-top: 1px solid rgba(255, 255, 255, 0.04);
  display: flex;
  justify-content: space-between;
  align-items: center;
  & > * + * { margin-left: 12px; }
  font-size: 11px;
  color: rgba(255, 255, 255, 0.4);
  flex-wrap: wrap;
`;

const Badge = styled.span<{ tone: 'ok' | 'lag' | 'err' }>`
  display: inline-flex;
  align-items: center;
  padding: 4px 9px;
  border-radius: 999px;
  font-family: 'SFProDisplay', monospace;
  font-size: 11px;
  color: ${(p) =>
    p.tone === 'ok'  ? '#00f6d2'
  : p.tone === 'lag' ? '#f0c14b'
  : '#ff7676'};
  border: 1px solid ${(p) =>
    p.tone === 'ok'  ? 'rgba(0, 246, 210, 0.4)'
  : p.tone === 'lag' ? 'rgba(240, 193, 75, 0.5)'
  : 'rgba(255, 118, 118, 0.5)'};
  background: rgba(0, 0, 0, 0.18);
`;

const BadgeDot = styled.span`
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
  box-shadow: 0 0 6px currentColor;
  /* Match the 9px side padding so the orb has equal breathing room to the
     label and to the rounded pill border. (Plain margin, not flex gap — the
     wallet's QtWebEngine/Chrome 83 predates flex gap support.) */
  margin-right: 9px;
`;

const IndexerBadge: React.FC = () => {
  const [health, setHealth] = useState<HealthResp | null>(null);
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const fetchHealth = (): void => {
      api.health()
        .then((h) => { if (!cancelled) { setHealth(h as HealthResp); setErrored(false); } })
        .catch(() => { if (!cancelled) setErrored(true); });
    };
    fetchHealth();
    const t = setInterval(fetchHealth, 30_000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  if (errored && !health) return <Badge tone="err"><BadgeDot />indexer · unreachable</Badge>;
  if (!health) return <Badge tone="ok"><BadgeDot />syncing…</Badge>;

  const behind = health.blocks_behind ?? 0;
  const lagSec = health.lag_seconds ?? 0;
  const tone: 'ok' | 'lag' | 'err' = lagSec > 300 ? 'lag' : behind > 5 ? 'lag' : 'ok';
  const label =
    behind > 0
      ? `syncing · ${behind.toLocaleString()} block${behind === 1 ? '' : 's'} behind`
      : `synced · ${health.last_indexed_height.toLocaleString()}`;

  return (
    <Badge tone={tone} title={`tick ${lagSec}s ago · chain head ${health.chain_head?.toLocaleString() ?? '?'}`}>
      <BadgeDot />
      {label}
    </Badge>
  );
};

export const Footer: React.FC = () => (
  <Wrap>
    <Inner>
      <Col>
        <ColTitle>BEAM</ColTitle>
        <FLink href="https://beam.mw" target="_blank" rel="noopener noreferrer">beam.mw</FLink>
      </Col>
      <Col>
        <ColTitle>Community</ColTitle>
        <FLink href="https://x.com/beamprivacy" target="_blank" rel="noopener noreferrer">X (Twitter)</FLink>
        <FLink href="https://t.me/beamprivacy" target="_blank" rel="noopener noreferrer">Telegram</FLink>
        <FLink href="https://discord.gg/fwfArUqpfh" target="_blank" rel="noopener noreferrer">Discord</FLink>
      </Col>
      <Col>
        <ColTitle>BeamTerminal</ColTitle>
        <FLink href="https://github.com/Maxnflaxl/BeamTerminal" target="_blank" rel="noopener noreferrer">GitHub</FLink>
        <FLink href="/privacy">Privacy Policy</FLink>
      </Col>
      <Col>
        <ColTitle>Contact</ColTitle>
        <FLink href="mailto:me@maxnflaxl.dev">me@maxnflaxl.dev</FLink>
        <FLink href="https://t.me/maxnflaxl" target="_blank" rel="noopener noreferrer">Telegram (@maxnflaxl)</FLink>
      </Col>
    </Inner>
    <BottomBar>
      <span>Built by Maxnflaxl</span>
      <IndexerBadge />
    </BottomBar>
  </Wrap>
);

export default Footer;
