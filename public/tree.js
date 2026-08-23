/* ============================================================
   FirstPrinciplesEngine · SVG 树形可视化
   依赖：无。自动布局（叶子序 tidy 布局，链式/多叉树均无重叠），
   支持滚轮缩放、拖拽平移、点击节点回调。
   ============================================================ */
(function () {
  'use strict';

  const NODE_W = 172;
  const NODE_H = 60;
  const H_GAP = 52;   // 叶子间水平间距
  const V_GAP = 108;  // 层间垂直间距
  const PAD = 24;

  const DEPTH_COLORS = ['#818cf8', '#22d3ee', '#34d399', '#fbbf24', '#fb7185', '#a78bfa', '#f472b6', '#38bdf8'];

  function colorOf(depth) {
    return DEPTH_COLORS[Math.min(Math.max(depth, 0), DEPTH_COLORS.length - 1)];
  }

  function shortLabel(text, max) {
    const s = String(text || '').trim();
    if (!s) return '（未命名）';
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  }

  /* ---------- 布局：返回 {roots, nodeMap}，并为每个节点附加 _x/_y/_depth ---------- */
  function layout(nodes) {
    const byParent = new Map();
    const roots = [];
    for (const n of nodes) {
      if (n.parentId == null) roots.push(n);
      else {
        if (!byParent.has(n.parentId)) byParent.set(n.parentId, []);
        byParent.get(n.parentId).push(n);
      }
    }
    roots.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    for (const arr of byParent.values()) arr.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

    let leaf = 0;
    const nodeMap = new Map();
    function walk(n, depth) {
      n._depth = depth;
      nodeMap.set(n.id, n);
      const kids = byParent.get(n.id) || [];
      if (kids.length === 0) {
        n._x = leaf++;
        n._y = depth;
        return n._x;
      }
      const xs = kids.map((k) => walk(k, depth + 1));
      n._x = (Math.min(...xs) + Math.max(...xs)) / 2;
      n._y = depth;
      return n._x;
    }
    for (const r of roots) walk(r, 0);
    return { roots, nodeMap };
  }

  /* ---------- 渲染 ---------- */
  function renderTree(container, nodes, onNodeClick) {
    const svg = container;
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    if (!nodes || nodes.length === 0) {
      svg.setAttribute('viewBox', '0 0 100 100');
      return;
    }

    const { roots, nodeMap } = layout(nodes);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const pos = new Map();
    for (const n of nodeMap.values()) {
      const px = PAD + n._x * (NODE_W + H_GAP);
      const py = PAD + n._y * (NODE_H + V_GAP);
      pos.set(n.id, { x: px, y: py, color: colorOf(n._depth) });
      if (px < minX) minX = px;
      if (py < minY) minY = py;
      if (px + NODE_W > maxX) maxX = px + NODE_W;
      if (py + NODE_H > maxY) maxY = py + NODE_H;
    }
    const bw = maxX - minX + PAD * 2;
    const bh = maxY - minY + PAD * 2;

    const NS = 'http://www.w3.org/2000/svg';
    const viewport = document.createElementNS(NS, 'g');
    viewport.setAttribute('id', 'viewport');
    svg.appendChild(viewport);

    // —— 边（先画，保证节点在上层）——
    for (const n of nodeMap.values()) {
      if (n.parentId == null) continue;
      const parent = nodeMap.get(n.parentId);
      if (!parent) continue;
      const p = pos.get(parent.id);
      const c = pos.get(n.id);
      const x1 = p.x + NODE_W / 2, y1 = p.y + NODE_H;
      const x2 = c.x + NODE_W / 2, y2 = c.y;
      const bend = Math.max(18, (y2 - y1) / 2);
      const path = document.createElementNS(NS, 'path');
      path.setAttribute('d', `M ${x1} ${y1} C ${x1} ${y1 + bend}, ${x2} ${y2 - bend}, ${x2} ${y2}`);
      path.setAttribute('class', 'fp-edge');
      path.setAttribute('stroke', c.color);
      path.setAttribute('style', `--nc:${c.color}`);
      viewport.appendChild(path);
    }

    // —— 节点 ——
    for (const n of nodeMap.values()) {
      const { x, y, color } = pos.get(n.id);
      const g = document.createElementNS(NS, 'g');
      g.setAttribute('class', 'fp-node');
      g.setAttribute('style', `--nc:${color}`);
      g.setAttribute('data-id', n.id);

      const rect = document.createElementNS(NS, 'rect');
      rect.setAttribute('class', 'node-box');
      rect.setAttribute('x', x);
      rect.setAttribute('y', y);
      rect.setAttribute('width', NODE_W);
      rect.setAttribute('height', NODE_H);
      rect.setAttribute('rx', 12);
      rect.setAttribute('stroke', color);
      g.appendChild(rect);

      const depthT = document.createElementNS(NS, 'text');
      depthT.setAttribute('class', 'node-depth-t');
      depthT.setAttribute('x', x + NODE_W / 2);
      depthT.setAttribute('y', y + 18);
      depthT.setAttribute('style', `--nc:${color}`);
      depthT.textContent = `L${n._depth}`;
      g.appendChild(depthT);

      const labelT = document.createElementNS(NS, 'text');
      labelT.setAttribute('class', 'node-label-t');
      labelT.setAttribute('x', x + NODE_W / 2);
      labelT.setAttribute('y', y + 40);
      labelT.textContent = shortLabel(n.label || n.principle, 15);
      g.appendChild(labelT);

      // 透明点击区
      const hit = document.createElementNS(NS, 'rect');
      hit.setAttribute('x', x - 4);
      hit.setAttribute('y', y - 4);
      hit.setAttribute('width', NODE_W + 8);
      hit.setAttribute('height', NODE_H + 8);
      hit.setAttribute('fill', 'transparent');
      hit.style.cursor = 'pointer';
      hit.addEventListener('click', () => onNodeClick && onNodeClick(n.id));
      g.appendChild(hit);

      viewport.appendChild(g);
    }

    // 初始适配：让整棵树尽量完整可见
    svg.setAttribute('viewBox', `${-PAD} ${-PAD} ${bw} ${bh}`);
    fitToView(svg, bw, bh);

    return { roots, nodeMap };
  }

  /* ---------- 缩放 / 平移 ---------- */
  function fitToView(svg, bw, bh) {
    const wrap = svg.parentElement;
    const cw = wrap.clientWidth || 600;
    const ch = wrap.clientHeight || 380;
    const scale = Math.min(cw / bw, ch / bh, 1.15);
    const tx = (cw - bw * scale) / 2;
    const ty = (ch - bh * scale) / 2;
    const viewport = svg.querySelector('#viewport');
    if (viewport) {
      viewport.setAttribute('transform', `translate(${tx} ${ty}) scale(${scale})`);
      svg._fp = { scale, tx, ty };
    }
  }

  function setupPanZoom(svg) {
    let dragging = false, startX = 0, startY = 0, startT = null;

    svg.addEventListener('mousedown', (e) => {
      if (e.target.closest && e.target.closest('.fp-node')) return; // 点击节点不拖拽
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      startT = svg._fp || { scale: 1, tx: 0, ty: 0 };
      svg.classList.add('dragging');
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      applyTransform(svg, startT.scale, startT.tx + dx, startT.ty + dy);
    });
    window.addEventListener('mouseup', () => {
      dragging = false;
      svg.classList.remove('dragging');
    });

    svg.addEventListener('wheel', (e) => {
      e.preventDefault();
      const cur = svg._fp || { scale: 1, tx: 0, ty: 0 };
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      const next = Math.min(Math.max(cur.scale * factor, 0.15), 4);
      const rect = svg.getBoundingClientRect();
      // 以鼠标位置为中心缩放
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const k = next / cur.scale;
      const tx = px - (px - cur.tx) * k;
      const ty = py - (py - cur.ty) * k;
      applyTransform(svg, next, tx, ty);
    }, { passive: false });

    svg.addEventListener('dblclick', () => {
      const wrap = svg.parentElement;
      const vb = svg.viewBox.baseVal;
      fitToView(svg, vb.width, vb.height);
    });
  }

  function applyTransform(svg, scale, tx, ty) {
    const viewport = svg.querySelector('#viewport');
    if (!viewport) return;
    viewport.setAttribute('transform', `translate(${tx} ${ty}) scale(${scale})`);
    svg._fp = { scale, tx, ty };
  }

  window.FirstPrinciplesTree = { renderTree, setupPanZoom, colorOf, fitToView, applyTransform };
})();
