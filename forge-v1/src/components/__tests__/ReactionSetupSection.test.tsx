// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ReactionSetupSection from '../ReactionSetupSection';
import { EMPTY_REACTION_SETUP, type ReactionSetupState } from '../../utils/reactionSetup';
import type { IndustryRigsResponse } from '../../types';

// Shape of /api/industry-rigs (values are CCP's dogma numbers: Tatara 0.75, reactor rigs -20 / -2, null-sec x1.1)
const SEC = { hi: 0, low: 1, null: 1.1 };
const rigStats: IndustryRigsResponse = {
  structures: {
    '35825': { name: 'Raitaru', matMult: 0.99, costMult: 0.97, timeMult: 0.85 },
    '35835': { name: 'Athanor', matMult: 1, costMult: 1, timeMult: 1, refinery: true, rigSize: 'M' },
    '35836': { name: 'Tatara', matMult: 1, costMult: 1, timeMult: 0.75, refinery: true, rigSize: 'L' },
  },
  rigs: {
    '46484': { name: 'Standup M-Set Composite Reactor Time Efficiency I', size: 'M', family: 'Reactor', reaction: true, matPct: 0, timePct: 20, sec: SEC },
    '46496': { name: 'Standup L-Set Reactor Efficiency I', size: 'L', family: 'Reactor', reaction: true, matPct: 2, timePct: 20, sec: SEC },
    '43866': { name: 'Standup M-Set Advanced Component Manufacturing Material Efficiency II', size: 'M', family: 'Advanced Component', matPct: 2.4, timePct: 0, sec: { hi: 1, low: 1.9, null: 2.1 } },
  },
};

function setup(value: ReactionSetupState) {
  const onChange = vi.fn();
  render(<ReactionSetupSection token="t" value={value} onChange={onChange} rigStats={rigStats} />);
  return onChange;
}

describe('ReactionSetupSection', () => {
  it('is collapsed and optional when nothing is saved', () => {
    setup(EMPTY_REACTION_SETUP);
    expect(screen.getByText(/optional/i)).toBeTruthy();
    expect(screen.queryByText('Tatara')).toBeNull();
  });

  it('offers only refineries (with their real bonus) and shows only rigs that fit the chosen one', () => {
    setup({ ...EMPTY_REACTION_SETUP, structureId: 35836, systemId: 30000001, systemName: 'Somewhere', systemSecurity: -0.4 });
    expect(screen.getByText('Athanor')).toBeTruthy();
    expect(screen.getByText('25% faster reactions')).toBeTruthy();
    expect(screen.queryByText('Raitaru')).toBeNull();
    // Tatara takes the L rig, not the M reactor rig and never an engineering rig
    expect(screen.getByText(/Standup L-Set Reactor Efficiency I/)).toBeTruthy();
    expect(screen.queryByText(/Composite Reactor Time Efficiency I/)).toBeNull();
    expect(screen.queryByText(/Advanced Component/)).toBeNull();
    // nullsec x1.1 on the 20% time bonus
    expect(screen.getByText(/TE 20% → 22% here/)).toBeTruthy();
  });

  it('switching refinery drops rigs of the wrong size', () => {
    const onChange = setup({ ...EMPTY_REACTION_SETUP, structureId: 35836, rigs: [46496] });
    fireEvent.click(screen.getByLabelText(/Athanor/));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ structureId: 35835, rigs: [] }));
  });

  it('warns about highsec', () => {
    setup({ ...EMPTY_REACTION_SETUP, structureId: 35835, systemId: 30000142, systemName: 'Jita', systemSecurity: 0.9 });
    expect(screen.getByText(/can't be anchored in highsec/)).toBeTruthy();
  });
});
