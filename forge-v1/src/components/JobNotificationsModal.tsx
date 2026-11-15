import { useState, type FC, type FormEvent } from 'react';
import { useEscapeKey } from '../hooks/useEscapeKey';
import type { PushState } from '../hooks/usePushNotifications';
import { isDiscordWebhookUrl, type DiscordNotifications } from '../hooks/useDiscordNotifications';

interface Props {
  pushState: PushState;
  onPushEnable: () => void;
  onPushDisable: () => void;
  discord: DiscordNotifications;
  onClose: () => void;
}

const when = (sqliteUtc: string | null) =>
  sqliteUtc ? new Date(`${sqliteUtc.replace(' ', 'T')}Z`).toLocaleString() : null;

/** Job-completion alerts: browser pop-ups on this device, and/or messages in a Discord channel. */
const JobNotificationsModal: FC<Props> = ({ pushState, onPushEnable, onPushDisable, discord, onClose }) => {
  useEscapeKey(onClose);
  const [url, setUrl] = useState('');
  const [replacing, setReplacing] = useState(false);
  const { status } = discord;
  const showForm = !discord.enabled || replacing;
  const urlLooksWrong = url.trim() !== '' && !isDiscordWebhookUrl(url);

  const handleConnect = async (e: FormEvent) => {
    e.preventDefault();
    if (!isDiscordWebhookUrl(url) || discord.busy) return;
    if (await discord.connect(url)) {
      setUrl('');
      setReplacing(false);
    }
  };

  return (
    <div className="notify-overlay" role="presentation" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="notify-modal" role="dialog" aria-modal="true" aria-labelledby="notify-title">
        <div className="notify-header">
          <h2 id="notify-title" className="notify-title">Job notifications</h2>
          <button type="button" className="notify-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <p className="notify-help">
          FORGE tells you when your industry jobs finish. It checks every 5 minutes, for the jobs it saw the last
          time you had FORGE open, so open it after starting new jobs.
        </p>

        {/* ── Browser ─────────────────────────────────────────────────────── */}
        <section className="notify-section" aria-labelledby="notify-browser">
          <div className="notify-section-head">
            <h3 id="notify-browser">🔔 Browser</h3>
            {pushState === 'unsupported' ? (
              <span className="notify-muted">Not supported in this browser</span>
            ) : pushState === 'denied' ? (
              <span className="notify-muted">Blocked in your browser settings</span>
            ) : (
              <button
                type="button"
                className={`push-toggle${pushState === 'granted' ? ' on' : ''}`}
                onClick={pushState === 'granted' ? onPushDisable : onPushEnable}
                disabled={pushState === 'checking'}
                aria-pressed={pushState === 'granted'}
                aria-label="Browser job notifications"
              >
                <span className="push-toggle-thumb" />
                <span className="push-toggle-text">
                  {pushState === 'checking' ? '…' : pushState === 'granted' ? 'ON' : 'OFF'}
                </span>
              </button>
            )}
          </div>
          <p className="notify-muted">A pop-up on this device, even when the FORGE tab is in the background.</p>
          {pushState === 'error' && <p className="notify-error" role="alert">Could not turn on browser notifications. Try again.</p>}
        </section>

        {/* ── Discord ─────────────────────────────────────────────────────── */}
        {status.available && (
          <section className="notify-section" aria-labelledby="notify-discord">
            <div className="notify-section-head">
              <h3 id="notify-discord">💬 Discord</h3>
              <span className={discord.enabled ? 'notify-on' : 'notify-muted'}>
                {discord.enabled ? 'Connected' : status.connected ? 'Needs attention' : 'Not set up'}
              </span>
            </div>
            <p className="notify-muted">A message in a Discord channel of your choice, so you see it on your phone too.</p>

            {status.lastError && <p className="notify-error" role="alert">{status.lastError}</p>}

            {discord.enabled && !replacing && (
              <>
                {status.lastOkAt && <p className="notify-muted">Last message delivered {when(status.lastOkAt)}</p>}
                <div className="notify-actions">
                  <button type="button" className="notify-btn" onClick={discord.test} disabled={discord.busy}>Send a test</button>
                  <button type="button" className="notify-btn" onClick={() => { discord.clearMessages(); setReplacing(true); }}
                    disabled={discord.busy}>Use another channel</button>
                  <button type="button" className="notify-btn notify-btn-danger" onClick={discord.disconnect}
                    disabled={discord.busy}>Turn off</button>
                </div>
              </>
            )}

            {showForm && (
              <form onSubmit={handleConnect}>
                <ol className="notify-steps">
                  <li>In Discord, open the channel&apos;s settings (the ⚙ next to its name).</li>
                  <li>Go to <strong>Integrations</strong> → <strong>Webhooks</strong> → <strong>New Webhook</strong>.</li>
                  <li>Click <strong>Copy Webhook URL</strong> and paste it below.</li>
                </ol>
                <p className="notify-muted">
                  Use a private channel or one for your corp: anyone who has the URL can post in that channel.
                </p>
                <label className="notify-label" htmlFor="notify-webhook">Webhook URL</label>
                <input
                  id="notify-webhook"
                  className="notify-input"
                  type="url"
                  inputMode="url"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="https://discord.com/api/webhooks/…"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  aria-invalid={urlLooksWrong}
                  aria-describedby={urlLooksWrong ? 'notify-webhook-hint' : undefined}
                />
                {urlLooksWrong && (
                  <p id="notify-webhook-hint" className="notify-error">
                    That doesn&apos;t look like a Discord webhook URL. It starts with https://discord.com/api/webhooks/
                  </p>
                )}
                <div className="notify-actions">
                  <button type="submit" className="notify-btn notify-btn-primary"
                    disabled={discord.busy || !isDiscordWebhookUrl(url)}>
                    {discord.busy ? 'Connecting…' : 'Connect'}
                  </button>
                  {replacing && (
                    <button type="button" className="notify-btn" onClick={() => { setReplacing(false); setUrl(''); }}>
                      Cancel
                    </button>
                  )}
                </div>
              </form>
            )}

            {discord.error && <p className="notify-error" role="alert">{discord.error}</p>}
            {discord.notice && <p className="notify-ok" role="status">{discord.notice}</p>}
          </section>
        )}
      </div>
    </div>
  );
};

export default JobNotificationsModal;
