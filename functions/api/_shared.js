/**
 * 第一性原理引擎 · Cloudflare Pages Functions 共享逻辑（Workers 运行时）
 * - 提示词（目的链拆解 + 硬约束）
 * - DeepSeek 调用（非流式，OpenAI 兼容，含解析失败自动重试）
 * - JSON 解析容错
 */
'use strict';

const SYSTEM_BASE =
  '你是一位擅长拆解目标前置条件的思维教练，方法叫"目的链拆解"：不满足于表面答案，而是不断追问' +
  '"要达成这个目的，最基本、最关键的前提是什么？先要达成什么？"，把一个大目的拆成一条' +
  '"目的 → 更前置的目的 → 再前置的目的"的链条，直到拆到普通人都能听懂、能照着做为止。\n' +
  '硬性要求：全程用日常大白话，像跟朋友聊天一样；禁止使用专业术语、公式、定律、学术名词；' +
  '宁可说得朴素直白，也不要掉书袋。所有输出必须是严格合法的 JSON 对象，不要输出任何其他文字。';

const JSON_FIELDS = {
  goal: '{"label":"不超过14字的标题（给这个前置目的起个名）","principle":"达成该目的必须先达成的那个前置目的（一句话大白话，用「先要…」开头）","reasoning":"为什么必须先做到它（1~2句大白话，讲清楚因果）","keywords":["3~6个关键词"],"isActionable":true}',
  text: '{"label":"不超过14字的标题","essence":"用大白话提炼他真正想要什么（1~2句）","principle":"达成这个目的必须先达成的那个前置目的（一句话大白话，用「先要…」开头）","reasoning":"为什么必须先做到它（1~2句大白话）","keywords":["3~6个关键词"],"isActionable":true}',
  derive: '{"label":"不超过14字的标题","principle":"更前置的那个目的（一句话大白话，用「先要…」开头）","reasoning":"为什么必须先做到它（1~2句大白话）","keywords":["3~6个关键词"],"isActionable":true}',
};

export function buildDeriveMessages({ text, mode, context, hint }) {
  const hintLine = hint
    ? `\n【用户补充的想法（请把它揉进推导里，作为重要约束/背景）】${hint}\n`
    : '';
  const tasks = {
    goal: `用户给了一个【目的】：「${text}」\n请按"目的链"方式拆解：\n1. 找出达成这个目的最根本、最关键、不可跳过的【前置目的】——用"先要…"一句话说清；\n2. 用一两句大白话解释：为什么必须先达成它。\n3. 最后判断：这个前置目的是否已经是可以立刻开始做的事情（不用再准备什么就能上手）？在 isActionable 字段如实回答 true 或 false。`,
    text: `用户输入了一段散乱的长文本（随心所想）：\n「${text}」\n请按"目的链"方式拆解：\n1. 先用一两句大白话判断并提炼：他真正想要的是什么（他的目的）；\n2. 再找出达成这个目的最根本、最关键的前置目的——用"先要…"一句话说清。\n3. 最后判断：这个前置目的是否已经是可以立刻开始做的事情（不用再准备什么就能上手）？在 isActionable 字段如实回答 true 或 false。`,
    derive: `用户给出了一条【前置目的】，需要继续往前拆（当前为第 ${context && context.depth != null ? context.depth + 1 : 1} 层）：\n【待拆解】${text}\n${context && context.ancestors && context.ancestors.length
      ? `【已走过的目的链】${context.ancestors.map(a => `L${a.depth} ${a.label || a.principle}`).join(' → ')}\n`
      : ''}请继续追问：要达成这个目的，最基本、最关键、更前置的目的又是什么？给出下一层。\n要求：给的是一个"可以达成的目的/条件"，不是抽象理论或定律；不要重复已走过的链条。\n最后判断：这个更前置的目的是否已经是可以立刻开始做的事情（不用再准备什么就能上手）？在 isActionable 字段如实回答 true 或 false。${hintLine}`,
  };
  return [
    { role: 'system', content: SYSTEM_BASE },
    { role: 'user', content: `${tasks[mode] || tasks.goal}\n\n只输出严格 JSON 对象，字段格式：${JSON_FIELDS[mode] || JSON_FIELDS.goal}` },
  ];
}

export function buildSummarizeMessages(nodes) {
  const lines = nodes.map((n, i) => {
    const parts = [`[${i + 1}] L${n.depth}「${n.label || ''}」`, n.principle ? `前置目的：${n.principle}` : '', n.essence ? `真正想要的：${n.essence}` : ''];
    return parts.filter(Boolean).join('\n');
  });
  const user = `以下是用户按"目的链"方式拆解出的所有节点（每个节点是一个前置目的）：\n${lines.join('\n---\n')}\n\n请给出整体总结：\n1. 用大白话概括这条（些）目的链：最终想达成什么，一步步要先达成什么；\n2. 共同的主题或底层逻辑；\n3. 现在最应该先做的第一件事。\n\n只输出严格 JSON 对象，字段格式：{"summary":"整体总结（2~4句大白话）","themes":["共同主题1","共同主题2"],"actions":["行动建议1","行动建议2"]}`;
  return [
    { role: 'system', content: SYSTEM_BASE },
    { role: 'user', content: user },
  ];
}

/** DeepSeek 调用（Workers 运行时，非流式） */
export async function callDeepSeek({ env, messages, maxTokens = 2400, temperature = 0.4 }) {
  const baseUrl = (env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: env.DEEPSEEK_MODEL || 'deepseek-v4-flash',
      messages,
      response_format: { type: 'json_object' },
      temperature,
      max_tokens: maxTokens,
      stream: false,
    }),
  });
  const raw = await resp.text();
  if (!resp.ok) {
    let detail = raw.slice(0, 300);
    try { detail = JSON.parse(raw).error?.message || detail; } catch (_) { /* 保留原文 */ }
    throw new Error(`DeepSeek API ${resp.status}: ${detail}`);
  }
  const data = JSON.parse(raw);
  const msg = (data.choices && data.choices[0] && data.choices[0].message) || {};
  return {
    content: typeof msg.content === 'string' ? msg.content : '',
    thinking: typeof msg.reasoning_content === 'string' ? msg.reasoning_content : '',
  };
}

/** 从模型输出中尽力提取 JSON 对象 */
export function parseJsonContent(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch (_) { /* fallthrough */ }
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch (_) { /* fallthrough */ }
  }
  return null;
}

/** 校验并规整拆解结果；解析失败或缺少 principle 时抛错 */
export function normalizeDeriveResult(parsed, fallback) {
  const p = parsed && typeof parsed === 'object' ? parsed : null;
  const principle = p ? String(p.principle || '').trim() : '';
  if (!principle) {
    throw new Error(`模型未能生成有效结果（返回内容：${(fallback || '').slice(0, 200) || '空'}）。请点击重试。`);
  }
  return {
    label: String(p.label || '').trim().slice(0, 20) || principle.slice(0, 12),
    essence: String(p.essence || '').trim() || undefined,
    principle,
    reasoning: String(p.reasoning || '').trim(),
    keywords: Array.isArray(p.keywords) ? p.keywords.map(String).filter(Boolean).slice(0, 8) : [],
    isActionable: p.isActionable === true,
  };
}

/** JSON 响应工具 */
export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
