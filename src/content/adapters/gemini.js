// gemini.js — Gemini (gemini.google.com) 平台 adapter。注入后由 SW 调用。
// 两个入口，互相独立：
//   runGeminiTask(query, config)  —— 全流程：输入→提交→判完成→采集
//   collectGeminiPage(config)     —— 仅采集当前已打开、已出答案的页面
// 依赖 common.js 已注入的 globalThis.GEO。

(function () {
  const G = globalThis.GEO;

  async function findInput() {
    const selectors = ['div.ql-editor[contenteditable=true]', 'rich-textarea div[contenteditable=true]', 'div[contenteditable=true]', 'textarea'];
    for (let attempt = 0; attempt < 20; attempt++) {
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && el.offsetParent !== null) return el;
      }
      await G.sleep(500);
    }
    return null;
  }

  // 最后一对 QA:conversation-container 最后一个,包含 user-query + model-response
  function findLastQA() {
    const containers = [...document.querySelectorAll('.conversation-container')].filter((e) => e.offsetParent !== null);
    if (!containers.length) return null;
    const last = containers[containers.length - 1];
    const userItem = last.querySelector('user-query, .query-content, .query-text');
    const assistantItem = last.querySelector('model-response, message-content, .model-response-text');
    return { userItem, assistantItem, qaAncestor: last };
  }

  // 最后一条模型回复作为正文容器。
  // 注意：querySelectorAll 用逗号组合会按“文档顺序”返回，不能用来表达优先级；
  // 这里按选择器优先级逐个尝试，取最后一个匹配到、且有实际文本的元素。
  function answerRoot() {
    // 每种“回答容器”选择器，优先级从高到低
    const containerSels = ['message-content', 'model-response', '.model-response-text', '.response-content'];
    for (const sel of containerSels) {
      const els = [...document.querySelectorAll(sel)].filter((e) => e.offsetParent !== null && (e.innerText || '').trim().length > 0);
      if (els.length) {
        const last = els[els.length - 1];
        // 优先取其中的 markdown 主体（更贴近纯正文），否则用容器本身
        const md = last.querySelector('.markdown, [class*=markdown]');
        return md && (md.innerText || '').trim().length > 0 ? md : last;
      }
    }
    // 兜底：最后一个非空的 .markdown
    const mds = [...document.querySelectorAll('.markdown, [class*=markdown]')].filter((e) => e.offsetParent !== null && (e.innerText || '').trim().length > 0);
    if (mds.length) return mds[mds.length - 1];
    const main = document.querySelector('main');
    return main || document.body;
  }

  function loginRequired() {
    return /accounts\.google\.com|\/signin|ServiceLogin/i.test(location.href);
  }

  // 展开来源/引用面板（Gemini 常把来源折叠在 "Sources" / "来源" 里）
  async function expandSources() {
    const labels = ['来源', 'Sources', 'sources', 'Show sources'];
    for (const label of labels) {
      const btn = [...document.querySelectorAll('button, div[role=button], [aria-label]')]
        .find((e) => {
          const txt = (e.textContent || '') + ' ' + (e.getAttribute('aria-label') || '');
          return txt.includes(label) && e.offsetParent !== null;
        });
      if (btn) { try { btn.click(); await G.sleep(1500); return true; } catch {} }
    }
    return false;
  }

  async function collect(config = {}, ensureComplete = true, tr = null) {
    const cfg = { minChars: 1000, maxWait: 240000, ...config };
    const qa = findLastQA();
    if (tr) tr.push('findLastQA', qa ? { hasUser: !!qa.userItem, hasAssist: !!qa.assistantItem } : null);
    const root = answerRoot();
    if (tr) tr.push('collect answerRoot', { tag: root.tagName, cls: String(root.className).slice(0, 60), innerLen: (root.innerText || '').length });

    let text, timedOut = false;
    if (ensureComplete) {
      const r = await G.waitAnswerComplete({ root, minChars: cfg.minChars, maxWait: cfg.maxWait });
      text = r.text; timedOut = r.timedOut;
    } else if (G.isGenerating()) {
      const r = await G.waitAnswerComplete({ root, minChars: cfg.minChars, maxWait: 60000 });
      text = r.text; timedOut = r.timedOut;
    } else {
      text = (root.innerText || '').trim();
    }
    if (tr) tr.push('collected', { chars: text.length, timedOut });

    await expandSources();
    // 引用限定在 QA 容器内
    const citations = G.extractCitations({ root: qa ? qa.qaAncestor : document.body });
    if (tr) tr.push('citations', { n: citations.length });

    return {
      status: 'ok',
      text,
      answerHtml: root.innerHTML,
      answerChars: text.length,
      citations,
      qaHtml: qa ? qa.qaAncestor.outerHTML.slice(0, 200000) : null,
      qaSelector: '.conversation-container',
      domHtml: root.outerHTML,
      url: location.href,
      timedOut,
    };
  }

  // 入口 1：全流程
  globalThis.runGeminiTask = async function (query, config = {}) {
    const tr = G.makeTrace();
    tr.push('runGeminiTask start', { url: location.href, query: String(query).slice(0, 60) });
    try {
      const box = await findInput();
      if (!box) { tr.push('input_not_found'); return { status: 'failed', error: 'input_not_found', trace: tr.steps }; }
      tr.push('input found', { tag: box.tagName, cls: String(box.className).slice(0, 60), editable: box.isContentEditable });

      await G.humanType(box, query);
      tr.push('typed');
      await G.sleep(G.rand(400, 800));

      // 优先点发送按钮，退化到 Enter
      const sendBtn = document.querySelector('button[aria-label*="Send" i], button[aria-label*="发送"], button.send-button, [data-testid=send-button]');
      if (sendBtn && !sendBtn.disabled && sendBtn.offsetParent !== null) {
        sendBtn.click();
        tr.push('sent via button');
      } else {
        box.focus();
        box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
        box.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
        tr.push('sent via Enter', { btnFound: !!sendBtn, btnDisabled: sendBtn ? sendBtn.disabled : null });
      }

      await G.sleep(3500);
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
  globalThis.collectGeminiPage = async function (config = {}) {
    const tr = G.makeTrace();
    tr.push('collectGeminiPage start', { url: location.href });
    try {
      if (loginRequired()) { tr.push('login_required'); return { status: 'login_required', trace: tr.steps }; }
      const root = answerRoot();
      const len = (root.innerText || '').trim().length;
      tr.push('answerRoot', { tag: root.tagName, cls: String(root.className).slice(0, 60), innerLen: len });
      if (len < 20) {
        return { status: 'failed', error: 'no_answer_on_page', trace: tr.steps };
      }
      const out = await collect(config, false, tr);
      out.keyword = inferKeyword();
      out.trace = tr.steps;
      return out;
    } catch (e) {
      tr.push('exception', String(e && e.message || e));
      return { status: 'failed', error: String(e && e.message || e), trace: tr.steps };
    }
  };

  // 推断关键词：优先首条用户提问。
  // Gemini 的 .query-text-line 是纯提问文本；.query-text/user-query 会带 “你说” 前缀，需剥离。
  function inferKeyword() {
    const line = document.querySelector('.query-text-line');
    if (line && (line.innerText || '').trim().length > 1) return line.innerText.trim().slice(0, 200);

    const q = document.querySelector('.query-text, user-query-content, user-query');
    if (q && q.innerText) {
      // 去掉开头的 “你说 / You said” 提示行
      const cleaned = q.innerText.replace(/^(你说|You said)\s*/i, '').trim();
      if (cleaned.length > 1) return cleaned.slice(0, 200);
    }
    const t = (document.title || '').replace(/\s*[|\-–]\s*Gemini.*$/i, '').trim();
    return t && t !== 'Gemini' ? t : '当前页面';
  }
})();
