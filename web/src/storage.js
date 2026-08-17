const STORAGE_KEY = 'deepseek-chat-conversations';

export function loadConversations() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveConversations(conversations) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations));
}

export function createConversation() {
  return {
    id: crypto.randomUUID(),
    title: '新对话',
    createdAt: Date.now(),
    model: 'deepseek-v4-flash',
    webSearch: true,
    reasoningEffort: 'low',
    messages: [],
  };
}
