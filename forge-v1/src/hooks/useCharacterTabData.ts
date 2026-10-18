import type { AuthState } from './useAuth';
import { useMemo } from 'react';
import { type PiCharacter, type QueueCharacter, type ActiveJob } from '../types';

interface UseCharacterTabDataParams {
  auth: AuthState & { login: () => void; logout: () => void; addCharacter: () => void; removeCharacter: (characterId: number) => void; setRemember: (enabled: boolean) => Promise<void>; restoreRememberedCharacters: (characterIds: number[]) => Promise<{ characterId: number; name: string; error?: string | undefined; }[]>; forgetRememberedCharacter: (characterId: number) => Promise<void>; forgetAllRemembered: () => Promise<void>; };
  viewCharacterId: number | null;
}

export function useCharacterTabData({ auth, viewCharacterId }: UseCharacterTabDataParams) {
  // ── PI: all characters with their tokens (always all, not filtered by isolation) ──
  // PI is best viewed combined — each colony card shows who owns it.
  const piCharacters = useMemo<PiCharacter[]>(() => {
    const all: PiCharacter[] = [];
    if (auth.character && auth.token) {
      all.push({ characterId: auth.character.characterId, name: auth.character.name, token: auth.token });
    }
    auth.altCharacters.filter(a => !a.loading && !a.error).forEach(alt => {
      all.push({ characterId: alt.characterId, name: alt.name, token: alt.token });
    });
    // When "All" is selected (null), show every character's colonies combined.
    // When a specific character is selected, show only that character's colonies.
    if (viewCharacterId !== null) return all.filter(c => c.characterId === viewCharacterId);
    return all;
  }, [auth.character, auth.token, auth.altCharacters, viewCharacterId]);

  // ── Queue Planner: per-character slot summary ────────────────────────────
  // Manufacturing and Reaction jobs use two INDEPENDENT slot pools in EVE —
  // Mass Production/Advanced Mass Production (skills 3387/24625) govern
  // manufacturing slots; Mass Reactions/Advanced Mass Reactions (skills
  // 45748/45749) govern reaction slots. A reaction job can never occupy a
  // manufacturing slot or vice versa. (Verified 17 Sept 2026 — this used to
  // be a single combined pool sized only by the manufacturing skills, with
  // both job types counted against it, which under- or over-stated free
  // slots for anyone running reactions.)
  const queueCharacters = useMemo<QueueCharacter[]>(() => {
    const getSlots = (skills: Array<{ skill_id: number; active_skill_level: number }>, l1: number, l2: number) => {
      const sm: Record<number, number> = {};
      skills.forEach(s => { sm[s.skill_id] = s.active_skill_level; });
      return 1 + (sm[l1] || 0) + (sm[l2] || 0);
    };
    const chars: QueueCharacter[] = [];
    const toSkillMap = (skills: Array<{ skill_id: number; active_skill_level: number }>) => {
      const m: Record<number, number> = {};
      skills.forEach(s => { m[s.skill_id] = s.active_skill_level; });
      return m;
    };
    const buildChar = (
      characterId: number, name: string, token: string,
      skills: Array<{ skill_id: number; active_skill_level: number }>,
      activeJobs: ActiveJob[],
    ): QueueCharacter => {
      const mfgTotalSlots      = getSlots(skills, 3387, 24625);   // 1 + Mass Prod + Adv Mass Prod
      const reactionTotalSlots = getSlots(skills, 45748, 45749);  // 1 + Mass Reactions + Adv Mass Reactions
      const mfgBusy      = activeJobs.filter(j => j.activityId === 1).length;
      const reactionBusy = activeJobs.filter(j => j.activityId === 9).length;
      const mfgFreeSlots      = Math.max(0, mfgTotalSlots - mfgBusy);
      const reactionFreeSlots = Math.max(0, reactionTotalSlots - reactionBusy);
      return {
        characterId, name, token,
        totalSlots: mfgTotalSlots + reactionTotalSlots,
        freeSlots:  mfgFreeSlots + reactionFreeSlots,
        mfgTotalSlots, mfgFreeSlots, reactionTotalSlots, reactionFreeSlots,
        activeJobs,
        skills: toSkillMap(skills),
      };
    };
    if (auth.character) {
      chars.push(buildChar(
        auth.character.characterId, auth.character.name, auth.token ?? '',
        auth.skills, auth.character.activeJobs ?? [],
      ));
    }
    auth.altCharacters.filter(a => !a.loading && !a.error).forEach(alt => {
      chars.push(buildChar(alt.characterId, alt.name, alt.token, alt.skills, alt.activeJobs ?? []));
    });
    // When "All" is selected (null), plan across every character's slots combined.
    // When a specific character is selected, plan only for that character's slots
    // (still uses the primary's session for blueprint/asset data).
    if (viewCharacterId !== null) return chars.filter(c => c.characterId === viewCharacterId);
    return chars;
  }, [auth.character, auth.token, auth.skills, auth.altCharacters, viewCharacterId]);

  // Blueprint → owner name map (item_id → character name) — for attribution badges
  const blueprintOwnerMap = useMemo(() => {
    const map = new Map<number, string>();
    if (auth.altCharacters.length === 0) return map; // no alts → no badges needed
    auth.blueprints.forEach((bp) => map.set(bp.item_id, auth.character?.name ?? 'Primary'));
    auth.altCharacters.forEach((a) => a.blueprints.forEach((bp) => map.set(bp.item_id, a.name)));
    return map;
  }, [auth.blueprints, auth.character, auth.altCharacters]);

  return { blueprintOwnerMap, piCharacters, queueCharacters };
}
