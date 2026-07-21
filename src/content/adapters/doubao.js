// doubao.js — 豆包 (doubao.com) 平台 adapter
// 入口:
//   runDoubaoTask(query, config)      —— 全流程
//   collectDoubaoPage(config)         —— 仅采集
//
// DOM 参考: docs/adapters/doubao.md
// 关键锚:
//   输入框: textarea.semi-input-textarea (React 受控,需 native setter)
//   发送按钮: button (svg class 含 send-msg-btn)
//   停止按钮: div.size-34.rounded-full[data-trigger-type=hover](与发送同位置替换)
//   消息容器: .list_items > .v_list_row[data-observe-row=block_...]
//   消息 id: [data-message-id]
//   消息类型: [data-plugin-identifier=block_type:10000] 是用户(经验值,需最终验证)

(function () {
  const G = globalThis.GEO;

  async function findInput() {
    const selectors = ['textarea.semi-input-textarea', 'textarea', 'div[contenteditable=true]'];
    for (let attempt = 0; attempt < 20; attempt++) {
      for (const sel of selectors) {
        // 多个 textarea 时取输入区那个:排除隐藏 + 排除位置太靠顶
        const list = [...document.querySelectorAll(sel)].filter((e) => e.offsetParent !== null);
        list.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
        if (list[0]) return list[0];
      }
      await G.sleep(500);
    }
    return null;
  }

  // 用 React native setter 触发受控组件更新
  async function typeReact(el, text) {
    el.focus();
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    // 清空 + 逐字追加(拟人)
    setter.call(el, '');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    let cur = '';
    for (const ch of text) {
      cur += ch;
      setter.call(el, cur);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch, inputType: 'insertText' }));
      await G.sleep(G.rand(30, 90));
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function findSendButton() {
    return [...document.querySelectorAll('button')].find((b) => {
      if (!b.offsetParent) return false;
      const svg = b.querySelector('svg');
      return svg && /send-msg-btn/i.test(svg.getAttribute('class') || '');
    }) || null;
  }

  function findStopElement() {
    // 停止图标特征:size-34.rounded-full 里的 svg path 以 "M12 0.5C18.3513" 开头(圆圈内套方块)
    return [...document.querySelectorAll('div.size-34.rounded-full')].find((d) => {
      if (!d.offsetParent) return false;
      const p = d.querySelector('svg path');
      if (!p) return false;
      return /^M12 0\.5C18/.test(p.getAttribute('d') || '');
    }) || null;
  }

  function isDoubaoGenerating() {
    // 生成中:无 send-btn-wrapper && 有停止 icon
    const sendWrap = document.querySelector('div.send-btn-wrapper');
    if (sendWrap && sendWrap.offsetParent !== null) return false;
    return !!findStopElement();
  }

  // 最后一对 QA:遍历 .v_list_row[data-observe-row^=block_],取倒数两条
  function findLastQA() {
    const rows = [...document.querySelectorAll('.v_list_row[data-observe-row^="block_"]')].filter((r) => r.offsetParent !== null);
    if (!rows.length) return null;
    // 从后往前找,先助手后用户
    const isUser = (row) => !!row.querySelector('.bg-g-send-msg-bubble-bg');
    let assistantItem = null;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (!isUser(rows[i])) { assistantItem = rows[i]; break; }
    }
    if (!assistantItem) return null;
    let userItem = null;
    const idx = rows.indexOf(assistantItem);
    for (let i = idx - 1; i >= 0; i--) {
      if (isUser(rows[i])) { userItem = rows[i]; break; }
    }
    const list = document.querySelector('.list_items');
    return { userItem, assistantItem, qaAncestor: list || assistantItem.parentElement };
  }

  function answerRoot(qa) {
    const q = qa || findLastQA();
    if (!q || !q.assistantItem) return document.body;
    const md = q.assistantItem.querySelector('.md-box-root, [class*=markdown]');
    return md || q.assistantItem;
  }

  function loginRequired() {
    return /\/login|from_login=1|passport\./i.test(location.href);
  }

  // 豆包是虚拟列表: .list_items 里的 .v_list_row 全是 position:absolute + transform。
  // 直接截 .list_items 会导致 html-to-image 在独立 SVG 中丢失虚拟列表布局,
  // 且会混入历史消息/指示器。这里把当前 QA 对克隆到一个临时、自然流式的 wrapper 里,
  // 返回其 selector 给截图流程,截图后 common.js 会自动清理该 wrapper。
  function buildShotSelector(qa) {
    if (!qa || !qa.assistantItem) return null;
    // 清理历史临时截图包装器,避免累积
    try { document.querySelectorAll('.geo-shot-wrapper').forEach((el) => el.remove()); } catch {}
    const id = 'geo-shot-' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const wrapper = document.createElement('div');
    wrapper.id = id;
    wrapper.className = 'geo-shot-wrapper';
    wrapper.style.cssText = [
      'position:absolute',
      'left:0',
      'top:0',
      'z-index:-9999',
      'opacity:1',
      'background:#ffffff',
      'max-width:900px',
      'width:max-content',
      'pointer-events:none',
    ].join(';');

    const cloneRow = (row) => {
      const c = row.cloneNode(true);
      // 覆盖虚拟列表的 absolute/transform,让问答在自然流中垂直排列
      c.style.position = 'static';
      c.style.transform = 'none';
      c.style.top = 'auto';
      c.style.left = 'auto';
      c.style.width = '100%';
      c.style.maxHeight = 'none';
      c.style.overflow = 'visible';
      return c;
    };

    if (qa.userItem) wrapper.appendChild(cloneRow(qa.userItem));
    wrapper.appendChild(cloneRow(qa.assistantItem));
    document.body.appendChild(wrapper);
    return '#' + id;
  }

  async function collect(config = {}, ensureComplete = true, tr = null) {
    const cfg = { minChars: 400, maxWait: 240000, ...config };
    const qa = findLastQA();
    if (tr) tr.push('findLastQA', qa ? { user: !!qa.userItem, assistant: !!qa.assistantItem } : null);
    const root = answerRoot(qa);
    if (tr) tr.push('answerRoot', { tag: root.tagName, innerLen: (root.innerText || '').length });

    let text, timedOut = false;
    if (ensureComplete || isDoubaoGenerating()) {
      const r = await G.waitAnswerComplete({ root, minChars: cfg.minChars, maxWait: cfg.maxWait });
      text = r.text; timedOut = r.timedOut;
    } else {
      text = (root.innerText || '').trim();
    }
    if (tr) tr.push('collected', { chars: text.length, timedOut });

    const citations = G.extractCitations({ root: qa ? qa.assistantItem : document.body });
    if (tr) tr.push('citations', { n: citations.length });

    const shotSelector = buildShotSelector(qa);
    if (tr) tr.push('shotSelector', shotSelector);

    return {
      status: 'ok',
      text,
      answerHtml: root.innerHTML,
      answerChars: text.length,
      citations,
      qaHtml: qa ? qa.qaAncestor.outerHTML.slice(0, 200000) : null,
      qaSelector: shotSelector || '.list_items',
      url: location.href,
      timedOut,
    };
  }

  globalThis.runDoubaoTask = async function (query, config = {}) {
    const tr = G.makeTrace();
    tr.push('runDoubaoTask start', { url: location.href, query: String(query).slice(0, 60) });
    try {
      const box = await findInput();
      if (!box) { tr.push('input_not_found'); return { status: 'failed', error: 'input_not_found', trace: tr.steps }; }
      tr.push('input found', { tag: box.tagName });

      await typeReact(box, query);
      tr.push('typed (react setter)');
      await G.sleep(G.rand(600, 1000));

      const sendBtn = findSendButton();
      if (sendBtn) {
        sendBtn.click();
        tr.push('sent via send-msg-btn');
      } else {
        box.focus();
        box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
        tr.push('sent via Enter (send btn not found)');
      }

      await G.sleep(3500);
      if (loginRequired()) { tr.push('login_required'); return { status: 'login_required', trace: tr.steps }; }

      const out = await collect(config, true, tr);
      out.trace = tr.steps;
      return out;
    } catch (e) {
      tr.push('exception', String(e && e.message || e));
      return { status: 'failed', error: String(e && e.message || e), trace: tr.steps };
    }
  };

  globalThis.collectDoubaoPage = async function (config = {}) {
    const tr = G.makeTrace();
    tr.push('collectDoubaoPage start', { url: location.href });
    try {
      if (loginRequired()) { tr.push('login_required'); return { status: 'login_required', trace: tr.steps }; }
      const qa = findLastQA();
      if (!qa || !qa.assistantItem) return { status: 'failed', error: 'no_answer_on_page', trace: tr.steps };
      const len = (qa.assistantItem.innerText || '').trim().length;
      if (len < 20) return { status: 'failed', error: 'no_answer_on_page', trace: tr.steps };
      const out = await collect(config, false, tr);
      out.keyword = inferKeyword(qa);
      out.trace = tr.steps;
      return out;
    } catch (e) {
      tr.push('exception', String(e && e.message || e));
      return { status: 'failed', error: String(e && e.message || e), trace: tr.steps };
    }
  };

  function inferKeyword(qa) {
    const q = qa || findLastQA();
    if (q && q.userItem) {
      const bubble = q.userItem.querySelector('.bg-g-send-msg-bubble-bg') || q.userItem.querySelector('.md-box-root') || q.userItem;
      const t = (bubble.innerText || '').trim();
      if (t.length > 1) return t.slice(0, 200);
    }
    const title = (document.title || '').replace(/\s*[|\-–]\s*豆包.*$/i, '').trim();
    return title || '当前页面';
  }
})();
