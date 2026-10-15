/**
 * Haul method picker + its inputs (user-defined rates, contract hauler, self-haul).
 * Shared by IndustrySettings (Materials in / Goods out legs) and InterHubHaulConfig, which used to
 * carry two ~150-line copies of this block.
 */
import { useMemo, type FC } from 'react';
import type { HaulMethod } from '../types';
import { FREIGHT_SHIPS } from '../data/freightShips';
import { HAUL_PROVIDERS, calcProviderFee, fmtISK, type CharacterSkillData } from '../data/haulProviders';

export interface HaulLegValue {
  method:       HaulMethod;
  rate:         number;
  iskPerJump:   number;
  flatTotal:    number;
  serviceLabel: string;
  collateral:   number;
  selfCharId:   number | null;
  selfShip:     string;
  selfFuel:     number;
}

interface Props {
  value:      HaulLegValue;
  onChange:   (patch: Partial<HaulLegValue>) => void;
  characters: CharacterSkillData[];
}

const nonNeg = (raw: string) => Math.max(0, parseFloat(raw) || 0);
const LABEL: React.CSSProperties = { fontSize: 11, color: 'var(--color-text-secondary)', minWidth: 72 };
const ROW: React.CSSProperties   = { display: 'flex', alignItems: 'center', gap: 6 };
const COLUMN: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 5, paddingLeft: 56 };

const HaulMethodFields: FC<Props> = ({ value, onChange, characters }) => {
  const { method, rate, iskPerJump, flatTotal, serviceLabel, collateral, selfCharId, selfShip, selfFuel } = value;

  // Which freight ships can each character fly, and with how much cargo at their skill level.
  const charShipOptions = useMemo(() => characters.map((c) => {
    const skillMap = new Map(c.skills.map((s) => [s.skill_id, s.active_skill_level]));
    const ships = FREIGHT_SHIPS
      .filter((ship) => (skillMap.get(ship.skillId) ?? 0) >= ship.minLevel)
      .map((ship) => {
        const level = Math.min(5, Math.max(1, skillMap.get(ship.skillId) ?? 1));
        return { id: ship.id, name: ship.name, level, cargo: ship.cargoAtLevel[level] };
      });
    return { characterId: c.characterId, name: c.name, ships };
  }), [characters]);

  const flyableShips = charShipOptions.find((c) => c.characterId === selfCharId)?.ships ?? [];
  const selfCargo    = (selfCharId && selfShip && flyableShips.find((s) => s.id === selfShip)?.cargo) || 0;
  const rfEquiv      = selfCargo > 0 ? calcProviderFee('red_frog', selfCargo, 0) : 0;
  const breakEvenIskHr = rfEquiv > 0 ? rfEquiv / (9 / 60) : 0; // rough 9-jump estimate

  const provider = HAUL_PROVIDERS[method];

  return (
    <>
      <div style={{ ...ROW, gap: 8 }}>
        <span style={{ ...LABEL, minWidth: 48 }}>Method</span>
        <select className="settings-input" style={{ maxWidth: 200 }} value={method}
          onChange={(e) => onChange({ method: e.target.value as HaulMethod })}>
          <option value="user_defined">User-Defined</option>
          <option value="red_frog">Red Frog</option>
          <option value="black_frog">Black Frog</option>
          <option value="pushx">PushX</option>
          <option value="self_haul">Self-Haul</option>
        </select>
      </div>

      {method === 'user_defined' && (
        <div style={COLUMN}>
          <div style={ROW}>
            <input type="number" className="settings-input settings-input-short" value={rate} min={0} step={100} placeholder="0"
              onChange={(e) => onChange({ rate: nonNeg(e.target.value) })} />
            <span className="haul-leg-unit">ISK/m³</span>
          </div>
          <div style={ROW}>
            <input type="number" className="settings-input settings-input-short" value={iskPerJump || ''} min={0} step={100000} placeholder="0"
              onChange={(e) => onChange({ iskPerJump: nonNeg(e.target.value) })} />
            <span className="haul-leg-unit">ISK/jump</span>
          </div>
          <div style={ROW}>
            <input type="number" className="settings-input settings-input-short" value={flatTotal || ''} min={0} step={1000000} placeholder="0"
              onChange={(e) => onChange({ flatTotal: nonNeg(e.target.value) })} />
            <span className="haul-leg-unit">ISK flat</span>
          </div>
          <div style={ROW}>
            <input type="text" className="settings-input" style={{ maxWidth: 160 }} value={serviceLabel} placeholder="Label (e.g. Alliance JF)"
              onChange={(e) => onChange({ serviceLabel: e.target.value.slice(0, 40) })} />
          </div>
          {(rate > 0 || iskPerJump > 0 || flatTotal > 0) && (
            <div className="haul-leg-note">Using highest of filled fields (most conservative).</div>
          )}
        </div>
      )}

      {provider && (
        <div style={COLUMN}>
          <div className="haul-leg-note" style={{ marginBottom: 4 }}>
            ~{fmtISK(provider.isk_per_m3)} ISK/m³ base · {(provider.collateral_rate * 100).toFixed(1)}% collateral · min {fmtISK(provider.min_fee)} ISK · {provider.note}
          </div>
          <div style={ROW}>
            <span style={LABEL}>Collateral</span>
            <input type="number" className="settings-input settings-input-short" value={collateral || ''} min={0} step={10000000} placeholder="0"
              onChange={(e) => onChange({ collateral: nonNeg(e.target.value) })} />
            <span className="haul-leg-unit">ISK</span>
          </div>
          {collateral > 0 && (
            <div className="haul-leg-note">
              Collateral declared: {fmtISK(collateral)} ISK — affects quoted fee but not deducted from profit.
              Rates as of {provider.rates_as_of} — verify at provider website.
            </div>
          )}
        </div>
      )}

      {method === 'self_haul' && (
        <div style={COLUMN}>
          {characters.length === 0 ? (
            <div className="haul-leg-note">Log in to see available ships.</div>
          ) : (
            <>
              <div style={ROW}>
                <span style={LABEL}>Character</span>
                <select className="settings-input" style={{ maxWidth: 180 }} value={selfCharId ?? ''}
                  onChange={(e) => onChange({ selfCharId: e.target.value ? Number(e.target.value) : null, selfShip: '' })}>
                  <option value="">— select —</option>
                  {characters.map((c) => <option key={c.characterId} value={c.characterId}>{c.name}</option>)}
                </select>
              </div>
              <div style={ROW}>
                <span style={LABEL}>Ship</span>
                <select className="settings-input" style={{ maxWidth: 200 }} value={selfShip} disabled={!selfCharId}
                  onChange={(e) => onChange({ selfShip: e.target.value })}>
                  <option value="">— select —</option>
                  {flyableShips.map((s) => (
                    <option key={s.id} value={s.id}>{s.name} L{s.level} — {s.cargo.toLocaleString()} m³</option>
                  ))}
                  {selfCharId && flyableShips.length === 0 && <option disabled>No freight ships available</option>}
                </select>
              </div>
              {selfCargo > 0 && (
                <div className="haul-leg-note" style={{ color: 'var(--color-success)' }}>
                  ✓ {selfCargo.toLocaleString()} m³ cargo — 0 ISK/m³ (your time only)
                </div>
              )}
              <div style={ROW}>
                <span style={LABEL}>Fuel cost</span>
                <input type="number" className="settings-input settings-input-short" value={selfFuel || ''} min={0} step={1000000} placeholder="0"
                  onChange={(e) => onChange({ selfFuel: nonNeg(e.target.value) })} />
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
    </>
  );
};

export default HaulMethodFields;
