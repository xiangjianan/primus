/* ============================================================
   第一性原理引擎 · 前端逻辑
   Codex Agent 式：左侧工作空间栏（当前会话 / 历史 / 图谱）
   + 右侧主推导区（目标卡片 + 垂直下钻链 + 操作条 + 总结）
   ============================================================ */
(function () {
  'use strict';

  const STORAGE_KEY = 'fp-engine-state-v2';
  const MODE_META = {
    goal: {
      icon: '🎯', label: '目标拆解',
      hint: '输入一个目的（如“减肥”“创业”“学英语”），我会拆出达成它必须先达成的前置目的。',
      placeholder: '例如：我想在三个月内把体重从 80kg 降到 70kg，同时保持精力充沛……',
      statuses: ['正在拆解目标…', '正在找最关键的前提…', '正在想“先要达成什么”…', '正在凝练前置目的…'],
    },
    text: {
      icon: '📝', label: '随心所想',
      hint: '粘贴一段散乱的长文本（思绪、随笔、碎碎念都可以），我会先用大白话提炼你真正想要的，再给出达成它的前置目的。',
      placeholder: '把脑子里的想法一股脑倒进来吧，越散乱越好……',
      statuses: ['正在通读原文…', '正在判断你真正想要什么…', '正在找最关键的前提…', '正在凝练前置目的…'],
    },
    derive: {
      icon: '🔁', label: '递进推导',
      statuses: ['正在往前追问…', '正在想“要先达成什么”…', '正在剥离可有可无的步骤…', '正在凝练更前置的目的…'],
    },
  };

  const DEPTH_COLORS = ['#818cf8', '#22d3ee', '#34d399', '#fbbf24', '#fb7185', '#a78bfa', '#f472b6', '#38bdf8'];
  const colorOf = (d) => DEPTH_COLORS[Math.min(Math.max(d || 0, 0), DEPTH_COLORS.length - 1)];

  const state = {
    nodes: [],          // 所有节点（跨会话）
    summaries: {},      // rootId -> {summary, themes, actions, thinking}
    summaryLoading: false,
    pending: [],        // 进行中的请求 {id, kind:'root'|'child', mode, text, parentId, hint}
    mode: 'goal',
    currentRootId: null,  // 当前会话 root
    chainCollapsed: false, // 「收起本轮」
    deriveDrafts: {},     // nodeId -> 未提交补充文本（渲染间暂存）
  };

  const $ = (s) => document.querySelector(s);
  const mainContent = $('#mainContent');
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

  function shortStr(s, n) { return s && s.length > n ? s.slice(0, n - 1) + '…' : s; }

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
        summaries: state.summaries,
        currentRootId: state.currentRootId,
      }));
    } catch (_) { /* 忽略配额错误 */ }
  }

  function restore() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (Array.isArray(saved.nodes)) state.nodes = saved.nodes;
      if (saved.summaries && typeof saved.summaries === 'object') state.summaries = saved.summaries;
      if (saved.currentRootId) state.currentRootId = saved.currentRootId;
    } catch (_) { /* 损坏时忽略 */ }
  }

  function fmtTime(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function relTime(ts) {
    const diff = Date.now() - ts;
    const m = Math.floor(diff / 60000);
    if (m < 1) return '刚刚';
    if (m < 60) return `${m} 分钟前`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} 小时前`;
    const d = Math.floor(h / 24);
    if (d === 1) return '昨天';
    if (d < 30) return `${d} 天前`;
    return new Date(ts).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
  }

  /* ---------------- 状态派生 ---------------- */
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

  /** 会话（root 节点）列表，最新的在前 */
  function sessions() {
    return state.nodes.filter((n) => n.parentId == null).sort((a, b) => b.createdAt - a.createdAt);
  }

  /** 某条链的节点（先序：root → 子 → 孙），线性链时即 A→B→C 顺序 */
  function chainNodesOf(rootId) {
    const childrenOf = buildChildrenMap();
    const out = [];
    const walk = (id) => {
      const node = state.nodes.find((n) => n.id === id);
      if (node) out.push(node);
      for (const k of childrenOf.get(id) || []) walk(k.id);
    };
    walk(rootId);
    return out;
  }

  function chainStats(rootId) {
    const nodes = chainNodesOf(rootId);
    return {
      count: nodes.length,
      maxDepth: nodes.reduce((m, n) => Math.max(m, n.depth), 0),
    };
  }

  function ancestorsOf(node) {
    const list = [];
    let cur = state.nodes.find((n) => n.id === node.parentId);
    while (cur) {
      list.unshift({ id: cur.id, label: cur.label, principle: cur.principle, depth: cur.depth });
      cur = state.nodes.find((n) => n.id === cur.parentId);
    }
    return list;
  }

  /** 会话摘要文本（essence 优先） */
  function sessionEssence(root) {
    return root.essence || root.label || shortStr(root.principle, 40) || '（未命名会话）';
  }

  /* ---------------- 侧栏 ---------------- */
  const ws = $('#workspace');
  const isMobile = () => window.innerWidth <= 900;

  function openSidebar() {
    if (isMobile()) { ws.classList.add('open'); document.body.classList.add('ws-open'); }
    else ws.classList.remove('hidden');
  }
  function closeSidebar() {
    if (isMobile()) { ws.classList.remove('open'); document.body.classList.remove('ws-open'); }
    else ws.classList.add('hidden');
  }
  function toggleSidebar() {
    if (isMobile()) {
      const open = ws.classList.toggle('open');
      document.body.classList.toggle('ws-open', open);
    } else {
      ws.classList.toggle('hidden');
    }
  }
  $('#btnSidebar').addEventListener('click', toggleSidebar);
  $('#wsBackdrop').addEventListener('click', closeSidebar);

  function renderSidebar() {
    renderCurrentSession();
    renderHistory();
  }

  function renderCurrentSession() {
    const box = $('#currentSession');
    const root = state.nodes.find((n) => n.id === state.currentRootId);
    if (!root) {
      box.className = 'current-session empty';
      box.innerHTML = '暂无当前会话<br/>点击上方「开始新推导」';
      box.onclick = null;
      return;
    }
    box.className = 'current-session';
    const { count, maxDepth } = chainStats(root.id);
    box.innerHTML = `
      <div class="cs-essence">${escapeHtml(sessionEssence(root))}</div>
      <div class="cs-meta">
        <span class="cs-depth">${count} 层 · 最深 L${maxDepth}</span>
        <span class="cs-time">${relTime(root.createdAt)}</span>
      </div>`;
    box.onclick = () => {
      state.chainCollapsed = !state.chainCollapsed;
      persist();
      renderAll();
    };
    box.title = '点击展开/收起本轮';
  }

  function renderHistory() {
    const list = $('#historyList');
    const roots = sessions();
    if (roots.length === 0) {
      list.innerHTML = '<div class="history-empty">还没有历史记录</div>';
      return;
    }
    list.innerHTML = '';
    for (const root of roots) {
      const { count, maxDepth } = chainStats(root.id);
      const item = document.createElement('div');
      item.className = 'history-item' + (root.id === state.currentRootId ? ' active' : '');
      item.innerHTML = `
        <div class="hi-essence">${escapeHtml(sessionEssence(root))}</div>
        <div class="hi-meta">
          <span class="hi-depth">L0–L${maxDepth} · ${count}</span>
          <span class="hi-time">${relTime(root.createdAt)}</span>
        </div>
        <button class="hi-del" title="删除这条会话">✕</button>`;
      item.addEventListener('click', (e) => {
        if (e.target.closest('.hi-del')) return;
        state.currentRootId = root.id;
        state.chainCollapsed = false;
        persist();
        renderAll();
        if (isMobile()) closeSidebar();
      });
      item.querySelector('.hi-del').addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm(`确定删除这条会话（共 ${count} 个节点）吗？`)) deleteSession(root.id);
      });
      list.appendChild(item);
    }
  }

  $('#btnNewDerive').addEventListener('click', () => {
    state.currentRootId = null;
    state.chainCollapsed = false;
    state.summaryLoading = false;
    persist();
    renderAll();
    inputEl.focus();
    if (isMobile()) closeSidebar();
  });

  function deleteSession(rootId) {
    const ids = new Set([rootId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const n of state.nodes) {
        if (ids.has(n.parentId) && !ids.has(n.id)) { ids.add(n.id); changed = true; }
      }
    }
    state.nodes = state.nodes.filter((n) => !ids.has(n.id));
    delete state.summaries[rootId];
    if (state.currentRootId === rootId) {
      const rest = sessions();
      state.currentRootId = rest.length ? rest[0].id : null;
    }
    persist();
    renderAll();
    toast('已删除会话');
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

  inputEl.addEventListener('input', () => { charCountEl.textContent = inputEl.value.length; });
  inputEl.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); submitInput(); }
  });
  btnSubmit.addEventListener('click', submitInput);

  async function submitInput() {
    const text = inputEl.value.trim();
    if (!text) { toast('请先输入目标或文本', true); inputEl.focus(); return; }
    if (state.pending.some((p) => p.kind === 'root')) { toast('已有拆解正在进行中…'); return; }
    inputEl.value = '';
    charCountEl.textContent = '0';
    btnSubmit.disabled = true;

    const pending = { id: uid(), kind: 'root', mode: state.mode, text, parentId: null, hint: '' };
    state.pending.push(pending);
    state.currentRootId = pending.id; // 新会话成为当前会话
    state.chainCollapsed = false;
    renderAll();

    try {
      const res = await apiPost('/api/derive', { text, mode: state.mode, context: null });
      const node = {
        id: pending.id, parentId: null, rootId: pending.id, depth: 0, mode: state.mode,
        sourceText: text, label: res.data.label || '', principle: res.data.principle || '',
        essence: res.data.essence || '', reasoning: res.data.reasoning || '',
        keywords: Array.isArray(res.data.keywords) ? res.data.keywords : [],
        thinking: res.thinking || '', guidance: '', isActionable: !!res.data.isActionable,
        createdAt: Date.now(),
      };
      state.nodes.push(node);
      state.currentRootId = node.id;
      toast('✅ 已找到达成它的前置目的，可继续往前推');
    } catch (err) {
      state.pending = state.pending.filter((p) => p.id !== pending.id);
      state.nodes.push({
        id: pending.id, parentId: null, rootId: pending.id, depth: 0, mode: state.mode,
        sourceText: text, label: '', principle: '', essence: '', reasoning: '', keywords: [],
        thinking: '', guidance: '', isActionable: false, createdAt: Date.now(),
        error: err.message, retry: { text, mode: state.mode, parentId: null, kind: 'root', hint: '' },
      });
      state.currentRootId = pending.id;
      toast('拆解失败：' + err.message, true);
    } finally {
      state.pending = state.pending.filter((p) => p.id !== pending.id);
      btnSubmit.disabled = false;
      persist();
      renderAll();
    }
  }

  /* ---------------- 继续往前推 ---------------- */
  async function deriveFrom(nodeId, hint) {
    const node = state.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    if (state.pending.some((p) => p.kind === 'child' && p.parentId === node.id)) {
      toast('该节点正在推导中，请稍候…');
      return;
    }
    const pending = { id: uid(), kind: 'child', mode: 'derive', text: node.principle, parentId: node.id, hint: hint || '' };
    state.pending.push(pending);
    state.currentRootId = node.rootId;
    delete state.deriveDrafts[node.id];
    renderAll();

    try {
      const context = { depth: node.depth, ancestors: ancestorsOf(node).map((a) => ({ label: a.label, principle: a.principle, depth: a.depth })) };
      const res = await apiPost('/api/derive', { text: node.principle, mode: 'derive', context, hint: hint || '' });
      const child = {
        id: pending.id, parentId: node.id, rootId: node.rootId, depth: node.depth + 1, mode: 'derive',
        sourceText: node.principle, label: res.data.label || '', principle: res.data.principle || '',
        essence: '', reasoning: res.data.reasoning || '',
        keywords: Array.isArray(res.data.keywords) ? res.data.keywords : [],
        thinking: res.thinking || '', guidance: hint || '', isActionable: !!res.data.isActionable,
        createdAt: Date.now(),
      };
      state.nodes.push(child);
      toast(`🔁 已往前推到第 ${child.depth} 层`);
    } catch (err) {
      state.nodes.push({
        id: pending.id, parentId: node.id, rootId: node.rootId, depth: node.depth + 1, mode: 'derive',
        sourceText: node.principle, label: '', principle: '', essence: '', reasoning: '', keywords: [],
        thinking: '', guidance: hint || '', isActionable: false, createdAt: Date.now(),
        error: err.message, retry: { text: node.principle, mode: 'derive', parentId: node.id, kind: 'child', hint: hint || '' },
      });
      toast('推导失败：' + err.message, true);
    } finally {
      state.pending = state.pending.filter((p) => p.id !== pending.id);
      persist();
      renderAll();
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
        thinking: res.thinking || '', guidance: pending.hint || '', isActionable: !!res.data.isActionable,
        createdAt: Date.now(),
      });
    } catch (err) {
      state.nodes.push({
        id: pending.id, parentId, rootId: pending.id, depth: 0, mode: 'derive',
        sourceText: text, label: '', principle: '', essence: '', reasoning: '', keywords: [],
        thinking: '', guidance: pending.hint || '', isActionable: false, createdAt: Date.now(),
        error: err.message, retry: { text, mode: 'derive', parentId, kind: 'child', hint: pending.hint || '' },
      });
    }
  }

  function retryNode(nodeId) {
    const node = state.nodes.find((n) => n.id === nodeId);
    if (!node || !node.retry) return;
    state.nodes = state.nodes.filter((n) => n.id !== nodeId);
    const { text, mode, parentId, kind, hint } = node.retry;
    const pending = { id: uid(), kind, mode, text, parentId, hint: hint || '' };
    state.pending.push(pending);
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
        thinking: res.thinking || '', guidance: '', isActionable: !!res.data.isActionable,
        createdAt: Date.now(),
      });
      state.currentRootId = pending.id;
    } catch (err) {
      state.nodes.push({
        id: pending.id, parentId: null, rootId: pending.id, depth: 0, mode,
        sourceText: text, label: '', principle: '', essence: '', reasoning: '', keywords: [],
        thinking: '', guidance: '', isActionable: false, createdAt: Date.now(),
        error: err.message, retry: { text, mode, parentId: null, kind: 'root', hint: '' },
      });
      state.currentRootId = pending.id;
    }
  }

  /** 重新推导本层：删除链的最后一个节点，用相同参数（含原补充）重新生成 */
  function rederiveLast() {
    if (!state.currentRootId) return;
    const chain = chainNodesOf(state.currentRootId);
    const last = chain[chain.length - 1];
    if (!last || last.depth === 0) { toast('当前没有可重新推导的层级', true); return; }
    if (state.pending.some((p) => p.kind === 'child' && p.parentId === last.parentId)) {
      toast('正在推导中，请稍候…');
      return;
    }
    const parentId = last.parentId;
    const hint = last.guidance || '';
    state.nodes = state.nodes.filter((n) => n.id !== last.id);
    delete state.summaries[state.currentRootId];
    persist();
    renderAll();
    toast('🔄 正在重新推导本层…');
    deriveFrom(parentId, hint);
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
    const removedRoots = state.nodes.filter((n) => ids.has(n.id) && n.parentId == null).map((n) => n.id);
    state.nodes = state.nodes.filter((n) => !ids.has(n.id));
    removedRoots.forEach((rid) => delete state.summaries[rid]);
    if (state.currentRootId && ids.has(state.currentRootId)) {
      const rest = sessions();
      state.currentRootId = rest.length ? rest[0].id : null;
    }
    persist();
    renderAll();
    toast('已删除节点及其子节点');
  }

  /* ---------------- 渲染：主区 ---------------- */
  function saveDeriveDrafts() {
    document.querySelectorAll('.node-card[data-id] .derive-input').forEach((input) => {
      const card = input.closest('.node-card');
      if (card && card.dataset.id) state.deriveDrafts[card.dataset.id] = input.value;
    });
  }

  function renderMain() {
    saveDeriveDrafts();
    const hasData = state.nodes.length > 0 || state.pending.length > 0;

    if (!hasData) {
      mainContent.innerHTML = `
        <div class="main-empty">
          <div class="empty-icon">🧭</div>
          <p>从上方输入一个目的，或粘贴一段随心所想的长文本</p>
          <p class="empty-sub">我会拆出达成它的前置目的（“先要…”，一层层往前推），全程大白话，直到一听就懂。</p>
        </div>`;
      return;
    }

    // 保证存在当前会话
    if (!state.currentRootId) {
      const roots = sessions();
      state.currentRootId = roots.length ? roots[0].id : null;
    }

    const childrenOf = buildChildrenMap();
    const root = state.nodes.find((n) => n.id === state.currentRootId);
    const rootPending = state.pending.find((p) => p.kind === 'root');
    const frag = document.createDocumentFragment();

    if (root) {
      frag.appendChild(buildGoalCard(root));

      if (state.chainCollapsed) {
        const placeholder = document.createElement('div');
        placeholder.className = 'chain-collapsed';
        const { count, maxDepth } = chainStats(root.id);
        placeholder.innerHTML = `本轮已收起（L0–L${maxDepth} · ${count} 个节点）— 点击展开`;
        placeholder.addEventListener('click', () => {
          state.chainCollapsed = false;
          persist();
          renderAll();
        });
        frag.appendChild(placeholder);
      } else {
        const chainWrap = document.createElement('div');
        appendNodeWithKids(chainWrap, root, childrenOf);
        frag.appendChild(chainWrap);
      }

      frag.appendChild(buildChainActions(root));
      frag.appendChild(buildSummaryCard(root.id));
    } else if (rootPending) {
      // 新会话加载中
      frag.appendChild(buildPendingCard(rootPending));
    }

    mainContent.innerHTML = '';
    mainContent.appendChild(frag);
  }

  function appendNodeWithKids(frag, node, childrenOf) {
    frag.appendChild(buildNodeCard(node));
    // 进行中的子推导
    for (const pk of state.pending.filter((p) => p.kind === 'child' && p.parentId === node.id)) {
      frag.appendChild(chainArrow());
      frag.appendChild(buildPendingCard(pk));
    }
    for (const kid of childrenOf.get(node.id) || []) {
      frag.appendChild(chainArrow());
      appendNodeWithKids(frag, kid, childrenOf);
    }
  }

  function chainArrow() {
    const el = document.createElement('div');
    el.className = 'chain-arrow';
    el.innerHTML = `<div class="line"></div><div class="arr">▼</div>`;
    return el;
  }

  /* ---------- 目标卡片 ---------- */
  function buildGoalCard(root) {
    const el = document.createElement('div');
    el.className = 'goal-card';
    const meta = MODE_META[root.mode] || MODE_META.goal;
    const sourceHtml = root.sourceText
      ? `<details class="goal-source"><summary>📥 展开原始输入（${root.sourceText.length} 字）</summary><pre>${escapeHtml(root.sourceText)}</pre></details>`
      : '';
    el.innerHTML = `
      <div class="goal-tag">🎯 你的目标 · ${meta.icon} ${meta.label}</div>
      <div class="goal-essence">${escapeHtml(sessionEssence(root))}</div>
      ${sourceHtml}`;
    return el;
  }

  /* ---------- 节点卡片 ---------- */
  function buildNodeCard(node) {
    const el = document.createElement('div');
    const color = colorOf(node.depth);
    el.className = 'node-card' + (node.isActionable ? ' actionable' : '');
    el.dataset.id = node.id;
    el.style.setProperty('--node-color', color);
    const meta = MODE_META[node.mode] || MODE_META.derive;

    if (node.error) {
      el.classList.add('error');
      el.innerHTML = `
        <div class="node-top">
          <span class="depth-badge">第 ${node.depth} 层</span>
          <span class="mode-badge">⚠ 失败</span>
          <span class="node-time">${fmtTime(node.createdAt)}</span>
        </div>
        <div class="error-msg">${escapeHtml(node.error)}</div>
        <div class="node-actions">
          <button class="action-btn">↻ 重试</button>
          <button class="action-btn" data-act="del">🗑 删除</button>
        </div>`;
      el.querySelector('.action-btn').addEventListener('click', () => retryNode(node.id));
      el.querySelector('[data-act="del"]').addEventListener('click', () => deleteNode(node.id));
      return el;
    }

    const labelHtml = node.label
      ? `<div class="node-label">${escapeHtml(node.label)}<span class="origin">由 “${escapeHtml(shortStr(node.depth > 0 ? (state.nodes.find((n) => n.id === node.parentId)?.label || node.sourceText) : node.sourceText, 12))}” ${node.depth === 0 ? '' : '往前推'}</span></div>` : '';

    const guidanceHtml = node.guidance
      ? `<div class="guidance-tag"><b>结合你的补充：</b>${escapeHtml(node.guidance)}</div>` : '';

    const reasoningHtml = node.reasoning
      ? `<details class="think-block"><summary>🧠 为什么（展开看推导依据）</summary><pre>${escapeHtml(node.reasoning)}</pre></details>` : '';

    const thinkHtml = node.thinking
      ? `<details class="think-block"><summary>💭 模型思考过程（可展开）</summary><pre>${escapeHtml(node.thinking)}</pre></details>` : '';

    const kwHtml = node.keywords && node.keywords.length
      ? `<div class="node-keywords">${node.keywords.map((k) => `<span class="kw">${escapeHtml(k)}</span>`).join('')}</div>` : '';

    el.innerHTML = `
      <div class="node-top">
        <span class="depth-badge">第 ${node.depth} 层${node.depth === 0 ? ' · 原始' : ''}</span>
        <span class="mode-badge">${meta.icon} ${meta.label}</span>
        ${node.isActionable ? '<span class="action-badge">⚡ 现在就能做</span>' : ''}
        <span class="node-time">${fmtTime(node.createdAt)}</span>
      </div>
      ${labelHtml}
      <div class="node-principle">${escapeHtml(node.principle)}</div>
      ${guidanceHtml}
      ${kwHtml}
      ${reasoningHtml}
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
          <button class="action-btn" data-act="derive-go">⚡ 继续往前推</button>
        </div>
      </div>`;

    const deriveInput = el.querySelector('.derive-input');
    deriveInput.value = state.deriveDrafts[node.id] || '';

    const goBtn = el.querySelector('[data-act="derive-go"]');
    const deriving = state.pending.some((p) => p.kind === 'child' && p.parentId === node.id);
    if (deriving) {
      goBtn.disabled = true;
      goBtn.textContent = '⏳ 推导中…';
    }
    goBtn.addEventListener('click', () => deriveFrom(node.id, deriveInput.value.trim()));

    el.querySelector('[data-act="copy"]').addEventListener('click', () => {
      navigator.clipboard.writeText(node.principle).then(
        () => toast('已复制到剪贴板'),
        () => toast('复制失败', true)
      );
    });
    el.querySelector('[data-act="del"]').addEventListener('click', () => deleteNode(node.id));
    return el;
  }

  function buildPendingCard(p) {
    const el = document.createElement('div');
    const meta = MODE_META[p.mode] || MODE_META.derive;
    el.className = 'node-card loading';
    el.dataset.pendingId = p.id;
    el.innerHTML = `
      <div class="node-top">
        <span class="depth-badge">${p.kind === 'root' ? '第 0 层' : '↓'}</span>
        <span class="mode-badge">${meta.icon} ${meta.label}</span>
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
    return el;
  }

  /* ---------- 底部操作条 ---------- */
  function buildChainActions(root) {
    const el = document.createElement('div');
    el.className = 'chain-actions';
    const chain = chainNodesOf(root.id);
    const canRedo = chain.length > 1;
    const pending = state.pending.length > 0;
    const collapsed = state.chainCollapsed;
    const last = chain[chain.length - 1];

    const btnDerive = mkActionBtn('🔁 继续推导（+补充想法）', 'ca-derive');
    btnDerive.addEventListener('click', () => {
      if (state.chainCollapsed) { state.chainCollapsed = false; persist(); renderAll(); }
      // 滚动到最后一个节点的输入框并聚焦
      setTimeout(() => {
        const cards = document.querySelectorAll('.node-card[data-id]');
        const lastCard = cards[cards.length - 1];
        if (lastCard) {
          lastCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
          const input = lastCard.querySelector('.derive-input');
          if (input) setTimeout(() => input.focus(), 450);
        }
      }, 60);
    });

    const btnSummary = mkActionBtn('📋 生成总结', 'ca-summary');
    btnSummary.addEventListener('click', summarize);

    const btnRedo = mkActionBtn('🔄 重新推导本层', 'ca-redo');
    btnRedo.disabled = !canRedo || pending;
    btnRedo.addEventListener('click', rederiveLast);

    const btnCollapse = mkActionBtn(collapsed ? '📂 展开本轮' : '📁 收起本轮', 'ca-collapse');
    btnCollapse.addEventListener('click', () => {
      state.chainCollapsed = !state.chainCollapsed;
      persist();
      renderAll();
    });

    el.appendChild(btnDerive);
    el.appendChild(btnSummary);
    el.appendChild(btnRedo);
    el.appendChild(btnCollapse);
    return el;

    function mkActionBtn(label, cls) {
      const b = document.createElement('button');
      b.className = 'btn btn-small ' + cls;
      b.textContent = label;
      return b;
    }
  }

  /* ---------- 总结卡片 ---------- */
  function buildSummaryCard(rootId) {
    const el = document.createElement('div');
    el.className = 'summary-card';
    const data = state.summaries[rootId];

    const head = document.createElement('div');
    head.className = 'summary-head';
    head.innerHTML = '<h3>📋 总结</h3>';
    const reBtn = document.createElement('button');
    reBtn.className = 'btn btn-small';
    reBtn.textContent = data ? '重新生成' : '生成总结';
    reBtn.addEventListener('click', summarize);
    head.appendChild(reBtn);
    el.appendChild(head);

    const body = document.createElement('div');
    body.className = 'summary-body';

    if (state.summaryLoading) {
      body.innerHTML = '<div class="summary-loading"><div class="spinner"></div>正在串联整条目的链…</div>';
    } else if (!data) {
      body.innerHTML = '<p class="muted">把整条目的链汇总后，生成整体洞察：最终想达成什么、一步步要先达成什么、最该先做的第一件事。</p>';
    } else {
      const mdHtml = Md.toHtml(data.summary);
      const themesHtml = data.themes && data.themes.length
        ? `<div class="summary-themes"><h4>🔗 共同主题</h4><div class="node-keywords">${data.themes.map((t) => `<span class="kw">${escapeHtml(t)}</span>`).join('')}</div></div>` : '';
      const actionsHtml = data.actions && data.actions.length
        ? `<div class="summary-actions"><h4>🚀 行动建议</h4><ul>${data.actions.map((a) => `<li>${escapeHtml(a)}</li>`).join('')}</ul></div>` : '';
      const thinkHtml = data.thinking
        ? `<details class="think-block"><summary>💭 模型思考过程（可展开）</summary><pre>${escapeHtml(data.thinking)}</pre></details>` : '';
      body.innerHTML = `<div class="md">${mdHtml}</div>${themesHtml}${actionsHtml}${thinkHtml}`;
    }
    el.appendChild(body);
    return el;
  }

  async function summarize() {
    if (!state.currentRootId) { toast('请先选择一个会话', true); return; }
    const chain = chainNodesOf(state.currentRootId);
    if (chain.length === 0) { toast('还没有可总结的节点', true); return; }
    state.summaryLoading = true;
    renderAll();
    try {
      const payload = chain.map((n) => ({
        label: n.label, principle: n.principle, essence: n.essence, depth: n.depth, mode: n.mode,
      }));
      const res = await apiPost('/api/summarize', { nodes: payload });
      state.summaries[state.currentRootId] = {
        summary: (res.data && res.data.summary) || '',
        themes: (res.data && res.data.themes) || [],
        actions: (res.data && res.data.actions) || [],
        thinking: res.thinking || '',
      };
      toast('✅ 总结已生成');
    } catch (err) {
      toast('生成总结失败：' + err.message, true);
    } finally {
      state.summaryLoading = false;
      persist();
      renderAll();
    }
  }

  /* ---------------- 图谱 ---------------- */
  function renderTree() {
    const hasData = state.nodes.length > 0;
    vizEmpty.style.display = hasData ? 'none' : 'grid';
    if (!hasData) { svg.setAttribute('viewBox', '0 0 100 100'); return; }
    FirstPrinciplesTree.renderTree(svg, state.nodes, focusNode);
  }

  function focusNode(id) {
    const node = state.nodes.find((n) => n.id === id);
    if (!node) return;
    if (node.rootId !== state.currentRootId) {
      state.currentRootId = node.rootId;
      state.chainCollapsed = false;
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

  /* ---------------- 导出 / 清空 ---------------- */
  $('#btnExport').addEventListener('click', exportMarkdown);

  function exportMarkdown() {
    if (state.nodes.length === 0) { toast('暂无内容可导出', true); return; }
    const childrenOf = buildChildrenMap();
    const roots = sessions().reverse(); // 按时间正序
    const lines = ['# ⚛️ 第一性原理拆解记录', '', `> 生成时间：${new Date().toLocaleString('zh-CN')}`, ''];
    roots.forEach((root, i) => {
      lines.push(`## 会话 ${i + 1}：${sessionEssence(root)}`, '');
      walkMd(root, childrenOf, lines, 0);
      const s = state.summaries[root.id];
      if (s && s.summary) {
        lines.push('**总结**：' + s.summary, '');
        if (s.themes && s.themes.length) lines.push('**共同主题**：' + s.themes.join('、'), '');
        if (s.actions && s.actions.length) {
          lines.push('**行动建议**：');
          s.actions.forEach((a) => lines.push(`- ${a}`));
        }
        lines.push('');
      }
    });
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
    if (node.guidance) lines.push(`${indent}- 💬 结合补充：${node.guidance}`);
    if (node.isActionable) lines.push(`${indent}- ⚡ 现在就能做`);
    if (node.reasoning) lines.push(`${indent}- 🧠 为什么：${node.reasoning}`);
    lines.push('');
    for (const k of childrenOf.get(node.id) || []) walkMd(k, childrenOf, lines, depth + 1);
  }

  $('#btnClear').addEventListener('click', () => {
    if (state.nodes.length === 0) { toast('当前没有记录'); return; }
    if (!confirm('确定清空所有拆解记录与图谱吗？')) return;
    state.nodes = [];
    state.summaries = {};
    state.currentRootId = null;
    state.chainCollapsed = false;
    persist();
    renderAll();
    toast('已清空');
  });

  /* ---------------- 图谱缩放（侧栏） ---------------- */
  function ensureVizTools() {
    const wrap = $('#vizWrap');
    if (wrap.querySelector('.viz-tools')) return;
    const tools = document.createElement('div');
    tools.className = 'viz-tools';
    tools.innerHTML = `
      <button class="icon-btn" data-viz="out" title="缩小">−</button>
      <button class="icon-btn" data-viz="in" title="放大">+</button>
      <button class="icon-btn" data-viz="fit" title="适应窗口">⤢</button>`;
    tools.querySelector('[data-viz="out"]').addEventListener('click', () => {
      const cur = svg._fp || { scale: 1, tx: 0, ty: 0 };
      FirstPrinciplesTree.applyTransform(svg, Math.max(cur.scale / 1.2, 0.15), cur.tx, cur.ty);
    });
    tools.querySelector('[data-viz="in"]').addEventListener('click', () => {
      const cur = svg._fp || { scale: 1, tx: 0, ty: 0 };
      FirstPrinciplesTree.applyTransform(svg, cur.scale * 1.2, cur.tx, cur.ty);
    });
    tools.querySelector('[data-viz="fit"]').addEventListener('click', () => {
      const vb = svg.viewBox.baseVal;
      FirstPrinciplesTree.fitToView(svg, vb.width, vb.height);
    });
    wrap.appendChild(tools);
  }

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

  /* ---------------- 主题（深色 / 浅色） ---------------- */
  const THEME_KEY = 'fp-theme';
  const themeBtn = $('#btnTheme');

  function applyTheme(t, persistIt) {
    document.documentElement.dataset.theme = t;
    if (persistIt !== false) {
      try { localStorage.setItem(THEME_KEY, t); } catch (_) { /* 忽略 */ }
    }
    themeBtn.textContent = t === 'dark' ? '☀️' : '🌙';
    themeBtn.title = t === 'dark' ? '切换到浅色主题' : '切换到深色主题';
    renderTree(); // 图谱灰阶跟随主题
  }

  function initTheme() {
    let t = null;
    try { t = localStorage.getItem(THEME_KEY); } catch (_) { /* 忽略 */ }
    if (t !== 'dark' && t !== 'light') {
      t = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    }
    applyTheme(t, false);
  }

  themeBtn.addEventListener('click', () => {
    applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
    toast('已切换为' + (document.documentElement.dataset.theme === 'dark' ? '深色' : '浅色') + '主题');
  });

  /* ---------------- 汇总渲染 ---------------- */
  function renderAll() {
    renderMain();
    renderSidebar();
    renderTree();
    ensureVizTools();
  }

  /* ---------------- 启动 ---------------- */
  initTheme();
  restore();
  if (!state.currentRootId) {
    const roots = sessions();
    if (roots.length) state.currentRootId = roots[0].id;
  }
  FirstPrinciplesTree.setupPanZoom(svg);
  renderAll();
  checkHealth();
  setInterval(checkHealth, 30000);

  window.addEventListener('resize', () => {
    const vb = svg.viewBox.baseVal;
    if (vb.width > 0) FirstPrinciplesTree.fitToView(svg, vb.width, vb.height);
  });

  // PWA：注册 Service Worker（相对路径，适配子路径部署）
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => { /* 忽略（如不支持/离线） */ });
    });
  }
})();
