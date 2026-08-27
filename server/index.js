import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';
import { generateImage, findLatestImageUrl } from './imageGen.js';
import { searchKnowledge } from './rag/index.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
});

const ALLOWED_MODELS = new Set(['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp']);
const VISION_MODEL = 'deepseek-v4-flash-vision-exp';

const IMAGE_GEN_TOOL = {
  type: 'function',
  name: 'generate_image',
  description:
    '根据文字描述生成一张图片（文生图）。如果用户想基于对话中已经出现过的图片做修改/编辑（图生图），把 use_reference_image 设为 true，会自动使用对话中最近一张图片作为参考图。',
  parameters: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: '详细描述要生成或编辑成什么样的图片，尽量包含主体、风格、构图、色彩等细节',
      },
      use_reference_image: {
        type: 'boolean',
        description: '是否使用对话中最近出现的一张图片作为参考图进行图生图编辑，而不是从零生成新图，默认 false',
      },
    },
    required: ['prompt'],
  },
};

const KNOWLEDGE_TOOL = {
  type: 'function',
  name: 'search_tianxi_knowledge',
  description:
    '检索“天禧个人超级智能体”与联想集团相关的官方知识库，用于回答关于天禧产品功能、使用方法、AI键/快捷键设置、账号与登录、订阅与能量、故障排查、联想公司介绍等问题。当用户问到天禧是什么、怎么用某个功能、遇到什么问题、或询问联想集团相关信息时调用。',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: '要检索的问题或关键词，尽量使用用户原始问题',
      },
    },
    required: ['query'],
  },
};

const MAX_TOOL_ROUNDS = 4;

function toResponsesContent(content) {
  if (typeof content === 'string' || !Array.isArray(content)) return content;
  return content.map((block) => {
    if (block.type === 'image') {
      return { type: 'input_image', image_url: block.imageUrl, detail: block.detail || 'auto' };
    }
    return { type: 'input_text', text: block.text || '' };
  });
}

function sseSend(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

const ALLOWED_EFFORTS = new Set(['low', 'high', 'max']);

function buildInstructions(base) {
  const now = new Date();
  const beijingTime = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    dateStyle: 'full',
    timeStyle: 'medium',
  }).format(now);
  return `${base || 'You are a helpful assistant.'}\n\nCurrent date and time: ${beijingTime} (北京时间, UTC+8).`;
}

app.post('/api/login', (req, res) => {
  res.json({ ok: true });
});

app.post('/api/chat', async (req, res) => {
  const { messages, model, webSearch, instructions, reasoningEffort } = req.body || {};

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages 不能为空' });
  }
  const hasImage = messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'image'));
  const chosenModel = hasImage ? VISION_MODEL : (ALLOWED_MODELS.has(model) ? model : 'deepseek-v4-flash');
  const chosenEffort = ALLOWED_EFFORTS.has(reasoningEffort) ? reasoningEffort : 'low';

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  let input = messages.map((m) => ({ role: m.role, content: toResponsesContent(m.content) }));

  const tools = [IMAGE_GEN_TOOL, KNOWLEDGE_TOOL];
  if (webSearch) tools.push({ type: 'web_search' });

  const startedAt = Date.now();
  let contentTtftSent = false;
  let commentaryTtftSent = false;
  let searchTtftSent = false;
  let reasoningTtftSent = false;
  let fullText = '';
  const sources = [];
  // message item_id -> 该 item 第一个 output_text.delta 到达的时间。
  // 注意：response.output_item.added 里的 phase 字段永远是占位值 "final_answer"，
  // 只有 output_item.done 里的 phase 才是模型最终确定的真实值（"commentary" 旁白 / "final_answer" 正文），
  // 所以要等 done 事件才能判断这段文字该算旁白还是正文，先把首字时间缓存起来。
  const itemFirstDeltaAt = new Map();

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const requestPayload = {
        model: chosenModel,
        instructions: buildInstructions(instructions),
        input,
        stream: true,
        reasoning: { effort: chosenEffort },
        tools,
        tool_choice: 'auto',
      };

      const stream = await client.responses.create(requestPayload);
      const pendingCalls = [];
      // thinking 模式下，reasoning 输出项必须原样回传给下一轮请求，否则报
      // "reasoning_text in the thinking mode must be passed back"。response.completed
      // 里的 response.output 已经是该轮全部输出项（reasoning/function_call/message...）的
      // 原始顺序数组，工具调用后直接整段重放进 input，不用自己拼 function_call 条目。
      let roundOutput = [];

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
            } else if (item?.type === 'function_call') {
              pendingCalls.push({ callId: item.call_id, name: item.name, arguments: item.arguments });
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

          case 'response.reasoning_text.delta':
            if (!reasoningTtftSent) {
              reasoningTtftSent = true;
              sseSend(res, 'reasoning_ttft', { ms: Date.now() - startedAt });
            }
            sseSend(res, 'reasoning_delta', { text: event.delta });
            break;

          case 'response.completed':
            roundOutput = event.response?.output || [];
            if (pendingCalls.length === 0) {
              sseSend(res, 'done', {
                fullText,
                usage: event.response?.usage || null,
                sources,
              });
            }
            break;

          case 'response.incomplete':
          case 'response.failed':
            sseSend(res, 'error', {
              message: `模型响应${event.type === 'response.failed' ? '失败' : '未完成'}`,
            });
            res.end();
            return;

          default:
            break;
        }
      }

      if (pendingCalls.length === 0) {
        return;
      }

      // 模型请求调用工具（目前只有生图）。把这一轮完整的输出项（包含 reasoning，如果有）
      // 按原始顺序整段重放进 input，thinking 模式下 reasoning 项必须回传，否则报 400；
      // function_call 本身也在 roundOutput 里，不用再手动 push 一遍。
      input.push(...roundOutput);

      for (const call of pendingCalls) {
        if (call.name === 'generate_image') {
          sseSend(res, 'image_status', { status: 'generating' });
          let output;
          try {
            let args = {};
            try {
              args = JSON.parse(call.arguments || '{}');
            } catch {
              args = {};
            }
            const referenceImageUrl = args.use_reference_image ? findLatestImageUrl(messages) : null;
            const imageUrl = await generateImage({ prompt: args.prompt, referenceImageUrl });
            sseSend(res, 'image_generated', { url: imageUrl, prompt: args.prompt });
            output = `图片已生成，地址：${imageUrl}`;
          } catch (err) {
            sseSend(res, 'image_status', { status: 'failed', message: err.message });
            output = `图片生成失败：${err.message}`;
          }
          input.push({ type: 'function_call_output', call_id: call.callId, output });
        } else if (call.name === 'search_tianxi_knowledge') {
          sseSend(res, 'knowledge_status', { status: 'searching' });
          let output;
          try {
            let args = {};
            try {
              args = JSON.parse(call.arguments || '{}');
            } catch {
              args = {};
            }
            const hits = searchKnowledge(args.query || '', 3);
            sseSend(res, 'knowledge_status', { status: 'done', hits: hits.map((h) => ({ id: h.id, question: h.question })) });
            output = hits.length
              ? JSON.stringify(hits.map((h) => ({ question: h.question, answer: h.answer })))
              : '知识库中没有找到相关内容。';
          } catch (err) {
            sseSend(res, 'knowledge_status', { status: 'failed', message: err.message });
            output = `知识库检索失败：${err.message}`;
          }
          input.push({ type: 'function_call_output', call_id: call.callId, output });
        } else {
          input.push({ type: 'function_call_output', call_id: call.callId, output: `未知工具：${call.name}` });
        }
      }
    }

    sseSend(res, 'error', { message: '工具调用轮数超出上限' });
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
