// FORGE — InterHubHaulConfig
// Inline (non-modal) panel for configuring inter-hub haulage costs,
// independent from the manufacturing haul config.

import { useState, useEffect, useMemo, type FC } from 'react';
import type { HaulMethod } from '../types';
import { FREIGHT_SHIPS } from '../data/freightShips';

// ── Haul provider rate tables (mirrored from server.js HAUL_PROVIDERS) ────────
interface HaulProvider {
  name:            string;
  max_volume_m3:   number;
  min_fee:         number;
  isk_per_m3:      number;
  collateral_rate: number;
  rates_as_of:     string;
  note:            string;
}

const HAUL_PROVIDERS: Record<string, HaulProvider> = {
  red_frog:   { name: 'Red Frog',   max_volume_m3: 860_000, min_fee: 1_000_000, isk_per_m3: 400,   collateral_rate: 0.005, rates_as_of: 'Jun 2025', note: 'Highsec only'          },
  black_frog: { name: 'Black Frog', max_volume_m3: 860_000, min_fee: 1_500_000, isk_per_m3: 1_200, collateral_rate: 0.01,  rates_as_of: 'Jun 2025', note: 'Lowsec / Null / WH'    },
  pushx:      { name: 'PushX',      max_volume_m3: 860_000, min_fee: 1_000_000, isk_per_m3: 380,   collateral_rate: 0.005, rates_as_of: 'Jun 2025', note: 'Highsec + some lowsec' },
};

function calcProviderFee(provider: string, volumeM3: number, collateral: number): number {
  const p = HAUL_PROVIDERS[provider];
  if (!p || volumeM3 <= 0) return 0;
  const contracts  = Math.ceil(volumeM3 / p.max_volume_m3);
  const volPerCon  = volumeM3   / contracts;
  const colPerCon  = collateral / contracts;
  const feePerCon  = Math.max(p.min_fee, p.isk_per_m3 * volPerCon + p.collateral_rate * colPerCon);
  return feePerCon * contracts;
}

function fmtISK(n: number): string {
  if (n >= 1e9)  return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6)  return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3)  return (n / 1e3).toFixed(0) + 'K';
  return n.toFixed(0);
}

// ── Freight ship table ────────────────────────────────────────────────────────
// Shared with IndustrySettings.tsx — see data/freightShips.ts for the full
// verification notes.

// ── Types ──────────────────────────────────────────────────────────────────────

interface CharacterSkillData {
  characterId: number;
  name:        string;
  skills:      Array<{ skill_id: number; active_skill_level: number }>;
}

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

  // ── Self-haul helpers ─────────────────────────────────────────────────────
  const charShipOptions = useMemo(() => {
    return characters.map((c) => {
      const skillMap = new Map(c.skills.map(s => [s.skill_id, s.active_skill_level]));
      const flyable = FREIGHT_SHIPS
        .filter(ship => (skillMap.get(ship.skillId) ?? 0) >= ship.minLevel)
        .map(ship => {
          const level = Math.min(5, Math.max(1, skillMap.get(ship.skillId) ?? 1));
          return { id: ship.id, name: ship.name, level, cargo: ship.cargoAtLevel[level] };
        });
      return { characterId: c.characterId, name: c.name, ships: flyable };
    });
  }, [characters]);

  function getSelfHaulCargo(charId: number | null, shipId: string): number {
    if (!charId || !shipId) return 0;
    const char = charShipOptions.find(c => c.characterId === charId);
    return char?.ships.find(s => s.id === shipId)?.cargo ?? 0;
  }

  const selectedChar = charShipOptions.find(c => c.characterId === selfCharId);
  const flyableShips = selectedChar?.ships ?? [];
  const selfCargo    = getSelfHaulCargo(selfCharId, selfShip);
  const rfEquiv      = selfCargo > 0 ? calcProviderFee('red_frog', selfCargo, 0) : 0;
  const breakEvenIskHr = rfEquiv > 0 && selfCargo > 0 ? rfEquiv / (9 / 60) : 0;

  const providerPreview = (m: HaulMethod) => {
    const p = HAUL_PROVIDERS[m];
    if (!p) return null;
    return `~${fmtISK(p.isk_per_m3)} ISK/m³ base · ${(p.collateral_rate * 100).toFixed(1)}% collateral · min ${fmtISK(p.min_fee)} ISK · ${p.note}`;
  };

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
                {/* Method selector */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 11, color: 'var(--color-text-secondary)', minWidth: 48 }}>Method</span>
                  <select
                    className="settings-input"
                    style={{ maxWidth: 200 }}
                    value={method}
                    onChange={(e) => setMethod(e.target.value as HaulMethod)}
                  >
                    <option value="user_defined">User-Defined</option>
                    <option value="red_frog">Red Frog</option>
                    <option value="black_frog">Black Frog</option>
                    <option value="pushx">PushX</option>
                    <option value="self_haul">Self-Haul</option>
                  </select>
                </div>

                {/* User-Defined inputs */}
                {method === 'user_defined' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 5, paddingLeft: 56 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <input type="number" className="settings-input settings-input-short" value={rate} min={0} step={100} placeholder="0"
                        onChange={(e) => setRate(Math.max(0, parseFloat(e.target.value) || 0))} />
                      <span className="haul-leg-unit">ISK/m³</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <input type="number" className="settings-input settings-input-short" value={iskPerJump || ''} min={0} step={100000} placeholder="0"
                        onChange={(e) => setIskPerJump(Math.max(0, parseFloat(e.target.value) || 0))} />
                      <span className="haul-leg-unit">ISK/jump</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <input type="number" className="settings-input settings-input-short" value={flatTotal || ''} min={0} step={1000000} placeholder="0"
                        onChange={(e) => setFlatTotal(Math.max(0, parseFloat(e.target.value) || 0))} />
                      <span className="haul-leg-unit">ISK flat</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <input type="text" className="settings-input" style={{ maxWidth: 160 }} value={serviceLabel} placeholder="Label (e.g. Alliance JF)"
                        onChange={(e) => setServiceLabel(e.target.value.slice(0, 40))} />
                    </div>
                    {(rate > 0 || iskPerJump > 0 || flatTotal > 0) && (
                      <div className="haul-leg-note">Using highest of filled fields (most conservative).</div>
                    )}
                  </div>
                )}

                {/* Contract hauler inputs */}
                {(method === 'red_frog' || method === 'black_frog' || method === 'pushx') && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 5, paddingLeft: 56 }}>
                    <div className="haul-leg-note" style={{ marginBottom: 4 }}>
                      {providerPreview(method)}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontSize: 11, color: 'var(--color-text-secondary)', minWidth: 72 }}>Collateral</span>
                      <input type="number" className="settings-input settings-input-short" value={collateral || ''} min={0} step={10000000} placeholder="0"
                        onChange={(e) => setCollateral(Math.max(0, parseFloat(e.target.value) || 0))} />
                      <span className="haul-leg-unit">ISK</span>
                    </div>
                    {collateral > 0 && (
                      <div className="haul-leg-note">
                        Collateral declared: {fmtISK(collateral)} ISK — affects quoted fee but not deducted from profit.
                        Rates as of {HAUL_PROVIDERS[method].rates_as_of} — verify at provider website.
                      </div>
                    )}
                  </div>
                )}

                {/* Self-Haul inputs */}
                {method === 'self_haul' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 5, paddingLeft: 56 }}>
                    {characters.length === 0 ? (
                      <div className="haul-leg-note">Log in to see available ships.</div>
                    ) : (
                      <>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ fontSize: 11, color: 'var(--color-text-secondary)', minWidth: 72 }}>Character</span>
                          <select className="settings-input" style={{ maxWidth: 180 }} value={selfCharId ?? ''} onChange={(e) => { setSelfCharId(e.target.value ? Number(e.target.value) : null); setSelfShip(''); }}>
                            <option value="">— select —</option>
                            {characters.map(c => <option key={c.characterId} value={c.characterId}>{c.name}</option>)}
                          </select>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ fontSize: 11, color: 'var(--color-text-secondary)', minWidth: 72 }}>Ship</span>
                          <select className="settings-input" style={{ maxWidth: 200 }} value={selfShip} onChange={(e) => setSelfShip(e.target.value)} disabled={!selfCharId}>
                            <option value="">— select —</option>
                            {flyableShips.map(s => (
                              <option key={s.id} value={s.id}>
                                {s.name} L{s.level} — {s.cargo.toLocaleString()} m³
                              </option>
                            ))}
                            {selfCharId && flyableShips.length === 0 && <option disabled>No freight ships available</option>}
                          </select>
                        </div>
                        {selfCargo > 0 && (
                          <div className="haul-leg-note" style={{ color: 'var(--color-success)' }}>
                            ✓ {selfCargo.toLocaleString()} m³ cargo — 0 ISK/m³ (your time only)
                          </div>
                        )}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ fontSize: 11, color: 'var(--color-text-secondary)', minWidth: 72 }}>Fuel cost</span>
                          <input type="number" className="settings-input settings-input-short" value={selfFuel || ''} min={0} step={1000000} placeholder="0"
                            onChange={(e) => setSelfFuel(Math.max(0, parseFloat(e.target.value) || 0))} />
                          <span className="haul-leg-unit">ISK</span>
                        </div>
                        {selfCargo > 0 && rfEquiv > 0 && (
                          <div className="haul-leg-note">
                            Red Frog equivalent ≈ {fmtISK(rfEquiv)} ISK · Break-even: your time worth &lt; {fmtISK(breakEvenIskHr)} ISK/hr → self-haul wins
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}
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
