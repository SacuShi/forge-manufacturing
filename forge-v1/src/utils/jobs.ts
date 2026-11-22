// Industry job rules shared by the Jobs tab, slot counts, the ticker and notifications (CCP / ESI):
//   - ESI lists a character's jobs as active, paused (structure offline) or ready (finished, not delivered).
//     All three still hold their slot until the job is delivered.
//   - Activity ids: 1 manufacturing, 3 TE research, 4 ME research, 5 copying, 7 reverse engineering,
//     8 invention, 9 reactions (ESI reports reactions as 9; the SDE's reaction activity is 11, so both count).

export const SLOT_HOLDING_STATUSES = new Set(['active', 'paused', 'ready']);

export const isReactionActivity = (id: number | undefined): boolean => id === 9 || id === 11;

export const isManufacturingActivity = (id: number | undefined): boolean => id === 1;

export function activityLabel(id: number | undefined): string {
  switch (id) {
    case 1:  return 'Mfg';
    case 3:  return 'TE Research';
    case 4:  return 'ME Research';
    case 5:  return 'Copying';
    case 7:  return 'Rev.Eng';
    case 8:  return 'Invention';
    case 9:
    case 11: return 'Reaction';
    default: return '';
  }
}

/** Time left on a job, recomputed from its end date (`now` passed in so the Jobs tab can tick). */
export function jobTimeRemaining(endDate: string | undefined, status: string | undefined, now: number = Date.now()): { label: string; done: boolean } {
  if (status === 'ready') return { label: 'Done', done: true };
  if (status === 'paused') return { label: 'Paused', done: false };
  if (!endDate) return { label: '', done: false };
  const diff = new Date(endDate).getTime() - now;
  if (diff <= 0) return { label: 'Done', done: true };
  const totalMinutes = Math.floor(diff / 60_000);
  const hours        = Math.floor(totalMinutes / 60);
  const minutes      = totalMinutes % 60;
  if (hours === 0) return { label: `${minutes}m`, done: false };
  return { label: `${hours}h ${String(minutes).padStart(2, '0')}m`, done: false };
}
