/* ============================================================
   FirstPrinciplesEngine · 轻量 Markdown 渲染（零依赖）
   支持：标题、粗体/斜体、行内代码、代码块、无序/有序列表、
   引用、链接、段落与换行。输入先 HTML 转义再渲染。
   ============================================================ */
(function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** 行内样式：粗体 / 斜体 / 行内代码 / 链接 */
  function inline(s) {
    return esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  }

  /** 把一段 markdown 文本渲染为 HTML */
  function mdToHtml(src) {
    if (!src) return '';
    const lines = String(src).replace(/\r\n/g, '\n').split('\n');
    const out = [];
    let inCode = false;
    let codeBuf = [];
    let inList = false;
    let listType = null;

    const flushList = () => {
      if (inList) { out.push(`</${listType}>`); inList = false; listType = null; }
    };

    for (const raw of lines) {
      // 代码块
      if (/^```/.test(raw)) {
        if (inCode) { out.push('<pre><code>' + esc(codeBuf.join('\n')) + '</code></pre>'); codeBuf = []; inCode = false; }
        else { flushList(); inCode = true; }
        continue;
      }
      if (inCode) { codeBuf.push(raw); continue; }

      const t = raw.trim();
      if (!t) { flushList(); out.push(''); continue; }

      // 标题
      const h = t.match(/^(#{1,4})\s+(.*)$/);
      if (h) { flushList(); const lvl = h[1].length; out.push(`<h${lvl + 1}>${inline(h[2])}</h${lvl + 1}>`); continue; }

      // 引用
      if (/^>\s?/.test(t)) { flushList(); out.push(`<blockquote>${inline(t.replace(/^>\s?/, ''))}</blockquote>`); continue; }

      // 无序列表
      const ul = t.match(/^[-•]\s+(.*)$/);
      if (ul) {
        if (!inList) { inList = true; listType = 'ul'; out.push('<ul>'); }
        out.push(`<li>${inline(ul[1])}</li>`);
        continue;
      }
      // 有序列表
      const ol = t.match(/^\d+[.、]\s+(.*)$/);
      if (ol) {
        if (!inList) { inList = true; listType = 'ol'; out.push('<ol>'); }
        out.push(`<li>${inline(ol[1])}</li>`);
        continue;
      }

      flushList();
      out.push(`<p>${inline(t)}</p>`);
    }
    if (inCode) out.push('<pre><code>' + esc(codeBuf.join('\n')) + '</code></pre>');
    flushList();
    return out.join('\n');
  }

  window.Md = { toHtml: mdToHtml };
})();
