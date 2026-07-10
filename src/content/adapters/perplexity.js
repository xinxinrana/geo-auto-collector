// perplexity.js — Perplexity 平台 adapter。注入后由 SW 调用。
// 两个入口，互相独立：
//   runPerplexityTask(query, config)  —— 全流程：输入→提交→判完成→采集
//   collectPerplexityPage(config)     —— 仅采集当前已打开、已出答案的页面
// 依赖 common.js 已注入的 globalThis.GEO。

(function () {
  const G = globalThis.GEO;

  async function findInput() {
    const selectors = ['div[role=textbox]', 'textarea', '[contenteditable=true]'];
    for (let attempt = 0; attempt < 20; attempt++) {
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && el.offsetParent !== null) return el;
      }
      await G.sleep(500);
    }
    return null;
  }

  async function expandSources() {
    const labels = ['个来源', '来源', 'Sources', 'sources'];
    for (const label of labels) {
      const btn = [...document.querySelectorAll('button, div[role=button], span')]
        .find((e) => e.textContent && e.textContent.includes(label) && e.offsetParent !== null);
      if (btn) {
        try { btn.click(); await G.sleep(2000); return true; } catch {}
      }
    }
    return false;
  }

  // 定位回答正文容器，尽量避开导航/侧栏
  function answerRoot() {
    const candidates = ['main', '[class*=answer]', '[class*=prose]', '[data-testid*=answer]'];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el && (el.innerText || '').length > 50) return el;
    }
    return document.body;
  }

  // 从当前页提取：展开来源 → 抓正文/引用/DOM。ensureComplete=true 时先等生成结束。
  async function collect(config = {}, ensureComplete = true) {
    const cfg = { minChars: 1200, maxWait: 180000, stableNeeded: 4, ...config };
    const root = answerRoot();

    let text, timedOut = false;
    if (ensureComplete) {
      const r = await G.waitAnswerComplete({
        root,
        minChars: cfg.minChars,
        maxWait: cfg.maxWait,
        stableNeeded: cfg.stableNeeded,
      });
      text = r.text;
      timedOut = r.timedOut;
    } else {
      // 仅采集当前页：不重新等待，若仍在生成则短等一下
      if (G.isGenerating()) {
        const r = await G.waitAnswerComplete({ root, minChars: cfg.minChars, maxWait: 60000, stableNeeded: cfg.stableNeeded });
        text = r.text;
        timedOut = r.timedOut;
      } else {
        text = (root.innerText || '').trim();
      }
    }

    await expandSources();
    const citations = G.extractCitations();

    return {
      status: 'ok',
      text,
      answerHtml: root.innerHTML,
      answerChars: text.length,
      citations,
      domHtml: root.outerHTML,
      url: location.href,
      timedOut,
    };
  }

  // 入口 1：全流程
  globalThis.runPerplexityTask = async function (query, config = {}) {
    try {
      const box = await findInput();
      if (!box) return { status: 'failed', error: 'input_not_found' };

      await G.humanType(box, query);
      await G.sleep(G.rand(300, 600));

      box.focus();
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
      box.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));

      await G.sleep(3000);

      if (location.href.includes('/login') || location.href.includes('signin')) {
        return { status: 'login_required' };
      }

      return await collect(config, true);
    } catch (e) {
      return { status: 'failed', error: String(e && e.message || e) };
    }
  };

  // 入口 2：仅采集当前页面（页面已由用户手动打开并已出答案）
  globalThis.collectPerplexityPage = async function (config = {}) {
    try {
      if (location.href.includes('/login') || location.href.includes('signin')) {
        return { status: 'login_required' };
      }
      const root = answerRoot();
      if ((root.innerText || '').trim().length < 20) {
        return { status: 'failed', error: 'no_answer_on_page' };
      }
      // 从 URL 或页面推断关键词（首个用户提问）
      const keyword = inferKeyword();
      const out = await collect(config, false);
      out.keyword = keyword;
      return out;
    } catch (e) {
      return { status: 'failed', error: String(e && e.message || e) };
    }
  };

  // 尝试推断当前对话的关键词：优先 h1/首个标题，退化到 document.title
  function inferKeyword() {
    const h1 = document.querySelector('h1');
    if (h1 && h1.textContent && h1.textContent.trim().length > 1) return h1.textContent.trim().slice(0, 200);
    const t = (document.title || '').replace(/\s*[|\-–]\s*Perplexity.*$/i, '').trim();
    return t || '当前页面';
  }
})();
