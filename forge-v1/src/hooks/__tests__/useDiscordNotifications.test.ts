// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useDiscordNotifications, isDiscordWebhookUrl, apiErrorMessage } from '../useDiscordNotifications';

const fetchMock = vi.fn();
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); });

const reply = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300, status,
  json: async () => body, text: async () => JSON.stringify(body),
});
const OFF = { available: true, connected: false, active: false, lastOkAt: null, lastError: null };
const ON = { available: true, connected: true, active: true, lastOkAt: '2026-11-15 10:00:00', lastError: null };
const HOOK = `https://discord.com/api/webhooks/123456789012345678/${'x'.repeat(40)}`;

describe('isDiscordWebhookUrl', () => {
  it('matches the server rule', () => {
    expect(isDiscordWebhookUrl(HOOK)).toBe(true);
    expect(isDiscordWebhookUrl(`  ${HOOK}  `)).toBe(true);
    expect(isDiscordWebhookUrl(HOOK.replace('https', 'http'))).toBe(false);
    expect(isDiscordWebhookUrl(HOOK.replace('discord.com', 'discord.com.evil.example'))).toBe(false);
    expect(isDiscordWebhookUrl('https://discord.com/channels/1/2')).toBe(false);
  });
});

describe('apiErrorMessage', () => {
  it("returns the server's own message from an API error", () => {
    expect(apiErrorMessage(new Error('API 400 /api/notify/discord: {"error":"Discord says no"}'))).toBe('Discord says no');
    expect(apiErrorMessage(new Error('API 502 /x: Bad Gateway'))).toBe('Bad Gateway');
    expect(apiErrorMessage(new Error('Failed to fetch'))).toBe('Failed to fetch');
  });
});

describe('useDiscordNotifications', () => {
  it('loads the status for the signed-in character', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, ON));
    const { result } = renderHook(() => useDiscordNotifications('tok-a'));
    await waitFor(() => expect(result.current.enabled).toBe(true));
    expect(fetchMock.mock.calls[0][0]).toBe('/api/notify/discord');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer tok-a');
  });

  it("never shows the previous character's setting after a switch", async () => {
    fetchMock.mockResolvedValueOnce(reply(200, ON));
    const { result, rerender } = renderHook(({ t }) => useDiscordNotifications(t), { initialProps: { t: 'tok-a' } });
    await waitFor(() => expect(result.current.enabled).toBe(true));
    fetchMock.mockReturnValueOnce(new Promise(() => {})); // second character's status still loading
    rerender({ t: 'tok-b' });
    expect(result.current.enabled).toBe(false);
    expect(result.current.available).toBe(false);
  });

  it('connects and reports success', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, OFF)).mockResolvedValueOnce(reply(200, ON));
    const { result } = renderHook(() => useDiscordNotifications('tok-a'));
    await waitFor(() => expect(result.current.available).toBe(true));
    let ok = false;
    await act(async () => { ok = await result.current.connect(` ${HOOK} `); });
    expect(ok).toBe(true);
    expect(result.current.enabled).toBe(true);
    expect(result.current.notice).toMatch(/Connected/);
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe('/api/notify/discord');
    expect(JSON.parse(init.body)).toEqual({ url: HOOK });
  });

  it("shows the server's reason when connecting fails, and refreshes the status", async () => {
    fetchMock
      .mockResolvedValueOnce(reply(200, OFF))
      .mockResolvedValueOnce(reply(400, { error: 'Discord says that webhook does not exist.' }))
      .mockResolvedValueOnce(reply(200, OFF));
    const { result } = renderHook(() => useDiscordNotifications('tok-a'));
    await waitFor(() => expect(result.current.available).toBe(true));
    let ok = true;
    await act(async () => { ok = await result.current.connect(HOOK); });
    expect(ok).toBe(false);
    expect(result.current.error).toBe('Discord says that webhook does not exist.');
    expect(result.current.busy).toBe(false);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  });

  it('stays hidden when the server has no Discord support', async () => {
    fetchMock.mockResolvedValueOnce(reply(404, 'Not found'));
    const { result } = renderHook(() => useDiscordNotifications('tok-a'));
    await act(async () => { await Promise.resolve(); });
    expect(result.current.available).toBe(false);
    expect(result.current.enabled).toBe(false);
  });
});
