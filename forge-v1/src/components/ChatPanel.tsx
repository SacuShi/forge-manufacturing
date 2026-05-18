/**
 * FORGE v1.0 — ChatPanel component
 *
 * Right-edge slide-in AI advisor panel (340px when open, 0 when closed).
 * Width transition handled purely by CSS (.chat-panel / .chat-panel.open).
 *
 * Features:
 *   - Quick prompt chips (fill the input for editing before sending)
 *   - Thinking indicator (pulsing spinner while waiting for AI)
 *   - [[Name|typeId]] token parsing → clickable ItemLink elements
 *   - Chat history persistence (clear button with confirm dialog)
 *   - Enter sends; Shift+Enter inserts newline
 *
 * Security: no dangerouslySetInnerHTML — tokens parsed via regex + React nodes.
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
import ItemLink from './ItemLink';

// ── Types ────────────────────────────────────────────────────────────────────

interface ChatPanelProps {
  open: boolean;
  messages: ChatMessage[];
  thinking: boolean;
  quickPrompts: string[];
  onSend: (text: string) => void;
  onItemSelect: (typeId: number) => void;
  onClearHistory?: () => void;
}

// ── Token parser ─────────────────────────────────────────────────────────────

/**
 * Parses [[Name|typeId]] tokens in assistant messages into ItemLink elements.
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

  if (lastIndex < content.length) {
    nodes.push(content.slice(lastIndex));
  }

  return nodes;
}

// ── Component ────────────────────────────────────────────────────────────────

const ChatPanel: FC<ChatPanelProps> = ({
  open,
  messages,
  thinking,
  quickPrompts,
  onSend,
  onItemSelect,
  onClearHistory,
}) => {
  const [draft, setDraft] = useState('');
  const messagesEndRef    = useRef<HTMLDivElement>(null);
  const textareaRef       = useRef<HTMLTextAreaElement>(null);

  /* Auto-scroll to the bottom whenever messages/thinking changes */
  useEffect(() => {
    setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 60);
  }, [messages, thinking]);

  /* Focus textarea when panel opens */
  useEffect(() => {
    if (open) {
      const t = setTimeout(() => textareaRef.current?.focus(), 260);
      return () => clearTimeout(t);
    }
  }, [open]);

  /* ── Handlers ──────────────────────────────────────────────────────────── */

  const handleSend = () => {
    const text = draft.trim();
    if (!text || thinking) return;
    onSend(text);
    setDraft('');
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  /** Quick prompt: fill the input (so user can edit before sending) */
  const handleQuickPrompt = (prompt: string) => {
    setDraft(prompt);
    textareaRef.current?.focus();
  };

  const handleClear = () => {
    if (!onClearHistory) return;
    if (window.confirm('Clear all chat history? This cannot be undone.')) {
      onClearHistory();
    }
  };

  /* Whether to show chips (before user sends any message) */
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
          <div className="chat-subtitle">
            <span className="backronym-letter">F</span>abrication,{' '}
            <span className="backronym-letter">O</span>perations,{' '}
            <span className="backronym-letter">R</span>esource &amp;{' '}
            <span className="backronym-letter">G</span>uidance{' '}
            <span className="backronym-letter">E</span>ngine
          </div>
        </div>
        {onClearHistory && (
          <button
            type="button"
            className="chat-clear-btn"
            onClick={handleClear}
            aria-label="Clear chat history"
          >
            CLEAR
          </button>
        )}
      </div>

      {/* ── Message list ──────────────────────────────────────────────────── */}
      <div
        className="chat-messages"
        role="log"
        aria-live="polite"
        aria-label="Conversation history"
        aria-atomic="false"
      >
        {messages.map((msg, i) => (
          <div key={msg.id ?? i} className="msg">
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

        {/* Thinking indicator */}
        {thinking && (
          <div className="msg">
            <div className="msg-label">F.O.R.G.E.</div>
            <div className="msg-assistant" style={{ color: 'var(--color-text-tertiary)' }}>
              <span className="spin" style={{ display: 'inline-block', marginRight: 6 }}>◈</span>
              Thinking…
            </div>
          </div>
        )}

        {/* Scroll anchor */}
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
            disabled={thinking}
          />
          <button
            type="button"
            className="chat-send-btn"
            onClick={handleSend}
            disabled={!draft.trim() || thinking}
            aria-label="Send message"
          >
            Send
          </button>
        </div>

        {/* Quick prompt chips */}
        {showChips && (
          <div className="quick-prompts" aria-label="Suggested questions">
            {quickPrompts.map((prompt) => (
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
