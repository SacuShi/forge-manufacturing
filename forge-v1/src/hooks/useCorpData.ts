/**
 * FORGE v1.5.2 — useCorpData hook
 *
 * Manages corp feature state:
 *   - Checks whether the corp has been configured (GET /api/corp/status)
 *   - Checks whether the current character has Director access via ESI
 *     (server-side: GET /characters/{id}/roles/ + corp membership check)
 *   - No PIN required — access is granted automatically to EVE Directors
 *
 * Call this hook once in App.tsx and pass results down as props.
 */

import { useState, useEffect, useCallback } from 'react';
import type { CorpStatus, CorpAccessStatus } from '../types';
import { apiGet } from '../api/client';

// ── Types ────────────────────────────────────────────────────────────────────

export interface UseCorpDataReturn {
  /** Whether the corp has been set up on the server */
  corpStatus:    CorpStatus | null;
  /** Whether the current character has Director access */
  accessStatus:  CorpAccessStatus | null;
  /** True while loading corpStatus or accessStatus */
  loading:       boolean;
  /** Re-check access status (e.g. after re-auth with updated scopes) */
  refreshAccess: () => Promise<void>;
}

// ── Hook ────────────────────────────────────────────────────────────────────

export function useCorpData(
  token:    string | null,
  /** Only fires requests when the Corp tab is active and the user is logged in */
  isActive: boolean,
): UseCorpDataReturn {
  const [corpStatus,   setCorpStatus]   = useState<CorpStatus | null>(null);
  const [accessStatus, setAccessStatus] = useState<CorpAccessStatus | null>(null);
  const [loading,      setLoading]      = useState(false);

  // ── Load corp status + access status when the Corp tab first becomes active ──
  useEffect(() => {
    if (!isActive || !token) return;

    let cancelled = false;
    setLoading(true);

    Promise.all([
      apiGet<CorpStatus>('/api/corp/status'),
      apiGet<CorpAccessStatus>('/api/corp/access-status', token),
    ])
      .then(([status, access]) => {
        if (cancelled) return;
        setCorpStatus(status);
        setAccessStatus(access);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        console.warn('Corp status check failed:', err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  // Fires once per Corp-tab activation while logged in
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, !!token]);

  // ── Re-check access (e.g. after scope grant / re-auth) ──────────────────────
  const refreshAccess = useCallback(async () => {
    if (!token) return;
    try {
      const access = await apiGet<CorpAccessStatus>('/api/corp/access-status', token);
      setAccessStatus(access);
    } catch {
      // non-fatal
    }
  }, [token]);

  return { corpStatus, accessStatus, loading, refreshAccess };
}
