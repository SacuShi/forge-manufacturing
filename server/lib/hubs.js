'use strict';
// The trade hubs and regions FORGE knows about: ids, names, station and system ids, standings and structure fees.
// Plain data, shared by the price caches, the pollers and the routes.

// ════════════════════════════════════════════════════════════════════════════
// STATION-TRADING MULTI-HUB POLLER — 5 major trade hubs, each kept ~5 min fresh
// via Fuzzwork market aggregates (ESI-fallback kept for resilience).
//
// COMPLETELY SEPARATE from regionPriceCache (manufacturing). Day/station trading
// needs ORDER-BOOK DEPTH (spread, competition, order sizes) that the manufacturing
// collapse throws away, and it needs the freshest data available.
//
// Design:
//  • Fuzzwork provides pre-aggregated best buy/sell per item per station, updated
//    on the same ~5-min ESI cache cycle. 20-50 HTTP requests vs 100+ raw ESI pages,
//    and they don't touch the shared ESI error budget at all.
//  • Per-hub books: each hub has its own in-memory book, meta, name map, and poll
//    timer. Polling starts lazily when a user first visits that hub's scanner and
//    self-stops after TRADE_IDLE_STOP_MS of inactivity.
//  • ESI history enrichment runs per-hub to build 30-day average volume for ISK/day
//    estimates. Only one enrichment job runs globally at a time to protect the budget.
// ════════════════════════════════════════════════════════════════════════════

// Five major trade hubs — stationId for Fuzzwork, regionId for ESI history + fees.
const HUB_CONFIG = {
  jita:    { name: 'Jita IV-4',     stationId: 60003760,       regionId: 10000002, label: 'Jita IV - Moon 4 - Caldari Navy Assembly Plant' },
  amarr:   { name: 'Amarr VIII-4',  stationId: 60008494,       regionId: 10000043, label: 'Amarr VIII - Moon 4 - Emperor Family Academy' },
  dodixie: { name: 'Dodixie IX-20', stationId: 60011866,       regionId: 10000032, label: 'Dodixie IX - Moon 20 - Federation Navy Assembly Plant' },
  rens:    { name: 'Rens VI-8',     stationId: 60004588,       regionId: 10000030, label: 'Rens VI - Moon 8 - Brutor Tribe Treasury' },
  hek:     { name: 'Hek VIII-12',   stationId: 60005686,       regionId: 10000042, label: 'Hek VIII - Moon 12 - Boundless Creation Factory' },
  keepstar: { name: 'C-J6MT Keepstar', stationId: 1049588174021, regionId: 10099000, label: '1st Taj Mahgoon (DJ\'s Retirement Fund)', isStructure: true },
};

// Fixed broker fees for player structures (no standings discount applies).
// Key is the synthetic regionId used in VALID_REGIONS / regionPriceCache.
const HUB_STRUCTURE_FEES = {
  10099000: 0.015, // C-J6MT Keepstar — 1.5% set by structure owner
};

const HUB_IDS = Object.keys(HUB_CONFIG);

const REGION_TO_HUB = Object.fromEntries(Object.entries(HUB_CONFIG).map(([k, v]) => [v.regionId, k]));

const VALID_REGIONS = [
  10000002, // Jita
  10000043, // Amarr
  10000032, // Dodixie
  10000042, // Hek
  10000030, // Rens
  10000041, // Syndicate
  10099000, // C-J6MT Keepstar (synthetic ID — resolved via structure market endpoint)
];

// Human-readable names for the AI and formatting
// Merged region registry: name = region display name, hub = trade hub city name.
// Replaces the former REGION_NAMES and REGION_HUB_NAMES constants.
const REGIONS = {
  10000002: { name: 'The Forge',         hub: 'Jita'            },
  10000043: { name: 'Domain',            hub: 'Amarr'           },
  10000032: { name: 'Sinq Laison',       hub: 'Dodixie'         },
  10000042: { name: 'Metropolis',        hub: 'Hek'             },
  10000030: { name: 'Heimatar',          hub: 'Rens'            },
  10000041: { name: 'Syndicate',         hub: 'Syndicate'       },
  10099000: { name: 'C-J6MT (Keepstar)', hub: 'C-J6MT Keepstar' },
};

// NPC corp + faction standings that affect broker fees at each trade hub.
// Used by /api/true-cost to calculate the character-specific broker fee rate.
// corp_id  = NPC corporation that owns the station
// faction_id = NPC faction associated with that hub's space
// Verified 17 Sept 2026 directly against ESI /universe/stations/{id}/'s `owner`
// field (the authoritative station-owning-corp value) — the previous corp_ids
// here were wrong for every hub except Jita (same "unverified hand-typed ids"
// pattern as the original rig-catalog bug). Syndicate's faction_id was also
// wrong (500010 is Guristas Pirates, not The Syndicate/500009).
const HUB_STANDINGS = {
  10000002: { corp_id: 1000035, faction_id: 500001 }, // Jita — Caldari Navy / Caldari State
  10000043: { corp_id: 1000086, faction_id: 500003 }, // Amarr — Emperor Family / Amarr Empire
  10000032: { corp_id: 1000120, faction_id: 500004 }, // Dodixie — Federation Navy / Gallente Federation
  10000042: { corp_id: 1000057, faction_id: 500002 }, // Hek — Boundless Creation / Minmatar Republic
  10000030: { corp_id: 1000049, faction_id: 500002 }, // Rens — Brutor Tribe / Minmatar Republic
  10000041: { corp_id: 1000147, faction_id: 500009 }, // Syndicate — Intaki Syndicate / The Syndicate (null-sec, no faction bonus)
};

// Hub region → main station solar system ID (for jump-count API and auto-zero haul legs)
const HUB_SYSTEM_IDS = {
  10000002: 30000142, // Jita IV – Moon 4 – Caldari Navy Assembly Plant
  10000043: 30002187, // Amarr VIII (Oris) – Emperor Family Academy
  10000032: 30002659, // Dodixie IX – Moon 20 – Federation Navy Assembly Plant
  10000042: 30002053, // Hek VIII – Moon 12 – Boundless Creation Factory
  10000030: 30002510, // Rens VI – Moon 8 – Brutor Tribe Treasury
  10000041: 30003271, // Syndicate – Poitot (verified 17 Sept 2026: the old id, 30045331, was actually Vaaralen — a different system in a different region entirely)
  10099000: 30000772, // C-J6MT Keepstar (1st Taj Mahgoon, structure_id 1049588174021)
};

// ── C-J6MT Keepstar market integration ──────────────────────────────────────
// Structure ID confirmed 2026-06-28 via ESI character assets (Rorqual location_ids).
// All alliance members have docking rights — any active user's token can poll the market.
// Synthetic regionId 10099000 is used internally; it is not a real EVE region.
const KEEPSTAR_STRUCTURE_ID = 1049588174021;

const KEEPSTAR_REGION_ID    = 10099000;

module.exports = {
  HUB_CONFIG, HUB_STRUCTURE_FEES, HUB_IDS, REGION_TO_HUB, VALID_REGIONS, REGIONS, HUB_STANDINGS, HUB_SYSTEM_IDS,
  KEEPSTAR_STRUCTURE_ID, KEEPSTAR_REGION_ID,
};
