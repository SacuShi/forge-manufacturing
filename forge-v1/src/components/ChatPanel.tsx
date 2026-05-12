/**
 * FORGE v1.0 — ChatPanel component
 *
 * Right-edge slide-in AI advisor panel (340px when open, 0 when closed).
 * Width transition is handled purely by CSS (.chat-panel / .chat-panel.open).
 *
 * Layout:
 *   [Chat header — title + backronym subtitle]
 *   [Scrollable message list]
 *   [Input area — textarea + Send button + quick prompt chips]
 *
 * Message rendering:
 *   User messages      → plain text in a styled bubble.
 *   Assistant messages → content may contain [[Name|typeId]] tokens.
 *     These are parsed into ItemLink elements at render time via
 *     parseMessageContent(), avoiding dangerouslySetInnerHTML entirely.
 *
 * State:
 *   - draft  : current textarea value (local)
 *   - Message history is owned by App and passed in via props,
 *     so quick prompts fired from LeftSidebar appear here automatically.
 *
 * Keyboard:
 *   Enter (without Shift) sends the draft. Shift+Enter inserts a newline.
 *
 * Security:
 *   - No dangerouslySetInnerHTML — token parsing uses regex + React nodes.
 *   - Icon URLs in ItemLink use numeric typeIds only.
 */

import {
  useState,
  useRef,
  useEffect,
  type FC,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import type { ChatMessage } from '../types';
import { QUICK_PROMPTS } from '../data/mockData';
import ItemLink from './ItemLink';

// ── Types ────────────────────────────────────────────────────────────────────

interface ChatPanelProps {
  open: boolean;
  messages: ChatMessage[];
  /** Called when the user sends a message (draft text, trimmed) */
  onSend: (text: string) => void;
  /** Called when user clicks an [[ItemLink]] inside an assistant message */
  onItemSelect: (typeId: number) => void;
}

// ── Token parser ─────────────────────────────────────────────────────────────

/**
 * Parses an assistant message string that may contain [[Name|typeId]] tokens
 * and returns an array of React nodes (plain strings + ItemLink elements).
 *
 * @example
 *   "Best bet is [[Vagabond|11993]] right now."
 *   → ["Best bet is ", <ItemLink typeId={11993} name="Vagabond" />, " right now."]
 *
 * Uses a stateful regex exec loop so partial matches don't cause issues.
 */
function parseMessageContent(
  content: string,
  onItemSelect: (typeId: number) => void
): ReactNode[] {
  const TOKEN_RE = /\[\[([^\]|]+)\|(\d+)\]\]/g;
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = TOKEN_RE.exec(content)) !== null) {
    /* Text segment before this token */
    if (match.index > lastIndex) {
      nodes.push(content.slice(lastIndex, match.index));
    }

    const name   = match[1];
    const typeId = parseInt(match[2], 10);

    nodes.push(
      <ItemLink
        key={`${typeId}-${match.index}`}
        typeId={typeId}
        name={name}
        onClick={onItemSelect}
      />
    );

    lastIndex = match.index + match[0].length;
  }

  /* Trailing text after the last token */
  if (lastIndex < content.length) {
    nodes.push(content.slice(lastIndex));
  }

  return nodes;
}

// ── Component ────────────────────────────────────────────────────────────────

const ChatPanel: FC<ChatPanelProps> = ({ open, messages, onSend, onItemSelect }) => {
  const [draft, setDraft]   = useState('');
  const messagesEndRef      = useRef<HTMLDivElement>(null);
  const textareaRef         = useRef<HTMLTextAreaElement>(null);

  /* Auto-scroll to the bottom whenever messages change */
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  /* Focus the textarea when the panel opens */
  useEffect(() => {
    if (open) {
      // Small delay allows the CSS width transition to complete first
      const timer = setTimeout(() => textareaRef.current?.focus(), 260);
      return () => clearTimeout(timer);
    }
  }, [open]);

  /* ── Handlers ──────────────────────────────────────────────────────────── */

  const handleSend = () => {
    const text = draft.trim();
    if (!text) return;
    onSend(text);
    setDraft('');
  };

  /** Enter sends; Shift+Enter inserts a newline */
  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleQuickPrompt = (prompt: string) => {
    onSend(prompt);
  };

  /* Whether to show quick prompt chips (only before any user message) */
  const showChips = !messages.some((m) => m.role === 'user');

  /* ── Render ────────────────────────────────────────────────────────────── */

  return (
    <section
      className={`chat-panel${open ? ' open' : ''}`}
      aria-label="F.O.R.G.E. AI advisor"
      aria-hidden={!open}
    >
      {/* ── Panel header ──────────────────────────────────────────────────── */}
      <div className="chat-header">
        <div>
          <div className="chat-title">F.O.R.G.E. AI</div>
          {/*
           * Backronym subtitle — initial letters highlighted with
           * .backronym-letter so the acronym origin is visually obvious.
           * Using &amp; for the ampersand (JSX XSS safe).
           */}
          <div className="chat-subtitle">
            <span className="backronym-letter">F</span>abrication,{' '}
            <span className="backronym-letter">O</span>perations,{' '}
            <span className="backronym-letter">R</span>esource &amp;{' '}
            <span className="backronym-letter">G</span>uidance{' '}
            <span className="backronym-letter">E</span>ngine
          </div>
        </div>
      </div>

      {/* ── Message list ──────────────────────────────────────────────────── */}
      <div
        className="chat-messages"
        role="log"
        aria-live="polite"
        aria-label="Conversation history"
        aria-atomic="false"
      >
        {messages.map((msg) => (
          <div key={msg.id} className="msg">
            <div className="msg-label">
              {msg.role === 'user' ? 'You' : 'F.O.R.G.E.'}
            </div>

            {msg.role === 'user' ? (
              <div className="msg-user">{msg.content}</div>
            ) : (
              <div className="msg-assistant">
                {parseMessageContent(msg.content, onItemSelect)}
              </div>
            )}
          </div>
        ))}

        {/* Scroll anchor — scrolled into view after new messages */}
        <div ref={messagesEndRef} aria-hidden="true" />
      </div>

      {/* ── Input area ────────────────────────────────────────────────────── */}
      <div className="chat-input-area">
        <div className="chat-input-row">
          <textarea
            ref={textareaRef}
            className="chat-textarea"
            placeholder="Ask about manufacturing opportunities…"
            value={draft}
            rows={2}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            aria-label="Message input — press Enter to send, Shift+Enter for new line"
          />
          <button
            type="button"
            className="chat-send-btn"
            onClick={handleSend}
            disabled={!draft.trim()}
            aria-label="Send message"
          >
            Send
          </button>
        </div>

        {/* Quick prompt chips — shown until the user sends their first message */}
        {showChips && (
          <div className="quick-prompts" aria-label="Suggested questions">
            {QUICK_PROMPTS.map((prompt) => (
              <button
                key={prompt}
                type="button"
                className="quick-prompt-btn"
                onClick={() => handleQuickPrompt(prompt)}
              >
                {prompt}
              </button>
            ))}
          </div>
        )}
      </div>
    </section>
  );
};

export default ChatPanel;
