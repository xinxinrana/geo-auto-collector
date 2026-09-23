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

  async function findInput(config = {}) {
    const selectors = [
      'div[contenteditable=true][data-lexical-editor=true]',
      'div[contenteditable=true]',
      'textarea',
    ];
    for (let attempt = 0; attempt < 20; attempt++) {
      const configured = G.getConfiguredElement(config.inputSelector, { matcher: config.inputMatcher });
      if (configured) return configured;
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

  function answerRoot(qa, config = {}) {
    const configured = G.getConfiguredElement(config.answerSelector, { last: true, matcher: config.answerMatcher });
    if (configured) return configured;
    const q = qa || findLastQA();
    if (!q || !q.assistantItem) return document.body;
    // 优先 markdown / 内容容器类
    const md = q.assistantItem.querySelector(
      '.segment-content-box, .markdown, [class*="markdown"], .prose, [class*="content-box"], [class*="message-content"]'
    );
    if (md) return md;

    // 兜底:取 assistantItem 内文本最长且包含段落/列表/代码块的内容 div
    const divs = [...q.assistantItem.querySelectorAll('div')].filter((el) =>
      el.querySelector('p, li, pre, table') || el.children.length === 0
    );
    if (divs.length) {
      divs.sort((a, b) => (b.innerText || '').length - (a.innerText || '').length);
      return divs[0];
    }

    return q.assistantItem;
  }

  function loginRequired() {
    return /\/login|\/signin/i.test(location.href);
  }

  // Kimi 的 .chat-content-list 是整个消息列表,它在页面中通常有固定宽度 / 居中 / 左右内边距,
  // 且用户消息右对齐。直接截该容器会把这些布局空白一起截进去,导致画面"整体偏右"。
  // 这里把当前 QA 对 clone 到一个自然流式的临时 wrapper 里,消除容器级 margin/padding/对齐影响。
  function buildShotSelector(qa) {
    if (!qa || !qa.assistantItem) return null;
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

    const cloneItem = (item) => {
      const c = item.cloneNode(true);
      // 移除可能影响截图对齐的容器级样式
      c.style.margin = '0';
      c.style.marginLeft = '0';
      c.style.marginRight = '0';
      c.style.padding = '0';
      c.style.width = '100%';
      c.style.maxWidth = 'none';
      return c;
    };

    if (qa.userItem) wrapper.appendChild(cloneItem(qa.userItem));
    wrapper.appendChild(cloneItem(qa.assistantItem));
    document.body.appendChild(wrapper);
    return '#' + id;
  }

  async function collect(config = {}, ensureComplete = true, tr = null) {
    const cfg = { minChars: 400, maxWait: 240000, ...config };
    const qa = findLastQA();
    if (tr) tr.push('findLastQA', qa ? { user: !!qa.userItem, assistant: !!qa.assistantItem, ancestor: qa.qaAncestor.className.slice(0, 40) } : null);
    const root = answerRoot(qa, cfg);
    if (tr) tr.push('answerRoot', { tag: root.tagName, cls: String(root.className).slice(0, 60), innerLen: (root.innerText || '').length });

    let text, timedOut = false;
    if (ensureComplete || isKimiGenerating()) {
      const r = await G.waitAnswerComplete({
        root,
        minChars: cfg.minChars,
        maxWait: cfg.maxWait,
        requireMinCharsForStable: false,
        isGeneratingFn: isKimiGenerating, // 使用 Kimi 自己的生成判断,避免通用判断失效
      });
      text = r.text; timedOut = r.timedOut;
    } else {
      text = (root.innerText || '').trim();
    }
    if (tr) tr.push('collected', { chars: text.length, timedOut });

    // 引用扫描:只在 QA 容器内(不扫全页)
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
      qaSelector: cfg.answerSelector || shotSelector || '.chat-content-list',
      url: location.href,
      timedOut,
    };
  }

  globalThis.runKimiTask = async function (query, config = {}) {
    const tr = G.makeTrace();
    tr.push('runKimiTask start', { url: location.href, query: String(query).slice(0, 60) });
    try {
      const box = await findInput(config);
      if (!box) { tr.push('input_not_found'); return { status: 'failed', error: 'input_not_found', trace: tr.steps }; }
      tr.push('input found', { tag: box.tagName, editable: box.isContentEditable });

      await G.humanType(box, query);
      tr.push('typed');
      await G.sleep(G.rand(400, 800));

      const sendBtn = G.getConfiguredElement(config.sendSelector, { matcher: config.sendMatcher }) || findSendButton();
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
      const configuredAnswer = G.getConfiguredElement(config.answerSelector, { last: true, matcher: config.answerMatcher });
      if ((!qa || !qa.assistantItem) && !configuredAnswer) {
        tr.push('no_qa');
        return { status: 'failed', error: 'no_answer_on_page', trace: tr.steps };
      }
      const len = ((configuredAnswer || qa.assistantItem).innerText || '').trim().length;
      tr.push('qa found', { userLen: qa?.userItem ? qa.userItem.innerText.length : 0, assistLen: len });
      if (len < 20) return { status: 'failed', error: 'no_answer_on_page', trace: tr.steps };

      const out = await collect(config, false, tr);
      out.keyword = inferKeyword(qa, config);
      out.trace = tr.steps;
      return out;
    } catch (e) {
      tr.push('exception', String(e && e.message || e));
      return { status: 'failed', error: String(e && e.message || e), trace: tr.steps };
    }
  };

  function inferKeyword(qa, config = {}) {
    const configured = G.getConfiguredElement(config.questionSelector, { last: true, matcher: config.questionMatcher });
    if (configured && configured.innerText?.trim().length > 1) return configured.innerText.trim().slice(0, 200);
    const q = qa || findLastQA();
    if (q && q.userItem) {
      const t = (q.userItem.querySelector('.user-content') || q.userItem).innerText.trim();
      if (t.length > 1) return t.slice(0, 200);
    }
    const title = (document.title || '').replace(/\s*[|\-–]\s*Kimi.*$/i, '').trim();
    return title || '当前页面';
  }

})();
