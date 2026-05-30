import React, { useCallback, useMemo, useState } from 'react';
import { styled } from '@linaria/react';
import type { ApiAssetListEntry } from '../api/types';
import { useWallet, invokeCreatePool } from '../wallet';
import { useAssets, usePairs } from '../hooks';
import {
  Overlay, Card, CloseBtn, Btn, FEE_TIERS, actionButtonState,
} from './modalChrome';

const Head = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
  h3 { margin: 0; font-size: 16px; font-weight: 700; color: #fff; }
`;

const Field = styled.div`
  margin-bottom: 12px;
  label {
    display: block;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: rgba(255, 255, 255, 0.5);
    margin-bottom: 6px;
  }
`;

const Select = styled.select`
  width: 100%;
  padding: 10px 12px;
  background: rgba(0, 0, 0, 0.25);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 10px;
  color: #fff;
  font-family: inherit;
  font-size: 14px;
  outline: none;
  &:focus { border-color: var(--color-green); }
  &:disabled { opacity: 0.6; }
  option { background: #042548; color: #fff; }
`;

const TierRow = styled.div`
  display: flex;
  & > * + * { margin-left: 8px; }
  flex-wrap: wrap;
`;

const TierPill = styled.button<{ active?: boolean }>`
  padding: 6px 12px;
  border-radius: 14px;
  border: 1px solid ${(p) => (p.active ? 'var(--color-green)' : 'rgba(255, 255, 255, 0.15)')};
  background: ${(p) => (p.active ? 'rgba(0, 246, 210, 0.15)' : 'transparent')};
  color: ${(p) => (p.active ? '#00f6d2' : 'rgba(255, 255, 255, 0.6)')};
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  &:hover { border-color: rgba(0, 246, 210, 0.5); }
`;

const ErrMsg = styled.div`
  font-size: 12px;
  color: #f25f5b;
  margin: 4px 0 0;
`;

// Labeled asset dropdown — locked (single fixed option, e.g. PairDetail's
// create-missing-tier) or a full picker. Used for both pair sides.
const AssetSelect: React.FC<{
  label: string;
  value: number | null;
  onChange: (aid: number | null) => void;
  options: ApiAssetListEntry[];
  optionLabel: (aid: number) => string;
  locked: boolean;
  error?: string;
}> = ({
  label, value, onChange, options, optionLabel, locked, error,
}) => (
  <Field>
    <label>{label}</label>
    {locked && value !== null ? (
      <Select value={value} disabled>
        <option value={value}>{optionLabel(value)}</option>
      </Select>
    ) : (
      <Select
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
      >
        <option value="">Select asset…</option>
        {options.map((a) => (
          <option key={a.aid} value={a.aid}>{optionLabel(a.aid)}</option>
        ))}
      </Select>
    )}
    {error && <ErrMsg>{error}</ErrMsg>}
  </Field>
);

interface Props {
  /** When provided, the pair is locked (PairDetail "create missing tier"). */
  initialAid1?: number;
  initialAid2?: number;
  initialKind?: 0 | 1 | 2;
  lockPair?: boolean;
  onClose: () => void;
}

export const CreatePoolModal: React.FC<Props> = ({
  initialAid1, initialAid2, initialKind, lockPair = false, onClose,
}) => {
  const { headless, connecting, connect } = useWallet();
  const { data } = useAssets();
  const assets = useMemo(
    () => (data?.assets ?? [])
      .slice()
      .sort((a, b) => a.aid - b.aid),
    [data],
  );

  // Every existing pool (one row per fee tier) → keyed "aid1_aid2_kind" so we
  // can block creating a duplicate. The contract rejects duplicates too, but
  // disabling the button up front is clearer than letting the create fail.
  const { data: allPairs } = usePairs(useMemo(() => ({ group: 'tier' as const, limit: 500 }), []));
  const existingKeys = useMemo(
    () => new Set((allPairs?.pairs ?? []).map((pp) => `${pp.aid1}_${pp.aid2}_${pp.kind}`)),
    [allPairs],
  );

  const [aid1, setAid1] = useState<number | null>(initialAid1 ?? null);
  const [aid2, setAid2] = useState<number | null>(initialAid2 ?? null);
  const [kind, setKind] = useState<0 | 1 | 2>(initialKind ?? 1);
  const [executing, setExecuting] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  const label = (aid: number): string => {
    const a = assets.find((x) => x.aid === aid);
    const sym = a?.short_name ?? a?.unit_name ?? a?.name ?? `aid${aid}`;
    return `${sym} · #${aid}`;
  };

  const sameAsset = aid1 !== null && aid2 !== null && aid1 === aid2;
  const lo = aid1 !== null && aid2 !== null ? Math.min(aid1, aid2) : null;
  const hi = aid1 !== null && aid2 !== null ? Math.max(aid1, aid2) : null;
  const poolExists = lo !== null && hi !== null && !sameAsset
    && existingKeys.has(`${lo}_${hi}_${kind}`);
  const canSubmit = aid1 !== null && aid2 !== null && !sameAsset && !poolExists;

  const create = useCallback(async () => {
    if (aid1 === null || aid2 === null) return;
    // Canonical pool key: lower AID first.
    const lo = Math.min(aid1, aid2);
    const hi = Math.max(aid1, aid2);
    setExecuting(true);
    setFeedback(null);
    try {
      const res = await invokeCreatePool({ aid1: lo, aid2: hi, kind });
      if (res?.txid) {
        setFeedback({ kind: 'success', text: 'Pool creation submitted' });
        setTimeout(() => onClose(), 1200);
      } else {
        setFeedback({ kind: 'error', text: 'Cancelled' });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setFeedback({ kind: 'error', text: msg.slice(0, 90) });
    } finally {
      setExecuting(false);
    }
  }, [aid1, aid2, kind, onClose]);

  const btn = actionButtonState({
    feedback,
    headless,
    connecting,
    executing,
    busyLabel: 'Submitting…',
    disabledReason: poolExists ? 'Pool already exists' : !canSubmit ? 'Select two assets' : null,
    actionLabel: 'Create pool',
  });

  return (
    <Overlay onClick={onClose}>
      <Card onClick={(e) => e.stopPropagation()}>
        <Head>
          <h3>Create Pool</h3>
          <CloseBtn type="button" aria-label="Close" onClick={onClose}>×</CloseBtn>
        </Head>

        <AssetSelect
          label="First asset"
          value={aid1}
          onChange={setAid1}
          options={assets}
          optionLabel={label}
          locked={lockPair}
        />
        <AssetSelect
          label="Second asset"
          value={aid2}
          onChange={setAid2}
          options={assets}
          optionLabel={label}
          locked={lockPair}
          error={sameAsset ? 'Pick two different assets.' : undefined}
        />

        <Field>
          <label>Fee tier</label>
          <TierRow>
            {FEE_TIERS.map((t) => (
              <TierPill
                key={t.kind}
                type="button"
                active={kind === t.kind}
                onClick={() => setKind(t.kind)}
              >
                {t.label}
              </TierPill>
            ))}
          </TierRow>
          {poolExists && <ErrMsg>This pool already exists — open it from the DEX list instead.</ErrMsg>}
        </Field>

        <Btn
          type="button"
          variant={btn.variant}
          disabled={btn.disabled}
          onClick={headless ? () => { void connect(); } : () => { void create(); }}
        >
          {btn.text}
        </Btn>
      </Card>
    </Overlay>
  );
};

export default CreatePoolModal;
