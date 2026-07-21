// kimi.js — Kimi (kimi.com) 平台 adapter
// 入口:
//   runKimiTask(query, config)      —— 全流程:输入→提交→判完成→采集
//   collectKimiPage(config)         —— 仅采集当前已打开、已出答案的页面
// 依赖 common.js 已注入的 globalThis.GEO。
//
// DOM 参考: docs/adapters/kimi.md
// 关键锚:
//   输入框: div[contenteditable=true][data-lexical-editor=true]
//   发送/停止: .send-button-container (含 .disabled/.stop 修饰)
//   消息列表: .chat-content-list
//   消息条: .chat-content-item.chat-content-item-user / -assistant

(function () {
  const G = globalThis.GEO;

  async function findInput() {
    const selectors = [
      'div[contenteditable=true][data-lexical-editor=true]',
      'div[contenteditable=true]',
      'textarea',
    ];
    for (let attempt = 0; attempt < 20; attempt++) {
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && el.offsetParent !== null) return el;
      }
      await G.sleep(500);
    }
    return null;
  }

  function findSendButton() {
    return document.querySelector('.send-button-container:not(.disabled)');
  }

  function isKimiGenerating() {
    return !!document.querySelector('.send-button-container.stop');
  }

  // 拿到最后一对 QA 的最小容器:两个连续的 .chat-content-item 的父节点(.chat-content-list)
  // 返回 { userItem, assistantItem, qaAncestor } 或 null
  function findLastQA() {
    const list = document.querySelector('.chat-content-list');
    if (!list) return null;
    const items = [...list.querySelectorAll(':scope > .chat-content-item')];
    if (!items.length) return null;
    // 从后往前找最后一个 assistant
    let assistantItem = null;
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i].classList.contains('chat-content-item-assistant')) { assistantItem = items[i]; break; }
    }
    if (!assistantItem) return null;
    // assistant 前面最近的 user
    let userItem = null;
    const idx = items.indexOf(assistantItem);
    for (let i = idx - 1; i >= 0; i--) {
      if (items[i].classList.contains('chat-content-item-user')) { userItem = items[i]; break; }
    }
    return { userItem, assistantItem, qaAncestor: list };
  }

  // 回答正文:assistant item 里的 markdown 主体
  function answerRoot(qa) {
    const q = qa || findLastQA();
    if (!q || !q.assistantItem) return document.body;
    // 优先 markdown 类
    const md = q.assistantItem.querySelector('.segment-content-box, .markdown, [class*=markdown], .prose');
    return md || q.assistantItem;
  }

  function loginRequired() {
    return /\/login|\/signin/i.test(location.href);
  }

  async function collect(config = {}, ensureComplete = true, tr = null) {
    const cfg = { minChars: 400, maxWait: 240000, ...config };
    const qa = findLastQA();
    if (tr) tr.push('findLastQA', qa ? { user: !!qa.userItem, assistant: !!qa.assistantItem, ancestor: qa.qaAncestor.className.slice(0, 40) } : null);
    const root = answerRoot(qa);
    if (tr) tr.push('answerRoot', { tag: root.tagName, cls: String(root.className).slice(0, 60), innerLen: (root.innerText || '').length });

    let text, timedOut = false;
    if (ensureComplete || isKimiGenerating()) {
      const r = await G.waitAnswerComplete({ root, minChars: cfg.minChars, maxWait: cfg.maxWait });
      text = r.text; timedOut = r.timedOut;
    } else {
      text = (root.innerText || '').trim();
    }
    if (tr) tr.push('collected', { chars: text.length, timedOut });

    // 引用扫描:只在 QA 容器内(不扫全页)
    const citations = G.extractCitations({ root: qa ? qa.assistantItem : document.body });
    if (tr) tr.push('citations', { n: citations.length });

    return {
      status: 'ok',
      text,
      answerHtml: root.innerHTML,
      answerChars: text.length,
      citations,
      qaHtml: qa ? qa.qaAncestor.outerHTML.slice(0, 200000) : null,
      qaSelector: '.chat-content-list',
      url: location.href,
      timedOut,
    };
  }

  globalThis.runKimiTask = async function (query, config = {}) {
    const tr = G.makeTrace();
    tr.push('runKimiTask start', { url: location.href, query: String(query).slice(0, 60) });
    try {
      const box = await findInput();
      if (!box) { tr.push('input_not_found'); return { status: 'failed', error: 'input_not_found', trace: tr.steps }; }
      tr.push('input found', { tag: box.tagName, editable: box.isContentEditable });

      await G.humanType(box, query);
      tr.push('typed');
      await G.sleep(G.rand(400, 800));

      const sendBtn = findSendButton();
      if (sendBtn) {
        sendBtn.click();
        tr.push('sent via .send-button-container');
      } else {
        box.focus();
        box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
        tr.push('sent via Enter (send btn not found)');
      }

      await G.sleep(3000);
      if (loginRequired()) { tr.push('login_required'); return { status: 'login_required', trace: tr.steps }; }

      const out = await collect(config, true, tr);
      out.trace = tr.steps;
      return out;
    } catch (e) {
      tr.push('exception', String(e && e.message || e));
      return { status: 'failed', error: String(e && e.message || e), trace: tr.steps };
    }
  };

  globalThis.collectKimiPage = async function (config = {}) {
    const tr = G.makeTrace();
    tr.push('collectKimiPage start', { url: location.href });
    try {
      if (loginRequired()) { tr.push('login_required'); return { status: 'login_required', trace: tr.steps }; }
      const qa = findLastQA();
      if (!qa || !qa.assistantItem) {
        tr.push('no_qa');
        return { status: 'failed', error: 'no_answer_on_page', trace: tr.steps };
      }
      const len = (qa.assistantItem.innerText || '').trim().length;
      tr.push('qa found', { userLen: qa.userItem ? qa.userItem.innerText.length : 0, assistLen: len });
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
      const t = (q.userItem.querySelector('.user-content') || q.userItem).innerText.trim();
      if (t.length > 1) return t.slice(0, 200);
    }
    const title = (document.title || '').replace(/\s*[|\-–]\s*Kimi.*$/i, '').trim();
    return title || '当前页面';
  }

  // 暴露给 SW 用于 DOM 截图定位
  globalThis.geoGetQANodeSelector = globalThis.geoGetQANodeSelector || function () {
    const qa = findLastQA();
    return qa ? { platform: 'kimi', selector: '.chat-content-list' } : null;
  };
})();
