import { describe, it, expect } from 'vitest';
import { piLineTooltip } from '../piText';

// Real cards from Nov 2026: the planet makes most of the input, its factories (full time) need more.
describe('PI line hover text', () => {
  it('a planet that makes most of an input is never described as making none', () => {
    const t = piLineTooltip({ label: 'Noble Metals', made: 578_600, used: 864_000, net: -285_400 }, []);
    expect(t).toContain('this planet makes 578.6K/day');
    expect(t).toContain('need 864.0K/day');
    expect(t).toContain('idle about 33% of the time');
    expect(t).not.toMatch(/makes none|has to be bought|None of your colonies makes it/);
  });
  it('names your other planets with spare', () => {
    expect(piLineTooltip({ label: 'Water', made: 1920, used: 2880, net: -960 }, ['Tanoo VI'])).toContain('Spare Water on Tanoo VI');
  });
  it('a pure factory input says the planet makes none of it', () => {
    expect(piLineTooltip({ label: 'Coolant', made: 0, used: 480, net: -480 }, [])).toContain('this planet makes none');
  });
  it('spare and all-used lines', () => {
    expect(piLineTooltip({ label: 'Aqueous Liquids', made: 362_500, used: 288_000, net: 74_500 }, [])).toContain('leaving 74.5K/day spare');
    expect(piLineTooltip({ label: 'Toxic Metals', made: 4320, used: 4320, net: 0 }, [])).toContain('use all of it');
  });
});
