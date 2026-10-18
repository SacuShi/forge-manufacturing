import type { Market } from '../types';

/** The trade hubs FORGE can price against. C-J6MT (id 10099000) is the Keepstar and is hidden from pilots without docking rights. */
export const MARKETS: Market[] = [
  { id: 10000002, name: 'Jita',      region: 'The Forge',   type: 'hisec'   },
  { id: 10000043, name: 'Amarr',     region: 'Domain',      type: 'hisec'   },
  { id: 10000032, name: 'Dodixie',   region: 'Sinq Laison', type: 'hisec'   },
  { id: 10000042, name: 'Hek',       region: 'Metropolis',  type: 'hisec'   },
  { id: 10000030, name: 'Rens',      region: 'Heimatar',    type: 'hisec'   },
  { id: 10000041, name: 'Syndicate', region: 'Syndicate',   type: 'nullsec' },
  { id: 10099000, name: 'C-J6MT',   region: 'Keepstar',    type: 'nullsec' },
];
