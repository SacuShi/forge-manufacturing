/** The pilot's reaction (refinery) setup as edited in ⚙ Mfg Setup → Reactions. */
export interface ReactionSetupState {
  structureId:    number | null;   // 35835 Athanor / 35836 Tatara, or null = none
  rigs:           number[];
  systemId:       number | null;
  systemName:     string | null;
  systemSecurity: number | null;
  tax:            number;          // %
}

export const EMPTY_REACTION_SETUP: ReactionSetupState = {
  structureId: null, rigs: [], systemId: null, systemName: null, systemSecurity: null, tax: 0,
};
