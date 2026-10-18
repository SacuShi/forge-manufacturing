import { describe, it, expect } from 'vitest';
import {
  formatISK, formatISKPerHour, formatISKDisplay, formatMargin, formatPerDay, formatBuildTime, liquidityInfo,
  marginColourClass, profitColourClass,
} from '../format';

describe('formatISK', () => {
  it.each([
    [47_200_000, '47.2M'], [-800_000, '−800K'], [-2_500_000, '−2.5M'], [4_827_300_000, '4.8B'], [4_800_000_000_000, '4.8T'],
    [12_500, '13K'], [999, '999'], [0, '0'],
  ])('formats %d as %s', (value, text) => expect(formatISK(value)).toBe(text));

  it('shows a dash for missing values', () => {
    expect(formatISK(null)).toBe('—');
    expect(formatISK(undefined)).toBe('—');
    expect(formatISK(NaN)).toBe('—');
    expect(formatISKDisplay(null)).toBe('—');
  });

  it('adds units for the per-hour and display variants', () => {
    expect(formatISKPerHour(178_000_000)).toBe('178.0M/hr');
    expect(formatISKDisplay(47_200_000)).toBe('47.2M ISK');
  });
});

describe('margins and colours', () => {
  it('signs margins', () => {
    expect(formatMargin(12.34)).toBe('+12.3%');
    expect(formatMargin(-5)).toBe('−5.0%');
  });
  it('maps margin bands to colours', () => {
    expect(marginColourClass(30)).toBe('success');
    expect(marginColourClass(15)).toBe('warning');
    expect(marginColourClass(2)).toBe('danger');
    expect(marginColourClass(-10)).toBe('danger');
  });
  it('colours profit by sign', () => {
    expect(profitColourClass(1)).toBe('success');
    expect(profitColourClass(-1)).toBe('danger');
  });
});

describe('volume and time', () => {
  it.each([
    [null, '—'], [0, '—'], [4.26, '4.3/day'], [42, '42/day'], [250.4, '250/day'], [12_345, '12.3K/day'], [2_500_000, '2.5M/day'],
  ])('formats %s per day as %s', (v, text) => expect(formatPerDay(v as number | null)).toBe(text));

  it.each([[0, '—'], [90, '1m'], [3600, '1h'], [5400, '1h 30m']])('formats %d seconds as %s', (s, text) => {
    expect(formatBuildTime(s)).toBe(text);
  });
});

describe('liquidityInfo', () => {
  it('marks risky markets and defaults to liquid', () => {
    expect(liquidityInfo('low_volume').label).toBe('Thin');
    expect(liquidityInfo('contract_only').dot).toBe('muted');
    expect(liquidityInfo('extreme_margin').dot).toBe('danger');
    expect(liquidityInfo(null).label).toBe('Liquid');
    expect(liquidityInfo('anything-else').dot).toBe('success');
  });
});
