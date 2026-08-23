/* ============================================================
   第一性原理引擎 · 前端逻辑
   - 输入（目标 / 随心所想）→ 第一性原理
   - 逐层递进推导（A → B → C → …）
   - 记录、树形可视化、整体总结、Markdown 导出、localStorage 持久化
   ============================================================ */
(function () {
  'use strict';

  const STORAGE_KEY = 'fp-engine-state-v1';
  const MODE_META = {
    goal: {
      icon: '🎯',
      label: '目标拆解',
      hint: '输入一个目的（如“减肥”“创业”“学英语”），我会拆出达成它必须先达成的前置目的。',
      placeholder: '例如：三个月内把体重从 80kg 降到 70kg，同时保持精力充沛……',
      statuses: ['正在拆解目标…', '正在找最关键的前提…', '正在想“先要达成什么”…', '正在凝练前置目的…'],
    },
    text: {
      icon: '📝',
      label: '随心所想',
      hint: '粘贴一段散乱的长文本（思绪、随笔、碎碎念都可以），我会先用大白话提炼你真正想要的，再给出达成它的前置目的。',
      placeholder: '把脑子里的想法一股脑倒进来吧，越散乱越好……',
      statuses: ['正在通读原文…', '正在判断你真正想要什么…', '正在找最关键的前提…', '正在凝练前置目的…'],
    },
    derive: {
      icon: '🔁',
      label: '递进推导',
      hint: '',
      placeholder: '',
      statuses: ['正在往前追问…', '正在想“要先达成什么”…', '正在剥离可有可无的步骤…', '正在凝练更前置的目的…'],
    },
  };

  const DEPTH_COLORS = ['#818cf8', '#22d3ee', '#34d399', '#fbbf24', '#fb7185', '#a78bfa', '#f472b6', '#38bdf8'];
  const colorOf = (d) => DEPTH_COLORS[Math.min(Math.max(d || 0, 0), DEPTH_COLORS.length - 1)];

  const state = {
    nodes: [],      // {id,parentId,rootId,depth,mode,sourceText,label,principle,essence,reasoning,keywords,thinking,createdAt}
    summary: null,  // {summary,themes,actions}
    pending: [],    // 进行中的请求占位 {id, kind:'root'|'child', mode, text, parentId, hint}
    mode: 'goal',
    expanded: new Set(), // 展开状态的会话 rootId
    deriveDrafts: {},    // nodeId -> 未提交的补充文本（仅渲染间暂存，不持久化）
  };

  const $ = (s) => document.querySelector(s);
  const chainEl = $('#chain');
  const emptyEl = $('#emptyState');
  const inputEl = $('#inputText');
  const charCountEl = $('#charCount');
  const btnSubmit = $('#btnSubmit');
  const svg = $('#vizSvg');
  const vizEmpty = $('#vizEmpty');
  const toastEl = $('#toast');

  /* ---------------- 工具 ---------------- */
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'n' + Date.now() + Math.random().toString(36).slice(2));

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  let toastTimer = null;
  function toast(msg, isErr) {
    toastEl.textContent = msg;
    toastEl.className = 'toast show' + (isErr ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.className = 'toast'; }, 3200);
  }

  async function apiPost(path, body) {
    const resp = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error || `请求失败（${resp.status}）`);
    return data;
  }

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        nodes: state.nodes,
        summary: state.summary,
        expanded: [...state.expanded],
      }));
    } catch (_) { /* 忽略配额错误 */ }
  }

  function restore() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (Array.isArray(saved.nodes)) state.nodes = saved.nodes;
      if (saved.summary) state.summary = saved.summary;
      if (Array.isArray(saved.expanded)) state.expanded = new Set(saved.expanded);
    } catch (_) { /* 损坏时忽略 */ }
  }

  function fmtTime(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  /* ---------------- 状态派生 ---------------- */
  function ancestorsOf(node) {
    const list = [];
    let cur = state.nodes.find((n) => n.id === node.parentId);
    while (cur) {
      list.unshift({ id: cur.id, label: cur.label, principle: cur.principle, depth: cur.depth });
      cur = state.nodes.find((n) => n.id === cur.parentId);
    }
    return list;
  }

  /* ---------------- 输入区 ---------------- */
  const modeBtns = document.querySelectorAll('.seg-btn');
  modeBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      state.mode = btn.dataset.mode;
      modeBtns.forEach((b) => b.classList.toggle('active', b === btn));
      const meta = MODE_META[state.mode];
      $('#modeHint').textContent = meta.hint;
      inputEl.placeholder = meta.placeholder;
    });
  });

  inputEl.addEventListener('input', () => {
    charCountEl.textContent = inputEl.value.length;
  });

  inputEl.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      submitInput();
    }
  });

  btnSubmit.addEventListener('click', submitInput);

  async function submitInput() {
    const text = inputEl.value.trim();
    if (!text) { toast('请先输入目标或文本', true); inputEl.focus(); return; }
    if (state.pending.some((p) => p.kind === 'root')) { toast('已有拆解正在进行中…'); return; }
    inputEl.value = '';
    charCountEl.textContent = '0';
    btnSubmit.disabled = true;

    const pending = { id: uid(), kind: 'root', mode: state.mode, text, parentId: null };
    state.pending.push(pending);
    renderAll();

    try {
      const res = await apiPost('/api/derive', { text, mode: state.mode, context: null });
      const node = {
        id: pending.id,
        parentId: null,
        rootId: pending.id,
        depth: 0,
        mode: state.mode,
        sourceText: text,
        label: res.data.label || '',
        principle: res.data.principle || '',
        essence: res.data.essence || '',
        reasoning: res.data.reasoning || '',
        keywords: Array.isArray(res.data.keywords) ? res.data.keywords : [],
        thinking: res.thinking || '',
        createdAt: Date.now(),
      };
      state.nodes.push(node);
      state.expanded.add(node.id); // 新会话默认展开
      toast('✅ 已找到达成它的前置目的，可点击“继续往前推”深入');
    } catch (err) {
      state.pending = state.pending.filter((p) => p.id !== pending.id);
      state.nodes.push({
        id: pending.id, parentId: null, rootId: pending.id, depth: 0, mode: state.mode,
        sourceText: text, label: '', principle: '', essence: '', reasoning: '', keywords: [],
        thinking: '', createdAt: Date.now(), error: err.message, retry: { text, mode: state.mode, parentId: null, kind: 'root' },
      });
      toast('拆解失败：' + err.message, true);
    } finally {
      state.pending = state.pending.filter((p) => p.id !== pending.id);
      btnSubmit.disabled = false;
      persist();
      renderAll();
    }
  }

  /* ---------------- 继续往前推（可携带用户补充文本） ---------------- */
  async function deriveFrom(nodeId, hint) {
    const node = state.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    // 防重复：该节点已有推导进行中则忽略
    if (state.pending.some((p) => p.kind === 'child' && p.parentId === node.id)) {
      toast('该节点正在推导中，请稍候…');
      return;
    }
    const pending = { id: uid(), kind: 'child', mode: 'derive', text: node.principle, parentId: node.id, hint: hint || '' };
    state.pending.push(pending);
    if (node.rootId) state.expanded.add(node.rootId); // 保证所属会话展开，能看到推导进度
    delete state.deriveDrafts[node.id]; // 已提交，清掉草稿
    renderAll();

    try {
      const context = { depth: node.depth, ancestors: ancestorsOf(node).map((a) => ({ label: a.label, principle: a.principle, depth: a.depth })) };
      const res = await apiPost('/api/derive', { text: node.principle, mode: 'derive', context, hint: hint || '' });
      const child = {
        id: pending.id,
        parentId: node.id,
        rootId: node.rootId,
        depth: node.depth + 1,
        mode: 'derive',
        sourceText: node.principle,
        label: res.data.label || '',
        principle: res.data.principle || '',
        essence: '',
        reasoning: res.data.reasoning || '',
        keywords: Array.isArray(res.data.keywords) ? res.data.keywords : [],
        thinking: res.thinking || '',
        createdAt: Date.now(),
      };
      state.nodes.push(child);
      toast(`🔁 已往前推到第 ${child.depth} 层`);
    } catch (err) {
      state.nodes.push({
        id: pending.id, parentId: node.id, rootId: node.rootId, depth: node.depth + 1, mode: 'derive',
        sourceText: node.principle, label: '', principle: '', essence: '', reasoning: '', keywords: [],
        thinking: '', createdAt: Date.now(), error: err.message, retry: { text: node.principle, mode: 'derive', parentId: node.id, kind: 'child', hint: hint || '' },
      });
      toast('推导失败：' + err.message, true);
    } finally {
      state.pending = state.pending.filter((p) => p.id !== pending.id);
      persist();
      renderAll();
    }
  }

  function retryNode(nodeId) {
    const node = state.nodes.find((n) => n.id === nodeId);
    if (!node || !node.retry) return;
    state.nodes = state.nodes.filter((n) => n.id !== nodeId);
    const { text, mode, parentId, kind, hint } = node.retry;
    const pending = { id: uid(), kind, mode, text, parentId, hint: hint || '' };
    state.pending.push(pending);
    if (node.rootId) state.expanded.add(node.rootId);
    renderAll();
    const doIt = kind === 'root' ? submitInputInternal : deriveInternal;
    doIt(pending, text, mode, parentId).finally(() => {
      state.pending = state.pending.filter((p) => p.id !== pending.id);
      persist();
      renderAll();
    });
  }

  async function submitInputInternal(pending, text, mode) {
    try {
      const res = await apiPost('/api/derive', { text, mode, context: null });
      state.nodes.push({
        id: pending.id, parentId: null, rootId: pending.id, depth: 0, mode,
        sourceText: text, label: res.data.label || '', principle: res.data.principle || '',
        essence: res.data.essence || '', reasoning: res.data.reasoning || '',
        keywords: Array.isArray(res.data.keywords) ? res.data.keywords : [],
        thinking: res.thinking || '', createdAt: Date.now(),
      });
    } catch (err) {
      state.nodes.push({
        id: pending.id, parentId: null, rootId: pending.id, depth: 0, mode,
        sourceText: text, label: '', principle: '', essence: '', reasoning: '', keywords: [],
        thinking: '', createdAt: Date.now(), error: err.message, retry: { text, mode, parentId: null, kind: 'root' },
      });
    }
  }

  async function deriveInternal(pending, text, mode, parentId) {
    try {
      const parent = state.nodes.find((n) => n.id === parentId);
      const ctx = parent ? { depth: parent.depth, ancestors: ancestorsOf(parent).map((a) => ({ label: a.label, principle: a.principle, depth: a.depth })) } : null;
      const res = await apiPost('/api/derive', { text, mode: 'derive', context: ctx, hint: pending.hint || '' });
      const parent2 = state.nodes.find((n) => n.id === parentId);
      const depth = parent2 ? parent2.depth + 1 : 0;
      state.nodes.push({
        id: pending.id, parentId, rootId: parent2 ? parent2.rootId : pending.id, depth, mode: 'derive',
        sourceText: text, label: res.data.label || '', principle: res.data.principle || '',
        essence: '', reasoning: res.data.reasoning || '',
        keywords: Array.isArray(res.data.keywords) ? res.data.keywords : [],
        thinking: res.thinking || '', createdAt: Date.now(),
      });
    } catch (err) {
      state.nodes.push({
        id: pending.id, parentId, rootId: pending.id, depth: 0, mode: 'derive',
        sourceText: text, label: '', principle: '', essence: '', reasoning: '', keywords: [],
        thinking: '', createdAt: Date.now(), error: err.message, retry: { text, mode: 'derive', parentId, kind: 'child', hint: pending.hint || '' },
      });
    }
  }

  /* ---------------- 渲染：会话链（层次化折叠） ---------------- */
  function buildChildrenMap() {
    const childrenOf = new Map();
    for (const n of state.nodes) {
      if (n.parentId == null) continue;
      if (!childrenOf.has(n.parentId)) childrenOf.set(n.parentId, []);
      childrenOf.get(n.parentId).push(n);
    }
    for (const arr of childrenOf.values()) arr.sort((a, b) => a.createdAt - b.createdAt);
    return childrenOf;
  }

  /** 某条链的节点总数与最大层级 */
  function chainStats(rootId, childrenOf) {
    let count = 0, maxDepth = 0;
    const stack = [rootId];
    while (stack.length) {
      const id = stack.pop();
      const kids = childrenOf.get(id) || [];
      for (const k of kids) {
        count++;
        if (k.depth > maxDepth) maxDepth = k.depth;
        stack.push(k.id);
      }
    }
    return { count: count + 1, maxDepth };
  }

  /** 从某个子节点向上找到链的 rootId */
  function findRootOf(nodeId) {
    let cur = state.nodes.find((n) => n.id === nodeId);
    while (cur && cur.parentId != null) {
      cur = state.nodes.find((n) => n.id === cur.parentId);
    }
    return cur ? cur.id : null;
  }

  function renderChains() {
    saveDeriveDrafts(); // 重建前暂存各卡片输入框内容，避免丢失
    const scroll = chainEl.scrollTop;
    chainEl.innerHTML = '';
    const childrenOf = buildChildrenMap();

    // 保证进行中的推导（含新会话）所属会话处于展开态
    for (const p of state.pending) {
      if (p.kind === 'root') state.expanded.add(p.id);
      else {
        const rid = findRootOf(p.parentId);
        if (rid) state.expanded.add(rid);
      }
    }

    const roots = state.nodes.filter((n) => n.parentId == null).sort((a, b) => a.createdAt - b.createdAt);
    const rootPendings = state.pending.filter((p) => p.kind === 'root');
    const hasData = roots.length > 0 || state.pending.length > 0;

    if (!hasData) {
      if (!emptyEl.parentNode) chainEl.appendChild(emptyEl);
      emptyEl.style.display = '';
      $('#chainStats').textContent = '';
      return;
    }
    emptyEl.style.display = 'none';

    const frag = document.createDocumentFragment();
    let sessionIdx = 0;

    // 已完成的会话（每条链折叠为一张会话卡片）
    for (const root of roots) {
      sessionIdx++;
      frag.appendChild(buildSessionCard(sessionIdx, root, childrenOf));
    }

    // 进行中的新会话（自动展开，内部显示加载卡）
    for (const p of rootPendings) {
      sessionIdx++;
      frag.appendChild(buildPendingSessionCard(sessionIdx, p));
    }

    chainEl.appendChild(frag);
    chainEl.scrollTop = scroll;

    const total = state.nodes.length;
    const maxDepth = state.nodes.reduce((m, n) => Math.max(m, n.depth), 0);
    const chainCount = roots.length + rootPendings.length;
    $('#chainStats').textContent = total ? `${chainCount} 条链 · ${total} 个节点 · 最深 L${maxDepth}` : '';
  }

  /** 会话卡片：折叠 = 一行摘要；展开 = 内部节点链 */
  function buildSessionCard(idx, root, childrenOf) {
    const el = document.createElement('div');
    const rootId = root.id;
    const expanded = state.expanded.has(rootId);
    el.className = 'session-card' + (expanded ? ' open' : '');
    el.dataset.root = rootId;
    el.style.setProperty('--nc', colorOf(root.depth));

    const meta = MODE_META[root.mode] || MODE_META.goal;
    const { count, maxDepth } = chainStats(rootId, childrenOf);
    const title = root.label || shortStr(root.sourceText, 20) || '（未命名）';
    const sub = shortStr(root.principle, 42);

    const head = document.createElement('div');
    head.className = 'session-head';
    head.innerHTML = `
      <span class="session-chevron">▸</span>
      <span class="session-mode">${meta.icon}</span>
      <span class="session-title">${escapeHtml(title)}</span>
      <span class="session-meta">L0–L${maxDepth} · ${count} 个节点 · ${fmtTime(root.createdAt)}</span>
      <button class="action-btn session-del" data-act="del-session" title="删除整条会话">🗑</button>`;
    head.querySelector('.session-del').addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirm(`确定删除这条会话（共 ${count} 个节点）吗？`)) deleteNode(rootId);
    });
    head.addEventListener('click', () => toggleSession(rootId));
    el.appendChild(head);

    if (expanded) {
      const body = document.createElement('div');
      body.className = 'session-body';
      buildChainCards(body, root, childrenOf);
      el.appendChild(body);
    }
    return el;
  }

  /** 进行中的新会话卡片（展开 + 加载卡） */
  function buildPendingSessionCard(idx, p) {
    const el = document.createElement('div');
    el.className = 'session-card open pending-session';
    el.dataset.root = p.id;
    el.style.setProperty('--nc', '#22d3ee');
    const meta = MODE_META[p.mode] || MODE_META.goal;
    const head = document.createElement('div');
    head.className = 'session-head';
    head.innerHTML = `
      <span class="session-chevron">▾</span>
      <span class="session-mode">${meta.icon}</span>
      <span class="session-title">${escapeHtml(shortStr(p.text, 20))}</span>
      <span class="session-meta">新会话 · ${meta.label}</span>`;
    el.appendChild(head);
    const body = document.createElement('div');
    body.className = 'session-body';
    body.appendChild(buildPendingCard(p));
    el.appendChild(body);
    return el;
  }

  function toggleSession(rootId) {
    if (state.expanded.has(rootId)) state.expanded.delete(rootId);
    else state.expanded.add(rootId);
    persist();
    renderAll();
  }

  /** 递归渲染一条链的节点卡片（带向下箭头） */
  function buildChainCards(frag, root, childrenOf) {
    frag.appendChild(buildNodeCard(root));
    const renderKids = (parentId) => {
      const kids = childrenOf.get(parentId) || [];
      for (const kid of kids) {
        const arrow = document.createElement('div');
        arrow.className = 'chain-arrow';
        arrow.innerHTML = `<div class="line"></div><div class="arr">▼</div>`;
        frag.appendChild(arrow);
        frag.appendChild(buildNodeCard(kid));
        renderKids(kid.id);
      }
    };
    renderKids(root.id);
    return frag;
  }

  function buildNodeCard(node) {
    const el = document.createElement('div');
    const color = colorOf(node.depth);
    el.className = 'node-card';
    el.dataset.id = node.id;
    el.style.setProperty('--node-color', color);
    const meta = MODE_META[node.mode] || MODE_META.goal;
    const time = fmtTime(node.createdAt);

    if (node.error) {
      el.classList.add('error');
      el.innerHTML = `
        <div class="node-top">
          <span class="depth-badge">L${node.depth}</span>
          <span class="mode-badge">⚠ 失败</span>
          <span class="node-time">${time}</span>
        </div>
        <div class="error-msg">${escapeHtml(node.error)}</div>
        <div class="node-actions">
          <button class="action-btn primary">↻ 重试</button>
          <button class="action-btn" data-act="del">🗑 删除</button>
        </div>`;
      el.querySelector('.action-btn.primary').addEventListener('click', () => retryNode(node.id));
      el.querySelector('[data-act="del"]').addEventListener('click', () => { deleteNode(node.id); });
      return el;
    }

    const kwHtml = node.keywords && node.keywords.length
      ? `<div class="node-keywords">${node.keywords.map((k) => `<span class="kw">${escapeHtml(k)}</span>`).join('')}</div>` : '';

    const essenceHtml = node.essence
      ? `<div class="node-block"><div class="node-block-tag" style="--block-color:#fbbf24"><span class="tag-icon">📌</span>他真正想要的</div>
         <div class="node-block-text">${escapeHtml(node.essence)}</div></div>` : '';

    const reasoningHtml = node.reasoning
      ? `<div class="node-block"><div class="node-block-tag" style="--block-color:#a78bfa"><span class="tag-icon">🧠</span>为什么</div>
         <div class="node-block-text">${escapeHtml(node.reasoning)}</div></div>` : '';

    const thinkHtml = node.thinking
      ? `<details class="think-block"><summary>💭 模型思考过程（可展开）</summary><pre>${escapeHtml(node.thinking)}</pre></details>` : '';

    const sourceHtml = node.depth === 0
      ? `<div class="node-block"><div class="node-block-tag" style="--block-color:#64748b"><span class="tag-icon">📥</span>原始输入</div>
         <div class="node-block-text">${escapeHtml(node.sourceText)}</div></div>` : '';

    const labelText = escapeHtml(node.label || '（未命名）');
    const origin = node.depth === 0
      ? `<span class="origin">${meta.icon} ${meta.label}</span>`
      : `<span class="origin">由 “${escapeHtml(shortStr(state.nodes.find((n) => n.id === node.parentId)?.label || node.sourceText, 12))}” 往前推</span>`;

    el.innerHTML = `
      <div class="node-top">
        <span class="depth-badge">第 ${node.depth} 层${node.depth === 0 ? ' · 原始' : ''}</span>
        <span class="mode-badge">${meta.icon} ${meta.label}</span>
        <span class="node-time">${time}</span>
      </div>
      <div class="node-label">${labelText}${origin}</div>
      ${sourceHtml}
      ${essenceHtml}
      <div class="node-block"><div class="node-block-tag" style="--block-color:${color}"><span class="tag-icon">🎯</span>达成它的前置目的</div>
        <div class="node-block-text">${escapeHtml(node.principle)}</div></div>
      ${reasoningHtml}
      ${kwHtml}
      ${thinkHtml}
      <div class="node-actions">
        <button class="action-btn" data-act="copy">📋 复制</button>
        <button class="action-btn" data-act="del">🗑 删除</button>
      </div>
      <div class="derive-box">
        <div class="derive-head">
          <span class="derive-title">🔁 继续往前推</span>
          <span class="derive-tip">补充你的想法、约束或背景（可选），留空则直接推导</span>
        </div>
        <textarea class="derive-input" rows="2" maxlength="2000"
          placeholder="例如：我特别爱吃零食、控制不住；或者：我只有周末有时间……"></textarea>
        <div class="derive-actions">
          <button class="action-btn primary" data-act="derive-go">⚡ 继续往前推</button>
        </div>
      </div>`;

    const deriveInput = el.querySelector('.derive-input');
    deriveInput.value = state.deriveDrafts[node.id] || ''; // 恢复渲染前未提交的草稿

    const goBtn = el.querySelector('[data-act="derive-go"]');
    const deriving = state.pending.some((p) => p.kind === 'child' && p.parentId === node.id);
    if (deriving) {
      goBtn.disabled = true;
      goBtn.textContent = '⏳ 推导中…';
    }
    goBtn.addEventListener('click', () => {
      const hint = deriveInput.value.trim();
      deriveFrom(node.id, hint);
    });
    el.querySelector('[data-act="copy"]').addEventListener('click', () => {
      navigator.clipboard.writeText(node.principle).then(
        () => toast('已复制到剪贴板'),
        () => toast('复制失败', true)
      );
    });
    el.querySelector('[data-act="del"]').addEventListener('click', () => deleteNode(node.id));
    return el;
  }

  function shortStr(s, n) { return s && s.length > n ? s.slice(0, n - 1) + '…' : s; }

  /** 把当前 DOM 中所有"补充文本"输入框的内容暂存起来（供渲染重建后恢复） */
  function saveDeriveDrafts() {
    document.querySelectorAll('.node-card[data-id] .derive-input').forEach((input) => {
      const card = input.closest('.node-card');
      if (card && card.dataset.id) state.deriveDrafts[card.dataset.id] = input.value;
    });
  }

  function buildPendingCard(p) {
    const el = document.createElement('div');
    const meta = MODE_META[p.mode] || MODE_META.derive;
    el.className = 'node-card loading';
    el.dataset.pendingId = p.id;
    el.innerHTML = `
      <div class="node-top">
        <span class="depth-badge">${p.kind === 'root' ? 'L0' : '↓'}</span>
        <span class="mode-badge">${meta.icon} ${meta.label}</span>
        <span class="node-time">${fmtTime(Date.now())}</span>
      </div>
      <div class="loading-line">
        <div class="spinner"></div>
        <div class="loading-status">${meta.statuses[0]}</div>
      </div>
      <div class="node-block">
        <div class="skeleton" style="height:16px;width:55%"></div>
        <div class="skeleton" style="height:14px;width:88%;margin-top:9px"></div>
        <div class="skeleton" style="height:14px;width:72%;margin-top:7px"></div>
      </div>`;
    let idx = 1;
    const timer = setInterval(() => {
      if (!document.body.contains(el)) { clearInterval(timer); return; }
      const statusEl = el.querySelector('.loading-status');
      if (statusEl) statusEl.textContent = meta.statuses[idx % meta.statuses.length];
      idx++;
    }, 2600);
    el._timer = timer;
    return el;
  }

  function deleteNode(id) {
    const ids = new Set([id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const n of state.nodes) {
        if (ids.has(n.parentId) && !ids.has(n.id)) { ids.add(n.id); changed = true; }
      }
    }
    state.nodes = state.nodes.filter((n) => !ids.has(n.id));
    // 清理已不存在的会话展开状态
    for (const rid of [...state.expanded]) {
      if (!state.nodes.some((n) => n.id === rid)) state.expanded.delete(rid);
    }
    state.summary = null;
    persist();
    renderAll();
    toast('已删除节点及其子节点');
  }

  /* ---------------- 渲染：记录列表（树状层次） ---------------- */
  function renderRecords() {
    const wrap = $('#records');
    const roots = state.nodes.filter((n) => n.parentId == null).sort((a, b) => a.createdAt - b.createdAt);
    $('#recordCount').textContent = state.nodes.length;
    if (roots.length === 0) {
      wrap.innerHTML = '<div class="record-empty">还没有任何记录</div>';
      return;
    }
    wrap.innerHTML = '';
    const childrenOf = buildChildrenMap();
    for (const root of roots) appendRecordItem(wrap, root, childrenOf, 0);
  }

  function appendRecordItem(parent, node, childrenOf, depth) {
    const item = document.createElement('div');
    item.className = 'record-item' + (depth === 0 ? ' record-root' : '');
    item.style.setProperty('--nc', colorOf(node.depth));
    item.style.setProperty('--indent', (depth * 18) + 'px');
    const kids = childrenOf.get(node.id) || [];
    item.innerHTML = `
      <span class="record-depth">L${node.depth}</span>
      <div class="record-text"><b>${escapeHtml(node.label || '（未命名）')}</b>${escapeHtml(shortStr(node.principle, 46))}</div>
      ${kids.length ? '<span class="record-branch">' + kids.length + ' ↧</span>' : ''}`;
    item.addEventListener('click', () => focusNode(node.id));
    parent.appendChild(item);
    for (const k of kids) appendRecordItem(parent, k, childrenOf, depth + 1);
  }

  /* ---------------- 渲染：树形图谱 ---------------- */
  function renderTree() {
    const hasData = state.nodes.length > 0 || state.pending.length > 0;
    vizEmpty.style.display = hasData ? 'none' : 'grid';
    if (!hasData) { svg.setAttribute('viewBox', '0 0 100 100'); return; }
    FirstPrinciplesTree.renderTree(svg, state.nodes, focusNode);
  }

  function focusNode(id) {
    const node = state.nodes.find((n) => n.id === id);
    if (!node) return;
    // 若所属会话处于折叠态，先展开再定位
    if (node.rootId && !state.expanded.has(node.rootId)) {
      state.expanded.add(node.rootId);
      persist();
      renderAll();
    }
    const card = document.querySelector(`.node-card[data-id="${CSS.escape(id)}"]`);
    if (!card) return;
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.classList.remove('flash');
    void card.offsetWidth;
    card.classList.add('flash');
  }

  /* ---------------- 渲染：总结 ---------------- */
  function renderSummary() {
    const body = $('#summaryBody');
    if (state.summaryLoading) {
      body.innerHTML = '<div class="summary-loading"><div class="spinner"></div>正在串联整条目的链…</div>';
      return;
    }
    if (!state.summary) {
      body.innerHTML = '<p class="muted">把整条目的链汇总后，点击“生成总结”，用大白话概括“最终想达成什么、一步步要先达成什么”。</p>';
      return;
    }
    const s = state.summary;
    const themesHtml = s.themes && s.themes.length
      ? `<div class="summary-themes"><h4>🔗 共同主题</h4><div class="node-keywords">${s.themes.map((t) => `<span class="kw">${escapeHtml(t)}</span>`).join('')}</div></div>` : '';
    const actionsHtml = s.actions && s.actions.length
      ? `<div class="summary-actions"><h4>🚀 行动建议</h4><ul>${s.actions.map((a) => `<li>${escapeHtml(a)}</li>`).join('')}</ul></div>` : '';
    body.innerHTML = `<div class="summary-text">${escapeHtml(s.summary)}</div>${themesHtml}${actionsHtml}`;
  }

  $('#btnSummarize').addEventListener('click', async () => {
    if (state.nodes.length === 0) { toast('还没有可总结的原理节点', true); return; }
    state.summaryLoading = true;
    renderSummary();
    try {
      const payload = state.nodes.map((n) => ({
        label: n.label, principle: n.principle, essence: n.essence, depth: n.depth, mode: n.mode,
      }));
      const res = await apiPost('/api/summarize', { nodes: payload });
      state.summary = res.data || {};
      toast('✅ 总结已生成');
    } catch (err) {
      toast('生成总结失败：' + err.message, true);
    } finally {
      state.summaryLoading = false;
      persist();
      renderSummary();
    }
  });

  /* ---------------- 导出 / 清空 ---------------- */
  $('#btnExport').addEventListener('click', exportMarkdown);

  function exportMarkdown() {
    if (state.nodes.length === 0) { toast('暂无内容可导出', true); return; }
    const childrenOf = new Map();
    for (const n of state.nodes) {
      if (n.parentId == null) continue;
      if (!childrenOf.has(n.parentId)) childrenOf.set(n.parentId, []);
      childrenOf.get(n.parentId).push(n);
    }
    for (const arr of childrenOf.values()) arr.sort((a, b) => a.createdAt - b.createdAt);
    const roots = state.nodes.filter((n) => n.parentId == null).sort((a, b) => a.createdAt - b.createdAt);

    const lines = ['# ⚛️ 第一性原理拆解记录', '', `> 生成时间：${new Date().toLocaleString('zh-CN')}`, ''];
    roots.forEach((root, i) => {
      lines.push(`## 会话 ${i + 1}`, '');
      walkMd(root, childrenOf, lines, 0);
      lines.push('');
    });
    if (state.summary) {
      lines.push('## 📋 整体总结', '', state.summary.summary, '');
      if (state.summary.themes && state.summary.themes.length) {
        lines.push('**共同主题**：' + state.summary.themes.join('、'), '');
      }
      if (state.summary.actions && state.summary.actions.length) {
        lines.push('**行动建议**：');
        state.summary.actions.forEach((a) => lines.push(`- ${a}`));
        lines.push('');
      }
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `第一性原理记录-${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('⬇ 已导出 Markdown 文件');
  }

  function walkMd(node, childrenOf, lines, depth) {
    const indent = '  '.repeat(depth);
    lines.push(`${indent}### L${node.depth} ${node.label || '（未命名）'}`);
    if (node.depth === 0 && node.sourceText) lines.push(`${indent}> 📥 原始输入：${node.sourceText}`);
    if (node.essence) lines.push(`${indent}> 📌 真正想要的：${node.essence}`);
    lines.push(`${indent}- 🎯 前置目的：${node.principle}`);
    if (node.reasoning) lines.push(`${indent}- 🧠 为什么：${node.reasoning}`);
    if (node.keywords && node.keywords.length) lines.push(`${indent}- 🏷 关键词：${node.keywords.join('、')}`);
    lines.push('');
    const kids = childrenOf.get(node.id) || [];
    for (const k of kids) walkMd(k, childrenOf, lines, depth + 1);
  }

  $('#btnClear').addEventListener('click', () => {
    if (state.nodes.length === 0) { toast('当前没有记录'); return; }
    if (!confirm('确定清空所有拆解记录与图谱吗？')) return;
    state.nodes = [];
    state.summary = null;
    persist();
    renderAll();
    toast('已清空');
  });

  /* ---------------- 图谱工具栏 ---------------- */
  $('#zoomIn').addEventListener('click', () => {
    const cur = svg._fp || { scale: 1, tx: 0, ty: 0 };
    FirstPrinciplesTree.applyTransform(svg, cur.scale * 1.2, cur.tx, cur.ty);
  });
  $('#zoomOut').addEventListener('click', () => {
    const cur = svg._fp || { scale: 1, tx: 0, ty: 0 };
    FirstPrinciplesTree.applyTransform(svg, Math.max(cur.scale / 1.2, 0.15), cur.tx, cur.ty);
  });
  $('#zoomFit').addEventListener('click', () => {
    const vb = svg.viewBox.baseVal;
    FirstPrinciplesTree.fitToView(svg, vb.width, vb.height);
  });

  /* ---------------- 健康检查 ---------------- */
  async function checkHealth() {
    const badge = $('#healthBadge');
    try {
      const r = await fetch('/api/health');
      const d = await r.json();
      badge.textContent = `● ${d.model}`;
      badge.classList.add('ok');
      badge.title = '后端与模型连接正常';
    } catch (_) {
      badge.textContent = '● 后端未连接';
      badge.classList.add('err');
    }
  }

  /* ---------------- 汇总渲染 ---------------- */
  function renderAll() {
    renderChains();
    renderTree();
    renderRecords();
    renderSummary();
  }

  /* ---------------- 启动 ---------------- */
  restore();
  FirstPrinciplesTree.setupPanZoom(svg);
  renderAll();
  checkHealth();
  setInterval(checkHealth, 30000);

  window.addEventListener('resize', () => {
    const vb = svg.viewBox.baseVal;
    if (vb.width > 0) FirstPrinciplesTree.fitToView(svg, vb.width, vb.height);
  });
})();
