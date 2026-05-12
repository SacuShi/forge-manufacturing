/**
 * FORGE v1.0 — App root component
 *
 * Owns all shared application state and coordinates the full layout.
 *
 * Auth states:
 *   idle       → LoginScreen
 *   exchanging → LoadingScreen ("Verifying login with EVE…")
 *   loading    → LoadingScreen (step-by-step data load)
 *   authed     → Full three-column dashboard
 *   error      → LoginScreen with error message
 *
 * Data flow:
 *   1. useAuth loads token + character data from ESI
 *   2. useEffect fetches /api/top-profitable once authenticated
 *   3. Market items are mapped from TopProfitableItem → MarketItem,
 *      with ownership status derived by comparing blueprint_id against
 *      the user's ESI blueprint list
 *   4. Item detail for the right panel is derived from the same
 *      top-profitable data (already in memory — no extra fetch)
 *   5. AI chat calls POST /api/ai-chat with the EVE token
 */

import { useState, useEffect, useCallback, type FC } from 'react';
import type { ChatMessage, MarketItem, ItemDetail, TopProfitableResponse } from './types';
import { useAuth } from './hooks/useAuth';
import { apiGet } from './api/client';
import { formatBuildTime } from './utils/format';
import { QUICK_PROMPTS } from './data/mockData';

import Header        from './components/Header';
import LeftSidebar   from './components/LeftSidebar';
import MainContent   from './components/MainContent';
import RightSidebar  from './components/RightSidebar';
import ChatPanel     from './components/ChatPanel';
import LoginScreen   from './components/LoginScreen';
import LoadingScreen from './components/LoadingScreen';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Maps the /api/top-profitable results to the UI MarketItem shape.
 * Ownership is determined by checking whether the item's blueprint_id
 * appears in the user's ESI blueprint list.
 *   quantity === -1  → BPO
 *   quantity > 0     → BPC
 *   not present      → '—'
 */
function mapToMarketItems(
  results: TopProfitableResponse['results'],
  esiBlueprints: Array<{ type_id: number; quantity: number }>
): MarketItem[] {
  // Build a lookup map for O(1) access
  const bpMap = new Map<number, number>(); // type_id → quantity
  esiBlueprints.forEach((bp) => bpMap.set(bp.type_id, bp.quantity));

  return results.map((item, index) => {
    const bpQty = bpMap.get(item.blueprint_id);
    const owned =
      bpQty === undefined ? '—' :
      bpQty === -1        ? 'BPO' :
                            'BPC';

    const buildTimeSecs = item.build_time ?? 0;

    return {
      rank:             index + 1,
      typeId:           item.product_id,
      name:             item.product_name,
      category:         '',            // Not returned by this endpoint; v1.1 will add it
      profitPerRun:     item.profit,
      margin:           item.profit_margin,
      iskPerHour:       item.isk_per_hour,
      buildTime:        formatBuildTime(buildTimeSecs),
      buildTimeMinutes: Math.round(buildTimeSecs / 60),
      owned,
      canBuild:         owned !== '—',
    };
  });
}

/**
 * Derives an ItemDetail from an already-loaded TopProfitableItem.
 * No additional fetch required — all the data we need is already in memory.
 */
function toItemDetail(
  item: TopProfitableResponse['results'][number],
  owned: MarketItem['owned']
): ItemDetail {
  return {
    typeId:       item.product_id,
    name:         item.product_name,
    category:     '',
    owned,
    profitPerRun: item.profit,
    margin:       item.profit_margin,
    iskPerHour:   item.isk_per_hour,
    buildTime:    formatBuildTime(item.build_time ?? 0),
    sellPrice:    item.sell_price,
    matCost:      item.material_cost,
    materials:    [],   // Material breakdown requires a separate /api/item-details call (v1.1)
  };
}

// ── Component ────────────────────────────────────────────────────────────────

const App: FC = () => {
  const auth = useAuth();

  /* ── Dashboard state ────────────────────────────────────────────────────── */
  const [chatOpen,       setChatOpen]       = useState(false);
  const [selectedTypeId, setSelectedTypeId] = useState<number | null>(null);
  const [chatMessages,   setChatMessages]   = useState<ChatMessage[]>([]);
  const [marketItems,    setMarketItems]    = useState<MarketItem[]>([]);
  const [rawResults,     setRawResults]     = useState<TopProfitableResponse['results']>([]);
  const [marketLoading,  setMarketLoading]  = useState(false);
  const [marketError,    setMarketError]    = useState<string | null>(null);

  /* ── Load market data once authenticated ────────────────────────────────── */
  useEffect(() => {
    if (auth.status !== 'authed') return;

    setMarketLoading(true);
    apiGet<TopProfitableResponse>('/api/top-profitable?limit=50')
      .then((data) => {
        setRawResults(data.results);
        setMarketItems(mapToMarketItems(data.results, auth.blueprints));

        // Welcome message once data is ready
        const lastComputed = data.meta.lastComputed
          ? new Date(data.meta.lastComputed).toLocaleTimeString()
          : 'recently';

        setChatMessages([{
          id:        'welcome',
          role:      'assistant',
          content:   `Welcome back, ${auth.character?.name}. ` +
                     `Your wallet is at ${(( auth.character?.walletISK ?? 0) / 1e9).toFixed(2)}B ISK ` +
                     `with ${auth.character?.activeJobCount ?? 0} active jobs.\n\n` +
                     `Market data last updated ${lastComputed}. ` +
                     `${data.results.length} profitable opportunities found.`,
          timestamp: new Date(),
        }]);
      })
      .catch((e: Error) => setMarketError(e.message))
      .finally(() => setMarketLoading(false));
  }, [auth.status, auth.blueprints, auth.character]);

  /* ── Derived: item detail from selected row ─────────────────────────────── */
  const selectedDetail: ItemDetail | null = (() => {
    if (!selectedTypeId) return null;
    const raw = rawResults.find((r) => r.product_id === selectedTypeId);
    if (!raw) return null;
    const marketItem = marketItems.find((m) => m.typeId === selectedTypeId);
    return toItemDetail(raw, marketItem?.owned ?? '—');
  })();

  /* ── Handlers ───────────────────────────────────────────────────────────── */

  const handleToggleChat = () => setChatOpen((p) => !p);

  const handleItemSelect = (typeId: number) => {
    setSelectedTypeId((p) => (p === typeId ? null : typeId));
  };

  /**
   * Sends a message to the AI backend (POST /api/ai-chat).
   * Falls back to a friendly error message if the call fails.
   */
  const handleSendMessage = useCallback(async (text: string) => {
    const now = Date.now();

    const userMsg: ChatMessage = {
      id:        `user-${now}`,
      role:      'user',
      content:   text,
      timestamp: new Date(now),
    };

    // Optimistically show the user message
    setChatMessages((prev) => [...prev, userMsg]);
    setChatOpen(true);

    try {
      // Build the message history for Anthropic (role alternation required)
      const history = [...chatMessages, userMsg].map((m) => ({
        role:    m.role as 'user' | 'assistant',
        content: m.content,
      }));

      const response = await fetch('/api/ai-chat', {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${auth.token ?? ''}`,
        },
        body: JSON.stringify({ messages: history }),
      });

      const data = await response.json() as {
        content?: Array<{ type: string; text?: string }>;
        error?:   string;
        code?:    string;
      };

      // Check for known error conditions
      if (!response.ok || data.error) {
        const msg = data.code === 'SESSION_EXPIRED'
          ? 'Session expired — please refresh the page to reconnect your character.'
          : (data.error ?? `Server error ${response.status}`);
        throw new Error(msg);
      }

      // Extract the assistant text from the Anthropic response
      const assistantText =
        data.content?.find((b) => b.type === 'text')?.text ??
        'No response received.';

      const assistantMsg: ChatMessage = {
        id:        `assist-${Date.now()}`,
        role:      'assistant',
        content:   assistantText,
        timestamp: new Date(),
      };

      setChatMessages((prev) => [...prev, assistantMsg]);

    } catch (e) {
      const errMsg: ChatMessage = {
        id:        `err-${Date.now()}`,
        role:      'assistant',
        content:   `Sorry, I couldn't process that: ${(e as Error).message}`,
        timestamp: new Date(),
      };
      setChatMessages((prev) => [...prev, errMsg]);
    }
  }, [auth.token, chatMessages]);

  /* ── Render: auth screens ───────────────────────────────────────────────── */

  if (auth.status === 'idle' || auth.status === 'error') {
    return (
      <div className="app" style={{ alignItems: 'center', justifyContent: 'center' }}>
        <LoginScreen onLogin={auth.login} error={auth.error} />
      </div>
    );
  }

  if (auth.status === 'exchanging' || auth.status === 'loading') {
    return (
      <div className="app" style={{ alignItems: 'center', justifyContent: 'center' }}>
        <LoadingScreen step={auth.loadStep} log={auth.dataLog} />
      </div>
    );
  }

  /* ── Render: dashboard ──────────────────────────────────────────────────── */

  const character = auth.character!;

  return (
    <div className="app">
      <Header
        character={character}
        chatOpen={chatOpen}
        onToggleChat={handleToggleChat}
        onLogout={auth.logout}
      />

      <div className="app-body">
        <LeftSidebar
          character={character}
          onQuickPrompt={handleSendMessage}
        />

        <MainContent
          items={marketItems}
          loading={marketLoading}
          error={marketError}
          selectedTypeId={selectedTypeId}
          onSelect={handleItemSelect}
        />

        <RightSidebar detail={selectedDetail} />

        <ChatPanel
          open={chatOpen}
          messages={chatMessages}
          quickPrompts={QUICK_PROMPTS}
          onSend={handleSendMessage}
          onItemSelect={handleItemSelect}
        />
      </div>
    </div>
  );
};

export default App;
