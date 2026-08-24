import { buildDeriveMessages, callDeepSeek, parseJsonContent, normalizeDeriveResult, json } from './_shared.js';

/** POST /api/derive — 目的链下钻 */
export async function onRequestPost(context) {
  let body;
  try { body = await context.request.json(); } catch (_) { body = null; }
  if (!body || typeof body !== 'object') return json({ error: '请求体不是合法 JSON' }, 400);

  const text = String(body.text || '').trim();
  const hint = String(body.hint || '').trim();
  const mode = ['goal', 'text', 'derive'].includes(body.mode) ? body.mode : 'goal';

  if (!text) return json({ error: '请输入目标或文本内容' }, 400);
  if (text.length > 30000) return json({ error: '文本过长（上限 30000 字符）' }, 400);
  if (!context.env.DEEPSEEK_API_KEY) return json({ error: '未配置 DEEPSEEK_API_KEY（Cloudflare Secret）' }, 500);

  const build = () => buildDeriveMessages({ text, mode, context: body.context || null, hint });
  const attempt = async (tokens) => {
    const r = await callDeepSeek({ env: context.env, messages: build(), maxTokens: tokens });
    return { content: r.content, thinking: r.thinking, parsed: parseJsonContent(r.content) };
  };

  try {
    const first = await attempt(2400);
    try {
      return json({ data: normalizeDeriveResult(first.parsed, first.content), thinking: first.thinking });
    } catch (_firstErr) {
      // 首次结果无效（如被推理过程挤占导致截断/为空）：放宽 token 上限重试一次
      const retry = await attempt(4800);
      return json({ data: normalizeDeriveResult(retry.parsed, retry.content), thinking: retry.thinking });
    }
  } catch (err) {
    return json({ error: err.message || '推导失败，请重试' }, 500);
  }
}
