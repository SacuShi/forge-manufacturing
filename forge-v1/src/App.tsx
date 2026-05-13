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
 *   3. Market items mapped TopProfitableItem → MarketItem with ownership from ESI blueprints
 *   4. useItemDetail calls /api/item-details for the selected item
 *   5. useItemNames loads the full item name DB for Blueprints/Assets tabs
 *   6. AI chat calls POST /api/ai-chat; history is saved/loaded from server
 */

import { useState, useEffect, useCallback, type FC } from 'react';
import type {
  ChatMessage,
  MarketItem,
  ItemDetail,
  TopProfitableResponse,
  AiChatResponse,
} from './types';
import { useAuth }       from './hooks/useAuth';
import { useItemDetail } from './hooks/useItemDetail';
import { useItemNames }  from './hooks/useItemNames';
import { apiGet, apiPost } from './api/client';
import { formatBuildTime }  from './utils/format';
import { QUICK_PROMPTS }    from './data/mockData';

import Header        from './components/Header';
import LeftSidebar   from './components/LeftSidebar';
import MainContent   from './components/MainContent';
import RightSidebar  from './components/RightSidebar';
import ChatPanel     from './components/ChatPanel';
import LoginScreen   from './components/LoginScreen';
import LoadingScreen from './components/LoadingScreen';

// ── Helpers ──────────────────────────────────────────────────────────────────

function mapToMarketItems(
  results: TopProfitableResponse['results'],
  esiBlueprints: Array<{ type_id: number; quantity: number }>
): MarketItem[] {
  const bpMap = new Map<number, number>();
  esiBlueprints.forEach((bp) => bpMap.set(bp.type_id, bp.quantity));

  return results.map((item, index) => {
    const bpQty = bpMap.get(item.blueprint_id);
    const owned =
      bpQty === undefined ? '—' :
      bpQty === -1        ? 'BPO' :
                            'BPC';

    return {
      rank:             index + 1,
      typeId:           item.product_id,
      name:             item.product_name,
      category:         '',
      profitPerRun:     item.profit,
      margin:           item.profit_margin,
      iskPerHour:       item.isk_per_hour,
      buildTime:        formatBuildTime(item.build_time ?? 0),
      buildTimeMinutes: Math.round((item.build_time ?? 0) / 60),
      owned,
      canBuild:         owned !== '—',
    } as MarketItem;
  });
}

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
    materials:    [],
  };
}

// ── Component ────────────────────────────────────────────────────────────────

const App: FC = () => {
  const auth = useAuth();

  // ── New feature hooks ──────────────────────────────────────────────────────
  const { names: itemNames }  = useItemNames();

  // ── UI state ───────────────────────────────────────────────────────────────
  const [theme, setTheme] = useState<string>(
    () => localStorage.getItem('forge-theme') ?? 'dark'
  );
  const [activeTab,      setActiveTab]      = useState('market');
  const [chatOpen,       setChatOpen]       = useState(false);
  const [detailOpen,     setDetailOpen]     = useState(false);
  const [drawerOpen,     setDrawerOpen]     = useState(false);
  const [selectedTypeId, setSelectedTypeId] = useState<number | null>(null);
  const [selectedName,   setSelectedName]   = useState('');
  const [thinking,       setThinking]       = useState(false);
  const [historyLoaded,  setHistoryLoaded]  = useState(false);

  // ── Market data ────────────────────────────────────────────────────────────
  const [chatMessages,  setChatMessages]  = useState<ChatMessage[]>([]);
  const [marketItems,   setMarketItems]   = useState<MarketItem[]>([]);
  const [rawResults,    setRawResults]    = useState<TopProfitableResponse['results']>([]);
  const [marketLoading, setMarketLoading] = useState(false);
  const [marketError,   setMarketError]   = useState<string | null>(null);

  // ── Item detail from /api/item-details ────────────────────────────────────
  const {
    detail:  apiDetail,
    loading: detailLoading,
    error:   detailError,
  } = useItemDetail(selectedTypeId, auth.assets, auth.blueprints, auth.token);

  // ── Theme persist ─────────────────────────────────────────────────────────
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('forge-theme', theme);
  }, [theme]);

  // ── Load market data once authenticated ───────────────────────────────────
  useEffect(() => {
    if (auth.status !== 'authed') return;

    setMarketLoading(true);
    apiGet<TopProfitableResponse>('/api/top-profitable?limit=50')
      .then((data) => {
        setRawResults(data.results);
        setMarketItems(mapToMarketItems(data.results, auth.blueprints));

        const lastComputed = data.meta.lastComputed
          ? new Date(data.meta.lastComputed).toLocaleTimeString()
          : 'recently';

        // Only set welcome message if no history loaded yet
        setChatMessages((prev) => prev.length === 0 ? [{
          role:    'assistant',
          content: `Welcome back, ${auth.character?.name}. ` +
                   `Your wallet is at ${((auth.character?.walletISK ?? 0) / 1e9).toFixed(2)}B ISK ` +
                   `with ${auth.character?.activeJobCount ?? 0} active jobs.\n\n` +
                   `Market data last updated ${lastComputed}. ` +
                   `${data.results.length} profitable opportunities found.`,
        }] : prev);
      })
      .catch((e: Error) => setMarketError(e.message))
      .finally(() => setMarketLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.status]);

  // ── Load chat history once authenticated ──────────────────────────────────
  useEffect(() => {
    if (auth.status !== 'authed' || !auth.token || !auth.character || historyLoaded) return;

    const cid = auth.character.characterId;
    apiGet<Array<{ role: string; content: string }>>(
      `/api/chat-history/${cid}`,
      auth.token
    )
      .then((hist) => {
        if (hist.length > 1) {
          const limit   = 20;
          const limited = hist.length > limit ? hist.slice(-limit) : hist;
          const note    = hist.length > limit
            ? ` (Loaded last ${limit} of ${hist.length} messages)`
            : '';
          setChatMessages([
            {
              role:    'assistant',
              content: `Welcome back! Your previous conversation has been restored.${note}`,
            },
            ...limited.map((m) => ({
              role:    m.role as 'user' | 'assistant',
              content: m.content,
            })),
          ]);
          setHistoryLoaded(true);
        }
      })
      .catch(() => { /* history unavailable — not a fatal error */ });
  }, [auth.status, auth.character, auth.token, historyLoaded]);

  // ── Derived: item detail from selected row (fallback) ────────────────────
  const selectedDetail: ItemDetail | null = (() => {
    if (!selectedTypeId) return null;
    const raw = rawResults.find((r) => r.product_id === selectedTypeId);
    if (!raw) return null;
    const mi = marketItems.find((m) => m.typeId === selectedTypeId);
    return toItemDetail(raw, mi?.owned ?? '—');
  })();

  // ── Handlers ──────────────────────────────────────────────────────────────

  const handleToggleChat = () => setChatOpen((p) => !p);

  const handleItemSelect = useCallback((typeId: number) => {
    setSelectedTypeId((prev) => {
      if (prev === typeId) {
        setDetailOpen(false);
        setSelectedName('');
        return null;
      }
      setDetailOpen(true);
      return typeId;
    });
  }, []);

  const handleSelectItem = useCallback((typeId: number, name: string) => {
    setSelectedTypeId(typeId);
    setSelectedName(name);
    setDetailOpen(true);
  }, []);

  const handleCloseDetail = useCallback(() => {
    setSelectedTypeId(null);
    setSelectedName('');
    setDetailOpen(false);
  }, []);

  /** Send a message to the AI backend, persist both sides to the server. */
  const handleSendMessage = useCallback(async (text: string) => {
    const now    = Date.now();
    const userMsg: ChatMessage = {
      id:        `user-${now}`,
      role:      'user',
      content:   text,
      timestamp: new Date(now),
    };

    setChatMessages((prev) => [...prev, userMsg]);
    setChatOpen(true);
    setThinking(true);

    // Save user message to server (fire-and-forget)
    if (auth.character && auth.token) {
      apiPost('/api/save-message', {
        characterId:    auth.character.characterId,
        role:           'user',
        content:        text,
        conversationId: 'default',
      }, auth.token).catch(() => {});
    }

    try {
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

      const data = await response.json() as AiChatResponse;

      if (!response.ok || data.error) {
        const msg = data.code === 'SESSION_EXPIRED'
          ? 'Session expired — please refresh the page to reconnect your character.'
          : (data.error ?? `Server error ${response.status}`);
        throw new Error(msg);
      }

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

      // Save assistant message (fire-and-forget)
      if (auth.character && auth.token) {
        apiPost('/api/save-message', {
          characterId:    auth.character.characterId,
          role:           'assistant',
          content:        assistantText,
          conversationId: 'default',
        }, auth.token).catch(() => {});
      }

    } catch (e) {
      const errMsg: ChatMessage = {
        id:        `err-${Date.now()}`,
        role:      'assistant',
        content:   `Sorry, I couldn't process that: ${(e as Error).message}`,
        timestamp: new Date(),
      };
      setChatMessages((prev) => [...prev, errMsg]);
    }

    setThinking(false);
  }, [auth.token, auth.character, chatMessages]);

  /** Clear chat history on the server and reset local state. */
  const handleClearHistory = useCallback(async () => {
    if (!auth.character || !auth.token) return;
    try {
      const res = await fetch(`/api/chat-history/${auth.character.characterId}`, {
        method:  'DELETE',
        headers: { 'Authorization': `Bearer ${auth.token}` },
      });
      if (res.ok) {
        setChatMessages([]);
        setHistoryLoaded(false);
      }
    } catch {
      // ignore
    }
  }, [auth.character, auth.token]);

  // ── Render: auth screens ──────────────────────────────────────────────────

  if (auth.status === 'idle' || auth.status === 'error') {
    return (
      <div className="app" data-theme={theme} style={{ alignItems: 'center', justifyContent: 'center' }}>
        <LoginScreen onLogin={auth.login} error={auth.error} />
      </div>
    );
  }

  if (auth.status === 'exchanging' || auth.status === 'loading') {
    return (
      <div className="app" data-theme={theme} style={{ alignItems: 'center', justifyContent: 'center' }}>
        <LoadingScreen step={auth.loadStep} log={auth.dataLog} />
      </div>
    );
  }

  // ── Render: dashboard ─────────────────────────────────────────────────────

  const character = auth.character!;

  return (
    <div className="app" data-theme={theme}>
      <Header
        character={character}
        chatOpen={chatOpen}
        theme={theme}
        onToggleChat={handleToggleChat}
        onMenuToggle={() => setDrawerOpen((o) => !o)}
        onThemeToggle={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
        onLogout={auth.logout}
      />

      <div className="app-body">
        {/* Mobile drawer backdrop */}
        {drawerOpen && (
          <div
            className="sidebar-overlay"
            onClick={() => setDrawerOpen(false)}
            style={{ display: 'block' }}
          />
        )}

        <LeftSidebar
          character={character}
          blueprints={auth.blueprints}
          activeTab={activeTab}
          onTabChange={(tab) => {
            setActiveTab(tab);
            setDrawerOpen(false);
          }}
          drawerOpen={drawerOpen}
          onQuickPrompt={handleSendMessage}
        />

        <MainContent
          activeTab={activeTab}
          onTabChange={setActiveTab}
          marketItems={marketItems}
          marketLoading={marketLoading}
          marketError={marketError}
          blueprints={auth.blueprints}
          assets={auth.assets}
          activeJobs={character.activeJobs}
          itemNames={itemNames}
          selectedTypeId={selectedTypeId}
          onSelectItem={handleSelectItem}
          onMarketSelect={handleItemSelect}
        />

        {/* Tablet overlay (dims background when detail panel is open) */}
        <div
          className={`sidebar-overlay${detailOpen ? ' detail-open' : ''}`}
          onClick={handleCloseDetail}
        />

        <RightSidebar
          selectedTypeId={selectedTypeId}
          selectedName={selectedName}
          fallbackDetail={selectedDetail}
          apiDetail={apiDetail}
          detailLoading={detailLoading}
          detailError={detailError}
          detailOpen={detailOpen}
          blueprints={auth.blueprints}
          itemNames={itemNames}
          onClose={handleCloseDetail}
          onSelectItem={handleSelectItem}
        />

        <ChatPanel
          open={chatOpen}
          messages={chatMessages}
          thinking={thinking}
          quickPrompts={QUICK_PROMPTS}
          onSend={handleSendMessage}
          onItemSelect={handleItemSelect}
          onClearHistory={handleClearHistory}
        />
      </div>
    </div>
  );
};

export default App;
