/**
 * FORGE v1.5 — useAuth hook
 *
 * Manages the complete EVE Online OAuth2 authentication lifecycle:
 *
 *   1. On mount: check sessionStorage for a previously saved token.
 *      If found, resume the session without re-authenticating.
 *      Also restores any alt characters saved in forge_alt_tokens.
 *
 *   2. OAuth callback: if the URL contains ?code=xxx, exchange it for an
 *      access token via POST /api/eve-token, then load character data.
 *      If forge_adding_alt is set in sessionStorage, the callback loads
 *      the character as an alt rather than replacing the primary.
 *
 *   3. Login: redirect the browser to the EVE SSO URL with the correct
 *      scopes. A CSRF state token is stored in sessionStorage and verified
 *      on callback.
 *
 *   4. Data loading: after a successful token exchange, load assets,
 *      blueprints, wallet, and jobs from ESI, then cache the session on
 *      the FORGE server (required for AI chat to work).
 *
 *   5. Logout: clear the token and all character data from state and storage.
 *
 * v1.5 additions:
 *   - altCharacters: AltCharacter[] — additional logged-in characters
 *   - addCharacter()  — triggers EVE SSO flow for an additional character
 *   - removeCharacter(characterId) — removes an alt from state + sessionStorage
 *   - forge_alt_tokens sessionStorage key stores alt tokens as JSON array
 *   - forge_adding_alt flag distinguishes alt login from primary login
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import type {
  CharacterInfo,
  ActiveJob,
  EsiBlueprint,
  EsiAsset,
  EsiJob,
  EsiCharacter,
  AltCharacter,
} from '../types';
import { esiFetchAll, esiGet, apiPost } from '../api/client';

// ── EVE OAuth constants (must match EVE Developer Portal registration) ────────

const EVE_CLIENT_ID = '5be8a3b3444a4413b7f82b45c2c54a26';
const SCOPES =
  'esi-assets.read_assets.v1 esi-characters.read_blueprints.v1 ' +
  'esi-wallet.read_character_wallet.v1 esi-industry.read_character_jobs.v1 ' +
  'esi-skills.read_skills.v1 ' +
  'esi-markets.structure_markets.v1 ' +
  'esi-characters.read_standings.v1';

const SESSION_TOKEN_KEY  = 'forge_token';
const SESSION_STATE_KEY  = 'forge_oauth_state';
const ALT_TOKENS_KEY     = 'forge_alt_tokens';
const ADDING_ALT_KEY     = 'forge_adding_alt';

// ── Types ────────────────────────────────────────────────────────────────────

export type AuthStatus = 'idle' | 'exchanging' | 'loading' | 'authed' | 'error';

export interface LoadStep {
  label: string;
  status: 'ok' | 'warn' | 'err' | 'pending';
  detail?: string;
}

export interface AuthState {
  status: AuthStatus;
  token: string | null;
  character: CharacterInfo | null;
  /** Raw ESI blueprint list — needed for ownership checks and AI chat */
  blueprints: EsiBlueprint[];
  /** Raw ESI asset list — needed for AI chat */
  assets: EsiAsset[];
  /** Character trained skills (skill_id + active_skill_level) — for blueprint filtering */
  skills: Array<{ skill_id: number; active_skill_level: number }>;
  /** True if esi-characters.read_standings.v1 was granted on this login. */
  hasStandingsScope: boolean;
  error: string | null;
  /** Current loading step label (shown on LoadingScreen) */
  loadStep: string;
  /** Log of all loading steps (shown on LoadingScreen) */
  dataLog: LoadStep[];
  /** v1.5 — Additional characters loaded alongside the primary */
  altCharacters: AltCharacter[];
  /** v1.5 — True while EVE SSO redirect is in progress for adding an alt */
  addingAlt: boolean;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Decode a JWT payload without verifying the signature (verification happens server-side) */
function decodeJwtPayload(token: string): Record<string, unknown> {
  const part = token.split('.')[1]
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const pad = '=='.slice(0, (4 - (part.length % 4)) % 4);
  return JSON.parse(atob(part + pad)) as Record<string, unknown>;
}

/** Extract numeric characterId from EVE JWT sub claim ("CHARACTER:EVE:12345678") */
function characterIdFromJwt(token: string): number {
  const payload = decodeJwtPayload(token);
  const sub = payload.sub as string;
  return parseInt(sub.replace('CHARACTER:EVE:', ''), 10);
}

/** Generate a cryptographically random state string for CSRF protection */
function generateState(): string {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Convert ESI end_date (ISO 8601) to a human-readable remaining time string.
 * Returns "Done" if the date is in the past.
 */
function formatTimeRemaining(endDate: string): { label: string; done: boolean } {
  const diff = new Date(endDate).getTime() - Date.now();
  if (diff <= 0) return { label: 'Done', done: true };

  const totalMinutes = Math.floor(diff / 60_000);
  const hours        = Math.floor(totalMinutes / 60);
  const minutes      = totalMinutes % 60;

  if (hours === 0) return { label: `${minutes}m`, done: false };
  return { label: `${hours}h ${String(minutes).padStart(2, '0')}m`, done: false };
}

/** Read saved alt tokens from sessionStorage */
function getSavedAltTokens(): string[] {
  try {
    return JSON.parse(sessionStorage.getItem(ALT_TOKENS_KEY) ?? '[]') as string[];
  } catch {
    return [];
  }
}

/** Write alt tokens back to sessionStorage */
function saveAltTokens(tokens: string[]): void {
  sessionStorage.setItem(ALT_TOKENS_KEY, JSON.stringify(tokens));
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useAuth(): AuthState & {
  login:           () => void;
  logout:          () => void;
  addCharacter:    () => void;
  removeCharacter: (characterId: number) => void;
} {
  const [status,            setStatus]            = useState<AuthStatus>('idle');
  const [token,             setToken]             = useState<string | null>(null);
  const [character,         setCharacter]         = useState<CharacterInfo | null>(null);
  const [blueprints,        setBlueprints]        = useState<EsiBlueprint[]>([]);
  const [assets,            setAssets]            = useState<EsiAsset[]>([]);
  const [skills,            setSkills]            = useState<Array<{ skill_id: number; active_skill_level: number }>>([]);
  const [hasStandingsScope, setHasStandingsScope] = useState(false);
  const [error,             setError]             = useState<string | null>(null);
  const [loadStep,          setLoadStep]          = useState('');
  const [dataLog,           setDataLog]           = useState<LoadStep[]>([]);

  // v1.5 — Alt character state
  const [altCharacters, setAltCharacters] = useState<AltCharacter[]>([]);
  const [addingAlt,     setAddingAlt]     = useState(false);

  // Ref to track alt loading cancellation
  const altCancelledRef = useRef<Set<number>>(new Set());

  // ── loadCharacterData ──────────────────────────────────────────────────────

  const loadCharacterData = useCallback(async (acc: string) => {
    setToken(acc);
    setStatus('loading');

    const log: LoadStep[] = [];
    const addLog = (label: string, st: LoadStep['status'], detail?: string) => {
      log.push({ label, status: st, detail });
      setDataLog([...log]);
    };

    try {
      // ── 1. Decode JWT → characterId ──────────────────────────────────────
      const cid = characterIdFromJwt(acc);

      // ── 2. Character info ─────────────────────────────────────────────────
      setLoadStep('Loading character…');
      const charInfo = await esiGet<EsiCharacter>(`/characters/${cid}/`, acc);
      addLog('Character', 'ok', charInfo.name);

      // ── 3. Assets ─────────────────────────────────────────────────────────
      setLoadStep('Scanning asset hold…');
      let aData: EsiAsset[] = [];
      try {
        aData = await esiFetchAll<EsiAsset>(`/characters/${cid}/assets/`, acc);
        setAssets(aData);
        addLog('Assets', aData.length > 0 ? 'ok' : 'warn',
          `${aData.length} stacks${aData.length === 0 ? ' — check scopes or corp hangar' : ''}`);
      } catch (e) {
        addLog('Assets', 'err', (e as Error).message);
      }

      // ── 4. Blueprints ─────────────────────────────────────────────────────
      setLoadStep('Cataloguing blueprints…');
      let bData: EsiBlueprint[] = [];
      try {
        bData = await esiFetchAll<EsiBlueprint>(`/characters/${cid}/blueprints/`, acc);
        setBlueprints(bData);
        addLog('Blueprints', bData.length > 0 ? 'ok' : 'warn',
          `${bData.length} blueprints${bData.length === 0 ? ' — check scopes or corp hangar' : ''}`);
      } catch (e) {
        addLog('Blueprints', 'err', (e as Error).message);
      }

      // ── 5. Wallet ─────────────────────────────────────────────────────────
      setLoadStep('Reading wallet…');
      let wallet = 0;
      try {
        wallet = await esiGet<number>(`/characters/${cid}/wallet/`, acc);
        addLog('Wallet', 'ok', `${(wallet / 1e9).toFixed(2)}B ISK`);
      } catch (e) {
        addLog('Wallet', 'err', (e as Error).message);
      }

      // ── 6. Industry jobs ──────────────────────────────────────────────────
      setLoadStep('Checking industry jobs…');
      let activeJobs: ActiveJob[] = [];
      try {
        const allJobs = await esiGet<EsiJob[]>(
          `/characters/${cid}/industry/jobs/?include_completed=true`,
          acc
        );
        const activeEsiJobs = allJobs.filter((j) => j.status === 'active');

        const namePromises = activeEsiJobs.map(async (job) => {
          try {
            const typeInfo = await esiGet<{ name: string }>(
              `/universe/types/${job.product_type_id}/`
            );
            return typeInfo.name;
          } catch {
            return `Item #${job.product_type_id}`;
          }
        });

        const names = await Promise.all(namePromises);

        activeJobs = activeEsiJobs.map((job, i) => {
          const { label, done } = formatTimeRemaining(job.end_date);
          return {
            name:       names[i],
            quantity:   job.runs,
            remaining:  label,
            done,
            activityId: job.activity_id,
          };
        });

        addLog('Industry Jobs', 'ok', `${activeJobs.length} active`);
      } catch (e) {
        addLog('Industry Jobs', 'err', (e as Error).message);
      }

      // ── 7. Character skills ────────────────────────────────────────────────
      setLoadStep('Scanning skills…');
      let skillData: Array<{ skill_id: number; active_skill_level: number }> = [];
      try {
        const skillsResponse = await esiGet<{ skills: Array<{ skill_id: number; active_skill_level: number }> }>(
          `/characters/${cid}/skills/`,
          acc
        );
        skillData = skillsResponse.skills || [];
        setSkills(skillData);
        addLog('Skills', 'ok', `${skillData.length} trained`);
      } catch (e) {
        addLog('Skills', 'err', (e as Error).message);
      }

      // ── 8. Character standings (for broker fee accuracy) ──────────────────
      setLoadStep('Loading standings…');
      let standingsData: { factions: Record<number, number>; corps: Record<number, number> } =
        { factions: {}, corps: {} };
      let standingsScopeGranted = false;
      try {
        type EsiStanding = { from_id: number; from_type: string; standing: number };
        const rawStandings = await esiGet<EsiStanding[]>(`/characters/${cid}/standings/`, acc);
        for (const s of rawStandings) {
          if (s.from_type === 'faction')   standingsData.factions[s.from_id] = s.standing;
          if (s.from_type === 'npc_corp')  standingsData.corps[s.from_id]    = s.standing;
        }
        standingsScopeGranted = true;
        setHasStandingsScope(true);
        addLog('Standings', 'ok', `${rawStandings.length} entries`);
      } catch (e) {
        addLog('Standings', 'warn', 'Scope not granted — broker fee uses skills only');
        setHasStandingsScope(false);
      }

      // ── Count BPOs vs BPCs ──────────────────────────────────────────────────
      const bpoCount = bData.filter((bp) => bp.quantity === -1).length;

      // ── Build CharacterInfo ──────────────────────────────────────────────────
      const charInfoResult: CharacterInfo = {
        characterId:    cid,
        name:           charInfo.name,
        walletISK:      wallet,
        activeJobCount: activeJobs.length,
        blueprintCount: bData.length,
        bpoCount,
        activeJobs,
      };
      setCharacter(charInfoResult);

      // ── 10. Cache session on FORGE server (required for AI chat) ────────────
      setLoadStep('Caching session data…');
      try {
        await apiPost('/api/session-data', {
          assets:    aData,
          blueprints: bData,
          prices:    {},
          wallet,
          jobs:      activeJobs,
          skills:    skillData,
          standings: standingsScopeGranted ? standingsData : null,
        }, acc);
        addLog('Session', 'ok', 'Cached on server (2hr expiry)');
      } catch (e) {
        addLog('Session', 'warn', `Cache failed — AI chat may not work: ${(e as Error).message}`);
        console.warn('Session cache failed:', e);
      }

      // ── 11. Done ──────────────────────────────────────────────────────────
      sessionStorage.setItem(SESSION_TOKEN_KEY, acc);
      setStatus('authed');

    } catch (e) {
      const msg = (e as Error).message;
      setError(msg);
      setStatus('error');
    }
  }, []);

  // ── loadAltCharacterData ─────────────────────────────────────────────────
  // v1.5 — Loads an additional character and adds it to altCharacters[].
  // Non-blocking: adds a stub entry immediately, then updates it in-place.

  const loadAltCharacterData = useCallback(async (acc: string) => {
    let cid: number;
    try {
      cid = characterIdFromJwt(acc);
    } catch {
      console.warn('Invalid alt token — skipping');
      return;
    }

    // Don't load a duplicate (primary or already-loaded alt)
    // We'll check after getting cid below

    // Add stub entry immediately so UI shows a loading card
    const stub: AltCharacter = {
      characterId: cid, name: `Character #${cid}`, token: acc,
      blueprints: [], assets: [], skills: [], activeJobs: [],
      walletISK: 0, blueprintCount: 0, bpoCount: 0, activeJobCount: 0,
      hasStandingsScope: false, loading: true, error: null,
    };

    setAltCharacters((prev) => {
      // Deduplicate: don't add if already present
      if (prev.some((a) => a.characterId === cid)) return prev;
      return [...prev, stub];
    });

    // Save token to sessionStorage
    const saved = getSavedAltTokens();
    if (!saved.includes(acc)) {
      saveAltTokens([...saved, acc]);
    }

    try {
      const charInfo  = await esiGet<EsiCharacter>(`/characters/${cid}/`, acc);

      let aData: EsiAsset[] = [];
      try { aData = await esiFetchAll<EsiAsset>(`/characters/${cid}/assets/`, acc); } catch {}

      let bData: EsiBlueprint[] = [];
      try { bData = await esiFetchAll<EsiBlueprint>(`/characters/${cid}/blueprints/`, acc); } catch {}

      let wallet = 0;
      try { wallet = await esiGet<number>(`/characters/${cid}/wallet/`, acc); } catch {}

      let activeJobs: ActiveJob[] = [];
      try {
        const allJobs = await esiGet<EsiJob[]>(`/characters/${cid}/industry/jobs/?include_completed=true`, acc);
        const activeEsiJobs = allJobs.filter((j) => j.status === 'active');
        const names = await Promise.all(activeEsiJobs.map(async (job) => {
          try {
            const t = await esiGet<{ name: string }>(`/universe/types/${job.product_type_id}/`);
            return t.name;
          } catch { return `Item #${job.product_type_id}`; }
        }));
        activeJobs = activeEsiJobs.map((job, i) => {
          const { label, done } = formatTimeRemaining(job.end_date);
          return { name: names[i], quantity: job.runs, remaining: label, done, activityId: job.activity_id };
        });
      } catch {}

      let skillData: Array<{ skill_id: number; active_skill_level: number }> = [];
      try {
        const sr = await esiGet<{ skills: Array<{ skill_id: number; active_skill_level: number }> }>(
          `/characters/${cid}/skills/`, acc
        );
        skillData = sr.skills || [];
      } catch {}

      let standingsScopeGranted = false;
      let standingsData: { factions: Record<number, number>; corps: Record<number, number> } =
        { factions: {}, corps: {} };
      try {
        type EsiStanding = { from_id: number; from_type: string; standing: number };
        const rawStandings = await esiGet<EsiStanding[]>(`/characters/${cid}/standings/`, acc);
        for (const s of rawStandings) {
          if (s.from_type === 'faction')  standingsData.factions[s.from_id] = s.standing;
          if (s.from_type === 'npc_corp') standingsData.corps[s.from_id]    = s.standing;
        }
        standingsScopeGranted = true;
      } catch {}

      // Cache alt session on server
      try {
        await apiPost('/api/session-data', {
          assets: aData, blueprints: bData, prices: {}, wallet,
          jobs: activeJobs, skills: skillData,
          standings: standingsScopeGranted ? standingsData : null,
        }, acc);
      } catch {}

      const bpoCount = bData.filter((bp) => bp.quantity === -1).length;

      // Replace stub with fully-loaded alt
      if (!altCancelledRef.current.has(cid)) {
        setAltCharacters((prev) => prev.map((a) =>
          a.characterId === cid
            ? {
                characterId: cid, name: charInfo.name, token: acc,
                blueprints: bData, assets: aData, skills: skillData, activeJobs,
                walletISK: wallet, blueprintCount: bData.length, bpoCount,
                activeJobCount: activeJobs.length,
                hasStandingsScope: standingsScopeGranted,
                loading: false, error: null,
              }
            : a
        ));
      }
    } catch (e) {
      if (!altCancelledRef.current.has(cid)) {
        setAltCharacters((prev) => prev.map((a) =>
          a.characterId === cid
            ? { ...a, loading: false, error: (e as Error).message }
            : a
        ));
      }
    }
  }, []);

  // ── OAuth callback + saved-token check on mount ───────────────────────────

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code   = params.get('code');
    const state  = params.get('state');

    // Detect whether this OAuth callback is for an alt or the primary character
    const isAddingAlt = sessionStorage.getItem(ADDING_ALT_KEY) === 'true';

    if (code && state) {
      // ── Handle OAuth callback ──────────────────────────────────────────────
      window.history.replaceState({}, '', window.location.pathname);
      sessionStorage.removeItem(ADDING_ALT_KEY);

      const savedState = sessionStorage.getItem(SESSION_STATE_KEY);
      sessionStorage.removeItem(SESSION_STATE_KEY);

      if (!savedState || state !== savedState) {
        setError('OAuth state mismatch — possible CSRF. Please try logging in again.');
        setStatus('error');
        return;
      }

      if (isAddingAlt) {
        // Alt login: exchange token and load as alt (non-blocking)
        const redirectUri = window.location.origin + window.location.pathname;
        apiPost<{ access_token: string; error_description?: string }>(
          '/api/eve-token',
          { code, redirect_uri: redirectUri }
        )
          .then((data) => {
            if (!data.access_token) throw new Error(data.error_description ?? 'No token returned');
            return loadAltCharacterData(data.access_token);
          })
          .catch((e: Error) => console.warn('Alt login failed:', e.message));
        return;
      }

      // Primary login
      setStatus('exchanging');
      setLoadStep('Verifying login with EVE…');

      const redirectUri = window.location.origin + window.location.pathname;
      apiPost<{ access_token: string; error_description?: string }>(
        '/api/eve-token',
        { code, redirect_uri: redirectUri }
      )
        .then((data) => {
          if (!data.access_token) {
            throw new Error(data.error_description ?? 'Token exchange returned no token');
          }
          return loadCharacterData(data.access_token);
        })
        .catch((e: Error) => {
          setError(e.message);
          setStatus('error');
        });

      return;
    }

    // ── Resume saved session ───────────────────────────────────────────────
    const saved = sessionStorage.getItem(SESSION_TOKEN_KEY);
    if (saved) {
      loadCharacterData(saved)
        .then(() => {
          // After primary loads, restore any saved alts
          const altTokens = getSavedAltTokens();
          altTokens.forEach((t) => loadAltCharacterData(t));
        })
        .catch((e: Error) => {
          sessionStorage.removeItem(SESSION_TOKEN_KEY);
          setError(`Session expired: ${e.message}`);
          setStatus('idle');
        });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── addCharacter ──────────────────────────────────────────────────────────
  // v1.5 — Redirects to EVE SSO with a flag so the callback adds an alt.

  const addCharacter = useCallback(() => {
    const state       = generateState();
    const redirectUri = window.location.origin + window.location.pathname;

    sessionStorage.setItem(SESSION_STATE_KEY, state);
    sessionStorage.setItem(ADDING_ALT_KEY, 'true');
    setAddingAlt(true);

    const params = new URLSearchParams({
      response_type: 'code',
      client_id:     EVE_CLIENT_ID,
      redirect_uri:  redirectUri,
      scope:         SCOPES,
      state,
    });

    window.location.href = `https://login.eveonline.com/v2/oauth/authorize?${params}`;
  }, []);

  // ── removeCharacter ───────────────────────────────────────────────────────
  // v1.5 — Removes an alt from state and sessionStorage.

  const removeCharacter = useCallback((characterId: number) => {
    altCancelledRef.current.add(characterId);
    setAltCharacters((prev) => {
      const removed = prev.find((a) => a.characterId === characterId);
      if (!removed) return prev;
      // Remove token from sessionStorage
      const saved = getSavedAltTokens();
      saveAltTokens(saved.filter((t) => {
        try { return characterIdFromJwt(t) !== characterId; } catch { return true; }
      }));
      return prev.filter((a) => a.characterId !== characterId);
    });
  }, []);

  // ── login ─────────────────────────────────────────────────────────────────

  const login = useCallback(() => {
    const state       = generateState();
    const redirectUri = window.location.origin + window.location.pathname;

    sessionStorage.setItem(SESSION_STATE_KEY, state);

    const params = new URLSearchParams({
      response_type: 'code',
      client_id:     EVE_CLIENT_ID,
      redirect_uri:  redirectUri,
      scope:         SCOPES,
      state,
    });

    window.location.href = `https://login.eveonline.com/v2/oauth/authorize?${params}`;
  }, []);

  // ── logout ────────────────────────────────────────────────────────────────

  const logout = useCallback(() => {
    sessionStorage.removeItem(SESSION_TOKEN_KEY);
    sessionStorage.removeItem(ALT_TOKENS_KEY);
    setToken(null);
    setCharacter(null);
    setBlueprints([]);
    setAssets([]);
    setSkills([]);
    setHasStandingsScope(false);
    setError(null);
    setDataLog([]);
    setStatus('idle');
    setAltCharacters([]);
    setAddingAlt(false);
    altCancelledRef.current.clear();
  }, []);

  // ── session-expired event listener ────────────────────────────────────────

  useEffect(() => {
    const handleExpiry = () => logout();
    window.addEventListener('forge:session-expired', handleExpiry);
    return () => window.removeEventListener('forge:session-expired', handleExpiry);
  }, [logout]);

  return {
    status,
    token,
    character,
    blueprints,
    assets,
    skills,
    hasStandingsScope,
    error,
    loadStep,
    dataLog,
    altCharacters,
    addingAlt,
    login,
    logout,
    addCharacter,
    removeCharacter,
  };
}
