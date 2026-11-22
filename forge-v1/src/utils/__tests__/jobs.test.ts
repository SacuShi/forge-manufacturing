import { describe, it, expect } from 'vitest';
import { activityLabel, isReactionActivity, jobTimeRemaining, SLOT_HOLDING_STATUSES } from '../jobs';

describe('industry job rules', () => {
  it('paused and ready jobs still hold a slot; delivered ones do not', () => {
    expect(['active', 'paused', 'ready'].every((s) => SLOT_HOLDING_STATUSES.has(s))).toBe(true);
    expect(SLOT_HOLDING_STATUSES.has('delivered')).toBe(false);
  });
  it('reactions are 9 (ESI) or 11 (SDE); 7 is reverse engineering', () => {
    expect(isReactionActivity(9) && isReactionActivity(11)).toBe(true);
    expect(activityLabel(11)).toBe('Reaction');
    expect(activityLabel(7)).toBe('Rev.Eng');
  });
  it('time left is recomputed from the end date', () => {
    const end = '2026-11-22T12:00:00Z';
    expect(jobTimeRemaining(end, 'active', Date.parse('2026-11-22T09:30:00Z'))).toEqual({ label: '2h 30m', done: false });
    expect(jobTimeRemaining(end, 'active', Date.parse('2026-11-22T11:55:00Z'))).toEqual({ label: '5m', done: false });
    expect(jobTimeRemaining(end, 'active', Date.parse('2026-11-22T12:00:01Z'))).toEqual({ label: 'Done', done: true });
    expect(jobTimeRemaining(end, 'paused', 0).label).toBe('Paused');
    expect(jobTimeRemaining(end, 'ready', 0).done).toBe(true);
  });
});
