import { type FC } from 'react';

const STORAGE_KEY = 'forge-ticker-intro-v1';

interface TickerIntroProps {
  onClose: () => void;
}

const TickerIntro: FC<TickerIntroProps> = ({ onClose }) => {
  // Always persist dismissal — any close action means "I've seen it".
  // Without this, the intro re-appeared on every page load if the user
  // closed it without ticking the "Don't show again" checkbox.
  const handleClose = () => {
    localStorage.setItem(STORAGE_KEY, '1');
    onClose();
  };

  return (
    <div className="ticker-intro-backdrop" role="dialog" aria-modal="true" aria-label="Ticker introduction">
      <div className="ticker-intro">

        <div className="ticker-intro-header">
          <span className="ticker-intro-dot" />
          <h2 className="ticker-intro-title">Your Live Ticker</h2>
          <button type="button" className="ticker-intro-x" onClick={handleClose} aria-label="Close">✕</button>
        </div>

        <div className="ticker-intro-body">

          <div className="ticker-intro-section">
            <span className="ticker-intro-icon">⊕</span>
            <div>
              <strong>Pinning things</strong>
              <p>
                Hover over almost any price, profit, or timer in FORGE and a gold <strong>⊕</strong> will
                appear next to it. Click it to add that value to the ticker bar at the bottom of your screen.
                It will stay there and update automatically.
              </p>
            </div>
          </div>

          <div className="ticker-intro-section">
            <span className="ticker-intro-icon">⚙</span>
            <div>
              <strong>Managing your pins</strong>
              <p>
                Click <strong>⚙</strong> in the ticker bar to open the setup panel. Drag the <strong>⠿</strong> handle
                to reorder pins, click <strong>✕</strong> to remove one, or use the dropdown on each row to
                move a pin to a different layout.
              </p>
            </div>
          </div>

          <div className="ticker-intro-section">
            <span className="ticker-intro-icon ticker-intro-icon--green">●</span>
            <div>
              <strong>Layouts</strong>
              <p>
                Create multiple named ticker layouts — for example one for Manufacturing and one for Trading.
                Switch between them instantly using the layout name in the ticker bar. Pins you add always
                go to whichever layout is currently active.
              </p>
            </div>
          </div>

          <div className="ticker-intro-section">
            <span className="ticker-intro-icon">⊟</span>
            <div>
              <strong>Dual-row mode</strong>
              <p>
                Once you have two layouts, click <strong>⊟</strong> in the ticker controls to show both
                at once on separate rows — one scrolling faster than the other. Good for keeping
                fast-moving data (jobs, wallet) separate from slow-moving data (market prices).
              </p>
            </div>
          </div>

          <div className="ticker-intro-section">
            <span className="ticker-intro-icon">↗</span>
            <div>
              <strong>Pop-out window</strong>
              <p>
                Click <strong>↗</strong> to open the ticker in its own narrow window. Drag it to a
                second monitor and it will stay in sync with the main FORGE tab automatically.
              </p>
            </div>
          </div>

        </div>

        <div className="ticker-intro-footer">
          <button type="button" className="ticker-intro-ok" onClick={handleClose}>
            Got it!
          </button>
        </div>

      </div>
    </div>
  );
};

export function shouldShowTickerIntro(): boolean {
  return !localStorage.getItem(STORAGE_KEY);
}

export default TickerIntro;
