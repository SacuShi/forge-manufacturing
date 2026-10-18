import { useCallback, useState } from 'react';

// POCO tax is set per-structure by whoever owns it and isn't available live —
// the user enters their actual rate, shared (via localStorage) between PiTab's
// rankings and PiPlannerTab so both reflect the same real-world number.
const STORAGE_KEY  = 'forge_pi_poco_tax_rate';
const DEFAULT_RATE = 0.10;

function readStored(): number {
  const raw = localStorage.getItem(STORAGE_KEY);
  const parsed = raw != null ? parseFloat(raw) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : DEFAULT_RATE;
}

export function usePocoTaxRate(): [number, (rate: number) => void] {
  const [rate, setRate] = useState<number>(readStored);

  const update = useCallback((next: number) => {
    const clamped = Math.min(Math.max(Number.isFinite(next) ? next : DEFAULT_RATE, 0), 1);
    setRate(clamped);
    localStorage.setItem(STORAGE_KEY, String(clamped));
  }, []);

  return [rate, update];
}
