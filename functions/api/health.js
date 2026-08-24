import { json } from './_shared.js';

/** GET /api/health — 健康检查 */
export async function onRequestGet(context) {
  return json({
    ok: true,
    model: context.env.DEEPSEEK_MODEL || 'deepseek-v4-flash',
    apiKeySet: Boolean(context.env.DEEPSEEK_API_KEY),
  });
}
