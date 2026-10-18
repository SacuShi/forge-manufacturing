/**
 * FORGE — shared self-haul freight ship reference data.
 *
 * Single source of truth for both IndustrySettings.tsx (manufacturing haul
 * config) and InterHubHaulConfig.tsx (inter-hub arbitrage haul config) —
 * previously duplicated verbatim in both files, which is how a data bug in
 * this table ended up fixed in only one place the first time around.
 *
 * skillId/skillName verified 17 Sept 2026 against live ESI
 * (/universe/types/{id}/) — the earlier version pointed at unrelated skills
 * entirely (e.g. "Mass Production", "Reprocessing Efficiency" for the T1
 * haulers — not hauling skills at all; "X Industrial" isn't even a real
 * skill name, it's "X Hauler") and the freighter ids were shifted by one row
 * (one didn't exist, the other three each named a different race's skill
 * than the ship they were attached to).
 *
 * cargoAtLevel[n] = cargo capacity (m³) at trained skill level n (1–5),
 * verified 17 Sept 2026:
 *   - T1 haulers: base capacity from ESI dogma attribute 38, ×(1 + 0.05×level)
 *     — EVE University wiki confirms all four racial Hauler skills give a
 *     uniform "5% bonus to ship cargo capacity per level", including Iteron
 *     Mark V (previously modelled as a special all-or-nothing jump to 62,500m³
 *     only at level 5 — that was fabricated; it uses the same uniform 5%/level
 *     rule as every other T1 hauler, so minLevel is 1 like the rest).
 *   - Hoarder: its real GENERAL cargo hold is tiny (500 m³ base) — EVE
 *     University confirms this exactly. Its actual specialty, a 41,000 m³
 *     Ammo Hold, is a separate bay that doesn't accept generic manufacturing
 *     materials, so it isn't usable for self-haul here. Previously modelled
 *     with the same inflated numbers as the other T1 haulers.
 *   - Freighters: base capacity from ESI dogma attribute 38, ×(1 + 0.05×level)
 *     — cross-checked exactly against EVE University's published per-level
 *     freighter capacity table (both agree to the m³).
 */

export interface FreightShip {
  id:           string;
  name:         string;
  skillId:      number;
  skillName:    string;
  minLevel:     number;
  cargoAtLevel: [number, number, number, number, number, number]; // [unused, L1, L2, L3, L4, L5]
}

export const FREIGHT_SHIPS: FreightShip[] = [
  // T1 Industrials
  { id: 'bestower',   name: 'Bestower',        skillId: 3343,  skillName: 'Amarr Hauler',     minLevel: 1, cargoAtLevel: [0, 5040, 5280, 5520, 5760, 6000] },
  { id: 'sigil',      name: 'Sigil',            skillId: 3343,  skillName: 'Amarr Hauler',     minLevel: 1, cargoAtLevel: [0, 2205, 2310, 2415, 2520, 2625] },
  { id: 'badger',     name: 'Badger',           skillId: 3342,  skillName: 'Caldari Hauler',   minLevel: 1, cargoAtLevel: [0, 4095, 4290, 4485, 4680, 4875] },
  { id: 'iteron_v',   name: 'Iteron Mark V',    skillId: 3340,  skillName: 'Gallente Hauler',  minLevel: 1, cargoAtLevel: [0, 6090, 6380, 6670, 6960, 7250] },
  { id: 'hoarder',    name: 'Hoarder',          skillId: 3341,  skillName: 'Minmatar Hauler',  minLevel: 1, cargoAtLevel: [0, 525,  550,  575,  600,  625]  },
  // Freighters
  { id: 'providence', name: 'Providence',       skillId: 20524, skillName: 'Amarr Freighter',    minLevel: 1, cargoAtLevel: [0, 456750, 478500, 500250, 522000, 543750] },
  { id: 'charon',     name: 'Charon',           skillId: 20526, skillName: 'Caldari Freighter',  minLevel: 1, cargoAtLevel: [0, 488250, 511500, 534750, 558000, 581250] },
  { id: 'obelisk',    name: 'Obelisk',          skillId: 20527, skillName: 'Gallente Freighter', minLevel: 1, cargoAtLevel: [0, 462000, 484000, 506000, 528000, 550000] },
  { id: 'fenrir',     name: 'Fenrir',           skillId: 20528, skillName: 'Minmatar Freighter', minLevel: 1, cargoAtLevel: [0, 456750, 478500, 500250, 522000, 543750] },
];
