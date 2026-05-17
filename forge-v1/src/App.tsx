// FORGE v1.0 — App root. Auth states: idle/exchanging/loading → authed | error

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

function mapToMarketItems(
  results: TopProfitableResponse['results'],
  esiBlueprints: Array<{ type_id: number; quantity: number; runs: number }>
): MarketItem[] {
  // Map type_id → owned status.
  // ESI: BPO = runs === -1; BPC singleton = quantity === -1 but runs > 0; BPC stack = quantity > 0
  const bpMap = new Map<number, 'BPO' | 'BPC'>();
  esiBlueprints.forEach((bp) => {
    const isBpo = bp.runs === -1;
    // BPO wins if any copy is an original (don't downgrade BPO → BPC)
    if (isBpo || !bpMap.has(bp.type_id)) {
      bpMap.set(bp.type_id, isBpo ? 'BPO' : 'BPC');
    }
  });

  return results.map((item, index) => {
    const owned = bpMap.get(item.blueprint_id) ?? '—';

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

const App: FC = () => {
  const auth = useAuth();
  const { names: itemNames } = useItemNames();

  const [theme, setTheme] = useState<string>(
    () => localStorage.getItem('forge-theme') ?? 'dark'
  );
  const [activeTab, setActiveTab] = useState('market');
  const [chatOpen, setChatOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [selectedTypeId, setSelectedTypeId] = useState<number | null>(null);
  const [selectedName, setSelectedName] = useState('');
  const [thinking, setThinking] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  // Navigation stack — allows ← Back through chain drill-downs
  const [panelHistory, setPanelHistory] = useState<Array<{ typeId: number; name: string }>>([]);

  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [marketItems, setMarketItems] = useState<MarketItem[]>([]);
  const [rawResults, setRawResults] = useState<TopProfitableResponse['results']>([]);
  const [marketLoading, setMarketLoading] = useState(false);
  const [marketError, setMarketError] = useState<string | null>(null);

  const {
    detail: apiDetail,
    loading: detailLoading,
    error: detailError,
  } = useItemDetail(selectedTypeId, auth.assets, auth.blueprints, auth.token);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('forge-theme', theme);
  }, [theme]);

  useEffect(() => {
    if (auth.status !== 'authed') return;

    setMarketLoading(true);
    // Use skills-filtered endpoint: shows only blueprints user can build based on trained skills
    apiGet<TopProfitableResponse>('/api/top-profitable-by-skills?limit=50', auth.token ?? '')
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

  const selectedDetail: ItemDetail | null = (() => {
    if (!selectedTypeId) return null;
    const raw = rawResults.find((r) => r.product_id === selectedTypeId);
    if (!raw) return null;
    const mi = marketItems.find((m) => m.typeId === selectedTypeId);
    return toItemDetail(raw, mi?.owned ?? '—');
  })();

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
    // Push the currently displayed item onto the back-stack before navigating
    setSelectedTypeId((prev) => {
      if (prev !== null) {
        setSelectedName((prevName) => {
          setPanelHistory((h) => [...h, { typeId: prev, name: prevName }]);
          return name;
        });
      } else {
        setSelectedName(name);
      }
      return typeId;
    });
    setDetailOpen(true);
  }, []);

  const handlePanelBack = useCallback(() => {
    setPanelHistory((h) => {
      if (h.length === 0) return h;
      const prev = h[h.length - 1];
      setSelectedTypeId(prev.typeId);
      setSelectedName(prev.name);
      return h.slice(0, -1);
    });
  }, []);

  const handleCloseDetail = useCallback(() => {
    setSelectedTypeId(null);
    setSelectedName('');
    setDetailOpen(false);
    setPanelHistory([]);   // clear back-stack on explicit close
  }, []);

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

    if (auth.character && auth.token) {
      apiPost('/api/save-message', {
        characterId:    auth.character.characterId,
        role:           'user',
        content:        text,
        conversationId: 'default',
      }, auth.token).catch(() => {});
    }

    try {
      const history = [...chatMessages.slice(-10), userMsg].map((m) => ({
        role: m.role as 'user' | 'assistant',
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
          onBack={handlePanelBack}
          canGoBack={panelHistory.length > 0}
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
