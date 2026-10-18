/**
 * Amber notice for items locked in Asset Safety: what they're worth at today's Jita price and what it
 * costs to release them. Asset Safety is not a station — the items sit in "Asset Safety Wrap" containers
 * and can't be used for manufacturing until released, so FORGE leaves them out of every calculation.
 *
 * Fees (CCP support, "Asset Safety"): 15% of the items' value if they're delivered to a station in another
 * system (what the automatic 20-day move does), 0.5% if you choose a station in the same system as the
 * original structure (possible after 5 days). CCP values items at their average market price; here they are
 * valued at the current Jita lowest sell, so the real fee will differ a little.
 */

import { useEffect, useState, type FC } from 'react';
import { formatISKDisplay as formatISK } from '../utils/format';
import { assetSafetyFees } from '../utils/assetSafety';

export interface SafetyHolding { typeId: number; qty: number }

interface Props {
  holdings: SafetyHolding[];
  /** item types in Asset Safety that can't be valued at a Jita price (blueprints/formulas) */
  unvaluedTypes?: number;
  /** Asset Safety wraps present in the asset list (even if ESI listed nothing inside them) */
  wrapCount: number;
  /** Whether the safety items are currently hidden from the list below (the pill) */
  hidden: boolean;
}

interface Valuation {
  status: 'loading' | 'ready' | 'error';
  total: number;
  pricedTypes: number;
  unpricedTypes: number;
  error?: string;
}

const BATCH = 200;   // /api/appraise accepts at most 200 lines per request

const AssetSafetyPanel: FC<Props> = ({ holdings, unvaluedTypes = 0, wrapCount, hidden }) => {
  const [val, setVal] = useState<Valuation>({ status: 'loading', total: 0, pricedTypes: 0, unpricedTypes: 0 });
  const key = holdings.map(h => `${h.typeId}:${h.qty}`).sort().join(',');

  useEffect(() => {
    if (holdings.length === 0) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- guarded request loader: marks loading before the request
    setVal(v => ({ ...v, status: 'loading' }));
    (async () => {
      try {
        let total = 0, priced = 0, unpriced = 0;
        for (let i = 0; i < holdings.length; i += BATCH) {
          if (cancelled) return;                       // the list changed or the tab closed: stop asking
          const slice = holdings.slice(i, i + BATCH).map(h => ({ typeId: h.typeId, qty: h.qty }));
          const res = await fetch('/api/appraise', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ items: slice, regionId: 10000002 }),   // Jita
          });
          if (!res.ok) {
            const body = await res.json().catch(() => ({})) as { error?: string };
            throw new Error(body.error ?? `Server error ${res.status}`);
          }
          const data = await res.json() as { items: Array<{ sell: number; sellTotal: number }> };
          for (const it of data.items) {
            if (it.sell > 0) { total += it.sellTotal; priced++; } else unpriced++;
          }
        }
        if (!cancelled) setVal({ status: 'ready', total, pricedTypes: priced, unpricedTypes: unpriced });
      } catch (e) {
        if (!cancelled) setVal({ status: 'error', total: 0, pricedTypes: 0, unpricedTypes: 0, error: (e as Error).message });
      }
    })();
    return () => { cancelled = true; };
    // `key` captures the contents of `holdings`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (holdings.length === 0 && unvaluedTypes === 0 && wrapCount === 0) return null;
  if (holdings.length === 0 && unvaluedTypes === 0) {
    // wraps exist but ESI listed nothing inside them: say so rather than showing nothing
    return (
      <div className="bp-ownership-note" style={{ marginBottom: 10 }}>
        ⚠ {wrapCount} Asset Safety wrap{wrapCount === 1 ? '' : 's'} found, but EVE didn&apos;t list what {wrapCount === 1 ? 'is' : 'are'} inside, so the value and
        release cost can&apos;t be worked out here. Anything inside is locked until released, so FORGE doesn&apos;t count it in any calculation.
      </div>
    );
  }
  const fees = assetSafetyFees(val.total);
  const typeCount = holdings.length + unvaluedTypes;

  return (
    <div className="bp-ownership-note" style={{ marginBottom: 10 }}>
      ⚠ {typeCount.toLocaleString()} item type{typeCount === 1 ? '' : 's'} {hidden ? 'are hidden here because they are' : 'are'} locked in Asset Safety.
      They can&apos;t be used for manufacturing, so FORGE leaves them out of every calculation (have/needed, shortfalls,
      buildable-now, the Queue Planner) until you release them.
      <ul className="notice-list">
        {holdings.length === 0 && <li>Only blueprints are locked here, and blueprints can't be valued at a Jita price.</li>}
        {holdings.length > 0 && val.status === 'loading' && <li>Pricing them at Jita…</li>}
        {holdings.length > 0 && val.status === 'error' && <li>Couldn&apos;t price them at Jita ({val.error}). Reload to try again.</li>}
        {holdings.length > 0 && val.status === 'ready' && (
          <>
            <li>
              Value at current Jita prices: <strong>{formatISK(val.total)}</strong>
              {val.unpricedTypes > 0 && <> ({val.unpricedTypes} item type{val.unpricedTypes === 1 ? ' has' : 's have'} no Jita sell price and {val.unpricedTypes === 1 ? 'is' : 'are'} not counted)</>}
            </li>
            <li>
              Cost to release to a station in another system (the automatic move after 20 days): 15% ≈ <strong>{formatISK(fees.otherSystem)}</strong>
            </li>
            <li>
              Cost to release to a station in the same system as the original structure (you can choose this after 5 days): 0.5% ≈ <strong>{formatISK(fees.sameSystem)}</strong>
            </li>
          </>
        )}
      </ul>
      CCP charges the fee on the items&apos; average market price, so the real figure will differ slightly from this Jita-price estimate.
    </div>
  );
};

export default AssetSafetyPanel;
