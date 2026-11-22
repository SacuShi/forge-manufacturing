'use strict';
// Where items nobody manufactures come from, by CCP item group (names checked against ESI /universe/groups/):
// 18 Mineral, 427 Moon Materials, 423 Ice Product, 754 Salvaged Materials, 966 Ancient Salvage, 465 Ice (mined),
// 711 Harvestable Cloud (gas), 333 Datacores; Planetary Industry: P0 1032/1033/1035, P1 1042, P2 1034, P3 1040, P4 1041.
// Anything else in CCP's 'Asteroid' category is mined ore.
const NON_BUILT_SOURCES = {
  18: 'ore', 427: 'moon', 423: 'ice', 754: 'salvage', 966: 'salvage', 465: 'mined-ice', 711: 'gas', 333: 'datacore',
  1032: 'pi0', 1033: 'pi0', 1035: 'pi0', 1042: 'pi1', 1034: 'pi2', 1040: 'pi3', 1041: 'pi4',
};
function nonBuiltSource(item) {
  if (!item) return null;
  return NON_BUILT_SOURCES[item.group_id]
    || (item.pi_tier != null ? `pi${item.pi_tier}` : null)
    || (item.category_name === 'Asteroid' ? 'mined-ore' : null);
}

module.exports = { nonBuiltSource, NON_BUILT_SOURCES };
