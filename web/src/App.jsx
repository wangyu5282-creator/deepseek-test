import { useEffect, useRef, useState } from 'react';
import './App.css';
import { loadConversations, saveConversations, createConversation } from './storage';

const API_BASE = import.meta.env.VITE_API_BASE || (import.meta.env.MODE === 'production' ? '' : 'http://localhost:3001');
const MODELS = [
  { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
  { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
  { id: 'deepseek-v4-flash-vision-exp', label: 'DeepSeek V4 Flash Vision（多模态）' },
];
const VISION_MODEL = 'deepseek-v4-flash-vision-exp';
const EFFORTS = [
  { id: 'low', label: '推理强度：低（更快）' },
  { id: 'high', label: '推理强度：高' },
  { id: 'max', label: '推理强度：最高（更慢）' },
];

function App() {
  const [conversations, setConversations] = useState(() => {
    const loaded = loadConversations();
    return loaded.length ? loaded : [createConversation()];
  });
  const [activeId, setActiveId] = useState(() => conversations[0].id);
  const [input, setInput] = useState('');
  const [pendingImages, setPendingImages] = useState([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [lastContentTtft, setLastContentTtft] = useState(null);
  const [lastCommentaryTtft, setLastCommentaryTtft] = useState(null);
  const [lastSearchTtft, setLastSearchTtft] = useState(null);
  const [lastReasoningTtft, setLastReasoningTtft] = useState(null);
  const abortRef = useRef(null);
  const bottomRef = useRef(null);

  const active = conversations.find((c) => c.id === activeId) || conversations[0];

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

  function handleNewConversation() {
    const conv = createConversation();
    setConversations((prev) => [conv, ...prev]);
    setActiveId(conv.id);
    setLastContentTtft(null);
    setLastCommentaryTtft(null);
    setLastSearchTtft(null);
    setLastReasoningTtft(null);
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
    if ((!text && pendingImages.length === 0) || isStreaming || !active) return;

    const conversationId = active.id;
    const model = active.model;
    const webSearch = active.webSearch;
    const reasoningEffort = active.reasoningEffort || 'low';

    const images = pendingImages;
    const content =
      images.length > 0
        ? [
            ...(text ? [{ type: 'text', text }] : []),
            ...images.map((img) => ({ type: 'image', imageUrl: img.dataUrl })),
          ]
        : text;

    const requestMessages = [...active.messages, { role: 'user', content }];
    const newTitle = active.messages.length === 0 ? text.slice(0, 24) || '图片消息' : active.title;

    const userMessage = { role: 'user', content };
    const assistantMessage = {
      role: 'assistant',
      content: '',
      reasoning: '',
      contentTtftMs: null,
      commentaryTtftMs: null,
      searchTtftMs: null,
      reasoningTtftMs: null,
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
    setPendingImages([]);
    setIsStreaming(true);
    setLastContentTtft(null);
    setLastCommentaryTtft(null);
    setLastSearchTtft(null);
    setLastReasoningTtft(null);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch(`${API_BASE}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messages: requestMessages,
          model,
          webSearch,
          reasoningEffort,
        }),
        signal: controller.signal,
      });

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
    } else if (eventType === 'reasoning_ttft') {
      setLastReasoningTtft(data.ms);
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
      } else if (eventType === 'reasoning_ttft') {
        updated = { ...last, reasoningTtftMs: data.ms };
      } else if (eventType === 'search') {
        updated = { ...last, searching: data.status !== 'completed' };
      } else if (eventType === 'source') {
        updated = { ...last, sources: [...(last.sources || []), data] };
      } else if (eventType === 'query') {
        updated = { ...last, searchQueries: [...(last.searchQueries || []), ...data.queries] };
      } else if (eventType === 'reasoning_delta') {
        updated = { ...last, reasoning: (last.reasoning || '') + data.text };
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

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  const MAX_IMAGE_DIMENSION = 1280;

  function compressImage(file) {
    // GIF 用 canvas 重新编码会丢动画，直接跳过压缩
    if (file.type === 'image/gif') return fileToDataUrl(file);

    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.8));
        URL.revokeObjectURL(img.src);
      };
      img.onerror = reject;
      img.src = URL.createObjectURL(file);
    });
  }

  async function addImageFiles(files) {
    if (files.length === 0) return;
    const accepted = files.filter((f) => /^image\/(jpeg|png|gif|webp)$/.test(f.type));
    if (accepted.length < files.length) {
      alert('仅支持 JPEG/PNG/GIF/WebP 图片');
    }
    if (accepted.length === 0) return;
    const withDataUrls = await Promise.all(
      accepted.map(async (f) => ({ dataUrl: await compressImage(f), name: f.name || '粘贴的图片' }))
    );
    setPendingImages((prev) => [...prev, ...withDataUrls]);
  }

  function handleImageSelect(e) {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    addImageFiles(files);
  }

  function handleRemoveImage(index) {
    setPendingImages((prev) => prev.filter((_, i) => i !== index));
  }

  function handlePaste(e) {
    const files = Array.from(e.clipboardData?.items || [])
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter(Boolean);
    if (files.length === 0) return;
    e.preventDefault();
    addImageFiles(files);
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
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
          {lastReasoningTtft !== null && (
            <span className="ttft-badge">思考 TTFT: {lastReasoningTtft} ms</span>
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
              {m.role === 'assistant' && m.reasoning && (
                <details className="message-reasoning" open={!m.content}>
                  <summary>思考过程{m.reasoningTtftMs != null ? `（思考 TTFT: ${m.reasoningTtftMs} ms）` : ''}</summary>
                  <div className="reasoning-text">{m.reasoning}</div>
                </details>
              )}
              <div className="message-content">
                {m.searching && <div className="searching-indicator">正在联网搜索...</div>}
                {Array.isArray(m.content) ? (
                  <>
                    <div className="message-images">
                      {m.content
                        .filter((b) => b.type === 'image')
                        .map((b, i) => (
                          <img key={i} src={b.imageUrl} alt="上传的图片" className="message-image" />
                        ))}
                    </div>
                    {m.content
                      .filter((b) => b.type === 'text')
                      .map((b) => b.text)
                      .join('\n')}
                  </>
                ) : (
                  m.content || (isStreaming && idx === active.messages.length - 1 ? '思考中…' : '')
                )}
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
                (m.searchTtftMs != null ||
                  m.reasoningTtftMs != null ||
                  m.commentaryTtftMs != null ||
                  m.contentTtftMs != null) && (
                  <div className="message-meta">
                    {[
                      m.searchTtftMs != null ? `搜索 TTFT: ${m.searchTtftMs} ms` : null,
                      m.reasoningTtftMs != null ? `思考 TTFT: ${m.reasoningTtftMs} ms` : null,
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
          {pendingImages.length > 0 && (
            <div className="pending-images">
              {pendingImages.map((img, i) => (
                <div key={i} className="pending-image">
                  <img src={img.dataUrl} alt={img.name} />
                  <button
                    className="remove-image-btn"
                    onClick={() => handleRemoveImage(i)}
                    aria-label="移除图片"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="composer-row">
            <label className="upload-image-btn" title="上传图片（自动切换到多模态模型）">
              📷
              <input
                type="file"
                accept="image/jpeg,image/png,image/gif,image/webp"
                multiple
                onChange={handleImageSelect}
                disabled={isStreaming}
                hidden
              />
            </label>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder="输入消息，Enter 发送，Shift+Enter 换行（可直接 Ctrl+V 粘贴图片）"
              rows={2}
              disabled={isStreaming}
            />
            {isStreaming ? (
              <button className="stop-btn" onClick={handleStop}>
                停止
              </button>
            ) : (
              <button
                className="send-btn"
                onClick={handleSend}
                disabled={!input.trim() && pendingImages.length === 0}
              >
                发送
              </button>
            )}
          </div>
        </footer>
      </main>
    </div>
  );
}

export default App;
