import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
});

const ALLOWED_MODELS = new Set(['deepseek-v4-flash', 'deepseek-v4-pro']);

function sseSend(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

const ALLOWED_EFFORTS = new Set(['low', 'high', 'max']);

app.post('/api/login', (req, res) => {
  res.json({ ok: true });
});

app.post('/api/chat', async (req, res) => {
  const { messages, model, webSearch, instructions, reasoningEffort } = req.body || {};

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages 不能为空' });
  }
  const chosenModel = ALLOWED_MODELS.has(model) ? model : 'deepseek-v4-flash';
  const chosenEffort = ALLOWED_EFFORTS.has(reasoningEffort) ? reasoningEffort : 'low';

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const input = messages.map((m) => ({ role: m.role, content: m.content }));

  const requestPayload = {
    model: chosenModel,
    instructions: instructions || 'You are a helpful assistant.',
    input,
    stream: true,
    reasoning: { effort: chosenEffort },
  };

  if (webSearch) {
    requestPayload.tools = [{ type: 'web_search' }];
    requestPayload.tool_choice = 'auto';
  }

  const startedAt = Date.now();
  let contentTtftSent = false;
  let commentaryTtftSent = false;
  let searchTtftSent = false;
  let fullText = '';
  const sources = [];
  // message item_id -> 该 item 第一个 output_text.delta 到达的时间。
  // 注意：response.output_item.added 里的 phase 字段永远是占位值 "final_answer"，
  // 只有 output_item.done 里的 phase 才是模型最终确定的真实值（"commentary" 旁白 / "final_answer" 正文），
  // 所以要等 done 事件才能判断这段文字该算旁白还是正文，先把首字时间缓存起来。
  const itemFirstDeltaAt = new Map();

  try {
    const stream = await client.responses.create(requestPayload);

    for await (const event of stream) {
      switch (event.type) {
        case 'response.web_search_call.in_progress':
        case 'response.web_search_call.searching':
        case 'response.web_search_call.completed':
          sseSend(res, 'search', { status: event.type.split('.').pop() });
          break;

        case 'response.output_item.done': {
          const item = event.item;
          if (item?.type === 'web_search_call' && item.status === 'completed') {
            if (item.action?.type === 'open_page' && item.action.url) {
              // 第一个 open_page 落地才算真正拿到搜索结果（search action 只是发出的检索词，还没有结果）
              if (!searchTtftSent) {
                searchTtftSent = true;
                sseSend(res, 'search_ttft', { ms: Date.now() - startedAt });
              }
              const url = item.action.url.split('#ws_call_id=')[0];
              if (!sources.some((s) => s.url === url)) {
                const source = { url };
                sources.push(source);
                sseSend(res, 'source', source);
              }
            } else if (item.action?.type === 'search' && Array.isArray(item.action.queries)) {
              const queries = item.action.queries
                .map((q) => q.split('#ws_call_id=')[0].trim())
                .filter(Boolean);
              if (queries.length) {
                sseSend(res, 'query', { queries });
              }
            }
          } else if (item?.type === 'message' && item.id) {
            // 此时的 phase 才是真实值（added 时永远是占位的 "final_answer"）
            const firstDeltaAt = itemFirstDeltaAt.get(item.id);
            if (firstDeltaAt != null) {
              if (item.phase === 'commentary') {
                if (!commentaryTtftSent) {
                  commentaryTtftSent = true;
                  sseSend(res, 'commentary_ttft', { ms: firstDeltaAt - startedAt });
                }
              } else if (!contentTtftSent) {
                contentTtftSent = true;
                sseSend(res, 'content_ttft', { ms: firstDeltaAt - startedAt });
              }
            }
          }
          break;
        }

        case 'response.output_text.delta':
          if (event.item_id && !itemFirstDeltaAt.has(event.item_id)) {
            itemFirstDeltaAt.set(event.item_id, Date.now());
          }
          fullText += event.delta;
          sseSend(res, 'delta', { text: event.delta });
          break;

        case 'response.completed':
          sseSend(res, 'done', {
            fullText,
            usage: event.response?.usage || null,
            sources,
          });
          break;

        case 'response.incomplete':
        case 'response.failed':
          sseSend(res, 'error', {
            message: `模型响应${event.type === 'response.failed' ? '失败' : '未完成'}`,
          });
          break;

        default:
          break;
      }
    }
  } catch (err) {
    console.error(err);
    sseSend(res, 'error', { message: err?.message || '请求 DeepSeek API 失败' });
  } finally {
    res.end();
  }
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

const port = process.env.PORT || 3001;
app.listen(port, () => {
  console.log(`DeepSeek chat server listening on http://localhost:${port}`);
});
