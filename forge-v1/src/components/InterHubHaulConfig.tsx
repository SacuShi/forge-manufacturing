// FORGE — InterHubHaulConfig
// Inline (non-modal) panel for configuring inter-hub haulage costs,
// independent from the manufacturing haul config.

import { useState, useEffect, type FC } from 'react';
import type { HaulMethod } from '../types';

import HaulMethodFields from './HaulMethodFields';
import type { CharacterSkillData } from '../data/haulProviders';
// ── Freight ship table ────────────────────────────────────────────────────────
// Shared with IndustrySettings.tsx — see data/freightShips.ts for the full
// verification notes.

// ── Types ──────────────────────────────────────────────────────────────────────

interface InterHubHaulConfigProps {
  open:        boolean;
  onClose:     () => void;
  token:       string;
  characters?: CharacterSkillData[];
  onSaved?:    () => void;
}

// ── Component ──────────────────────────────────────────────────────────────────

const InterHubHaulConfig: FC<InterHubHaulConfigProps> = ({
  open,
  onClose,
  token,
  characters = [],
  onSaved,
}) => {
  // Form state
  const [haulEnabled,   setHaulEnabled]   = useState(false);
  const [method,        setMethod]        = useState<HaulMethod>('user_defined');
  const [rate,          setRate]          = useState(0);
  const [iskPerJump,    setIskPerJump]    = useState(0);
  const [flatTotal,     setFlatTotal]     = useState(0);
  const [serviceLabel,  setServiceLabel]  = useState('');
  const [collateral,    setCollateral]    = useState(0);
  const [selfCharId,    setSelfCharId]    = useState<number | null>(null);
  const [selfShip,      setSelfShip]      = useState('');
  const [selfFuel,      setSelfFuel]      = useState(0);

  // Save state
  const [saving,    setSaving]    = useState(false);
  const [saved,     setSaved]     = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [loading,   setLoading]   = useState(false);

  // Load current settings when panel opens
  useEffect(() => {
    if (!open || !token) return;
    let cancelled = false;
    setLoading(true);
    setSaved(false);
    setSaveError(null);
    fetch('/api/industry-settings', {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.json())
      .then((s) => {
        if (cancelled) return;
        setHaulEnabled(!!s.interhub_haul_enabled);
        setMethod((s.interhub_method ?? 'user_defined') as HaulMethod);
        setRate(s.interhub_haul_rate     ?? 0);
        setIskPerJump(s.interhub_isk_per_jump ?? 0);
        setFlatTotal(s.interhub_flat_total    ?? 0);
        setServiceLabel(s.interhub_service_label ?? '');
        setCollateral(s.interhub_collateral     ?? 0);
        setSelfCharId(s.interhub_self_char_id   ?? null);
        setSelfShip(s.interhub_self_ship        ?? '');
        setSelfFuel(s.interhub_self_fuel        ?? 0);
      })
      .catch(() => { /* non-fatal — form stays at defaults */ })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, token]);

  // ── Save ──────────────────────────────────────────────────────────────────
  const handleSave = async () => {
    if (!token) return;
    setSaving(true);
    setSaveError(null);
    try {
      const body = {
        interhub_haul_enabled:  haulEnabled,
        interhub_method:        method,
        interhub_haul_rate:     rate,
        interhub_isk_per_jump:  iskPerJump,
        interhub_flat_total:    flatTotal,
        interhub_service_label: serviceLabel || null,
        interhub_collateral:    collateral,
        interhub_self_char_id:  selfCharId,
        interhub_self_ship:     selfShip || null,
        interhub_self_fuel:     selfFuel,
      };
      const r = await fetch('/api/industry-settings', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body:    JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setSaved(true);
      onSaved?.();
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  return (
    <div style={{
      borderTop: '0.5px solid var(--color-border-light)',
      background: 'var(--color-bg-secondary)',
      padding: '12px 20px',
      flexShrink: 0,
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.5, color: 'var(--color-text-secondary)', textTransform: 'uppercase' }}>
          Inter-Hub Haulage
        </span>
        <button
          type="button"
          className="btn"
          onClick={onClose}
          style={{ fontSize: 10, padding: '2px 8px' }}
        >
          ✕ Close
        </button>
      </div>

      {loading ? (
        <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', padding: '6px 0' }}>Loading…</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {/* Enable toggle */}
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 12 }}>
            <input
              type="checkbox"
              checked={haulEnabled}
              onChange={(e) => setHaulEnabled(e.target.checked)}
            />
            <span style={{ color: 'var(--color-text-secondary)' }}>Enable haul cost</span>
          </label>

          {haulEnabled && (
            <div className="haul-leg" style={{ marginTop: 4 }}>
              <div className="haul-leg-label">
                <span className="haul-leg-title">Haulage</span>
                <span className="haul-leg-route">Buy hub → Sell hub (calculated per item)</span>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
                <HaulMethodFields
                  characters={characters}
                  value={{ method, rate, iskPerJump, flatTotal, serviceLabel, collateral, selfCharId, selfShip, selfFuel }}
                  onChange={(p) => {
                    if (p.method       !== undefined) setMethod(p.method);
                    if (p.rate         !== undefined) setRate(p.rate);
                    if (p.iskPerJump   !== undefined) setIskPerJump(p.iskPerJump);
                    if (p.flatTotal    !== undefined) setFlatTotal(p.flatTotal);
                    if (p.serviceLabel !== undefined) setServiceLabel(p.serviceLabel);
                    if (p.collateral   !== undefined) setCollateral(p.collateral);
                    if (p.selfCharId   !== undefined) setSelfCharId(p.selfCharId);
                    if (p.selfShip     !== undefined) setSelfShip(p.selfShip);
                    if (p.selfFuel     !== undefined) setSelfFuel(p.selfFuel);
                  }}
                />
              </div>
            </div>
          )}

          {/* Footer */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 }}>
            <button
              type="button"
              className="btn btn-primary"
              disabled={saving}
              onClick={handleSave}
              style={{ fontSize: 11, padding: '4px 14px' }}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            {saved && !saveError && (
              <span style={{ fontSize: 11, color: 'var(--color-success)' }}>✓ Saved</span>
            )}
            {saveError && (
              <span style={{ fontSize: 11, color: 'var(--color-danger)' }}>⚠ {saveError}</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default InterHubHaulConfig;
