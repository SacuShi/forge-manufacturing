/**
 * FORGE v1.0 — Mock data
 *
 * Realistic fake EVE Online manufacturing data used during the MVP build
 * phase before live API integration. Type IDs are real so CCP item icons
 * load correctly from images.evetech.net.
 *
 * Replace with real /api/* calls in the next integration phase.
 */

import type {
  MarketItem,
  ItemDetail,
  ChatMessage,
  CharacterInfo,
} from '../types';

// ── Character ───────────────────────────────────────────────────────────────

export const MOCK_CHARACTER: CharacterInfo = {
  characterId: 95465499,
  name: 'Gumpy Gallente',
  walletISK: 4_827_300_000,
  activeJobCount: 7,
  blueprintCount: 143,
  bpoCount: 62,
  lpPoints: [],
  activeJobs: [
    { name: 'Hammerhead II',        typeId: 2185,  quantity: 5,  remaining: '1h 42m',  done: false },
    { name: 'Drake',                typeId: 24698, quantity: 1,  remaining: '6h 11m',  done: false },
    { name: 'Medium Shield Ext II', typeId: 2281,  quantity: 10, remaining: '22h 05m', done: false },
    { name: 'Vagabond',             typeId: 11999, quantity: 1,  remaining: 'Done',     done: true  },
  ],
};

// ── Market items ────────────────────────────────────────────────────────────

export const MOCK_ITEMS: MarketItem[] = [
  {
    rank: 1,
    typeId: 11993,
    name: 'Vagabond',
    category: 'Heavy Assault Cruiser',
    profitPerRun:    47_200_000,
    margin:          38.2,
    iskPerHour:     178_000_000,
    buildTime:       '3h 12m',
    buildTimeMinutes: 192,
    owned:           'BPO',
    canBuild:        true,
  },
  {
    rank: 2,
    typeId: 2185,
    name: 'Hammerhead II',
    category: 'Medium Combat Drone',
    profitPerRun:    18_400_000,
    margin:          31.5,
    iskPerHour:      96_000_000,
    buildTime:       '45m',
    buildTimeMinutes: 45,
    owned:           'BPO',
    canBuild:        true,
  },
  {
    rank: 3,
    typeId: 24698,
    name: 'Drake',
    category: 'Battlecruiser',
    profitPerRun:    15_800_000,
    margin:          12.4,
    iskPerHour:      43_000_000,
    buildTime:       '8h 44m',
    buildTimeMinutes: 524,
    owned:           'BPO',
    canBuild:        true,
  },
  {
    rank: 4,
    typeId: 2364,
    name: 'Medium Shield Extender II',
    category: 'Shield Booster',
    profitPerRun:     9_100_000,
    margin:          27.3,
    iskPerHour:      84_000_000,
    buildTime:       '25m',
    buildTimeMinutes: 25,
    owned:           'BPC',
    canBuild:        false,
  },
  {
    rank: 5,
    typeId: 2456,
    name: 'Hobgoblin II',
    category: 'Small Combat Drone',
    profitPerRun:     7_200_000,
    margin:          22.8,
    iskPerHour:     120_000_000,
    buildTime:       '22m',
    buildTimeMinutes: 22,
    owned:           'BPO',
    canBuild:        true,
  },
  {
    rank: 6,
    typeId: 16229,
    name: 'Brutix',
    category: 'Battlecruiser',
    profitPerRun:     6_800_000,
    margin:           9.1,
    iskPerHour:      21_000_000,
    buildTime:       '7h 30m',
    buildTimeMinutes: 450,
    owned:           'BPO',
    canBuild:        false,
  },
  {
    rank: 7,
    typeId: 12003,
    name: 'Eagle',
    category: 'Heavy Assault Cruiser',
    profitPerRun:    52_100_000,
    margin:          40.7,
    iskPerHour:     195_000_000,
    buildTime:       '3h 05m',
    buildTimeMinutes: 185,
    owned:           '—',
    canBuild:        false,
  },
  {
    rank: 8,
    typeId: 3557,
    name: '200mm Railgun II',
    category: 'Hybrid Turret',
    profitPerRun:     4_300_000,
    margin:          19.2,
    iskPerHour:      61_000_000,
    buildTime:       '1h 02m',
    buildTimeMinutes: 62,
    owned:           'BPO',
    canBuild:        true,
  },
  {
    rank: 9,
    typeId: 621,
    name: 'Caracal',
    category: 'Cruiser',
    profitPerRun:     3_900_000,
    margin:           8.4,
    iskPerHour:      18_000_000,
    buildTime:       '5h 15m',
    buildTimeMinutes: 315,
    owned:           'BPO',
    canBuild:        true,
  },
  {
    rank: 10,
    typeId: 2281,
    name: 'Small Shield Extender II',
    category: 'Shield Booster',
    profitPerRun:     3_100_000,
    margin:          15.6,
    iskPerHour:      49_000_000,
    buildTime:       '18m',
    buildTimeMinutes: 18,
    owned:           'BPC',
    canBuild:        true,
  },
  {
    rank: 11,
    typeId: 4310,
    name: 'Incursus',
    category: 'Frigate',
    profitPerRun:     1_200_000,
    margin:           6.1,
    iskPerHour:       9_000_000,
    buildTime:       '1h 45m',
    buildTimeMinutes: 105,
    owned:           '—',
    canBuild:        false,
  },
  {
    rank: 12,
    typeId: 24692,
    name: 'Myrmidon',
    category: 'Battlecruiser',
    profitPerRun:      -800_000,
    margin:            -1.2,
    iskPerHour:       -3_000_000,
    buildTime:        '7h 48m',
    buildTimeMinutes:  468,
    owned:            '—',
    canBuild:         false,
  },
];

// ── Item detail data ─────────────────────────────────────────────────────────

/** Returns the full detail record for a given typeId, or null if not found. */
export function getMockDetail(typeId: number): ItemDetail | null {
  return MOCK_DETAILS[typeId] ?? null;
}

const MOCK_DETAILS: Record<number, ItemDetail> = {
  11993: {
    typeId: 11993,
    name: 'Vagabond',
    category: 'Heavy Assault Cruiser',
    owned: 'BPO',
    profitPerRun: 47_200_000,
    margin: 38.2,
    iskPerHour: 178_000_000,
    buildTime: '3h 12m',
    sellPrice: 123_600_000,
    matCost: 76_400_000,
    materials: [
      { typeId: 34,    name: 'Tritanium',  quantity: '2,812,450' },
      { typeId: 35,    name: 'Pyerite',    quantity: '712,300' },
      { typeId: 36,    name: 'Mexallon',   quantity: '189,200' },
      { typeId: 37,    name: 'Isogen',     quantity: '28,400' },
      { typeId: 38,    name: 'Nocxium',    quantity: '7,100' },
      { typeId: 39,    name: 'Zydrine',    quantity: '1,420' },
      { typeId: 40,    name: 'Megacyte',   quantity: '284' },
      { typeId: 11399, name: 'Morphite',   quantity: '142' },
    ],
  },
  2185: {
    typeId: 2185,
    name: 'Hammerhead II',
    category: 'Medium Combat Drone',
    owned: 'BPO',
    profitPerRun: 18_400_000,
    margin: 31.5,
    iskPerHour: 96_000_000,
    buildTime: '45m',
    sellPrice: 58_400_000,
    matCost: 40_000_000,
    materials: [
      { typeId: 34,    name: 'Tritanium',  quantity: '88,200' },
      { typeId: 35,    name: 'Pyerite',    quantity: '22,050' },
      { typeId: 36,    name: 'Mexallon',   quantity: '5,880' },
      { typeId: 11399, name: 'Morphite',   quantity: '18' },
    ],
  },
  24698: {
    typeId: 24698,
    name: 'Drake',
    category: 'Battlecruiser',
    owned: 'BPO',
    profitPerRun: 15_800_000,
    margin: 12.4,
    iskPerHour: 43_000_000,
    buildTime: '8h 44m',
    sellPrice: 127_400_000,
    matCost: 111_600_000,
    materials: [
      { typeId: 34,  name: 'Tritanium',  quantity: '4,120,000' },
      { typeId: 35,  name: 'Pyerite',    quantity: '1,030,000' },
      { typeId: 36,  name: 'Mexallon',   quantity: '275,000' },
      { typeId: 37,  name: 'Isogen',     quantity: '41,000' },
      { typeId: 38,  name: 'Nocxium',    quantity: '10,250' },
      { typeId: 39,  name: 'Zydrine',    quantity: '2,050' },
      { typeId: 40,  name: 'Megacyte',   quantity: '410' },
    ],
  },
};

// ── Chat ─────────────────────────────────────────────────────────────────────

/**
 * Item references in assistant messages use the token format [[Name|typeId]]
 * so ChatPanel can replace them with ItemLink components — no
 * dangerouslySetInnerHTML required.
 */
export const MOCK_CHAT_MESSAGES: ChatMessage[] = [
  {
    id: 'init-1',
    role: 'assistant',
    content:
      "Welcome back, Gumpy. Your wallet is at 4,827M ISK with 7 active jobs.\n" +
      "Your top opportunity right now is [[Vagabond|11993]] at 47.2M ISK profit per run " +
      "(38% margin). You have the BPO and materials in stock.",
    timestamp: new Date(Date.now() - 5 * 60_000),
  },
  {
    id: 'user-1',
    role: 'user',
    content: 'What T2 items should I focus on with 5B ISK?',
    timestamp: new Date(Date.now() - 3 * 60_000),
  },
  {
    id: 'assist-2',
    role: 'assistant',
    content:
      "With 5B ISK, your best T2 options right now:\n\n" +
      "1. [[Vagabond|11993]] — 47.2M/run, 38% margin, 3h build\n" +
      "2. [[Hammerhead II|2185]] ×20 batch — 18.4M, fast turnover\n" +
      "3. [[Medium Shield Extender II|2364]] — 9.1M each, high demand\n\n" +
      "I'd stack Vagabond runs first — your BPO has ME10 which cuts mat cost by 9%.",
    timestamp: new Date(Date.now() - 2 * 60_000),
  },
];

export const QUICK_PROMPTS: string[] = [
  "What's the most profitable manufacturing opportunity right now?",
  'Which blueprints can I build with my current materials?',
  'What T2 chains am I closest to completing?',
  'Estimate build costs for 10 runs of Hammerhead II',
];
