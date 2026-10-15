import type { FC } from 'react';
import { type JumpClone } from '../types';

const MFG_TIME_IMPLANTS: Record<number, { short: string; pct: number }> = {
  27170: { short: 'BX-801', pct: 1 },
  27167: { short: 'BX-802', pct: 2 },
  27171: { short: 'BX-804', pct: 4 },
};

const WHATIF_BX_IDS = [27170, 27167, 27171];

interface ImplantSelectorProps {
  activeImplants: number[];
  effectiveTrueCostError: string | null;
  jumpClones: JumpClone[];
  onImplantsChange: (implants: number[]) => void;
  selectedImplants: number[];
}

const ImplantSelector: FC<ImplantSelectorProps> = ({ activeImplants, effectiveTrueCostError, jumpClones, onImplantsChange, selectedImplants }) => {
  return (
    <>
{!effectiveTrueCostError?.startsWith('Not manufacturable') && (() => {
              const opts: Array<{ value: string; label: string; ids: number[] }> = [
                { value: '', label: 'No implants (default)', ids: [] },
              ];
              const seen = new Set<number>();

              // Current active clone implants
              for (const id of activeImplants) {
                const imp = MFG_TIME_IMPLANTS[id];
                if (!imp || seen.has(id)) continue;
                opts.push({ value: `c${id}`, label: `Current clone — ${imp.short} (−${imp.pct}% time)`, ids: [id] });
                seen.add(id);
              }

              // Jump clones — only show clones that have at least one mfg-time implant
              jumpClones.forEach((clone, idx) => {
                const cloneMfgIds = clone.implants.filter(id => id in MFG_TIME_IMPLANTS);
                if (cloneMfgIds.length === 0) return;
                // Build a compact label from the implant shortnames
                const impLabels = cloneMfgIds.map(id => MFG_TIME_IMPLANTS[id].short).join(', ');
                opts.push({
                  value: `j${clone.jumpCloneId}`,
                  label: `Jump clone ${idx + 1} — ${impLabels}`,
                  ids: clone.implants,
                });
              });

              // What-if options for implants not already shown
              for (const id of WHATIF_BX_IDS) {
                if (seen.has(id)) continue;
                const imp = MFG_TIME_IMPLANTS[id];
                opts.push({ value: `w${id}`, label: `What-if: ${imp.short} (−${imp.pct}% time)`, ids: [id] });
              }

              // Determine the currently selected option value
              const curId = selectedImplants[0];
              let curValue = '';
              if (curId) {
                if (activeImplants.includes(curId)) {
                  curValue = `c${curId}`;
                } else {
                  // Check if it matches a jump clone selection
                  const matchedClone = jumpClones.find(c => c.implants.includes(curId));
                  curValue = matchedClone ? `j${matchedClone.jumpCloneId}` : `w${curId}`;
                }
              }

              return (
                <div className="implant-selector">
                  <span className="implant-selector-label">💊 Implants</span>
                  <select
                    className="fee-char-select"
                    value={curValue}
                    title="Implants affect build time → ISK/hr only (not material cost). Default applies none."
                    onChange={(e) => {
                      const opt = opts.find(o => o.value === e.target.value);
                      onImplantsChange(opt ? opt.ids : []);
                    }}
                    aria-label="Implant set to apply to ISK/hr"
                    style={{ flex: 1 }}
                  >
                    {opts.map(o => <option key={o.value || 'none'} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
              );
            })()}
    </>
  );
};

export default ImplantSelector;
