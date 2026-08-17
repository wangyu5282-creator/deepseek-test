import { useEffect, useRef, useState } from 'react';
import './App.css';
import { loadConversations, saveConversations, createConversation } from './storage';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const PASSWORD_STORAGE_KEY = 'deepseek-chat-password';
const MODELS = [
  { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
  { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
];
const EFFORTS = [
  { id: 'low', label: '推理强度：低（更快）' },
  { id: 'high', label: '推理强度：高' },
  { id: 'max', label: '推理强度：最高（更慢）' },
];

function App() {
  const [password, setPassword] = useState(() => sessionStorage.getItem(PASSWORD_STORAGE_KEY) || '');
  const [unlocked, setUnlocked] = useState(false);
  const [loginInput, setLoginInput] = useState('');
  const [loginError, setLoginError] = useState('');
  const [loggingIn, setLoggingIn] = useState(false);

  const [conversations, setConversations] = useState(() => {
    const loaded = loadConversations();
    return loaded.length ? loaded : [createConversation()];
  });
  const [activeId, setActiveId] = useState(() => conversations[0].id);
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [lastContentTtft, setLastContentTtft] = useState(null);
  const [lastCommentaryTtft, setLastCommentaryTtft] = useState(null);
  const [lastSearchTtft, setLastSearchTtft] = useState(null);
  const abortRef = useRef(null);
  const bottomRef = useRef(null);

  const active = conversations.find((c) => c.id === activeId) || conversations[0];

  useEffect(() => {
    if (!password) return;
    verifyPassword(password).then((ok) => {
      if (ok) {
        setUnlocked(true);
      } else {
        sessionStorage.removeItem(PASSWORD_STORAGE_KEY);
        setPassword('');
      }
    });
  }, [password]);

  useEffect(() => {
    saveConversations(conversations);
  }, [conversations]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [active?.messages?.length]);

  function updateActive(updater) {
    setConversations((prev) =>
      prev.map((c) => (c.id === activeId ? updater(c) : c))
    );
  }

  async function verifyPassword(pwd) {
    try {
      const res = await fetch(`${API_BASE}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pwd }),
      });
      if (!res.ok) return false;
      const data = await res.json();
      return !!data.ok;
    } catch {
      return false;
    }
  }

  async function handleLogin(e) {
    e.preventDefault();
    setLoggingIn(true);
    setLoginError('');
    const ok = await verifyPassword(loginInput);
    setLoggingIn(false);
    if (ok) {
      sessionStorage.setItem(PASSWORD_STORAGE_KEY, loginInput);
      setPassword(loginInput);
      setUnlocked(true);
    } else {
      setLoginError('口令错误，请重新输入');
    }
  }

  function handleNewConversation() {
    const conv = createConversation();
    setConversations((prev) => [conv, ...prev]);
    setActiveId(conv.id);
    setLastContentTtft(null);
    setLastCommentaryTtft(null);
    setLastSearchTtft(null);
  }

  function handleDeleteConversation(id) {
    setConversations((prev) => {
      const next = prev.filter((c) => c.id !== id);
      if (next.length === 0) {
        const fresh = createConversation();
        setActiveId(fresh.id);
        return [fresh];
      }
      if (id === activeId) setActiveId(next[0].id);
      return next;
    });
  }

  function handleModelChange(model) {
    updateActive((c) => ({ ...c, model }));
  }

  function handleWebSearchToggle() {
    updateActive((c) => ({ ...c, webSearch: !c.webSearch }));
  }

  function handleEffortChange(reasoningEffort) {
    updateActive((c) => ({ ...c, reasoningEffort }));
  }

  async function handleSend() {
    const text = input.trim();
    if (!text || isStreaming || !active) return;

    const conversationId = active.id;
    const model = active.model;
    const webSearch = active.webSearch;
    const reasoningEffort = active.reasoningEffort || 'low';
    const requestMessages = [...active.messages, { role: 'user', content: text }];
    const newTitle = active.messages.length === 0 ? text.slice(0, 24) : active.title;

    const userMessage = { role: 'user', content: text };
    const assistantMessage = {
      role: 'assistant',
      content: '',
      contentTtftMs: null,
      commentaryTtftMs: null,
      searchTtftMs: null,
      searching: false,
      sources: [],
      searchQueries: [],
    };

    setConversations((prev) =>
      prev.map((c) =>
        c.id === conversationId
          ? { ...c, messages: [...c.messages, userMessage, assistantMessage], title: newTitle }
          : c
      )
    );
    setInput('');
    setIsStreaming(true);
    setLastContentTtft(null);
    setLastCommentaryTtft(null);
    setLastSearchTtft(null);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch(`${API_BASE}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(password ? { 'X-Access-Password': password } : {}),
        },
        body: JSON.stringify({
          messages: requestMessages,
          model,
          webSearch,
          reasoningEffort,
        }),
        signal: controller.signal,
      });

      if (response.status === 401) {
        sessionStorage.removeItem(PASSWORD_STORAGE_KEY);
        setPassword('');
        setUnlocked(false);
        throw new Error('登录已失效，请重新输入口令');
      }

      if (!response.ok || !response.body) {
        throw new Error(`请求失败: ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const events = buffer.split('\n\n');
        buffer = events.pop() ?? '';

        for (const chunk of events) {
          if (!chunk.trim()) continue;
          const lines = chunk.split('\n');
          let eventType = 'message';
          let dataStr = '';
          for (const line of lines) {
            if (line.startsWith('event: ')) eventType = line.slice(7).trim();
            else if (line.startsWith('data: ')) dataStr += line.slice(6);
          }
          if (!dataStr) continue;
          const data = JSON.parse(dataStr);
          applyStreamEvent(eventType, data);
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        updateActive((c) => {
          const lastIndex = c.messages.length - 1;
          const last = c.messages[lastIndex];
          if (!last || last.role !== 'assistant') return c;
          const messages = [...c.messages];
          messages[lastIndex] = { ...last, content: `出错了：${err.message}` };
          return { ...c, messages };
        });
      }
    } finally {
      setIsStreaming(false);
      abortRef.current = null;
    }
  }

  function applyStreamEvent(eventType, data) {
    if (eventType === 'content_ttft') {
      setLastContentTtft(data.ms);
    } else if (eventType === 'commentary_ttft') {
      setLastCommentaryTtft(data.ms);
    } else if (eventType === 'search_ttft') {
      setLastSearchTtft(data.ms);
    }
    updateActive((c) => {
      const lastIndex = c.messages.length - 1;
      const last = c.messages[lastIndex];
      if (!last || last.role !== 'assistant') return c;

      let updated = last;
      if (eventType === 'content_ttft') {
        updated = { ...last, contentTtftMs: data.ms };
      } else if (eventType === 'commentary_ttft') {
        updated = { ...last, commentaryTtftMs: data.ms };
      } else if (eventType === 'search_ttft') {
        updated = { ...last, searchTtftMs: data.ms };
      } else if (eventType === 'search') {
        updated = { ...last, searching: data.status !== 'completed' };
      } else if (eventType === 'source') {
        updated = { ...last, sources: [...(last.sources || []), data] };
      } else if (eventType === 'query') {
        updated = { ...last, searchQueries: [...(last.searchQueries || []), ...data.queries] };
      } else if (eventType === 'delta') {
        updated = { ...last, content: last.content + data.text };
      } else if (eventType === 'done') {
        updated = { ...last, searching: false, usage: data.usage, sources: data.sources?.length ? data.sources : last.sources };
      } else if (eventType === 'error') {
        updated = { ...last, content: last.content + `\n[错误] ${data.message}`, searching: false };
      } else {
        return c;
      }

      const messages = [...c.messages];
      messages[lastIndex] = updated;
      return { ...c, messages };
    });
  }

  function handleStop() {
    abortRef.current?.abort();
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  if (!unlocked) {
    return (
      <div className="login-screen">
        <form className="login-box" onSubmit={handleLogin}>
          <h1>访问口令</h1>
          <input
            type="password"
            value={loginInput}
            onChange={(e) => setLoginInput(e.target.value)}
            placeholder="请输入访问口令"
            autoFocus
          />
          {loginError && <div className="login-error">{loginError}</div>}
          <button type="submit" disabled={loggingIn || !loginInput.trim()}>
            {loggingIn ? '验证中…' : '进入'}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <button className="new-chat-btn" onClick={handleNewConversation}>
          + 新建对话
        </button>
        <ul className="conversation-list">
          {conversations.map((c) => (
            <li
              key={c.id}
              className={c.id === activeId ? 'active' : ''}
              onClick={() => setActiveId(c.id)}
            >
              <span className="conv-title">{c.title || '新对话'}</span>
              <button
                className="delete-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  handleDeleteConversation(c.id);
                }}
                aria-label="删除对话"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <main className="main">
        <header className="topbar">
          <select
            value={active.model}
            onChange={(e) => handleModelChange(e.target.value)}
          >
            {MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>

          <label className="web-search-toggle">
            <input
              type="checkbox"
              checked={active.webSearch}
              onChange={handleWebSearchToggle}
            />
            联网搜索
          </label>

          <select
            value={active.reasoningEffort || 'low'}
            onChange={(e) => handleEffortChange(e.target.value)}
            title="推理强度越高，回答质量可能更好，但联网搜索+高强度推理会明显更慢"
          >
            {EFFORTS.map((e) => (
              <option key={e.id} value={e.id}>
                {e.label}
              </option>
            ))}
          </select>

          {lastSearchTtft !== null && (
            <span className="ttft-badge">搜索 TTFT: {lastSearchTtft} ms</span>
          )}
          {lastCommentaryTtft !== null && (
            <span className="ttft-badge">旁白 TTFT: {lastCommentaryTtft} ms</span>
          )}
          {lastContentTtft !== null && (
            <span className="ttft-badge">正文 TTFT: {lastContentTtft} ms</span>
          )}
        </header>

        <div className="messages">
          {active.messages.length === 0 && (
            <div className="empty-hint">开始一个新对话吧</div>
          )}
          {active.messages.map((m, idx) => (
            <div key={idx} className={`message ${m.role}`}>
              <div className="message-role">{m.role === 'user' ? '你' : 'DeepSeek'}</div>
              <div className="message-content">
                {m.searching && <div className="searching-indicator">正在联网搜索...</div>}
                {m.content || (isStreaming && idx === active.messages.length - 1 ? '思考中…' : '')}
              </div>
              {m.role === 'assistant' && m.searchQueries?.length > 0 && (
                <div className="message-queries">
                  <div className="queries-label">检索词</div>
                  <ul>
                    {m.searchQueries.map((q, i) => (
                      <li key={i}>{q}</li>
                    ))}
                  </ul>
                </div>
              )}
              {m.role === 'assistant' && m.sources?.length > 0 && (
                <div className="message-sources">
                  <div className="sources-label">信息来源</div>
                  <ol>
                    {m.sources.map((s, i) => (
                      <li key={i}>
                        <a href={s.url} target="_blank" rel="noopener noreferrer">
                          {s.url}
                        </a>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
              {m.role === 'assistant' &&
                (m.searchTtftMs != null || m.commentaryTtftMs != null || m.contentTtftMs != null) && (
                  <div className="message-meta">
                    {[
                      m.searchTtftMs != null ? `搜索 TTFT: ${m.searchTtftMs} ms` : null,
                      m.commentaryTtftMs != null ? `旁白 TTFT: ${m.commentaryTtftMs} ms` : null,
                      m.contentTtftMs != null ? `正文 TTFT: ${m.contentTtftMs} ms` : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                )}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>

        <footer className="composer">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="输入消息，Enter 发送，Shift+Enter 换行"
            rows={2}
            disabled={isStreaming}
          />
          {isStreaming ? (
            <button className="stop-btn" onClick={handleStop}>
              停止
            </button>
          ) : (
            <button className="send-btn" onClick={handleSend} disabled={!input.trim()}>
              发送
            </button>
          )}
        </footer>
      </main>
    </div>
  );
}

export default App;
