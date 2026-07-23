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
 *
 * Security note (sessionStorage):
 *   All EVE Bearer tokens live in sessionStorage (cleared on tab close).
 *   The blast radius of an XSS attack is all loaded characters simultaneously.
 *   Mitigation: deploy with a strict Content-Security-Policy header on the
 *   server to block injected scripts.  A future improvement is to proxy ESI
 *   calls through the FORGE server with HttpOnly session cookies so raw tokens
 *   never reach the browser's JS environment.
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
  JumpClone,
} from '../types';
import { esiFetchAll, esiGet, apiPost } from '../api/client';

// ── EVE OAuth constants (must match EVE Developer Portal registration) ────────

const EVE_CLIENT_ID = import.meta.env.VITE_EVE_CLIENT_ID as string;
const SCOPES =
  'esi-assets.read_assets.v1 esi-characters.read_blueprints.v1 ' +
  'esi-wallet.read_character_wallet.v1 esi-industry.read_character_jobs.v1 ' +
  'esi-skills.read_skills.v1 ' +
  'esi-planets.manage_planets.v1 ' +
  'esi-characters.read_standings.v1 ' +
  'esi-characters.read_corporation_roles.v1 ' +
  'esi-corporations.read_corporation_membership.v1 ' +
  // v1.14.0 — corp data scopes so a Director can read THEIR OWN corp's
  // blueprints/assets/jobs directly (dynamic any-corp model; no admin setup).
  'esi-corporations.read_blueprints.v1 ' +
  'esi-assets.read_corporation_assets.v1 ' +
  'esi-industry.read_corporation_jobs.v1 ' +
  // v1.17.0 — active implants (industry hardwirings affect build time / ISK-hr).
  'esi-clones.read_implants.v1 ' +
  // v1.32.0 — jump clone list (implant selector lets user model a different clone).
  'esi-clones.read_clones.v1 ' +
  // v1.27.0 — active market orders (station trading My Orders panel + undercut alerts).
  'esi-markets.read_character_orders.v1 ' +
  // v1.28.0 — C-J6MT Keepstar structure market (alliance trade hub).
  'esi-markets.structure_markets.v1 ' +
  // v1.36.0 — LP balances per corp (LP Store tab).
  'esi-characters.read_loyalty.v1';

const SESSION_TOKEN_KEY = 'forge_token';
const SESSION_STATE_KEY = 'forge_oauth_state';
const ALT_TOKENS_KEY    = 'forge_alt_tokens';
const ADDING_ALT_KEY    = 'forge_adding_alt';

// ── Types ────────────────────────────────────────────────────────────────────

export type AuthStatus = 'idle' | 'exchanging' | 'loading' | 'authed' | 'error';

export interface LoadStep {
  label:   string;
  status:  'ok' | 'warn' | 'err' | 'pending';
  detail?: string;
}

/** Standings data stored for accurate combined-session re-POST in App.tsx */
export type StandingsData = {
  factions: Record<number, number>;
  corps:    Record<number, number>;
};

type EsiStanding = { from_id: number; from_type: string; standing: number };

export interface AuthState {
  status:           AuthStatus;
  token:            string | null;
  character:        CharacterInfo | null;
  blueprints:       EsiBlueprint[];
  assets:           EsiAsset[];
  skills:           Array<{ skill_id: number; active_skill_level: number }>;
  /** v1.17.1 — primary character's active implant type_ids (for the True Profit implant selector) */
  implants:         number[];
  /** v1.32.0 — jump clones with their implants (for the clone-based implant selector) */
  jumpClones:       JumpClone[];
  hasStandingsScope: boolean;
  /** Primary character standings — exposed so App.tsx can include them in combined re-POST */
  primaryStandings: StandingsData | null;
  /** Whether the primary character has docking rights at C-J6MT Keepstar. Defaults true (fail-open). */
  canDockKeestar:   boolean;
  error:            string | null;
  loadStep:         string;
  dataLog:          LoadStep[];
  altCharacters:    AltCharacter[];
  addingAlt:        boolean;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Decode a JWT payload without verifying the signature (verification happens server-side).
 * Uses TextDecoder so non-ASCII character names (accents etc.) are handled correctly;
 * atob() alone produces Latin-1 corruption for multi-byte UTF-8 sequences.
 */
function decodeJwtPayload(token: string): Record<string, unknown> {
  const part = token.split('.')[1];
  if (!part) throw new Error('Malformed JWT: missing payload segment');
  const padded = part.replace(/-/g, '+').replace(/_/g, '/');
  const pad    = '=='.slice(0, (4 - (padded.length % 4)) % 4);
  const bytes  = Uint8Array.from(atob(padded + pad), (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
}

/** Extract numeric characterId from EVE JWT sub claim ("CHARACTER:EVE:12345678") */
function characterIdFromJwt(token: string): number {
  const payload = decodeJwtPayload(token);
  const sub     = payload.sub as string;
  return parseInt(sub.replace('CHARACTER:EVE:', ''), 10);
}

/** Generate a cryptographically random state string for CSRF protection */
function generateState(): string {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Convert ESI end_date to a human-readable remaining time string */
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

/**
 * Resolve item names via the bulk ESI /universe/names/ POST endpoint (max 1000 IDs per call).
 * Much faster than N individual GETs, and handles newer items/SKINs that individual
 * type endpoints may not return a name for. Falls back to "Item #<id>" on any failure.
 */
async function resolveTypeNames(typeIds: number[]): Promise<Map<number, string>> {
  const uniqueIds = [...new Set(typeIds)];
  if (uniqueIds.length === 0) return new Map();
  const map = new Map<number, string>();
  for (let i = 0; i < uniqueIds.length; i += 1000) {
    const chunk = uniqueIds.slice(i, i + 1000);
    try {
      const res = await fetch(
        'https://esi.evetech.net/latest/universe/names/?datasource=tranquility',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(chunk) }
      );
      if (res.ok) {
        const data = await res.json() as Array<{ id: number; name: string }>;
        data.forEach(d => map.set(d.id, d.name));
      }
    } catch { /* silent — fallback below */ }
  }
  uniqueIds.forEach(id => { if (!map.has(id)) map.set(id, `Item #${id}`); });
  return map;
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
  // v1.17.1 — primary character's active implant type_ids (for the True Profit implant selector)
  const [implants,          setImplants]          = useState<number[]>([]);
  // v1.32.0 — jump clones with their implants (for the clone-based implant selector)
  const [jumpClones,        setJumpClones]        = useState<JumpClone[]>([]);
  const [hasStandingsScope, setHasStandingsScope] = useState(false);
  const [primaryStandings,  setPrimaryStandings]  = useState<StandingsData | null>(null);
  const [canDockKeestar,    setCanDockKeestar]    = useState(true);
  const [error,             setError]             = useState<string | null>(null);
  const [loadStep,          setLoadStep]          = useState('');
  const [dataLog,           setDataLog]           = useState<LoadStep[]>([]);

  // v1.5 — Alt character state
  const [altCharacters, setAltCharacters] = useState<AltCharacter[]>([]);
  const [addingAlt,     setAddingAlt]     = useState(false);

  /**
   * Tracks characterIds of in-flight alt loads to prevent duplicate concurrent
   * loads of the same character (race condition on session restore).
   */
  const inFlightAltsRef  = useRef<Set<number>>(new Set());
  /**
   * Tracks characterIds of removed alts so an in-flight load completing after
   * removal doesn't write stale data back into state.
   */
  const altCancelledRef  = useRef<Set<number>>(new Set());

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
        const allJobs       = await esiGet<EsiJob[]>(
          `/characters/${cid}/industry/jobs/?include_completed=true`, acc
        );
        const activeEsiJobs = allJobs.filter((j) => j.status === 'active');
        // Filter out jobs with missing product_type_id (edge case for non-standard activities)
        // then resolve names in parallel, deduplicated by typeId (fixes N+1 requests)
        const nameMap       = await resolveTypeNames(
          activeEsiJobs.filter((j) => j.product_type_id != null).map((j) => j.product_type_id)
        );
        activeJobs = activeEsiJobs.map((job) => {
          const { label, done } = formatTimeRemaining(job.end_date);
          return {
            name:       nameMap.get(job.product_type_id) ?? `Item #${job.product_type_id}`,
            typeId:     job.product_type_id,
            quantity:   job.runs,
            remaining:  label,
            done,
            activityId: job.activity_id,
            endDate:    job.end_date,
          };
        });
        addLog('Industry Jobs', 'ok', `${activeJobs.length} active`);
      } catch (e) {
        addLog('Industry Jobs', 'err', (e as Error).message);
      }

      // ── 7. Character skills ────────────────────────────────────────────────
      setLoadStep('Scanning skills…');
      let skillData: Array<{ skill_id: number; active_skill_level: number }> = [];
      let totalSp = 0;
      try {
        const skillsResponse = await esiGet<{
          skills:      Array<{ skill_id: number; active_skill_level: number }>;
          total_sp:    number;
          unallocated_sp?: number;
        }>(`/characters/${cid}/skills/`, acc);
        skillData = skillsResponse.skills ?? [];
        totalSp   = skillsResponse.total_sp ?? 0;
        setSkills(skillData);
        addLog('Skills', 'ok', `${skillData.length} trained · ${(totalSp / 1_000_000).toFixed(1)}M SP`);
      } catch (e) {
        addLog('Skills', 'err', (e as Error).message);
      }

      // ── 8. PI colonies ────────────────────────────────────────────────────────
      // Fetches the player's active planet colonies: planet type, CCU upgrade level,
      // and number of pins (structures). Used by the AI to reason about PI capacity.
      // Gracefully degrades — a missing scope or ESI error just leaves planetData empty.
      setLoadStep('Loading PI colonies…');
      let planetData: Array<{
        planet_id:      number;
        planet_type:    string;
        upgrade_level:  number;
        num_pins:       number;
        solar_system_id: number;
        last_update:    string;
      }> = [];
      try {
        planetData = await esiGet<typeof planetData>(`/characters/${cid}/planets/`, acc);
        addLog('PI Colonies', 'ok', `${planetData.length} planet${planetData.length !== 1 ? 's' : ''}`);
      } catch (e) {
        // 403 = scope not yet granted (old session); other errors = ESI issue
        addLog('PI Colonies', 'warn', `Not loaded — ${(e as Error).message}`);
      }

      // ── 9. Character standings (for broker fee accuracy) ──────────────────
      setLoadStep('Loading standings…');
      let standingsData: StandingsData = { factions: {}, corps: {} };
      let standingsScopeGranted        = false;
      try {
        const rawStandings = await esiGet<EsiStanding[]>(`/characters/${cid}/standings/`, acc);
        for (const s of rawStandings) {
          if (s.from_type === 'faction')  standingsData.factions[s.from_id] = s.standing;
          if (s.from_type === 'npc_corp') standingsData.corps[s.from_id]    = s.standing;
        }
        standingsScopeGranted = true;
        setHasStandingsScope(true);
        setPrimaryStandings(standingsData);
        addLog('Standings', 'ok', `${rawStandings.length} entries`);
      } catch (e) {
        // Only mark the scope as denied on a definitive 403 response.
        // A transient ESI outage (5xx, timeout) must not permanently show the
        // re-auth banner to users who already granted the scope.
        const isScopeDenied =
          (e as Error).message.includes('403') ||
          (e as Error).message.toLowerCase().includes('forbidden');
        if (isScopeDenied) {
          addLog('Standings', 'warn', 'Scope not granted — broker fee uses skills only');
          setHasStandingsScope(false);
          setPrimaryStandings(null);
        } else {
          addLog('Standings', 'warn',
            `ESI unavailable — standings not loaded (${(e as Error).message})`);
          // Leave hasStandingsScope at its current value; don't force a re-auth prompt
        }
      }

      // ── 9b. Active implants (industry hardwirings → build time / ISK-hr) ──
      // Returns an array of plugged-in implant type_ids. Graceful: a missing
      // scope (old session) just leaves the list empty.
      setLoadStep('Loading implants…');
      let implantData: number[] = [];
      try {
        implantData = await esiGet<number[]>(`/characters/${cid}/implants/`, acc);
        setImplants(implantData);
        addLog('Implants', 'ok', `${implantData.length} plugged in`);
      } catch (e) {
        addLog('Implants', 'warn', `Not loaded — ${(e as Error).message}`);
      }

      // ── 9c. Jump clones (for clone-based implant selector) ────────────────
      // Returns list of jump clones with their installed implants.
      // Graceful: old sessions without read_clones scope just leave the list empty.
      setLoadStep('Loading jump clones…');
      try {
        const clonesData = await esiGet<{
          jump_clones: Array<{
            jump_clone_id: number;
            location_id: number;
            location_type: string;
            implants: number[];
          }>;
        }>(`/characters/${cid}/clones/`, acc);
        const parsed: JumpClone[] = (clonesData.jump_clones ?? []).map(c => ({
          jumpCloneId:  c.jump_clone_id,
          locationId:   c.location_id,
          locationType: c.location_type,
          implants:     c.implants ?? [],
        }));
        setJumpClones(parsed);
        addLog('Jump Clones', 'ok', `${parsed.length} clone${parsed.length !== 1 ? 's' : ''}`);
      } catch (e) {
        addLog('Jump Clones', 'warn', `Not loaded — ${(e as Error).message}`);
      }

      // ── 9d. LP balances (loyalty points per NPC corp) ────────────────────
      setLoadStep('Loading LP balances…');
      let lpPoints: import('../types').LPPoint[] = [];
      try {
        const lpRes = await fetch('/api/lp-balance', {
          headers: { Authorization: `Bearer ${acc}` },
        });
        if (lpRes.ok) {
          const lpData = await lpRes.json();
          lpPoints = lpData.balances || [];
          addLog('LP Balances', 'ok', `${lpPoints.length} corp${lpPoints.length !== 1 ? 's' : ''} with LP`);
        } else if (lpRes.status === 403) {
          addLog('LP Balances', 'warn', 'Scope not yet granted — re-login to enable LP Wallet');
        } else {
          addLog('LP Balances', 'warn', `ESI ${lpRes.status}`);
        }
      } catch (e) {
        addLog('LP Balances', 'warn', `Not loaded — ${(e as Error).message}`);
      }

      // ── 9e. Keepstar docking rights ───────────────────────────────────────
      // Probes the structure market endpoint (esi-markets.structure_markets.v1, already granted).
      // ESI returns 403 if the character lacks docking rights; any other result → fail-open (true).
      // This controls whether C-J6MT appears in hub selectors across the app.
      setLoadStep('Checking Keepstar access…');
      try {
        const ksRes = await fetch('/api/can-dock-keepstar', {
          headers: { Authorization: `Bearer ${acc}` },
        });
        if (ksRes.ok) {
          const ksData = await ksRes.json();
          setCanDockKeestar(ksData.canDock !== false);
          addLog('Keepstar Access', ksData.canDock !== false ? 'ok' : 'warn',
            ksData.canDock !== false ? 'Docking rights confirmed' : 'No docking rights — C-J6MT hidden');
        }
        // Non-ok from our own server → fail-open, no log entry needed
      } catch {
        // Network error → fail-open
      }

      // ── Build CharacterInfo ──────────────────────────────────────────────
      const bpoCount = bData.filter((bp) => bp.quantity === -1).length;
      setCharacter({
        characterId:    cid,
        name:           charInfo.name,
        walletISK:      wallet,
        activeJobCount: activeJobs.length,
        blueprintCount: bData.length,
        bpoCount,
        activeJobs,
        lpPoints,
      });

      // ── 10. Cache session on FORGE server (required for AI chat) ──────────
      setLoadStep('Caching session data…');
      try {
        await apiPost('/api/session-data', {
          assets:    aData,
          blueprints: bData,
          prices:    {},
          wallet,
          jobs:      activeJobs,
          skills:    skillData,
          total_sp:  totalSp,
          standings: standingsScopeGranted ? standingsData : null,
          planets:   planetData,
          implants:  implantData,
        }, acc);
        addLog('Session', 'ok', 'Cached on server (2hr expiry)');
      } catch (e) {
        addLog('Session', 'warn',
          `Cache failed — AI chat may not work: ${(e as Error).message}`);
        console.warn('Session cache failed:', e);
      }

      sessionStorage.setItem(SESSION_TOKEN_KEY, acc);
      setStatus('authed');

    } catch (e) {
      setError((e as Error).message);
      setStatus('error');
    }
  }, []);

  // ── loadAltCharacterData ─────────────────────────────────────────────────
  //
  // v1.5 — Loads an additional character and merges it into altCharacters[].
  // All ESI requests run in parallel (Promise.allSettled) for fast alt loading.
  // Guards against: invalid tokens, adding the primary as alt, and concurrent
  // duplicate loads of the same character (race condition on session restore).

  const loadAltCharacterData = useCallback(async (acc: string) => {
    // ── Decode token ────────────────────────────────────────────────────────
    let cid: number;
    try {
      cid = characterIdFromJwt(acc);
    } catch {
      console.warn('Invalid alt token — skipping');
      return;
    }

    // ── Guard 1: don't add primary character as an alt ─────────────────────
    // Decode the saved primary token to get its characterId for comparison.
    const primaryToken = sessionStorage.getItem(SESSION_TOKEN_KEY);
    if (primaryToken) {
      try {
        if (characterIdFromJwt(primaryToken) === cid) {
          console.warn(`Character ${cid} is already the primary — skipping alt load`);
          return;
        }
      } catch {
        // Malformed primary token — let it fail elsewhere; don't block alt load
      }
    }

    // ── Guard 2: prevent duplicate concurrent loads ─────────────────────────
    // A fresh load supersedes any prior cancellation for the same character.
    altCancelledRef.current.delete(cid);
    if (inFlightAltsRef.current.has(cid)) return;
    inFlightAltsRef.current.add(cid);

    // ── Add stub so UI shows a loading card immediately ────────────────────
    const stub: AltCharacter = {
      characterId: cid, name: `Character #${cid}`, token: acc,
      blueprints: [], assets: [], skills: [], activeJobs: [],
      walletISK: 0, blueprintCount: 0, bpoCount: 0, activeJobCount: 0,
      hasStandingsScope: false, loading: true, error: null,
    };
    setAltCharacters((prev) => {
      // Functional-updater dedup: don't add if the card is already present
      if (prev.some((a) => a.characterId === cid)) return prev;
      return [...prev, stub];
    });

    // ── Persist token ───────────────────────────────────────────────────────
    const saved = getSavedAltTokens();
    if (!saved.includes(acc)) saveAltTokens([...saved, acc]);

    try {
      // ── Phase 1: Parallel ESI fetches ────────────────────────────────────
      // All requests fire simultaneously — alt loading is ~7× faster than sequential.
      const [
        charInfoResult,
        aDataResult,
        bDataResult,
        walletResult,
        jobsResult,
        skillsResult,
        standingsResult,
      ] = await Promise.allSettled([
        esiGet<EsiCharacter>(`/characters/${cid}/`, acc),
        esiFetchAll<EsiAsset>(`/characters/${cid}/assets/`, acc),
        esiFetchAll<EsiBlueprint>(`/characters/${cid}/blueprints/`, acc),
        esiGet<number>(`/characters/${cid}/wallet/`, acc),
        esiGet<EsiJob[]>(
          `/characters/${cid}/industry/jobs/?include_completed=true`, acc
        ),
        esiGet<{ skills: Array<{ skill_id: number; active_skill_level: number }> }>(
          `/characters/${cid}/skills/`, acc
        ),
        esiGet<EsiStanding[]>(`/characters/${cid}/standings/`, acc),
      ]);

      // Extract fulfilled values with safe fallbacks
      const charInfo  = charInfoResult.status  === 'fulfilled' ? charInfoResult.value  : null;
      const aData     = aDataResult.status     === 'fulfilled' ? aDataResult.value     : [];
      const bData     = bDataResult.status     === 'fulfilled' ? bDataResult.value     : [];
      const wallet    = walletResult.status    === 'fulfilled' ? walletResult.value    : 0;
      const rawJobs   = jobsResult.status      === 'fulfilled' ? jobsResult.value      : [];
      const skillData = skillsResult.status    === 'fulfilled'
        ? (skillsResult.value.skills ?? [])
        : [];
      const rawStandings = standingsResult.status === 'fulfilled'
        ? standingsResult.value
        : null;

      // ── Phase 2: Resolve job names (parallel, deduplicated) ───────────────
      // Filter out jobs missing product_type_id (edge case for some activity types)
      const activeEsiJobs = rawJobs.filter(
        (j) => j.status === 'active' && j.product_type_id != null
      );
      const nameMap       = await resolveTypeNames(
        activeEsiJobs.map((j) => j.product_type_id)
      );
      const activeJobs: ActiveJob[] = activeEsiJobs.map((job) => {
        const { label, done } = formatTimeRemaining(job.end_date);
        return {
          name:       nameMap.get(job.product_type_id) ?? `Item #${job.product_type_id}`,
          typeId:     job.product_type_id,
          quantity:   job.runs,
          remaining:  label,
          done,
          activityId: job.activity_id,
          endDate:    job.end_date,
        };
      });

      // ── Build standings ───────────────────────────────────────────────────
      let standingsData: StandingsData = { factions: {}, corps: {} };
      let standingsScopeGranted        = false;
      if (rawStandings) {
        for (const s of rawStandings) {
          if (s.from_type === 'faction')  standingsData.factions[s.from_id] = s.standing;
          if (s.from_type === 'npc_corp') standingsData.corps[s.from_id]    = s.standing;
        }
        standingsScopeGranted = true;
      }

      // Note: we deliberately do NOT post session-data here for the alt's own token.
      // App.tsx fires a debounced combined re-POST (under the primary's token) once
      // all alts finish loading, which overwrites the primary's server session with
      // the merged skills/assets/blueprints. Posting individually per alt would:
      //   (a) fire N extra requests during login burst → hits rate limit, and
      //   (b) get immediately overwritten by the combined re-POST anyway.

      const bpoCount = bData.filter((bp) => bp.quantity === -1).length;

      // ── Replace stub with fully-loaded alt (if not removed mid-load) ──────
      if (!altCancelledRef.current.has(cid)) {
        setAltCharacters((prev) => prev.map((a) =>
          a.characterId !== cid ? a : {
            characterId: cid,
            name:        charInfo?.name ?? `Character #${cid}`,
            token:       acc,
            blueprints:  bData,
            assets:      aData,
            skills:      skillData,
            activeJobs,
            walletISK:        wallet,
            blueprintCount:   bData.length,
            bpoCount,
            activeJobCount:   activeJobs.length,
            hasStandingsScope: standingsScopeGranted,
            loading: false,
            error:   null,
          }
        ));
      }
    } catch (e) {
      if (!altCancelledRef.current.has(cid)) {
        setAltCharacters((prev) => prev.map((a) =>
          a.characterId !== cid ? a : { ...a, loading: false, error: (e as Error).message }
        ));
      }
    } finally {
      inFlightAltsRef.current.delete(cid);
    }
  }, []);

  // ── OAuth callback + saved-token check on mount ───────────────────────────

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code   = params.get('code');
    const state  = params.get('state');

    // Read and ALWAYS clear the adding-alt flag before any branching.
    // If the user cancelled the EVE SSO flow (redirected back without code/state),
    // the flag would otherwise persist indefinitely and misroute the next primary login.
    const isAddingAlt = sessionStorage.getItem(ADDING_ALT_KEY) === 'true';
    sessionStorage.removeItem(ADDING_ALT_KEY);

    if (code && state) {
      // ── Handle OAuth callback ────────────────────────────────────────────
      window.history.replaceState({}, '', window.location.pathname);

      const savedState = sessionStorage.getItem(SESSION_STATE_KEY);
      sessionStorage.removeItem(SESSION_STATE_KEY);

      if (!savedState || state !== savedState) {
        setError('OAuth state mismatch — possible CSRF. Please try logging in again.');
        setStatus('error');
        return;
      }

      const redirectUri = window.location.origin + window.location.pathname;

      if (isAddingAlt) {
        // Alt login: exchange token and load as alt (non-blocking)
        apiPost<{ access_token: string; error_description?: string }>(
          '/api/eve-token',
          { code, redirect_uri: redirectUri }
        )
          .then((data) => {
            if (!data.access_token) {
              throw new Error(data.error_description ?? 'No token returned');
            }
            return loadAltCharacterData(data.access_token);
          })
          .catch((e: Error) => console.warn('Alt login failed:', e.message));

        // ── Critical: resume the primary session ─────────────────────────────
        // Redirecting to EVE SSO unmounts the entire React app — all useState is
        // gone. The primary token survives in sessionStorage but without this block
        // the isAddingAlt branch returned before reaching the "resume saved session"
        // section, leaving status='idle' and showing the login screen.
        const primaryToken = sessionStorage.getItem(SESSION_TOKEN_KEY);
        if (primaryToken) {
          loadCharacterData(primaryToken)
            .then(() => {
              // Restore any other saved alts that were already loaded before the
              // redirect (the new alt is handled by loadAltCharacterData above).
              getSavedAltTokens().forEach((t) => loadAltCharacterData(t));
            })
            .catch((e: Error) => {
              sessionStorage.removeItem(SESSION_TOKEN_KEY);
              setError(`Session expired: ${e.message}`);
              setStatus('idle');
            });
        }
        return;
      }

      // Primary login
      setStatus('exchanging');
      setLoadStep('Verifying login with EVE…');

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
          // After primary loads, restore alts in parallel
          getSavedAltTokens().forEach((t) => loadAltCharacterData(t));
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

  const addCharacter = useCallback(() => {
    const state       = generateState();
    const redirectUri = window.location.origin + window.location.pathname;

    sessionStorage.setItem(SESSION_STATE_KEY, state);
    sessionStorage.setItem(ADDING_ALT_KEY, 'true');
    setAddingAlt(true);

    window.location.href =
      `https://login.eveonline.com/v2/oauth/authorize?${new URLSearchParams({
        response_type: 'code',
        client_id:     EVE_CLIENT_ID,
        redirect_uri:  redirectUri,
        scope:         SCOPES,
        state,
      })}`;
  }, []);

  // ── removeCharacter ───────────────────────────────────────────────────────

  const removeCharacter = useCallback((characterId: number) => {
    // Mark as cancelled so any in-flight load won't write its result back to state
    altCancelledRef.current.add(characterId);

    setAltCharacters((prev) => {
      if (!prev.some((a) => a.characterId === characterId)) return prev;
      // Remove the token from sessionStorage (inline to keep it atomic with state update)
      saveAltTokens(
        getSavedAltTokens().filter((t) => {
          try { return characterIdFromJwt(t) !== characterId; }
          catch { return true; }
        })
      );
      return prev.filter((a) => a.characterId !== characterId);
    });
  }, []);

  // ── login ─────────────────────────────────────────────────────────────────

  const login = useCallback(() => {
    const state       = generateState();
    const redirectUri = window.location.origin + window.location.pathname;

    sessionStorage.setItem(SESSION_STATE_KEY, state);

    window.location.href =
      `https://login.eveonline.com/v2/oauth/authorize?${new URLSearchParams({
        response_type: 'code',
        client_id:     EVE_CLIENT_ID,
        redirect_uri:  redirectUri,
        scope:         SCOPES,
        state,
      })}`;
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
    setImplants([]);
    setJumpClones([]);
    setHasStandingsScope(false);
    setPrimaryStandings(null);
    setCanDockKeestar(true);
    setError(null);
    setDataLog([]);
    setStatus('idle');
    setAltCharacters([]);
    setAddingAlt(false);
    altCancelledRef.current.clear();
    inFlightAltsRef.current.clear();
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
    implants,
    jumpClones,
    hasStandingsScope,
    primaryStandings,
    canDockKeestar,
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
