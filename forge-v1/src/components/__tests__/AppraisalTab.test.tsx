// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import AppraisalTab from '../AppraisalTab';

const fetchMock = vi.fn();
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); });

function deferred() {
  let resolve!: (v: unknown) => void;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}
const answer = (hubName: string) => ({ ok: true, status: 200, json: async () => ({ items: [], totalSell: 200, totalBuy: 100, hubName }) });
const SEED = [{ typeId: 34, name: 'Tritanium', qty: 5 }];

describe('AppraisalTab', () => {
  it('appraises the items sent from the Assets tab as soon as it opens', async () => {
    fetchMock.mockResolvedValue(answer('Jita'));
    render(<AppraisalTab seedItems={SEED} />);
    await act(async () => { await Promise.resolve(); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/appraise');
    expect(JSON.parse(init.body)).toEqual({ items: SEED, regionId: 10000002 });
  });

  it('names the quick buttons after the selected hub', async () => {
    fetchMock.mockResolvedValue(answer('Jita'));
    render(<AppraisalTab seedItems={SEED} />);
    expect(screen.getByRole('button', { name: 'Jita Buy' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Amarr' }));
    expect(screen.getByRole('button', { name: 'Amarr Buy' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Amarr Sell' })).toBeInTheDocument();
    await act(async () => { await Promise.resolve(); });
  });

  it('shows the newest appraisal even when an older, slower one arrives last', async () => {
    const first = deferred();   // the automatic appraisal on open
    const second = deferred();  // after choosing Amarr
    const third = deferred();   // after pressing "Amarr Buy"
    fetchMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockReturnValueOnce(third.promise);
    render(<AppraisalTab seedItems={SEED} />);
    fireEvent.click(screen.getByRole('button', { name: 'Amarr' }));
    fireEvent.click(screen.getByRole('button', { name: 'Amarr Buy' }));
    expect(fetchMock).toHaveBeenCalledTimes(3);

    await act(async () => { third.resolve(answer('Amarr')); });
    expect(await screen.findByText(/Amarr buy orders/)).toBeInTheDocument();

    await act(async () => { first.resolve(answer('STALE-JITA')); second.resolve(answer('STALE-MID')); });
    expect(screen.getByText(/Amarr buy orders/)).toBeInTheDocument();
    expect(screen.queryByText(/STALE/)).toBeNull();
  });
});
