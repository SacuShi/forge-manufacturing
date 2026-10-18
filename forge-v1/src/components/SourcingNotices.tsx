import type { ReactElement, FC } from 'react';
import { formatISKDisplay as formatISK } from '../utils/format';
import { type ItemDetailApiResponse, type Market, type TrueCostResponse } from '../types';

interface SourcingNoticesProps {
  apiDetail: ItemDetailApiResponse | null;
  displayName: string;
  itemNames: Map<number, string>;
  materialMarketName: string;
  onOpenSettings: (section?: "haulage" | undefined) => void;
  selectedMarket: Market;
  trueCostData: TrueCostResponse | null;
  trueCostLoading: boolean;
}

const SourcingNotices: FC<SourcingNoticesProps> = ({ apiDetail, displayName, itemNames, materialMarketName, onOpenSettings, selectedMarket, trueCostData, trueCostLoading }) => {
  return (
    <>
{trueCostData && !trueCostLoading && (() => {
              const ms = trueCostData.material_sourcing;
              const hc = trueCostData.haul_cost;
              const nameOf = (id: number) =>
                apiDetail?.buildInfo?.materials?.find(m => m.materialId === id)?.name
                ?? itemNames.get(id) ?? `Material #${id}`;
              // one bullet per item, never a run-on sentence
              const bullets = (ids: number[]) => (
                <ul className="notice-list">
                  {ids.map(id => <li key={id}>{nameOf(id)}</li>)}
                </ul>
              );
              const haulLink = (
                <button type="button" onClick={() => onOpenSettings('haulage')}
                  style={{ background: 'none', border: 'none', padding: 0, color: 'inherit', font: 'inherit',
                           textDecoration: 'underline', cursor: 'pointer' }}>
                  ⚙ Mfg Setup → Haulage
                </button>
              );
              const notes: ReactElement[] = [];
              let haulAdviceShown = false;   // only one "set up haulage" box per panel
              if (ms) {
                const none = ms.lines.filter(l => l.scope === 'jita').map(l => l.material_id);
                const part = ms.lines.filter(l => l.scope === 'mixed').map(l => l.material_id);
                if (none.length + part.length > 0) {
                  if (hc.haul_enabled === false || hc.leg1_configured === false) haulAdviceShown = true;
                  notes.push(
                    <div key="import" className="bp-ownership-note">
                      {none.length > 0 && <>⚠ Not stocked at {materialMarketName}:{bullets(none)}</>}
                      {part.length > 0 && <>{none.length === 0 && '⚠ '}Only partly stocked at {materialMarketName}:{bullets(part)}</>}
                      What {materialMarketName} can&apos;t supply is priced at Jita ({formatISK(ms.import_cost)}) and has to be imported or manufactured.{' '}
                      {hc.haul_enabled === false || hc.leg1_configured === false
                        ? <>For an accurate True Profit, set up your haulage costs in {haulLink}.</>
                        : hc.import_leg_route_known === false
                          ? <>The route from Jita to your build system couldn&apos;t be looked up, so the import freight is NOT included — try again shortly.</>
                          : (hc.import_leg_cost ?? 0) > 0
                            ? <>Import freight is included: {formatISK(hc.import_leg_cost ?? 0)} for {Math.round(hc.import_leg_volume_m3 ?? 0).toLocaleString()} m³ over {hc.import_leg_jumps ?? 0} jumps, using your Leg 1 haulage settings ({haulLink}).</>
                            : hc.haul_enabled === undefined ? null
                              : <>No import freight was added (your build system is Jita, or these items have no volume data).</>}
                    </div>
                  );
                }
                const short = ms.lines.filter(l => l.short_stock).map(l => l.material_id);
                if (short.length > 0) {
                  notes.push(
                    <div key="short" className="bp-ownership-note">
                      ⚠ Not enough is listed at {materialMarketName} or at Jita to fill the full quantity of these — the rest is priced at the last visible price, so the real cost may be higher:
                      {bullets(short)}
                    </div>
                  );
                }
                const hist = ms.lines.filter(l => l.scope === 'history').map(l => l.material_id);
                const nothing = ms.lines.filter(l => l.scope === 'none').map(l => l.material_id);
                if (!ms.jita_unavailable && hist.length + nothing.length > 0) {
                  notes.push(
                    <div key="nodata" className="bp-ownership-note">
                      {hist.length > 0 && <>⚠ No one is selling these at {materialMarketName} or Jita — priced at their 30-day average:{bullets(hist)}</>}
                      {nothing.length > 0 && <>{hist.length === 0 && '⚠ '}No price at all, so these are missing from the material cost:{bullets(nothing)}</>}
                    </div>
                  );
                }
                if (ms.jita_unavailable && ms.lines.some(l => l.short_stock || l.scope === 'none' || l.scope === 'history')) {
                  notes.push(
                    <div key="nojita" className="bp-ownership-note">
                      ⚠ Jita prices aren&apos;t loaded yet, so imports couldn&apos;t be priced. Refresh in a moment.
                    </div>
                  );
                }
              }
              if (trueCostData.sell_price_scope === 'jita') {
                notes.push(
                  <div key="sell" className="bp-ownership-note">
                    ⚠ {displayName} isn&apos;t for sale at {selectedMarket.name}, so the sale price is Jita&apos;s current lowest sell
                    and fees and freight assume you sell it at Jita.{' '}
                    {haulAdviceShown ? null
                      : hc.haul_enabled === false ? <>Set up your haulage costs in {haulLink} to include the freight to Jita.</>
                      : hc.leg2_route_known === false ? null
                      : hc.leg2_jumps === 0 ? <>You build in Jita&apos;s system, so there is no freight to Jita.</>
                      : hc.leg2_cost === 0 ? <>Set up your Leg 2 (goods out) haulage in {haulLink} to include the freight to Jita.</>
                      : <>Freight to Jita is included.</>}
                  </div>
                );
              } else if (trueCostData.sell_listing && (trueCostData.sell_listing.spread_ratio ?? 0) >= 5) {
                const sl = trueCostData.sell_listing;
                notes.push(
                  <div key="thin" className="bp-ownership-note">
                    ⚠ Thin market at {selectedMarket.name}: the lowest sell is {Math.round(sl.spread_ratio ?? 0)}× the highest buy
                    ({formatISK(sl.hub_highest_buy)}){sl.units_listed != null && <> with only {sl.units_listed.toLocaleString()} unit{sl.units_listed === 1 ? '' : 's'} listed</>}.
                    Nobody may be paying that price — treat this profit as a best case.
                  </div>
                );
              }
              if (hc.haul_enabled && (hc.leg1_route_known === false || hc.leg2_route_known === false)) {
                notes.push(
                  <div key="route" className="bp-ownership-note">
                    ⚠ Couldn&apos;t look up the route for {hc.leg1_route_known === false && hc.leg2_route_known === false ? 'your materials-in and goods-out freight' : hc.leg1_route_known === false ? 'your materials-in freight' : 'your goods-out freight'}, so
                    that freight is NOT included in this figure. Try again shortly.
                  </div>
                );
              }
              return <>{notes}</>;
            })()}
    </>
  );
};

export default SourcingNotices;
