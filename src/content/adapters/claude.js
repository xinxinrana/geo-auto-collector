// claude.js — Claude (claude.ai) 平台 adapter。注入后由 SW 调用。
// 两个入口，互相独立：
//   runClaudeTask(query, config)  —— 全流程：输入→提交→判完成→采集
//   collectClaudePage(config)     —— 仅采集当前已打开、已出答案的页面
// 依赖 common.js 已注入的 globalThis.GEO。

(function () {
  const G = globalThis.GEO;

  async function findInput(config = {}) {
    const selectors = ['div[contenteditable=true].ProseMirror', 'div[contenteditable=true]', 'fieldset div[contenteditable=true]', 'textarea'];
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

  // 最后一条 Claude 回复作为正文容器
  function answerRoot(config = {}) {
    const configured = G.getConfiguredElement(config.answerSelector, { last: true, matcher: config.answerMatcher });
    if (configured) return configured;
    const msgs = [...document.querySelectorAll('[data-testid=assistant-message], div[class*="font-claude"], .prose')];
    if (msgs.length) {
      const last = msgs[msgs.length - 1];
      const md = last.querySelector('.prose, [class*=markdown]');
      return md || last;
    }
    const fallback = ['main .prose', 'main [class*=markdown]', 'main'];
    for (const sel of fallback) {
      const el = document.querySelector(sel);
      if (el && (el.innerText || '').length > 50) return el;
    }
    return document.body;
  }

  function loginRequired() {
    return /\/login|\/magic-link|auth\.claude|anthropic\.com\/(login|auth)/i.test(location.href);
  }

  async function collect(config = {}, ensureComplete = true, tr = null) {
    const cfg = { minChars: 1200, maxWait: 240000, ...config };
    const root = answerRoot(cfg);
    if (tr) tr.push('collect answerRoot', { tag: root.tagName, cls: String(root.className).slice(0, 60), innerLen: (root.innerText || '').length });

    let text, timedOut = false;
    if (ensureComplete) {
      const r = await G.waitAnswerComplete({
        root,
        minChars: cfg.minChars,
        maxWait: cfg.maxWait,
        requireMinCharsForStable: false,
      });
      text = r.text; timedOut = r.timedOut;
    } else if (G.isGenerating()) {
      const r = await G.waitAnswerComplete({
        root,
        minChars: cfg.minChars,
        maxWait: 60000,
        requireMinCharsForStable: false,
      });
      text = r.text; timedOut = r.timedOut;
    } else {
      text = (root.innerText || '').trim();
    }
    if (tr) tr.push('collected', { chars: text.length, timedOut });

    const citations = G.extractCitations();
    if (tr) tr.push('citations', { n: citations.length });

    return {
      status: 'ok',
      text,
      answerHtml: root.innerHTML,
      answerChars: text.length,
      citations,
      qaSelector: cfg.answerSelector || null,
      domHtml: root.outerHTML,
      url: location.href,
      timedOut,
    };
  }

  // 入口 1：全流程
  globalThis.runClaudeTask = async function (query, config = {}) {
    const tr = G.makeTrace();
    tr.push('runClaudeTask start', { url: location.href, query: String(query).slice(0, 60) });
    try {
      const box = await findInput(config);
      if (!box) { tr.push('input_not_found'); return { status: 'failed', error: 'input_not_found', trace: tr.steps }; }
      tr.push('input found', { tag: box.tagName, cls: String(box.className).slice(0, 60), editable: box.isContentEditable });

      await G.humanType(box, query);
      tr.push('typed');
      await G.sleep(G.rand(300, 600));

      const sendBtn = document.querySelector('button[aria-label*="Send" i], button[aria-label*="发送"], [data-testid=send-button]');
      if (sendBtn && !sendBtn.disabled && sendBtn.offsetParent !== null) {
        sendBtn.click();
        tr.push('sent via button');
      } else {
        box.focus();
        box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
        box.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
        tr.push('sent via Enter', { btnFound: !!sendBtn, btnDisabled: sendBtn ? sendBtn.disabled : null });
      }

      await G.sleep(3000);
      if (loginRequired()) { tr.push('login_required', { url: location.href }); return { status: 'login_required', trace: tr.steps }; }

      const out = await collect(config, true, tr);
      out.trace = tr.steps;
      return out;
    } catch (e) {
      tr.push('exception', String(e && e.message || e));
      return { status: 'failed', error: String(e && e.message || e), trace: tr.steps };
    }
  };

  // 入口 2：仅采集当前页面
  globalThis.collectClaudePage = async function (config = {}) {
    const tr = G.makeTrace();
    tr.push('collectClaudePage start', { url: location.href });
    try {
      if (loginRequired()) { tr.push('login_required'); return { status: 'login_required', trace: tr.steps }; }
      const root = answerRoot(config);
      const len = (root.innerText || '').trim().length;
      tr.push('answerRoot', { tag: root.tagName, cls: String(root.className).slice(0, 60), innerLen: len });
      if (len < 20) {
        return { status: 'failed', error: 'no_answer_on_page', trace: tr.steps };
      }
      const out = await collect(config, false, tr);
      out.keyword = inferKeyword(config);
      out.trace = tr.steps;
      return out;
    } catch (e) {
      tr.push('exception', String(e && e.message || e));
      return { status: 'failed', error: String(e && e.message || e), trace: tr.steps };
    }
  };

  // 推断关键词：优先首条用户消息，退化到 document.title
  function inferKeyword(config = {}) {
    const configured = G.getConfiguredElement(config.questionSelector, { last: true, matcher: config.questionMatcher });
    if (configured && configured.innerText?.trim().length > 1) return configured.innerText.trim().slice(0, 200);
    const user = document.querySelector('[data-testid=user-message]');
    if (user && user.innerText && user.innerText.trim().length > 1) {
      return user.innerText.trim().slice(0, 200);
    }
    const t = (document.title || '').replace(/\s*[|\-–]\s*Claude.*$/i, '').trim();
    return t && t !== 'Claude' ? t : '当前页面';
  }
})();
