// chatgpt.js — ChatGPT 平台 adapter。注入后由 SW 调用。
// 两个入口，互相独立：
//   runChatgptTask(query, config)  —— 全流程：输入→提交→判完成→采集
//   collectChatgptPage(config)     —— 仅采集当前已打开、已出答案的页面
// 依赖 common.js 已注入的 globalThis.GEO。

(function () {
  const G = globalThis.GEO;

  async function findInput(config = {}) {
    const selectors = ['#prompt-textarea', 'div[contenteditable=true]', 'textarea[data-id]', 'textarea'];
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

  // 最后一对 QA:通过 data-turn-id-container 定位每轮消息容器
  function findLastQA() {
    const turns = [...document.querySelectorAll('[data-turn-id-container], [data-testid^="conversation-turn-"]')].filter((e) => e.offsetParent !== null);
    if (!turns.length) return null;
    // 从后往前找 assistant
    let assistantItem = null;
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i].querySelector('[data-message-author-role=assistant]')) { assistantItem = turns[i]; break; }
    }
    if (!assistantItem) return null;
    let userItem = null;
    const idx = turns.indexOf(assistantItem);
    for (let i = idx - 1; i >= 0; i--) {
      if (turns[i].querySelector('[data-message-author-role=user]')) { userItem = turns[i]; break; }
    }
    // 二者共同祖先
    const ancestors = (n) => { const a = []; while (n) { a.push(n); n = n.parentElement; } return a; };
    const bChain = new Set(ancestors(assistantItem));
    let qaAncestor = assistantItem.parentElement;
    if (userItem) {
      const chain = ancestors(userItem);
      qaAncestor = chain.find((n) => bChain.has(n)) || qaAncestor;
    }
    return { userItem, assistantItem, qaAncestor };
  }

  // 最后一条 assistant 消息作为正文容器
  // 优先从已定位的 QA turn(assistantItem) 里找,避免全局选择器因页面改版失效
  function answerRoot(qa, config = {}) {
    const configured = G.getConfiguredElement(config.answerSelector, { last: true, matcher: config.answerMatcher });
    if (configured) return configured;
    const q = qa || findLastQA();
    if (q && q.assistantItem) {
      const assistantMsg = q.assistantItem.querySelector('[data-message-author-role=assistant]');
      if (assistantMsg) {
        const assistantText = (assistantMsg.innerText || '').trim();

        // 新版/旧版 markdown 容器类名兜底
        // 注意:stop 按钮消失时 .markdown 可能已挂载但内容尚未渲染完,
        // 所以必须校验它确实含有文本,否则退回到 assistantMsg 本身。
        const md = assistantMsg.querySelector(
          '.markdown, .prose, [class*="markdown"], [class*="MessageContent"]'
        );
        const mdText = md ? (md.innerText || '').trim() : '';
        // 选中 markdown 的条件:有内容,且长度不少于 assistantMsg 总文本的 30%
        // (避免选到空占位或只含 "Worked for Xs" 的 UI 容器)
        if (md && mdText.length > 0 && mdText.length >= Math.max(20, assistantText.length * 0.3)) {
          return md;
        }

        // 兜底:取 assistantMsg 内文本最长且确实含文本的 div
        const divs = [...assistantMsg.querySelectorAll('div')].filter((el) => {
          const t = (el.innerText || '').trim();
          return t.length > 0 && (el.children.length === 0 || el.querySelector('p, li, pre, table'));
        });
        if (divs.length) {
          divs.sort((a, b) => (b.innerText || '').length - (a.innerText || '').length);
          // 同样要求最长 div 含不少于 assistantMsg 30% 的文本,否则直接用 assistantMsg
          const best = divs[0];
          const bestText = (best.innerText || '').trim();
          if (bestText.length >= Math.max(20, assistantText.length * 0.3)) return best;
        }

        // 如果 markdown/最长 div 都不够长,直接用 assistant 消息容器本身
        // 它一定包含完整回答(即使多了一点 "Worked for Xs" UI 文本)
        if (assistantText.length > 0) return assistantMsg;
        return q.assistantItem;
      }
      return q.assistantItem;
    }

    // 全局 fallback(无 QA 结构时)
    const msgs = [...document.querySelectorAll('[data-message-author-role=assistant]')];
    if (msgs.length) {
      const last = msgs[msgs.length - 1];
      const md = last.querySelector('.markdown, .prose, [class*="markdown"], [class*="MessageContent"]');
      const mdText = md ? (md.innerText || '').trim() : '';
      if (md && mdText.length > 0) return md;
      return last;
    }
    const fallback = ['main [class*="markdown"]', 'main .prose', 'main'];
    for (const sel of fallback) {
      const el = document.querySelector(sel);
      if (el && (el.innerText || '').length > 50) return el;
    }
    return document.body;
  }

  function loginRequired() {
    return /\/auth\/login|\/login|auth0|openai\.com\/auth/i.test(location.href);
  }

  async function collect(config = {}, ensureComplete = true, tr = null) {
    const cfg = { minChars: 1500, maxWait: 300000, ...config };
    const qa = findLastQA();
    if (tr) tr.push('findLastQA', qa ? { hasUser: !!qa.userItem, hasAssist: !!qa.assistantItem } : null);
    const root = answerRoot(qa, cfg);
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

    const citations = G.extractCitations({ root: qa ? qa.qaAncestor : document.body });
    if (tr) tr.push('citations', { n: citations.length });

    return {
      status: 'ok',
      text,
      answerHtml: root.innerHTML,
      answerChars: text.length,
      citations,
      qaHtml: qa ? qa.qaAncestor.outerHTML.slice(0, 200000) : null,
      qaSelector: cfg.answerSelector || '[data-turn-id-container]',
      domHtml: root.outerHTML,
      url: location.href,
      timedOut,
    };
  }

  // 入口 1：全流程
  globalThis.runChatgptTask = async function (query, config = {}) {
    const tr = G.makeTrace();
    tr.push('runChatgptTask start', { url: location.href, query: String(query).slice(0, 60) });
    try {
      const box = await findInput(config);
      if (!box) { tr.push('input_not_found'); return { status: 'failed', error: 'input_not_found', trace: tr.steps }; }
      tr.push('input found', { tag: box.tagName, id: box.id, editable: box.isContentEditable });

      await G.humanType(box, query);
      tr.push('typed');
      await G.sleep(G.rand(300, 600));

      // 优先点发送按钮，退化到 Enter
      const sendBtn = document.querySelector('button[data-testid=send-button], button[aria-label*="Send" i]');
      if (sendBtn && !sendBtn.disabled) {
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
  globalThis.collectChatgptPage = async function (config = {}) {
    const tr = G.makeTrace();
    tr.push('collectChatgptPage start', { url: location.href });
    try {
      if (loginRequired()) { tr.push('login_required'); return { status: 'login_required', trace: tr.steps }; }
      const qa = findLastQA();
      const root = answerRoot(qa, config);
      const len = (root.innerText || '').trim().length;
      tr.push('answerRoot', { tag: root.tagName, cls: root.className, innerLen: len });
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
    const user = document.querySelector('[data-message-author-role=user]');
    if (user && user.innerText && user.innerText.trim().length > 1) {
      return user.innerText.trim().slice(0, 200);
    }
    const t = (document.title || '').replace(/\s*[|\-–]\s*ChatGPT.*$/i, '').trim();
    return t && t !== 'ChatGPT' ? t : '当前页面';
  }
})();
