// perplexity.js — Perplexity 平台 adapter
// 入口:
//   runPerplexityTask(query, config)  —— 全流程
//   collectPerplexityPage(config)     —— 仅采集当前已打开、已出答案的页面
//
// DOM 参考: docs/adapters/perplexity.md
// 关键锚:
//   输入框: div[role=textbox][contenteditable=true] (取靠底部的 followup)
//   发送按钮: button[aria-label="Submit"]
//   停止按钮: button[aria-label^="Stop response"] (生成中同位置替换)
//   QA 容器: main .focus\:outline-none div.flex.flex-col.gap-y-md (每轮一个)

(function () {
  const G = globalThis.GEO;

  async function findInput(config = {}) {
    // 优先取 main 里最靠底部的可编辑框
    for (let attempt = 0; attempt < 20; attempt++) {
      const configured = G.getConfiguredElement(config.inputSelector, { matcher: config.inputMatcher });
      if (configured) return configured;
      const list = [
        ...document.querySelectorAll('main div[role=textbox][contenteditable=true], main textarea, div[role=textbox][contenteditable=true], textarea'),
      ].filter((e) => e.offsetParent !== null);
      if (list.length) {
        list.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
        return list[0];
      }
      await G.sleep(500);
    }
    return null;
  }

  function findSendButton() {
    const b = document.querySelector('button[aria-label="Submit"]');
    if (b && b.offsetParent !== null && getComputedStyle(b).pointerEvents !== 'none') return b;
    return null;
  }

  function isPerplexityGenerating() {
    return !!document.querySelector('button[aria-label^="Stop response"]');
  }

  // 展开来源:点 "个来源" / "Sources"
  async function expandSources(root) {
    const scope = root || document;
    const labels = ['个来源', '来源', 'Sources', 'sources', 'Show sources'];
    for (const label of labels) {
      const btn = [...scope.querySelectorAll('button, div[role=button], span')]
        .find((e) => e.textContent && e.textContent.includes(label) && e.offsetParent !== null);
      if (btn) { try { btn.click(); await G.sleep(1500); return true; } catch {} }
    }
    return false;
  }

  // 找每轮 QA 容器,取最后一个
  function findLastQA() {
    // 主选择器
    const qas = [...document.querySelectorAll('main .focus\\:outline-none div.flex.flex-col.gap-y-md')].filter((e) => e.offsetParent !== null);
    if (qas.length) {
      const last = qas[qas.length - 1];
      const children = [...last.children];
      return {
        userItem: children[0] || null,
        assistantItem: children[1] || null,
        qaAncestor: last,
      };
    }
    return null;
  }

  function answerRoot(qa, config = {}) {
    const configured = G.getConfiguredElement(config.answerSelector, { last: true, matcher: config.answerMatcher });
    if (configured) return configured;
    const q = qa || findLastQA();
    if (q && q.assistantItem) {
      const md = q.assistantItem.querySelector('.prose.dark\\:prose-invert') || q.assistantItem.querySelector('.prose') || q.assistantItem.querySelector('[class*=prose]');
      return md || q.assistantItem;
    }
    // fallback:整个 main
    return document.querySelector('main') || document.body;
  }

  function loginRequired() {
    return /\/login|signin/i.test(location.href);
  }

  async function collect(config = {}, ensureComplete = true, tr = null) {
    const cfg = { minChars: 300, maxWait: 180000, ...config };
    const qa = findLastQA();
    if (tr) tr.push('findLastQA', qa ? { hasUser: !!qa.userItem, hasAssist: !!qa.assistantItem } : null);
    const root = answerRoot(qa, cfg);
    if (tr) tr.push('answerRoot', { tag: root.tagName, cls: String(root.className).slice(0, 60), innerLen: (root.innerText || '').length });

    let text, timedOut = false;
    if (ensureComplete || isPerplexityGenerating()) {
      const r = await G.waitAnswerComplete({
        root,
        minChars: cfg.minChars,
        maxWait: cfg.maxWait,
        requireMinCharsForStable: false,
      });
      text = r.text; timedOut = r.timedOut;
    } else {
      text = (root.innerText || '').trim();
    }
    if (tr) tr.push('collected', { chars: text.length, timedOut });

    // 展开来源(限定 QA 内)
    await expandSources(qa ? qa.qaAncestor : null);
    const citations = G.extractCitations({ root: qa ? qa.qaAncestor : (document.querySelector('main') || document.body) });
    if (tr) tr.push('citations', { n: citations.length });

    return {
      status: 'ok',
      text,
      answerHtml: root.innerHTML,
      answerChars: text.length,
      citations,
      qaHtml: qa ? qa.qaAncestor.outerHTML.slice(0, 200000) : null,
      qaSelector: cfg.answerSelector || 'main .focus\\:outline-none div.flex.flex-col.gap-y-md',
      url: location.href,
      timedOut,
    };
  }

  globalThis.runPerplexityTask = async function (query, config = {}) {
    const tr = G.makeTrace();
    tr.push('runPerplexityTask start', { url: location.href, query: String(query).slice(0, 60) });
    try {
      const box = await findInput(config);
      if (!box) { tr.push('input_not_found'); return { status: 'failed', error: 'input_not_found', trace: tr.steps }; }
      tr.push('input found', { tag: box.tagName, editable: box.isContentEditable });

      await G.humanType(box, query);
      tr.push('typed');
      await G.sleep(G.rand(400, 800));

      const sendBtn = findSendButton();
      if (sendBtn) {
        sendBtn.click();
        tr.push('sent via Submit button');
      } else {
        box.focus();
        box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
        box.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
        tr.push('sent via Enter');
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

  globalThis.collectPerplexityPage = async function (config = {}) {
    const tr = G.makeTrace();
    tr.push('collectPerplexityPage start', { url: location.href });
    try {
      if (loginRequired()) { tr.push('login_required'); return { status: 'login_required', trace: tr.steps }; }
      const qa = findLastQA();
      if (!qa || !qa.assistantItem) {
        const root = answerRoot(null, config);
        if ((root.innerText || '').trim().length < 50) return { status: 'failed', error: 'no_answer_on_page', trace: tr.steps };
      }
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
      const t = (q.userItem.innerText || '').trim();
      if (t.length > 1) return t.slice(0, 200);
    }
    // fallback: h1 / title
    const h1 = document.querySelector('main h1');
    if (h1 && h1.textContent && h1.textContent.trim().length > 1) return h1.textContent.trim().slice(0, 200);
    const t = (document.title || '').replace(/\s*[|\-–]\s*Perplexity.*$/i, '').trim();
    return t || '当前页面';
  }
})();
