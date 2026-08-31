import { useState, useEffect, useCallback, type FC } from 'react';
import { itemIconUrl } from '../utils/icons';
import { formatISK } from '../utils/format';
import ForgeWait from './ForgeWait';

interface AppraisalInput {
  typeId: number;
  name: string;
  qty: number;
}

interface AppraisalResult {
  typeId: number;
  name: string;
  qty: number;
  sell: number;
  buy: number;
  sellTotal: number;
  buyTotal: number;
}

interface AppraisalResponse {
  items: AppraisalResult[];
  totalSell: number;
  totalBuy: number;
  hubName: string;
}

const HUBS = [
  { regionId: 10000002, label: 'Jita' },
  { regionId: 10000043, label: 'Amarr' },
  { regionId: 10000032, label: 'Dodixie' },
  { regionId: 10000042, label: 'Hek' },
  { regionId: 10000030, label: 'Rens' },
  { regionId: 10099000, label: 'C-J6MT' },
];

const PCT_OPTIONS = [80, 85, 90, 95, 100];

type ColFocus = 'buy' | 'sell' | null;

interface AppraisalTabProps {
  seedItems: AppraisalInput[];
  canDockKeestar?: boolean;
}

function parsePaste(text: string): AppraisalInput[] {
  return text.split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(line => {
      const tabParts = line.split('\t');
      if (tabParts.length >= 2) {
        const qty = parseInt(tabParts[1].replace(/[^0-9]/g, ''), 10) || 1;
        return { typeId: 0, name: tabParts[0].trim(), qty };
      }
      const tokens = line.split(/\s+/);
      const last = tokens[tokens.length - 1];
      const n = parseInt(last.replace(/[^0-9,]/g, '').replace(',', ''), 10);
      if (!isNaN(n) && n > 0 && tokens.length > 1) {
        return { typeId: 0, name: tokens.slice(0, -1).join(' '), qty: n };
      }
      return { typeId: 0, name: line, qty: 1 };
    });
}

function adj(value: number, pct: number) { return value * pct / 100; }

const AppraisalTab: FC<AppraisalTabProps> = ({ seedItems, canDockKeestar = true }) => {
  const visibleHubs = HUBS.filter(h => h.regionId !== 10099000 || canDockKeestar);
  const [regionId, setRegionId] = useState(10000002);
  const [adjustPct, setAdjustPct] = useState(100);
  const [colFocus, setColFocus] = useState<ColFocus>(null);
  const [pasteText, setPasteText] = useState('');
  const [items, setItems] = useState<AppraisalInput[]>(seedItems);
  const [fromAssets, setFromAssets] = useState(seedItems.length > 0);
  const [results, setResults] = useState<AppraisalResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [goonCopied, setGoonCopied] = useState(false);

  useEffect(() => {
    if (seedItems.length > 0) {
      setItems(seedItems);
      setFromAssets(true);
      setResults(null);
    }
  }, [seedItems]);

  const doAppraise = useCallback(async (toAppraise: AppraisalInput[], rId: number) => {
    if (toAppraise.length === 0) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/appraise', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: toAppraise, regionId: rId }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error((errData as { error?: string }).error ?? `Server error ${res.status}`);
      }
      setResults(await res.json() as AppraisalResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Appraisal failed');
    } finally {
      setLoading(false);
    }
  }, []);

  const getActive = () => pasteText.trim() ? parsePaste(pasteText) : items;

  const handleAppraise = () => {
    if (pasteText.trim()) {
      const parsed = parsePaste(pasteText);
      setItems(parsed);
      setFromAssets(false);
      doAppraise(parsed, regionId);
    } else {
      doAppraise(items, regionId);
    }
  };

  const handleHubChange = (newId: number, focus?: ColFocus) => {
    setRegionId(newId);
    if (focus !== undefined) setColFocus(focus);
    const active = getActive();
    if (active.length > 0) doAppraise(active, newId);
  };

  // Auto-appraise on first load with seed items
  useEffect(() => {
    if (items.length > 0 && !results && !loading) doAppraise(items, regionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Use resolved names from results when available; fall back to raw input
  const exportSource = results ? results.items : items;
  const goonText = exportSource.map(i => `${i.name} x ${i.qty}`).join('\n');

  const copyForGoonpraisal = () => {
    navigator.clipboard.writeText(goonText).then(() => {
      setGoonCopied(true);
      setTimeout(() => setGoonCopied(false), 2000);
    }).catch(() => {});
  };

  const jitaBuyActive  = colFocus === 'buy'  && regionId === 10000002;
  const jitaSellActive = colFocus === 'sell' && regionId === 10000002;

  const hubLabel = HUBS.find(h => h.regionId === regionId)?.label ?? 'Hub';

  const heroTotal = results
    ? colFocus === 'buy'
      ? adj(results.totalBuy, adjustPct)
      : colFocus === 'sell'
        ? adj(results.totalSell, adjustPct)
        : null
    : null;

  const heroLabel = colFocus === 'buy'
    ? `${results?.hubName ?? 'Jita'} buy orders${adjustPct < 100 ? ` · ${adjustPct}%` : ''}`
    : colFocus === 'sell'
      ? `${results?.hubName ?? 'Jita'} sell orders${adjustPct < 100 ? ` · ${adjustPct}%` : ''}`
      : null;

  const buyColActive  = colFocus === 'buy'  || colFocus === null;
  const sellColActive = colFocus === 'sell' || colFocus === null;

  const s: Record<string, React.CSSProperties> = {
    pill:   { padding: '4px 10px', fontSize: 11, borderRadius: 3, cursor: 'pointer', fontFamily: 'inherit', border: '0.5px solid' },
    thCell: { padding: '6px 8px', fontWeight: 500, fontSize: 11 },
    tdCell: { padding: '5px 8px', fontSize: 11 },
  };

  return (
    <div style={{ padding: '0 16px 24px', maxWidth: 1000, height: '100%', overflowY: 'auto' }}>

      {/* Header */}
      <div style={{ marginBottom: 14 }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-text-primary)', margin: '0 0 3px' }}>
          Item Appraisal
        </h2>
        <p style={{ fontSize: 11, color: 'var(--color-text-tertiary)', margin: 0 }}>
          Values your items using FORGE's live market data. Select items in Assets and click Appraise, or paste a list below.
        </p>
      </div>

      {/* Quick shortcuts row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)' }}>Quick:</span>

        <button
          type="button"
          onClick={() => handleHubChange(10000002, 'buy')}
          title="Jita buy-order value — what buyers will pay you instantly for your items"
          style={{
            ...s.pill,
            padding: '5px 14px', fontSize: 12, fontWeight: 600,
            background: jitaBuyActive ? 'rgba(79,195,247,0.18)' : 'rgba(79,195,247,0.06)',
            borderColor: jitaBuyActive ? 'var(--color-accent-primary)' : 'rgba(79,195,247,0.35)',
            color: jitaBuyActive ? 'var(--color-accent-primary)' : 'var(--color-text-secondary)',
          }}
        >
          Jita Buy
        </button>

        <button
          type="button"
          onClick={() => handleHubChange(10000002, 'sell')}
          title="Jita sell-order value — what you'd receive listing at the current lowest sell price"
          style={{
            ...s.pill,
            padding: '5px 14px', fontSize: 12, fontWeight: 600,
            background: jitaSellActive ? 'rgba(76,175,80,0.18)' : 'rgba(76,175,80,0.06)',
            borderColor: jitaSellActive ? 'var(--color-success)' : 'rgba(76,175,80,0.35)',
            color: jitaSellActive ? 'var(--color-success)' : 'var(--color-text-secondary)',
          }}
        >
          Jita Sell
        </button>

        <div style={{ width: 1, height: 20, background: 'var(--color-border-light)', margin: '0 2px' }} />

        {/* Hub selector */}
        <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)' }}>Hub:</span>
        {visibleHubs.map(hub => {
          const active = regionId === hub.regionId && colFocus === null;
          const isJita = hub.regionId === 10000002;
          const jitaMode = isJita && (jitaBuyActive || jitaSellActive);
          return (
            <button
              key={hub.regionId}
              type="button"
              onClick={() => { setColFocus(null); handleHubChange(hub.regionId, null); }}
              style={{
                ...s.pill,
                background: (active || (isJita && jitaMode)) ? 'rgba(79,195,247,0.10)' : 'transparent',
                borderColor: (active || (isJita && jitaMode)) ? 'var(--color-accent-primary)' : 'var(--color-border-light)',
                color: (active || (isJita && jitaMode)) ? 'var(--color-accent-primary)' : 'var(--color-text-secondary)',
              }}
            >
              {hub.label}
            </button>
          );
        })}
      </div>

      {/* % adjustment row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12 }}>
        <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)' }}>Adjust:</span>
        {PCT_OPTIONS.map(pct => (
          <button
            key={pct}
            type="button"
            onClick={() => setAdjustPct(pct)}
            title={pct < 100 ? `Show ${pct}% of market price — common for bulk loot offers` : 'Full market value'}
            style={{
              ...s.pill,
              padding: '3px 8px', fontSize: 10,
              background: adjustPct === pct ? 'rgba(212,150,14,0.15)' : 'transparent',
              borderColor: adjustPct === pct ? 'rgba(212,150,14,0.6)' : 'var(--color-border-light)',
              color: adjustPct === pct ? 'var(--color-warning)' : 'var(--color-text-tertiary)',
            }}
          >
            {pct}%
          </button>
        ))}
        {adjustPct < 100 && (
          <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)', marginLeft: 4 }}>
            — showing {adjustPct}% of market price
          </span>
        )}
      </div>

      {/* Paste area */}
      <div style={{ marginBottom: 12 }}>
        <textarea
          value={pasteText}
          onChange={e => setPasteText(e.target.value)}
          placeholder={
            fromAssets && items.length > 0
              ? `${items.length} item${items.length !== 1 ? 's' : ''} loaded from Assets. Paste items here to replace (EVE clipboard format: Name[tab]Qty).`
              : 'Paste items here — one per line. EVE clipboard format: Name[tab]Qty, or just Name (qty defaults to 1).'
          }
          style={{
            width: '100%', minHeight: 72, padding: '6px 8px', fontSize: 11,
            background: 'var(--color-bg-tertiary)', color: 'var(--color-text-primary)',
            border: '0.5px solid var(--color-border-light)', borderRadius: 3,
            fontFamily: 'inherit', resize: 'vertical', boxSizing: 'border-box',
          }}
        />
        <div style={{ display: 'flex', gap: 8, marginTop: 6, alignItems: 'center' }}>
          <button
            type="button"
            onClick={handleAppraise}
            disabled={loading || (!pasteText.trim() && items.length === 0)}
            style={{
              padding: '5px 16px', fontSize: 11, borderRadius: 3, cursor: 'pointer',
              fontFamily: 'inherit', background: 'rgba(79,195,247,0.12)',
              color: 'var(--color-accent-primary)', border: '0.5px solid var(--color-accent-primary)',
              opacity: loading || (!pasteText.trim() && items.length === 0) ? 0.45 : 1,
            }}
          >
            {loading ? 'Appraising…' : 'Appraise'}
          </button>
          {items.length > 0 && !pasteText.trim() && (
            <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
              {fromAssets
                ? `${items.length} item${items.length !== 1 ? 's' : ''} from Assets selection`
                : `${items.length} item${items.length !== 1 ? 's' : ''}`}
            </span>
          )}
        </div>
      </div>

      {error && (
        <div style={{
          padding: '6px 10px', borderRadius: 3, marginBottom: 12, fontSize: 11,
          background: 'rgba(244,67,54,0.07)', border: '0.5px solid rgba(244,67,54,0.3)',
          color: 'var(--color-danger)',
        }}>
          {error}
        </div>
      )}

      {loading && <ForgeWait message="Appraising items…" quip="Consulting the market gods…" />}

      {!loading && results && (
        <>
          {/* Hero total — only shown when Jita Buy or Jita Sell is active */}
          {heroTotal !== null && (
            <div style={{
              marginBottom: 14, padding: '12px 16px', borderRadius: 4,
              background: colFocus === 'buy' ? 'rgba(79,195,247,0.06)' : 'rgba(76,175,80,0.06)',
              border: `0.5px solid ${colFocus === 'buy' ? 'rgba(79,195,247,0.25)' : 'rgba(76,175,80,0.25)'}`,
            }}>
              <div style={{
                fontSize: 26, fontWeight: 700, letterSpacing: '-0.5px', fontVariantNumeric: 'tabular-nums',
                color: colFocus === 'buy' ? 'var(--color-accent-primary)' : 'var(--color-success)',
              }}>
                {formatISK(heroTotal)}
              </div>
              <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: 3 }}>
                {heroLabel}
              </div>
            </div>
          )}

          {/* Results table */}
          <div style={{ overflowX: 'auto', marginBottom: 14 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 480 }}>
              <thead>
                <tr style={{ borderBottom: '0.5px solid var(--color-border-light)' }}>
                  <th style={{ ...s.thCell, textAlign: 'left', color: 'var(--color-text-tertiary)' }}>Item</th>
                  <th style={{ ...s.thCell, textAlign: 'right', color: 'var(--color-text-tertiary)' }}>Qty</th>
                  <th
                    style={{ ...s.thCell, textAlign: 'right', color: buyColActive ? 'var(--color-accent-primary)' : 'var(--color-text-tertiary)', opacity: buyColActive ? 1 : 0.45 }}
                    title="Sell to existing buy orders — instant ISK, lower price"
                  >
                    {hubLabel} buy{adjustPct < 100 ? ` (${adjustPct}%)` : ''}
                  </th>
                  <th
                    style={{ ...s.thCell, textAlign: 'right', color: sellColActive ? 'var(--color-success)' : 'var(--color-text-tertiary)', opacity: sellColActive ? 1 : 0.45 }}
                    title="List at the current lowest sell-order price — more ISK, not instant"
                  >
                    {hubLabel} sell{adjustPct < 100 ? ` (${adjustPct}%)` : ''}
                  </th>
                </tr>
              </thead>
              <tbody>
                {results.items.map((row, i) => (
                  <tr key={i} style={{ borderBottom: '0.5px solid rgba(139,149,166,0.08)' }}>
                    <td style={{ ...s.tdCell, display: 'flex', alignItems: 'center', gap: 6 }}>
                      {row.typeId > 0 && (
                        <img
                          src={itemIconUrl(row.typeId, 22)}
                          alt=""
                          width={22}
                          height={22}
                          crossOrigin="anonymous"
                          style={{ borderRadius: 2, flexShrink: 0 }}
                          onError={e => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden'; }}
                        />
                      )}
                      <span style={{ color: 'var(--color-text-primary)' }}>{row.name}</span>
                    </td>
                    <td style={{ ...s.tdCell, textAlign: 'right', color: 'var(--color-text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
                      {row.qty.toLocaleString()}
                    </td>
                    <td style={{ ...s.tdCell, textAlign: 'right', fontVariantNumeric: 'tabular-nums', opacity: buyColActive ? 1 : 0.35 }}>
                      {row.buy > 0
                        ? <span style={{ color: 'var(--color-text-primary)' }}>{formatISK(adj(row.buyTotal, adjustPct))}</span>
                        : <span style={{ color: 'var(--color-text-tertiary)' }}>no orders</span>}
                    </td>
                    <td style={{ ...s.tdCell, textAlign: 'right', fontVariantNumeric: 'tabular-nums', opacity: sellColActive ? 1 : 0.35 }}>
                      {row.sell > 0
                        ? <span style={{ color: 'var(--color-text-secondary)' }}>{formatISK(adj(row.sellTotal, adjustPct))}</span>
                        : <span style={{ color: 'var(--color-text-tertiary)' }}>no orders</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: '0.5px solid var(--color-border-light)' }}>
                  <td colSpan={2} style={{ ...s.tdCell, fontWeight: 600, color: 'var(--color-text-tertiary)' }}>
                    Total · {results.hubName}{adjustPct < 100 ? ` · ${adjustPct}%` : ''}
                  </td>
                  <td style={{ ...s.tdCell, textAlign: 'right', fontWeight: 700, color: 'var(--color-accent-primary)', fontVariantNumeric: 'tabular-nums', opacity: buyColActive ? 1 : 0.35 }}>
                    {formatISK(adj(results.totalBuy, adjustPct))}
                  </td>
                  <td style={{ ...s.tdCell, textAlign: 'right', fontWeight: 600, color: 'var(--color-text-secondary)', fontVariantNumeric: 'tabular-nums', opacity: sellColActive ? 1 : 0.35 }}>
                    {formatISK(adj(results.totalSell, adjustPct))}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          {/* Legend */}
          <p style={{ fontSize: 10, color: 'var(--color-text-tertiary)', margin: '0 0 14px' }}>
            <strong style={{ color: 'var(--color-accent-primary)' }}>{hubLabel} buy</strong> — sell to buy orders now (instant, guaranteed). {' '}
            <strong style={{ color: 'var(--color-success)' }}>{hubLabel} sell</strong> — post at cheapest sell-order price (potential, not instant).
          </p>

          {/* Goonpraisal export — multibuy format */}
          <div className="qp-multibuy-row">
            <button
              className="qp-multibuy-btn"
              onClick={copyForGoonpraisal}
              title="Copies items in EVE multibuy format (Name x Qty) — paste into Goonpraisal"
            >
              {goonCopied ? '✓ Copied!' : '📋 Copy as Multibuy list'}
            </button>
            <a
              href="https://appraise.gnf.lt/"
              target="_blank"
              rel="noopener noreferrer"
              onClick={copyForGoonpraisal}
              style={{
                padding: '7px 14px', fontSize: 11, borderRadius: 3, fontWeight: 600,
                letterSpacing: '0.8px', textDecoration: 'none', whiteSpace: 'nowrap',
                background: 'transparent', color: 'var(--color-text-secondary)',
                border: '0.5px solid var(--color-border-light)',
              }}
              title="Copies list then opens Goonpraisal — paste to get a second opinion"
            >
              Open Goonpraisal ↗
            </a>
            <span className="qp-multibuy-note">Paste into Goonpraisal or EVE's Multibuy window</span>
          </div>
        </>
      )}

      {!loading && !results && items.length === 0 && !error && (
        <div style={{ padding: '32px 0', textAlign: 'center', color: 'var(--color-text-tertiary)', fontSize: 11 }}>
          Select items in the Assets tab and click Appraise, or paste a list above.
        </div>
      )}
    </div>
  );
};

export default AppraisalTab;
