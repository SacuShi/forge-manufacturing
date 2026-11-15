// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import JobNotificationsModal from '../JobNotificationsModal';
import type { DiscordNotifications, DiscordStatus } from '../../hooks/useDiscordNotifications';

const HOOK = `https://discord.com/api/webhooks/123456789012345678/${'x'.repeat(40)}`;

function fakeDiscord(status: Partial<DiscordStatus> = {}, extra: Partial<DiscordNotifications> = {}): DiscordNotifications {
  const s: DiscordStatus = { available: true, connected: false, active: false, lastOkAt: null, lastError: null, ...status };
  return {
    status: s, available: s.available, enabled: s.connected && s.active, busy: false, error: null, notice: null,
    connect: vi.fn().mockResolvedValue(true), test: vi.fn(), disconnect: vi.fn(), clearMessages: vi.fn(),
    ...extra,
  } as DiscordNotifications;
}

const renderModal = (discord: DiscordNotifications, onClose = vi.fn()) => render(
  <JobNotificationsModal pushState="idle" onPushEnable={vi.fn()} onPushDisable={vi.fn()} discord={discord} onClose={onClose} />,
);

describe('JobNotificationsModal', () => {
  it('explains how to make a webhook and only allows a real webhook URL', async () => {
    const discord = fakeDiscord();
    renderModal(discord);
    expect(screen.getByText(/Copy Webhook URL/)).toBeTruthy();
    const input = screen.getByLabelText('Webhook URL');
    const connect = screen.getByRole('button', { name: 'Connect' }) as HTMLButtonElement;

    fireEvent.change(input, { target: { value: 'https://example.com/hook' } });
    expect(connect.disabled).toBe(true);
    expect(screen.getByText(/doesn.t look like a Discord webhook URL/)).toBeTruthy();
    expect(input.getAttribute('aria-invalid')).toBe('true');

    fireEvent.change(input, { target: { value: HOOK } });
    expect(connect.disabled).toBe(false);
    await act(async () => { fireEvent.click(connect); });
    expect(discord.connect).toHaveBeenCalledWith(HOOK);
  });

  it('offers test, change and turn off once connected, and shows why a webhook stopped working', () => {
    const discord = fakeDiscord({ connected: true, active: true, lastOkAt: '2026-11-15 10:00:00' });
    renderModal(discord);
    expect(screen.queryByLabelText('Webhook URL')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Send a test' }));
    fireEvent.click(screen.getByRole('button', { name: 'Turn off' }));
    expect(discord.test).toHaveBeenCalled();
    expect(discord.disconnect).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Use another channel' }));
    expect(screen.getByLabelText('Webhook URL')).toBeTruthy();
  });

  it('shows the reason and the form again when Discord deleted the webhook', () => {
    renderModal(fakeDiscord({ connected: true, active: false, lastError: 'Discord says this webhook was deleted.' }));
    expect(screen.getByRole('alert').textContent).toMatch(/deleted/);
    expect(screen.getByText('Needs attention')).toBeTruthy();
    expect(screen.getByLabelText('Webhook URL')).toBeTruthy();
  });

  it('hides the Discord section when the server does not offer it, and closes on Escape', () => {
    const onClose = vi.fn();
    renderModal(fakeDiscord({ available: false }), onClose);
    expect(screen.queryByText('💬 Discord')).toBeNull();
    expect(screen.getByRole('button', { name: 'Browser job notifications' })).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
