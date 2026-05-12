/**
 * FORGE v1.0 — App root component
 *
 * Owns all shared application state and wires the full three-column layout:
 *
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │                         Header                              │
 *   ├──────────────┬──────────────────────┬──────────┬────────────┤
 *   │  LeftSidebar │    MainContent       │ RightSide│ ChatPanel  │
 *   │  (char info, │  (tabs + ItemTable)  │  (item   │ (AI advisor│
 *   │  jobs, quick │                      │  detail) │  slide-in) │
 *   │  prompts)    │                      │          │            │
 *   └──────────────┴──────────────────────┴──────────┴────────────┘
 *
 * State:
 *   chatOpen       — whether the AI advisor panel is visible
 *   selectedTypeId — currently highlighted item (null = nothing selected)
 *   chatMessages   — full message history (user + assistant)
 *
 * Message flow:
 *   Quick prompt click (LeftSidebar) →  handleSendMessage
 *   Send button / Enter (ChatPanel)  →  handleSendMessage
 *   Both paths append a user msg + stub assistant reply and open the panel.
 *
 *   In v1.1 the stub assistant reply will be replaced with a live
 *   POST /api/chat call to the FORGE backend.
 */

import { useState, type FC } from 'react';
import type { ChatMessage } from './types';
import {
  MOCK_CHARACTER,
  MOCK_ITEMS,
  MOCK_CHAT_MESSAGES,
  getMockDetail,
} from './data/mockData';

import Header       from './components/Header';
import LeftSidebar  from './components/LeftSidebar';
import MainContent  from './components/MainContent';
import RightSidebar from './components/RightSidebar';
import ChatPanel    from './components/ChatPanel';

// ── Component ────────────────────────────────────────────────────────────────

const App: FC = () => {
  /* ── State ─────────────────────────────────────────────────────────────── */

  const [chatOpen,       setChatOpen]       = useState(false);
  const [selectedTypeId, setSelectedTypeId] = useState<number | null>(null);
  const [chatMessages,   setChatMessages]   = useState<ChatMessage[]>(MOCK_CHAT_MESSAGES);

  /* ── Derived data ───────────────────────────────────────────────────────── */

  const selectedDetail = selectedTypeId ? getMockDetail(selectedTypeId) : null;

  /* ── Handlers ───────────────────────────────────────────────────────────── */

  const handleToggleChat = () => setChatOpen((prev) => !prev);

  /**
   * Toggle-select: clicking the same row again deselects it.
   * Also triggered when the user clicks an ItemLink inside a chat message.
   */
  const handleItemSelect = (typeId: number) => {
    setSelectedTypeId((prev) => (prev === typeId ? null : typeId));
  };

  /**
   * Appends a user message + stub assistant reply, then opens the chat panel.
   *
   * Date.now() + 1 ensures the assistant ID is always distinct from
   * the user ID even if both are created in the same millisecond.
   *
   * The stub reply will be replaced with a live API call in v1.1.
   */
  const handleSendMessage = (text: string) => {
    const now = Date.now();

    const userMsg: ChatMessage = {
      id:        `user-${now}`,
      role:      'user',
      content:   text,
      timestamp: new Date(now),
    };

    const assistantMsg: ChatMessage = {
      id:        `assist-${now + 1}`,
      role:      'assistant',
      content:   'This is a demo build — live AI responses will be available when the FORGE backend is connected.',
      timestamp: new Date(now + 1),
    };

    setChatMessages((prev) => [...prev, userMsg, assistantMsg]);
    setChatOpen(true);
  };

  /* ── Render ─────────────────────────────────────────────────────────────── */

  return (
    <div className="app">
      <Header
        character={MOCK_CHARACTER}
        chatOpen={chatOpen}
        onToggleChat={handleToggleChat}
      />

      <div className="app-body">
        <LeftSidebar
          character={MOCK_CHARACTER}
          onQuickPrompt={handleSendMessage}
        />

        <MainContent
          items={MOCK_ITEMS}
          selectedTypeId={selectedTypeId}
          onSelect={handleItemSelect}
        />

        <RightSidebar detail={selectedDetail} />

        <ChatPanel
          open={chatOpen}
          messages={chatMessages}
          onSend={handleSendMessage}
          onItemSelect={handleItemSelect}
        />
      </div>
    </div>
  );
};

export default App;
