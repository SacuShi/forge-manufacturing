// Items nobody manufactures say where they come from (CCP item groups, checked against ESI /universe/groups/).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { nonBuiltSource } = require('../../lib/item-origin');

describe('where a non-manufacturable item comes from', () => {
  it.each([
    [{ group_id: 1034 }, 'pi2'],                       // Construction Blocks — Refined Commodities - Tier 2
    [{ group_id: 1032 }, 'pi0'], [{ group_id: 1042 }, 'pi1'], [{ group_id: 1040 }, 'pi3'], [{ group_id: 1041 }, 'pi4'],
    [{ group_id: 18 }, 'ore'], [{ group_id: 423 }, 'ice'], [{ group_id: 427 }, 'moon'], [{ group_id: 754 }, 'salvage'],
    [{ group_id: 465 }, 'mined-ice'], [{ group_id: 711 }, 'gas'], [{ group_id: 333 }, 'datacore'],
    [{ group_id: 99999, category_name: 'Asteroid' }, 'mined-ore'],
    [{ group_id: 99999, pi_tier: 3 }, 'pi3'],
    [{ group_id: 99999, category_name: 'Ship' }, null],
    [null, null],
  ])('%j → %s', (item, expected) => { expect(nonBuiltSource(item)).toBe(expected); });
});
