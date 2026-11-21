import { describe, it, expect } from 'vitest';
import { itemIconUrl } from '../icons';

// Regression (Nov 2026): Station Trading asked for 22 px icons, CCP's image server answers 400 to that size,
// and every row's icon was hidden. itemIconUrl must only ever ask for a size CCP serves (32 or 64).
describe('itemIconUrl', () => {
  it('defaults to a 32 px icon', () => {
    expect(itemIconUrl(34)).toBe('/api/icon/34?size=32&variant=icon');
  });

  it('never asks CCP for a size it does not serve', () => {
    expect(itemIconUrl(34, 22)).toBe('/api/icon/34?size=32&variant=icon');
    expect(itemIconUrl(34, 48)).toBe('/api/icon/34?size=64&variant=icon');
    expect(itemIconUrl(34, 64, 'bp')).toBe('/api/icon/34?size=64&variant=bp');
  });
});
