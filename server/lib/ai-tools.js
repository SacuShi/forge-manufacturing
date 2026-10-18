'use strict';
// AI advisor tool dispatch: executes one tool call from the model and returns a plain result object.
// Extracted from server.js; everything it needs from the server is injected so it stays testable.
const { buildTopProfitableQuery, orderFor } = require('./profit-query');

function createAiTools({ CORP_BP_USABLE_SQL, PORT, REGIONS, VALID_REGIONS, dbAll, dbGet, ensureCorpDataFresh, esiFetch, fetch, getItemPricesAllRegions, hubBooks, resolveViewerCorpAccess, security }) {
  // Tells the advisor how to read price_source on precomputed rows (a Jita price is not a hub price).
  const AI_PRICE_SOURCE_NOTE = "price_source 'jita_fallback' means nobody lists this item at the hub, so sell_price is Jita's current price  "
    + "the hub itself has no market for it. Say so when recommending it.";

  async function executeAiTool(toolUse, { characterId, req, jobs, blueprints, assets }) {
    let toolResult;

    try {
      switch (toolUse.name) {
        case "get_active_jobs": {
          const actFilter = toolUse.input.activityFilter || 'all';
          const activityIds = { manufacturing: [1], reaction: [9], invention: [8], research: [3,4], copying: [5] };
          const allowedIds = activityIds[actFilter];
          const filteredJobs = allowedIds
            ? jobs.filter(j => allowedIds.includes(j.activity_id))
            : jobs;
          const actLabel = id => ({ 1:'Manufacturing',3:'TE Research',4:'ME Research',5:'Copying',8:'Invention',9:'Reaction',11:'Rev.Eng' }[id] || `Activity ${id}`);
          toolResult = {
            total: filteredJobs.length,
            jobs: filteredJobs.map(j => ({
              product: j.product_name || `Blueprint #${j.blueprint_type_id}`,
              activity: actLabel(j.activity_id),
              runs: j.runs,
              status: j.status,
              remaining: j.remaining,
              done: j.done,
            }))
          };
          break;
        }

        case "get_my_orders": {
          try {
            const ordersRes = await fetch(`http://localhost:${PORT}/api/trading/character-orders`, {
              headers: { Authorization: req.headers.authorization || '' },
            });
            const ordersData = await ordersRes.json();
            if (ordersData.error) {
              toolResult = { error: ordersData.error };
              break;
            }

            const allOrders   = ordersData.orders || [];
            const undercutOnly = !!toolUse.input.undercutOnly;
            const undercut     = allOrders.filter(o => o.isUndercut);
            const rest         = undercutOnly ? [] : allOrders.filter(o => !o.isUndercut);

            toolResult = {
              total: allOrders.length,
              undercut_count: undercut.length,
              // Undercut orders are the actionable ones — full detail
              undercut: undercut.map(o => ({
                name:        o.name,
                side:        o.is_buy_order ? 'buy' : 'sell',
                my_price:    o.price,
                market_best: o.bookBest,
                undercut_by: Math.round(o.undercutBy * 100) / 100,
              })),
              // Non-undercut orders need no action — one compact line each, not full objects
              other: rest.map(o => `${o.name} (${o.is_buy_order ? 'buy' : 'sell'} @ ${o.price})`),
            };
          } catch (e) {
            toolResult = { error: e.message };
          }
          break;
        }

        case "get_blueprint":
          const bpRes = await fetch(`http://localhost:${PORT}/api/get-blueprint`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ itemName: toolUse.input.itemName })
          });
          toolResult = await bpRes.json();
          break;

        case "get_corp_blueprints": {
          // Corp hangar blueprints — requires a Director/CEO.
          // v1.23 — FIX: corp access follows the SELECTED view character (sidebar chip),
          // mirroring the Corp tab — NOT the primary chat character. The frontend sends
          // that character's token in X-Viewer-Token; it may be a Director ALT even when
          // the primary (chat) login is a non-Director. Resolve access against THAT
          // character + token (the token authorises ESI calls for its own characterId,
          // so both must come from the same character). Falls back to the chat token
          // when the header is absent (primary IS the director → unchanged behaviour).
          const authH = req.headers.authorization || '';
          const chatToken = authH.startsWith('Bearer ') ? authH.slice(7) : '';
          const viewerToken = String(req.headers['x-viewer-token'] || chatToken || '').trim();

          let viewerCharId = characterId; // chat (primary) character by default
          if (viewerToken && viewerToken !== chatToken) {
            try {
              const v = await security.extractCharacterFromToken(`Bearer ${viewerToken}`);
              viewerCharId = v.characterId;
            } catch (_) {
              viewerCharId = null; // bad/expired viewer token → deny below
            }
          }

          const access = (viewerToken && viewerCharId)
            ? await resolveViewerCorpAccess(viewerCharId, viewerToken)
            : { isDirector: false, corpId: null };
          if (!access.isDirector || !access.corpId) {
            toolResult = {
              error: 'not_director',
              message: "The selected character doesn't hold the Director (or CEO) role, so corp blueprints aren't accessible. Corp data is viewable when a Director is the selected character (the view chip in the sidebar) — switch to your Director character, or log that character in.",
            };
            break;
          }
          await ensureCorpDataFresh(access.corpId, viewerToken);
          const cbSearch = String(toolUse.input.search || '').replace(/[^a-zA-Z0-9 '\-]/g, '').trim();
          const cbType   = toolUse.input.type || 'all';
          const cbLimit  = Math.min(toolUse.input.limit || 50, 200);
          let cbWhere = `WHERE cb.corp_id = ? AND ${CORP_BP_USABLE_SQL}`;   // blueprints locked in Asset Safety can't be used
          const cbParams = [access.corpId];
          if (cbType === 'BPO') cbWhere += ' AND cb.runs = -1';
          else if (cbType === 'BPC') cbWhere += ' AND cb.runs >= 0';
          if (cbSearch) { cbWhere += " AND LOWER(COALESCE(i.name, '')) LIKE ?"; cbParams.push(`%${cbSearch.toLowerCase()}%`); }
          const cbRows = await dbAll(
            `SELECT COALESCE(i.name, 'Item #' || cb.type_id) AS name,
                    CASE WHEN cb.runs = -1 THEN 'BPO' ELSE 'BPC' END AS bp_type,
                    cb.material_efficiency AS me, cb.time_efficiency AS te, cb.runs,
                    b.product_id
             FROM corp_blueprints cb
             LEFT JOIN items i ON i.type_id = cb.type_id
             LEFT JOIN blueprints b ON b.blueprint_id = cb.type_id
             ${cbWhere} ORDER BY i.name ASC LIMIT ?`,
            [...cbParams, cbLimit]
          );
          const cbTotal = await dbGet(
            `SELECT COUNT(*) AS n FROM corp_blueprints cb LEFT JOIN items i ON i.type_id = cb.type_id ${cbWhere}`,
            cbParams
          );
          toolResult = {
            corp_name: access.corpName || `Corp ${access.corpId}`,
            total: cbTotal?.n ?? cbRows.length,
            showing: cbRows.length,
            blueprints: cbRows.map(r => ({ name: r.name, product_id: r.product_id ?? null, type: r.bp_type, me: r.me, te: r.te, runs: r.runs === -1 ? 'infinite' : r.runs })),
          };
          break;
        }

        case "analyze_blueprints":
          const analyzeRes = await fetch(`http://localhost:${PORT}/api/analyze-blueprints`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ownedBlueprints: blueprints || [],  // Fixed: use blueprints from session cache
              assets: assets || [],
              sortBy: toolUse.input.sortBy || "profit",
              limit: toolUse.input.limit || 20,
              buildableOnly: toolUse.input.buildableOnly || false
            })
          });
          toolResult = await analyzeRes.json();
          break;

        case "get_price":
          const priceRes = await fetch(`http://localhost:${PORT}/api/get-price`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ itemName: toolUse.input.itemName })
          });
          toolResult = await priceRes.json();
          break;

        case "get_precomputed":
          try {
            const pcSort         = toolUse.input.sort || 'profit';
            const pcLimit        = Math.min(toolUse.input.limit || 20, 100);
            const pcMinProfit    = toolUse.input.minProfit || 0;
            const pcSearch       = toolUse.input.search;
            const pcIncludeRisky = toolUse.input.includeRisky || false;
            const pcActivity     = toolUse.input.activityType || 'all';
            const pcGroupByHub   = toolUse.input.groupByHub === true;

            // ── groupByHub: top-3 per hub + bestOverall in one query ───────────
            if (pcGroupByHub && !pcSearch) {
              const activityFilter = pcActivity === 'reaction'
                ? "AND COALESCE(activity_id,1) = 9"
                : pcActivity === 'manufacturing'
                ? "AND COALESCE(activity_id,1) = 1"
                : '';
              const riskyFilter = pcIncludeRisky ? '' : `
                AND (liquidity_risk IS NULL OR liquidity_risk = '' OR liquidity_risk = 'low_volume')`;

              const allowedSorts = {
                profit:      'profit DESC',
                margin:      'profit_margin DESC',
                isk_per_hour:'isk_per_hour DESC'
              };
              const pcOrder = allowedSorts[pcSort] || allowedSorts.profit;
              const [sortCol] = pcOrder.split(' ');

              const allRows = await dbAll(`
                WITH ranked AS (
                  SELECT region_id, product_name, product_id,
                         material_cost, sell_price, profit, profit_margin,
                         isk_per_hour, avg_daily_volume, liquidity_risk, price_source,
                         COALESCE(activity_id,1) AS activity_id,
                         ROW_NUMBER() OVER (PARTITION BY region_id ORDER BY ${pcOrder}) AS rn
                  FROM precomputed_profits
                  WHERE profit > ? AND sell_price > 0
                    ${activityFilter} ${riskyFilter}
                )
                SELECT * FROM ranked WHERE rn <= 3
              `, [pcMinProfit]);

              // Group into per-hub summaries
              const hubMap = {};
              for (const row of allRows) {
                const rid = row.region_id;
                if (!hubMap[rid]) hubMap[rid] = { hub: REGIONS[rid]?.hub || `Region ${rid}`, regionId: rid, top3: [] };
                hubMap[rid].top3.push({
                  product_name:    row.product_name,
                  product_id:      row.product_id,
                  profit:          row.profit,
                  profit_margin:   parseFloat((row.profit_margin ?? 0).toFixed(1)),
                  isk_per_hour:    row.isk_per_hour,
                  avg_daily_volume:row.avg_daily_volume,
                  sell_price:      row.sell_price,
                  activity_id:     row.activity_id,
                  price_source:    row.price_source,
                });
              }

              const hubSummaries = Object.values(hubMap);

              // bestOverall: #1 item across all hubs by the requested sort column
              let bestRow = null;
              for (const hub of hubSummaries) {
                const candidate = hub.top3[0];
                if (!candidate) continue;
                if (!bestRow || candidate[sortCol] > bestRow[sortCol]) {
                  bestRow = { ...candidate, hub: hub.hub, regionId: hub.regionId };
                }
              }

              toolResult = {
                hubSummaries,
                bestOverall: bestRow,
                sort: pcSort,
                source: 'precomputed',
                note: 'top3 per hub ranked by ' + pcSort + '. bestOverall is the single best item across all hubs. ' + AI_PRICE_SOURCE_NOTE
              };
              break;
            }
            // ── end groupByHub ──────────────────────────────────────────────────

            // Allow AI to query a specific hub; default Jita
            const pcRegionId     = VALID_REGIONS.includes(toolUse.input.regionId)
                                   ? toolUse.input.regionId
                                   : 10000002;
            const pcHubName      = REGIONS[pcRegionId]?.hub || 'Jita';

            const { sql: pcSql, params: pcParams } = buildTopProfitableQuery({
              regionId:     pcRegionId,
              minProfit:    pcMinProfit,
              includeRisky: pcIncludeRisky,
              orderClause:  orderFor(pcSort),
              search:       pcSearch ? pcSearch.replace(/[^a-zA-Z0-9 '\-]/g, '').substring(0, 50) : undefined,
              activity:     pcActivity,
              limit:        pcLimit,
            });
            const pcResults = (await dbAll(pcSql, pcParams)).map((r) => ({
              product_id: r.product_id, product_name: r.product_name, material_cost: r.material_cost,
              sell_price: r.sell_price, profit: r.profit, profit_margin: r.profit_margin,
              isk_per_hour: r.isk_per_hour, avg_daily_volume: r.avg_daily_volume,
              liquidity_risk: r.liquidity_risk, activity_id: r.activity_id, price_source: r.price_source,
            }));

            toolResult = {
              results: pcResults,
              count: pcResults.length,
              sort: pcSort,
              hub: pcHubName,
              regionId: pcRegionId,
              source: 'precomputed',
              note: AI_PRICE_SOURCE_NOTE,
            };
          } catch (pcErr) {
            toolResult = { error: pcErr.message, results: [] };
          }
          break;

        case "compare_markets": {
          try {
            const cmQuery = (toolUse.input.query || '').replace(/[^a-zA-Z0-9 '\-]/g, '').substring(0, 80);
            if (!cmQuery) {
              toolResult = { error: 'query parameter is required' };
              break;
            }

            // All strategy values are pre-computed — simple lookup, no JOIN or arithmetic.
            const rows = await dbAll(`
              SELECT
                sell_region_id, product_id, product_name,
                product_qty, sell_price, buy_price, build_time, avg_daily_volume,
                local_mat_cost, local_profit, local_margin, local_isk_per_hour,
                jita_mat_cost,  jita_profit,  jita_margin,  jita_isk_per_hour
              FROM precomputed_strategies
              WHERE product_name LIKE ?
              ORDER BY sell_region_id
            `, [`%${cmQuery}%`]);

            if (!rows.length) {
              toolResult = { error: `No precomputed data found for "${cmQuery}". Try a shorter or different name.` };
              break;
            }

            // Group by product (query might match multiple items)
            const byProduct = {};
            for (const row of rows) {
              const key = row.product_id;
              if (!byProduct[key]) byProduct[key] = { product_name: row.product_name, hubs: [] };
              byProduct[key].hubs.push({
                hub:         REGIONS[row.sell_region_id]?.hub || `Region ${row.sell_region_id}`,
                regionId:    row.sell_region_id,
                sellPrice:   row.sell_price,
                productQty:  row.product_qty,
                avgDailyVol: row.avg_daily_volume,
                localMaterials: {
                  materialCost: row.local_mat_cost,
                  profit:       row.local_profit,
                  margin:       parseFloat((row.local_margin ?? 0).toFixed(1)),
                  iskPerHour:   row.local_isk_per_hour,
                },
                jitaMaterials: {
                  materialCost: row.jita_mat_cost,
                  profit:       row.jita_profit,
                  margin:       parseFloat((row.jita_margin ?? 0).toFixed(1)),
                  iskPerHour:   row.jita_isk_per_hour,
                },
              });
            }

            // Find best hub per strategy for each product
            const products = Object.values(byProduct).slice(0, 3);
            for (const prod of products) {
              const bestJita  = prod.hubs.reduce((b, h) => h.jitaMaterials.profit  > b.jitaMaterials.profit  ? h : b, prod.hubs[0]);
              const bestLocal = prod.hubs.reduce((b, h) => h.localMaterials.profit > b.localMaterials.profit ? h : b, prod.hubs[0]);
              prod.recommendation = {
                bestJitaMaterialsStrategy: {
                  sellHub:    bestJita.hub,
                  profit:     bestJita.jitaMaterials.profit,
                  margin:     bestJita.jitaMaterials.margin,
                  iskPerHour: bestJita.jitaMaterials.iskPerHour,
                  summary:    `Buy materials in Jita, sell in ${bestJita.hub} — ${bestJita.jitaMaterials.margin.toFixed(1)}% margin`,
                },
                bestLocalStrategy: {
                  sellHub:    bestLocal.hub,
                  profit:     bestLocal.localMaterials.profit,
                  margin:     bestLocal.localMaterials.margin,
                  iskPerHour: bestLocal.localMaterials.iskPerHour,
                  summary:    `Buy and sell locally in ${bestLocal.hub} — ${bestLocal.localMaterials.margin.toFixed(1)}% margin`,
                },
              };
            }

            toolResult = {
              query: cmQuery,
              note: 'local_materials = buy and sell at same hub. jita_materials = buy inputs at Jita, sell finished goods at listed hub.',
              products,
            };

            // Append haul context so AI can mention freight in recommendations
            try {
              const haulRows = await dbAll(
                `SELECT haul_enabled, leg1_haul_rate, leg2_haul_rate,
                        leg1_method, leg2_method, leg1_service_label, leg2_service_label
                 FROM character_industry_settings WHERE character_id = ?`, [characterId]
              );
              if (haulRows.length && haulRows[0].haul_enabled) {
                const s = haulRows[0];
                toolResult.haul_context = {
                  enabled: true,
                  note: 'Profits shown do NOT include haulage. Your configured haul cost will reduce actual profit.',
                  leg1: { method: s.leg1_method, rate: s.leg1_haul_rate, label: s.leg1_service_label },
                  leg2: { method: s.leg2_method, rate: s.leg2_haul_rate, label: s.leg2_service_label },
                };
              }
            } catch (_) { /* non-critical */ }
          } catch (cmErr) {
            toolResult = { error: cmErr.message };
          }
          break;
        }

        case "diagnose_blueprints": {
          try {
            const diagRes = await fetch(`http://localhost:${PORT}/api/diagnose-t2/${characterId}`, {
              headers: { Authorization: req.headers.authorization || '' },
            });
            const diagData = await diagRes.json();
            toolResult = {
              summary: diagData.summary,
              total_blueprints: diagData.total,
              found_in_db: diagData.inDb?.length || 0,
              missing_from_db: diagData.notInDb?.length || 0,
              t2_found: diagData.t2InDb?.length || 0,
              t2_missing: diagData.t2NotInDb?.length || 0,
              missing_names: (diagData.notInDb || []).map(b => b.name),
              t2_missing_names: (diagData.t2NotInDb || []).map(b => b.name),
              note: diagData.t2NotInDb?.length > 0
                ? `${diagData.t2NotInDb.length} T2 blueprint(s) not in the SDE database — their chain data cannot be analysed until the database is updated.`
                : 'All T2 blueprints found in database.'
            };
          } catch (diagErr) {
            toolResult = { error: diagErr.message };
          }
          break;
        }

        case "get_t2_blueprints": {
          try {
            const t2Sort = toolUse.input.sort || 'name';
            const bpList = blueprints || [];

            // Single bulk query — items.meta_level=1 means T2
            const typeIds = bpList.map(b => b.type_id);
            let t2TypeIds = new Set();
            let nameMap   = {};

            let productIdMap = {}; // blueprint type_id → product type_id
            if (typeIds.length > 0) {
              const ph = typeIds.map(() => '?').join(',');
              const rows = await dbAll(`SELECT type_id, name, meta_level FROM items WHERE type_id IN (${ph})`, typeIds);
              rows.forEach(r => {
                nameMap[r.type_id] = r.name;
                if ((r.meta_level ?? 0) === 1) t2TypeIds.add(r.type_id);
              });
              const bpRows = await dbAll(`SELECT blueprint_id, product_id FROM blueprints WHERE blueprint_id IN (${ph})`, typeIds);
              bpRows.forEach(r => { productIdMap[r.blueprint_id] = r.product_id; });
            }

            let t2Blueprints = bpList
              .filter(bp => t2TypeIds.has(bp.type_id))
              .map(bp => ({ type_id: bp.type_id, product_id: productIdMap[bp.type_id] || null, name: nameMap[bp.type_id] || `Blueprint #${bp.type_id}`, quantity: bp.quantity }));

            if (t2Sort === 'quantity') {
              t2Blueprints.sort((a, b) => b.quantity - a.quantity);
            } else {
              t2Blueprints.sort((a, b) => a.name.localeCompare(b.name));
            }

            toolResult = {
              total: t2Blueprints.length,
              total_blueprints: bpList.length,
              blueprints: t2Blueprints.map(bp => ({
                name: bp.name,
                type_id: bp.type_id,
                product_id: bp.product_id,
                owned: bp.quantity === -1 ? 'BPO' : 'BPC',
                quantity: bp.quantity === -1 ? 'Infinite (BPO)' : `${bp.quantity} copy${bp.quantity !== 1 ? 's' : ''}`
              })),
              summary: `Found ${t2Blueprints.length} T2 blueprints out of ${bpList.length} total`
            };
          } catch (t2Err) {
            toolResult = { error: t2Err.message, blueprints: [] };
          }
          break;
        }

        case "get_price_comparison": {
          try {
            const itemName = (toolUse.input.item_name || '').trim();
            if (!itemName) {
              toolResult = { error: 'item_name is required' };
              break;
            }

            // Case-insensitive exact lookup first, then partial match
            let item = await dbGet(
              'SELECT type_id, name FROM items WHERE LOWER(name) = LOWER(?)',
              [itemName]
            );
            if (!item) {
              // Try partial match for common shorthand (e.g. "Trit" → "Tritanium")
              item = await dbGet(
                'SELECT type_id, name FROM items WHERE LOWER(name) LIKE LOWER(?) LIMIT 1',
                [`%${itemName}%`]
              );
            }

            if (!item) {
              toolResult = { error: `Item "${itemName}" not found. Check spelling or try a more specific name.` };
              break;
            }

            const priceData = await getItemPricesAllRegions(item.type_id);

            if (priceData.length === 0) {
              toolResult = { error: `No live price data found for ${item.name} across any hub. It may not be actively traded.` };
              break;
            }

            // Sort: cheapest sell price first (best place to buy), highest buy price first (best place to sell)
            const bySellPrice = [...priceData].sort((a, b) => a.sell_price - b.sell_price);
            const byBuyPrice  = [...priceData].sort((a, b) => b.buy_price  - a.buy_price);

            const bestToBuyAt  = bySellPrice[0];   // lowest ask = cheapest to buy from
            const bestToSellAt = byBuyPrice[0];    // highest bid = best place to sell into

            const arbitrage = bestToSellAt.buy_price - bestToBuyAt.sell_price;

            toolResult = {
              item_name:   item.name,
              type_id:     item.type_id,
              note:        'buy_price = highest buy order (what you sell into). sell_price = lowest sell order (what you buy from).',
              all_hubs:    priceData,
              cheapest_to_buy_from: {
                hub:        bestToBuyAt.hub_name,
                sell_price: bestToBuyAt.sell_price,
                summary:    `Buy in ${bestToBuyAt.hub_name} at ${bestToBuyAt.sell_price.toLocaleString()} ISK`,
              },
              best_to_sell_into: {
                hub:       bestToSellAt.hub_name,
                buy_price: bestToSellAt.buy_price,
                summary:   `Sell in ${bestToSellAt.hub_name} at ${bestToSellAt.buy_price.toLocaleString()} ISK`,
              },
              arbitrage_opportunity: arbitrage > 0
                ? `Buy in ${bestToBuyAt.hub_name} (${bestToBuyAt.sell_price.toLocaleString()} ISK), sell in ${bestToSellAt.hub_name} (${bestToSellAt.buy_price.toLocaleString()} ISK) = +${arbitrage.toLocaleString()} ISK/unit margin`
                : 'No profitable arbitrage between hubs at current prices.',
            };
          } catch (pcErr) {
            toolResult = { error: pcErr.message };
          }
          break;
        }

        case "get_inter_hub_arb": {
          try {
            const HUB_NAME_TO_REGION = {};
            for (const [rid, { hub: name }] of Object.entries(REGIONS)) {
              HUB_NAME_TO_REGION[name.toLowerCase()] = parseInt(rid, 10);
            }
            // Also allow partial (e.g. "jita" → 10000002, "c-j6mt" → 10099000)
            const resolveHub = (str) => {
              if (!str) return null;
              const lower = str.toLowerCase().trim();
              for (const [name, rid] of Object.entries(HUB_NAME_TO_REGION)) {
                if (name.toLowerCase().includes(lower) || lower.includes(name.toLowerCase().split(' ')[0])) return rid;
              }
              return null;
            };

            const iaBuyHub  = resolveHub(toolUse.input.buy_hub)  || 10000002;
            const iaSellHub = resolveHub(toolUse.input.sell_hub) || 10000043;
            const iaMinMargin = parseFloat(toolUse.input.min_margin ?? 5);
            const iaSortBy  = toolUse.input.sort_by || 'est_daily_profit';
            const iaLimit   = Math.min(50, parseInt(toolUse.input.limit || 20, 10));

            const allowedIaSorts = {
              est_daily_profit: 'est_daily_profit DESC NULLS LAST',
              net_profit:       'net_profit DESC',
              net_margin_pct:   'net_margin_pct DESC',
              isk_per_m3:       'isk_per_m3 DESC NULLS LAST',
              avg_daily_volume: 'avg_daily_volume DESC NULLS LAST',
            };
            const iaOrder = allowedIaSorts[iaSortBy] || allowedIaSorts.est_daily_profit;
            // 3.375% sales tax at Accounting V: 1 − 0.075×(1−0.11×5) = 0.96625.
            // Was 0.964 (a hand-typed 3.6%) — didn't match calcSalesFeeRates, this
            // app's own verified formula for the same tax. Fixed 17 Sept 2026.
            const TAX = 0.96625;

            const iaRows = await dbAll(`
              SELECT
                p1.product_id,
                p1.product_name,
                p1.sell_price                         AS buy_at,
                p2.buy_price                          AS sell_into,
                p2.buy_price * ${TAX} - p1.sell_price AS net_profit,
                (p2.buy_price * ${TAX} - p1.sell_price) / p1.sell_price * 100 AS net_margin_pct,
                COALESCE(i.packaged_volume, 0)         AS volume_m3,
                CASE WHEN COALESCE(i.packaged_volume, 0) > 0
                  THEN (p2.buy_price * ${TAX} - p1.sell_price) / i.packaged_volume
                  ELSE NULL END                        AS isk_per_m3,
                COALESCE(p1.avg_daily_volume, p2.avg_daily_volume) AS avg_daily_volume,
                CASE WHEN COALESCE(p1.avg_daily_volume, p2.avg_daily_volume) IS NOT NULL
                  THEN COALESCE(p1.avg_daily_volume, p2.avg_daily_volume)
                       * (p2.buy_price * ${TAX} - p1.sell_price)
                  ELSE NULL END                        AS est_daily_profit
              FROM precomputed_profits p1
              JOIN precomputed_profits p2
                ON p1.product_id = p2.product_id
               AND p1.region_id  = ?
               AND p2.region_id  = ?
              LEFT JOIN items i ON i.type_id = p1.product_id
              WHERE p1.sell_price > 0
                AND COALESCE(p1.price_source, '') != 'jita_fallback'
                AND p2.buy_price  > 0
                AND (p2.buy_price * ${TAX} - p1.sell_price) / p1.sell_price * 100 >= ?
              ORDER BY ${iaOrder}
              LIMIT ?
            `, [iaBuyHub, iaSellHub, iaMinMargin, iaLimit]);

            toolResult = {
              buy_hub:   REGIONS[iaBuyHub]?.hub  || `Region ${iaBuyHub}`,
              sell_hub:  REGIONS[iaSellHub]?.hub || `Region ${iaSellHub}`,
              min_margin: iaMinMargin,
              sort_by:   iaSortBy,
              count:     iaRows.length,
              note:      'buy_at = lowest sell order at source. sell_into = highest buy order at destination. net_profit already deducts 3.6% sales tax. Hauling cost not included.',
              results:   iaRows.map(r => ({
                name:            r.product_name,
                buy_at:          Math.round(r.buy_at),
                sell_into:       Math.round(r.sell_into),
                net_profit:      Math.round(r.net_profit),
                net_margin_pct:  parseFloat((r.net_margin_pct ?? 0).toFixed(1)),
                volume_m3:       r.volume_m3,
                isk_per_m3:      r.isk_per_m3 ? Math.round(r.isk_per_m3) : null,
                avg_daily_volume: r.avg_daily_volume ? Math.round(r.avg_daily_volume) : null,
                est_daily_profit: r.est_daily_profit ? Math.round(r.est_daily_profit) : null,
              })),
            };
          } catch (iaErr) {
            toolResult = { error: iaErr.message };
          }
          break;
        }

        case "get_lp_balance": {
          try {
            const eveToken = req.headers.authorization?.replace(/^Bearer\s+/i, '');
            const lpRes = await esiFetch(
              `https://esi.evetech.net/v1/characters/${characterId}/loyalty/points/`,
              { headers: { Authorization: `Bearer ${eveToken}` } }
            );
            if (!lpRes.ok) {
              toolResult = { error: `ESI ${lpRes.status} — player may need to re-login to grant esi-characters.read_loyalty.v1`, balances: [] };
              break;
            }
            const points = await lpRes.json();
            const corpIds = points.map(p => p.corporation_id);
            const corpRows = corpIds.length
              ? await dbAll(`SELECT corp_id, corp_name, faction_id, faction_name FROM npc_corporations WHERE corp_id IN (${corpIds.map(() => '?').join(',')})`, corpIds)
              : [];
            const corpMap = new Map(corpRows.map(r => [r.corp_id, r]));
            const balances = points
              .filter(p => p.loyalty_points > 0)
              .map(p => {
                const c = corpMap.get(p.corporation_id) || {};
                return { corp_id: p.corporation_id, corp_name: c.corp_name || `Corp ${p.corporation_id}`, faction_name: c.faction_name || null, lp: p.loyalty_points };
              })
              .sort((a, b) => b.lp - a.lp);
            toolResult = { balances, total_corps: balances.length };
          } catch (e) { toolResult = { error: e.message }; }
          break;
        }

        case "get_lp_store_best": {
          try {
            const lpCorpName = (toolUse.input.corp_name || '').trim();
            const lpCategory = (toolUse.input.category || '').trim();
            const lpLimit    = Math.min(25, parseInt(toolUse.input.limit || 10, 10));

            // Resolve corp by name, or fall back to player's LP corps from ESI
            let lpCorpIds = null;
            if (lpCorpName) {
              const row = await dbGet(`SELECT corp_id FROM npc_corporations WHERE corp_name LIKE ? LIMIT 1`, [`%${lpCorpName}%`]);
              if (row) lpCorpIds = [row.corp_id];
            }
            if (!lpCorpIds) {
              try {
                const eveToken = req.headers.authorization?.replace(/^Bearer\s+/i, '');
                const lr = await esiFetch(`https://esi.evetech.net/v1/characters/${characterId}/loyalty/points/`, { headers: { Authorization: `Bearer ${eveToken}` } });
                if (lr.ok) {
                  const pts = await lr.json();
                  lpCorpIds = pts.filter(p => p.loyalty_points > 0).map(p => p.corporation_id);
                }
              } catch (_) {}
            }

            const wheres = [], params = [];
            if (lpCorpIds?.length) { wheres.push(`lo.corp_id IN (${lpCorpIds.map(() => '?').join(',')})`); params.push(...lpCorpIds); }
            if (lpCategory)        { wheres.push('i.category_name = ?'); params.push(lpCategory); }
            const lpWhere = wheres.length ? 'WHERE ' + wheres.join(' AND ') : '';

            const lpOffers = await dbAll(`
              SELECT lo.corp_id, lo.offer_id, lo.type_id, lo.quantity, lo.lp_cost, lo.isk_cost,
                     i.name AS item_name, i.category_name, nc.corp_name, nc.faction_name,
                     ihp.avg_30d_volume AS volume
                FROM lp_offers lo
                JOIN npc_corporations nc ON nc.corp_id = lo.corp_id
                LEFT JOIN items i ON i.type_id = lo.type_id
                LEFT JOIN item_history_prices ihp ON ihp.type_id = lo.type_id
                ${lpWhere}
            `, params);

            const jitaBook = hubBooks['jita'];
            const lpResults = [];
            for (const offer of lpOffers) {
              const entry = jitaBook?.get(offer.type_id);
              const jitaBuy = entry?.buy || 0;
              if (!jitaBuy) continue;
              const reqs = await dbAll(`SELECT req_type_id, quantity FROM lp_offer_required_items WHERE offer_id = ? AND corp_id = ?`, [offer.offer_id, offer.corp_id]);
              let reqCost = 0;
              for (const r of reqs) reqCost += ((jitaBook?.get(r.req_type_id)?.sell) || 0) * r.quantity;
              const netIsk   = jitaBuy * offer.quantity - offer.isk_cost - reqCost;
              const iskPerLp = offer.lp_cost > 0 ? netIsk / offer.lp_cost : 0;
              lpResults.push({
                item_name: offer.item_name || `Item ${offer.type_id}`, category: offer.category_name,
                corp_name: offer.corp_name, faction_name: offer.faction_name,
                quantity: offer.quantity, lp_cost: offer.lp_cost,
                isk_cost: Math.round(offer.isk_cost), req_cost: Math.round(reqCost),
                net_isk: Math.round(netIsk), isk_per_lp: Math.round(iskPerLp),
                volume_30d: offer.volume ? Math.round(offer.volume) : null,
              });
            }
            lpResults.sort((a, b) => b.isk_per_lp - a.isk_per_lp);
            toolResult = {
              offers: lpResults.slice(0, lpLimit), total_evaluated: lpResults.length,
              prices_live: !!(jitaBook?.size > 0),
              note: 'isk_per_lp = net ISK after Jita buy revenue minus isk_cost and required item costs, divided by LP cost. Sorted best first.',
            };
          } catch (e) { toolResult = { error: e.message }; }
          break;
        }

        case "get_pi_summary": {
          try {
            const eveToken = req.headers.authorization?.replace(/^Bearer\s+/i, '');
            const piRes = await fetch(`http://localhost:${PORT}/api/pi/colonies?characterId=${characterId}`, {
              headers: { Authorization: `Bearer ${eveToken}` }
            });
            const piData       = await piRes.json();
            const planets      = piData.colonies      || [];
            const productNames = piData.productNames  || {}; // typeId → {name, piTier}
            const schematics   = piData.schematics    || {}; // schematicId → {name}
            const factoryOutputs = piData.factoryOutputs || {}; // schematicId → output typeId
            const prices       = piData.prices        || {}; // typeId → {sell, buy}

            if (!planets.length) { toolResult = { summary: 'No active PI colonies found.', planets: [] }; break; }

            const summary = planets.map(p => {
              // Unique extractors with market price (P0 raw materials)
              const extracting = [...new Map(
                (p.pins || [])
                  .filter(pin => pin.extractor_details?.product_type_id)
                  .map(pin => {
                    const tid   = pin.extractor_details.product_type_id;
                    const name  = productNames[tid]?.name || `Type ${tid}`;
                    const price = prices[tid] || {};
                    return [tid, { name, sell: Math.round(price.sell || 0), buy: Math.round(price.buy || 0) }];
                  })
              ).values()];
              // Unique factories with output product price (P1/P2/P3)
              const producing = [...new Map(
                (p.pins || [])
                  .filter(pin => pin.factory_details?.schematic_id)
                  .map(pin => {
                    const sid       = pin.factory_details.schematic_id;
                    const outputTid = factoryOutputs[sid];
                    const name      = schematics[sid]?.name || `Schematic ${sid}`;
                    const price     = outputTid ? (prices[outputTid] || {}) : {};
                    return [sid, { name, sell: Math.round(price.sell || 0), buy: Math.round(price.buy || 0) }];
                  })
              ).values()];
              return {
                planet:      p.planet_name || `Planet ${p.planet_id}`,
                type:        p.planet_type,
                extracting,  // P0 raw materials being mined, with sell/buy ISK prices
                producing,   // factory outputs (P1/P2/P3), with sell/buy ISK prices
                num_pins:    (p.pins || []).length,
                last_update: p.last_update,
              };
            });
            toolResult = {
              colony_count: planets.length,
              colonies: summary,
              note: 'extracting = P0 raw materials. producing = processed factory outputs. sell/buy are current Jita prices. If you harvest these materials yourself you avoid buying them at market price — factor this into manufacturing cost calculations.',
            };
          } catch (e) { toolResult = { error: e.message, note: 'PI data may require a re-login if ESI scope was recently granted.' }; }
          break;
        }

        case "get_station_trading_scan": {
          try {
            const stMinMargin  = parseFloat(toolUse.input.min_margin_pct ?? 5);
            const stMinVolume  = parseInt(toolUse.input.min_volume ?? 20, 10);
            const stLimit      = Math.min(40, parseInt(toolUse.input.limit ?? 15, 10));
            const jitaBook     = hubBooks['jita'];
            if (!jitaBook || !jitaBook.size) { toolResult = { error: 'Jita price book not ready yet — try again in a moment.' }; break; }

            const stRows = await dbAll(`
              SELECT i.type_id, i.name, ihp.avg_30d_volume
                FROM items i
                JOIN item_history_prices ihp ON ihp.type_id = i.type_id
               WHERE ihp.avg_30d_volume >= ?
                 AND i.name IS NOT NULL
            `, [stMinVolume]);

            const stResults = [];
            for (const row of stRows) {
              const entry = jitaBook.get(row.type_id);
              if (!entry || !entry.sell || !entry.buy || entry.buy <= 0) continue;
              const spread_pct = (entry.sell - entry.buy) / entry.buy * 100;
              if (spread_pct < stMinMargin) continue;
              const gross_per_unit = entry.sell - entry.buy;
              const est_daily_isk  = gross_per_unit * (row.avg_30d_volume || 0);
              stResults.push({
                name: row.name, buy_wall: Math.round(entry.buy), sell_wall: Math.round(entry.sell),
                spread_pct: parseFloat(spread_pct.toFixed(1)),
                gross_per_unit: Math.round(gross_per_unit),
                volume_30d: Math.round(row.avg_30d_volume || 0),
                est_daily_isk: Math.round(est_daily_isk),
              });
            }
            stResults.sort((a, b) => b.est_daily_isk - a.est_daily_isk);
            toolResult = {
              results: stResults.slice(0, stLimit), total_found: stResults.length,
              note: 'buy_wall/sell_wall = best live Jita orders. spread_pct = (sell−buy)/buy. Gross only — deduct ~4% broker fee + 3.6% sales tax for true net. est_daily_isk assumes you capture 100% of volume (unrealistic; use as relative ranking).',
            };
          } catch (e) { toolResult = { error: e.message }; }
          break;
        }

        default:
          toolResult = { error: `Unknown tool: ${toolUse.name}` };
      }
    } catch (err) {
      toolResult = { error: err.message };
    }
    return toolResult;
  }

  return { executeAiTool };
}

module.exports = { createAiTools };
