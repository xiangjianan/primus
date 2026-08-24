import { buildSummarizeMessages, callDeepSeek, parseJsonContent, json } from './_shared.js';

/** POST /api/summarize — 整链总结 */
export async function onRequestPost(context) {
  let body;
  try { body = await context.request.json(); } catch (_) { body = null; }
  if (!body || typeof body !== 'object') return json({ error: '请求体不是合法 JSON' }, 400);

  const nodes = Array.isArray(body.nodes) ? body.nodes : [];
  if (nodes.length === 0) return json({ error: '暂无可总结的节点' }, 400);
  if (!context.env.DEEPSEEK_API_KEY) return json({ error: '未配置 DEEPSEEK_API_KEY（Cloudflare Secret）' }, 500);

  try {
    const { content, thinking } = await callDeepSeek({
      env: context.env,
      messages: buildSummarizeMessages(nodes),
      maxTokens: 3000,
      temperature: 0.5,
    });
    const parsed = parseJsonContent(content);
    const data = parsed && typeof parsed === 'object'
      ? {
          summary: String(parsed.summary || '').trim() || '（未能生成总结）',
          themes: Array.isArray(parsed.themes) ? parsed.themes.map(String).filter(Boolean).slice(0, 10) : [],
          actions: Array.isArray(parsed.actions) ? parsed.actions.map(String).filter(Boolean).slice(0, 10) : [],
        }
      : { summary: content.slice(0, 2000), themes: [], actions: [] };
    return json({ data, thinking });
  } catch (err) {
    return json({ error: err.message || '生成总结失败，请重试' }, 500);
  }
}
