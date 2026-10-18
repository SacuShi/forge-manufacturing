const STORAGE_KEY = 'forge-ticker-intro-v1';

/** True until the pilot has dismissed the ticker introduction with "don't show again". */
export function shouldShowTickerIntro(): boolean {
  return !localStorage.getItem(STORAGE_KEY);
}

export function markTickerIntroSeen(): void {
  localStorage.setItem(STORAGE_KEY, '1');
}
