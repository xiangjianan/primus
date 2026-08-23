#!/usr/bin/env node
/**
 * 第一性原理引擎 · 后端服务器（零第三方依赖）
 *
 * - 静态托管 public/ 下的前端页面
 * - POST /api/derive    输入目标/长文本/已有原理 → 返回第一性原理（结构化 JSON + 思考过程）
 * - POST /api/summarize 汇总会话中所有原理节点 → 返回整体总结
 * - GET  /api/health    健康检查（返回当前模型名）
 *
 * 配置来源（优先级从高到低）：
 *   环境变量 DEEPSEEK_API_KEY / DEEPSEEK_MODEL / DEEPSEEK_BASE_URL / PORT
 *   本目录 config.json（未提交到 git）
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------
function loadConfig() {
  let fileCfg = {};
  try {
    fileCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  } catch (_) { /* 没有 config.json 时使用环境变量/默认值 */ }
  return {
    apiKey: process.env.DEEPSEEK_API_KEY || fileCfg.apiKey || '',
    model: process.env.DEEPSEEK_MODEL || fileCfg.model || 'deepseek-v4-flash',
    baseUrl: (process.env.DEEPSEEK_BASE_URL || fileCfg.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, ''),
    port: Number(process.env.PORT || fileCfg.port || 3000),
  };
}
const CFG = loadConfig();

// ---------------------------------------------------------------------------
// 提示词
// ---------------------------------------------------------------------------
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

function buildDeriveMessages({ text, mode, context, hint }) {
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

function buildSummarizeMessages(nodes) {
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

// ---------------------------------------------------------------------------
// DeepSeek 调用
// ---------------------------------------------------------------------------
async function callDeepSeek(messages, maxTokens, temperature = 0.4) {
  const url = `${CFG.baseUrl}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 150000);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${CFG.apiKey}`,
      },
      body: JSON.stringify({
        model: CFG.model,
        messages,
        response_format: { type: 'json_object' },
        temperature,
        max_tokens: maxTokens,
        stream: false,
      }),
      signal: controller.signal,
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
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('DeepSeek API 请求超时（150 秒），请重试');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** 从模型输出中尽力提取 JSON 对象 */
function parseJsonContent(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch (_) { /* fallthrough */ }
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch (_) { /* fallthrough */ }
  }
  return null;
}

/** 校验并规整拆解结果；解析失败或缺少原理时抛错（前端会显示可重试的错误卡） */
function normalizeDeriveResult(parsed, mode, fallback) {
  const p = parsed && typeof parsed === 'object' ? parsed : null;
  const principle = p ? String(p.principle || '').trim() : '';
  if (!principle) {
    throw new Error(`模型未能生成有效的第一性原理（返回内容：${(fallback || '').slice(0, 200) || '空'}）。请点击重试。`);
  }
  return {
    label: String(p.label || '').trim().slice(0, 30) || principle.slice(0, 14),
    essence: mode === 'text' ? String(p.essence || '').trim() : undefined,
    principle,
    reasoning: String(p.reasoning || '').trim(),
    keywords: Array.isArray(p.keywords) ? p.keywords.map(String).filter(Boolean).slice(0, 8) : [],
    isActionable: p.isActionable === true,
  };
}

// ---------------------------------------------------------------------------
// HTTP 工具
// ---------------------------------------------------------------------------
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (e) { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    sendJson(res, 403, { error: '禁止访问' });
    return;
  }
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      sendJson(res, 404, { error: '未找到资源' });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': buf.length,
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  try {
    // —— 健康检查 ——
    if (req.method === 'GET' && pathname === '/api/health') {
      sendJson(res, 200, { ok: true, model: CFG.model, apiKeySet: Boolean(CFG.apiKey) });
      return;
    }

    // —— 第一性原理拆解 ——
    if (req.method === 'POST' && pathname === '/api/derive') {
      const body = await readBody(req);
      const text = String(body.text || '').trim();
      const hint = String(body.hint || '').trim();
      const mode = ['goal', 'text', 'derive'].includes(body.mode) ? body.mode : 'goal';
      if (!text) { sendJson(res, 400, { error: '请输入目标或文本内容' }); return; }
      if (text.length > 30000) { sendJson(res, 400, { error: '文本过长（上限 30000 字符）' }); return; }
      if (!CFG.apiKey) { sendJson(res, 500, { error: '未配置 DEEPSEEK_API_KEY，请在 config.json 或环境变量中设置' }); return; }

      const attempt = async (tokens) => {
        const r = await callDeepSeek(buildDeriveMessages({ text, mode, context: body.context || null, hint }), tokens);
        return { content: r.content, thinking: r.thinking, parsed: parseJsonContent(r.content) };
      };
      let { content, thinking, parsed } = await attempt(1600);
      try {
        const result = normalizeDeriveResult(parsed, mode, content);
        sendJson(res, 200, { data: result, thinking });
      } catch (_firstErr) {
        // 首次结果无效（如被推理过程挤占导致截断/为空）：放宽 token 上限重试一次
        const retry = await attempt(3200);
        const result = normalizeDeriveResult(retry.parsed, mode, retry.content);
        sendJson(res, 200, { data: result, thinking: retry.thinking });
      }
      return;
    }

    // —— 会话总结 ——
    if (req.method === 'POST' && pathname === '/api/summarize') {
      const body = await readBody(req);
      const nodes = Array.isArray(body.nodes) ? body.nodes : [];
      if (nodes.length === 0) { sendJson(res, 400, { error: '暂无可总结的原理节点' }); return; }
      if (!CFG.apiKey) { sendJson(res, 500, { error: '未配置 DEEPSEEK_API_KEY，请在 config.json 或环境变量中设置' }); return; }

      const messages = buildSummarizeMessages(nodes);
      const { content, thinking } = await callDeepSeek(messages, 1600, 0.5);
      const parsed = parseJsonContent(content);
      const result = parsed && typeof parsed === 'object'
        ? {
            summary: String(parsed.summary || '').trim() || '（未能生成总结）',
            themes: Array.isArray(parsed.themes) ? parsed.themes.map(String).filter(Boolean).slice(0, 10) : [],
            actions: Array.isArray(parsed.actions) ? parsed.actions.map(String).filter(Boolean).slice(0, 10) : [],
          }
        : { summary: content.slice(0, 2000), themes: [], actions: [] };
      sendJson(res, 200, { data: result, thinking });
      return;
    }

    // —— 静态资源 ——
    if (req.method === 'GET' || req.method === 'HEAD') {
      serveStatic(req, res, pathname);
      return;
    }

    sendJson(res, 405, { error: '方法不允许' });
  } catch (err) {
    console.error('[server error]', err.message);
    sendJson(res, 500, { error: err.message || '服务器内部错误' });
  }
});

server.listen(CFG.port, () => {
  console.log('┌────────────────────────────────────────────────┐');
  console.log('│   第一性原理引擎 (First Principles Engine)      │');
  console.log('└────────────────────────────────────────────────┘');
  console.log(`  ➜ 打开页面:  http://127.0.0.1:${CFG.port}`);
  console.log(`  ➜ 模型:      ${CFG.model}`);
  console.log(`  ➜ API Key:   ${CFG.apiKey ? '已配置' : '⚠ 未配置（请在 config.json 或环境变量设置 DEEPSEEK_API_KEY）'}`);
});
