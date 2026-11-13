(() => {
  // 构建戳：用于判断页面里已注入的适配器是否为当前版本。
  // 之前只按 platformId 判重，导致改了文件却仍在跑页面里最早注入的那份旧代码。
  // 但正在执行任务的页面上不能换适配器，否则行为会中途改变。
  const BUILD = 'doubao-2026-11-13a';
  const running = globalThis.GEORunner?.state && !globalThis.GEORunner.state.finished;
  if (globalThis.GEOAdapter?.platformId === 'doubao' && (globalThis.GEOAdapter.build === BUILD || running)) return;
  const PLATFORM_ID = 'doubao';
  const normalize = text => String(text || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const text = node => (node?.innerText ?? node?.textContent ?? '').trim();
  const visible = node => Boolean(node?.isConnected && node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden' && getComputedStyle(node).display !== 'none' && !node.closest('[hidden],[aria-hidden="true"],nav,aside'));
  function failure(code, message, field, details = {}) { const e = new Error(message); Object.assign(e, { code, field, details }); return e; }
  function select(selector, root = document) { try { return [...root.querySelectorAll(selector)].filter(visible); } catch { throw failure('invalid_selector', 'CSS 选择器语法错误', undefined); } }
  function unique(nodes, field) {
    nodes = [...new Set(nodes)];
    if (!nodes.length) throw failure('not_found', `未找到可验证的 ${field} 元素`, field, { count: 0 });
    if (nodes.length !== 1) throw failure('ambiguous', `${field} 有多个候选，需更精确的选择器`, field, { count: nodes.length });
    return nodes[0];
  }

  // 豆包是虚拟列表：滚动出视口的行会被卸载，用户行与助手行不保证同时存在，
  // 也不能按"相邻两行成对"来配。改为各自按 data-testid 语义锚独立定位（各自唯一），
  // 再按文档顺序配对：某个问题之后、下一个问题之前的第一个回答容器。
  // 问题行里混着时间戳与操作栏，回答容器里混着"共用时 xx"计时器，都要按语义剥掉。
  const defaults = {
    input: 'textarea.semi-input-textarea, main textarea, main [contenteditable="true"]',
    send: '',
    question: '[data-testid="send_message"]',
    answer: '[data-testid="receive_message"]'
  };
  const NOISE = '[data-testid="preamble-elapsed"],[data-testid="message_action_bar"],[class*="thinking"],[class*="cot-summary"],button,time';
  function clean(node) {
    if (!node) return node;
    const clone = node.cloneNode(true);
    clone.querySelectorAll(NOISE).forEach(n => n.remove());
    return clone;
  }
  // 问题文本取 message_content 里第一段正文，避开时间戳与按钮。
  function questionText(node) {
    const content = node.querySelector('[data-testid="message_content"]') || node;
    const box = content.querySelector('[data-testid="message_text_content"], .md-box-root') || content;
    return normalize(text(clean(box)) || text(content));
  }
  function editable(n) { return n.matches('textarea,input:not([type=password]):not([type=hidden])') || n.getAttribute('contenteditable') === 'true'; }
  function input(config) {
    let nodes = select(config.input || defaults.input).filter(editable);
    if (!config.input && !nodes.length) nodes = select('[role="textbox"][contenteditable="true"], textarea').filter(editable);
    // 输入区那个 textarea 在视觉上最靠下；页面上可能还有搜索框等第二个 textarea。
    nodes = nodes.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
    return unique(nodes.slice(0, 1).filter(n => !n.disabled && !n.readOnly), 'input');
  }
  function send(config) {
    if (config.send) return unique(select(config.send).filter(n => n.matches('button,[role="button"]') && !n.disabled && n.getAttribute('aria-disabled') !== 'true'), 'send');
    // 最稳的锚是 data-testid；豆包新版还会给 #flow-end-msg-send。旧版只剩图标 class。
    const stable = select('[data-testid="chat_input_send_button"], #flow-end-msg-send').filter(b => !b.disabled && b.getAttribute('aria-disabled') !== 'true');
    if (stable.length) return unique(stable, 'send');
    const icon = [...document.querySelectorAll('button,[role="button"]')].filter(b => {
      if (!visible(b) || b.disabled || b.getAttribute('aria-disabled') === 'true') return false;
      const svg = b.querySelector('svg');
      return svg && /send-msg-btn/i.test(svg.getAttribute('class') || '');
    });
    if (icon.length) return unique(icon, 'send');
    const wrap = document.querySelector('.send-btn-wrapper button, [class*="send-btn-wrapper"] button');
    if (wrap && visible(wrap)) return wrap;
    const labelled = select('button,[role="button"]').filter(b => !b.disabled && b.getAttribute('aria-disabled') !== 'true' && /^(submit|send|ask|提交|发送|提问)$/i.test(normalize(b.getAttribute('aria-label') || b.getAttribute('title') || text(b))));
    if (labelled.length) return unique(labelled, 'send');
    // 首页的发送入口不一定带 data-testid：它常是输入区右侧最后那个含 svg 的按钮。
    // 此时退回到"输入区内部、可见、含 svg、且位于最右侧"的按钮，并把候选写进错误信息以便核对。
    const zone = document.querySelector('[data-testid="chat_input"], [class*="chat_input"]') || document.querySelector('main') || document.body;
    const inner = [...zone.querySelectorAll('button')].filter(b => visible(b) && !b.disabled && b.querySelector('svg'));
    if (inner.length) {
      const rightmost = inner.sort((a, b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left)[0];
      return rightmost;
    }
    throw failure('not_found', '未找到可验证的 send 元素', 'send', { build: BUILD, candidates: inner.length });
  }
  // 豆包是虚拟列表：滚出视口的行会被整体卸载，问题行常常先于回答行消失。
  // 因此以"回答容器"为锚构建轮次（它只要可见就一定在），问题行只在还挂载着时作为前置信息附加。
  // 这样长回答把问题行顶出视口后，采集依然成立。
  function rounds(config = {}) {
    const questions = select(config.question || defaults.question).sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    const containers = select(config.answer || defaults.answer).filter(n => !n.closest('details')).sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    const out = [];
    for (const container of containers) {
      // 本轮问题 = 文档中位于该回答容器之前、且离它最近的一个问题行；已被卸载时为 null。
      let question = null;
      for (let i = questions.length - 1; i >= 0; i--) {
        if (questions[i].compareDocumentPosition(container) & Node.DOCUMENT_POSITION_FOLLOWING) { question = questions[i]; break; }
      }
      // 正文可能被拆成多个 md-box-root，全部保留并按文档顺序拼接。
      const boxes = [...container.querySelectorAll('[data-testid="message_text_content"], .md-box-root')].filter(visible);
      out.push({ question, container, answers: boxes.length ? boxes : [container] });
    }
    return out;
  }
  function current(config, expected, baseline = []) {
    const all = rounds(config);
    if (!all.length) throw failure('not_found', '未找到可验证的 answer 元素', 'answer', { count: 0 });
    let candidates = all;
    if (expected) {
      const want = normalize(expected);
      const matched = all.filter(r => r.question && questionText(r.question) === want);
      if (baseline.some(t => t === want)) throw failure('ambiguous', '提交前已有相同问题，无法证明当前轮次', 'question');
      // 问题行已被虚拟列表卸载时无法比对问句；若此时只有一轮回答，它就是本轮。
      candidates = matched.length ? matched : (all.length === 1 && !all[0].question ? all : []);
      if (!candidates.length) {
        if (all.length === 1) candidates = all;
        else throw failure('not_found', '未找到与问题匹配的轮次', 'question', { build: BUILD, rounds: all.length });
      }
    } else candidates = [all[all.length - 1]];
    const round = candidates[candidates.length - 1];
    // 排除"共用时 xx"这类前置计时器块，只保留真正的回答正文。
    const boxes = round.answers.filter(a => !a.closest('[data-testid="preamble-elapsed"]'));
    const parts = boxes.length ? boxes : round.answers;
    const answer = parts[0];
    if (!answer) throw failure('not_found', '未找到可验证的 answer 元素', 'answer', { count: 0 });
    if (round.question) {
      if (answer.contains(round.question) || !(round.question.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING)) throw failure('wrong_role', '回答不属于本轮正文', 'answer');
    }
    return { ...round, answers: parts, answer };
  }
  // 本轮正文 = 全部分段按文档顺序拼接。
  function bodyText(round) {
    const parts = (round.answers || [round.answer]).map(n => text(n)).filter(Boolean);
    return parts.join('\n\n');
  }
  function bodyHtml(round) {
    const parts = (round.answers || [round.answer]).map(n => n.innerHTML).filter(Boolean);
    return parts.join('');
  }
  function resolve(field, config = {}) {
    if (field === 'input') return input(config);
    if (field === 'send') return send(config);
    if (field === 'question') {
      const rs = rounds(config); if (!rs.length) throw failure('not_found', '无法识别当前问题', field, { build: BUILD, selector: config.question || defaults.question, documentUrl: location.href });
      // 长回答可能已把问题行顶出视口而被虚拟列表卸载，此时无从定位问题行，明确报错而不是选错节点。
      const q = rs[rs.length - 1].question;
      if (!q) throw failure('not_found', '当前问题行已被虚拟列表卸载（滚出视口），无法定位', field, { build: BUILD, reason: 'question_unmounted' });
      if (!visible(q) || !questionText(q) || q.matches('main,body,html')) throw failure('wrong_role', '问题角色验证失败', field);
      return q;
    }
    return current(config).answer;
  }
  function inspect(field, config) {
    // 虚拟列表会卸载滚出视口的问题行；inspect 不该因此整体失败，退回到可验证的回答容器。
    let node, degraded = null;
    try { node = resolve(field, config); }
    catch (e) {
      if (field !== 'question' || e.details?.reason !== 'question_unmounted') throw e;
      node = current(config).answer; degraded = 'question_unmounted';
    }
    const sel = config[field] || defaults[field] || 'known round';
    // 诊断用：原始命中数 vs 可见命中数，用来区分"没有元素"和"元素在但被判为不可见"。
    let raw = 0;
    try { raw = sel === 'known round' ? 1 : document.querySelectorAll(sel).length; } catch { raw = -1; }
    return { field, valid: true, build: BUILD, tag: node.tagName.toLowerCase(), textPreview: text(node).slice(0, 180), selector: sel, rawCount: raw, count: 1, ...(degraded ? { degraded } : {}), documentUrl: location.href };
  }
  function pruned(root, maxChars = 6000) {
    let count = 0, cut = false;
    const visit = (node, depth) => {
      if (++count > 600 || depth > 24) { cut = true; return ''; }
      if (node.nodeType === Node.TEXT_NODE) return (node.textContent || '').replace(/\s+/g, ' ').slice(0, 240).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
      if (node.nodeType !== Node.ELEMENT_NODE || node.matches('script,style,svg,noscript,iframe,input[type=password]')) return '';
      const tag = node.tagName.toLowerCase();
      const attrs = ['id', 'class', 'role', 'aria-label', 'data-testid', 'data-observe-row', 'data-message-id', 'data-streaming'].map(k => node.hasAttribute(k) ? ` ${k}=${JSON.stringify(String(node.getAttribute(k)).slice(0, 160)).replace(/</g, '&lt;')}` : '').join('');
      return `<${tag}${attrs}>${[...node.childNodes].map(n => visit(n, depth + 1)).join('')}</${tag}>`;
    };
    const scope = root || document.querySelector('.list_items') || document.querySelector('main') || document.body;
    const raw = visit(scope, 0);
    const landmarks = root ? undefined : select('h1,h2,h3,[data-testid],.md-box-root,[data-observe-row],textarea,button', scope).slice(0, 60).map(n => ({ tag: n.tagName.toLowerCase(), id: n.id, class: String(n.className).slice(0, 200), testId: n.getAttribute('data-testid'), row: n.getAttribute('data-observe-row'), label: n.getAttribute('aria-label'), text: text(n).slice(0, 220) }));
    return { html: raw.slice(0, maxChars), truncated: cut || raw.length > maxChars, maxChars, ...(landmarks ? { landmarks, textPreview: text(scope).slice(0, 4000) } : {}) };
  }
  // 生成中判定只认确定的正面信号：data-streaming="true"，或停止按钮可见。
  // 不能拿"发送按钮不见"当证据——按钮可能因为输入为空而隐藏，那样会永远判成生成中。
  function generating() {
    const streaming = [...document.querySelectorAll('[data-streaming="true"]')].filter(visible);
    if (streaming.length) return true;
    const stop = [...document.querySelectorAll('[data-testid*="stop" i],[aria-label*="停止"],[aria-label*="Stop" i]')].filter(visible);
    return stop.length > 0;
  }
  // 完成判定：豆包正式回答结束后会挂出操作栏（复制/点赞/分享），
  // 而"我先查一下…"这类搜索前开场白结束时没有操作栏。
  // 只靠 streaming/停止按钮会在这个间隙误判成已完成，采到只有一句话的开场白。
  function hasActionBar(round) {
    const scope = round.container;
    if (!scope) return false;
    // 必须限定在本轮回答容器内：页面上方用户消息也带操作栏，
    // 若在整个列表里找，会永远认为回答已完成。
    const bar = [...scope.querySelectorAll('[data-testid="message_action_bar"]')].filter(visible);
    if (!bar.length) return false;
    return bar.some(b => b.querySelector('[data-testid="message_action_copy"],[data-testid="message_action_like"],[data-testid="message_action_share"]'));
  }
  // 完成：正文稳定、不再生成，并且操作栏已出现；豆包不总有"复制"按钮，因此以操作栏为正向证据。
  function completed(round) { return Boolean(bodyText(round)) && !generating() && hasActionBar(round); }
  function extract(round, keyword) {
    const citations = [], seen = new Set();
    for (const a of (round.answers || [round.answer]).flatMap(n => [...n.querySelectorAll('a[href]')])) {
      try {
        const url = new URL(a.getAttribute('href'), location.href);
        if (!['http:', 'https:'].includes(url.protocol) || /^(www\.)?doubao\.com$/.test(url.hostname) || seen.has(url.href)) continue;
        seen.add(url.href); citations.push({ url: url.href, title: text(a).slice(0, 500) || url.hostname });
      } catch { /* Invalid or script links are not citations. */ }
    }
    const qa = pruned(round.container, 20000);
    return { platform: PLATFORM_ID, keyword: keyword || questionText(round.question), url: location.href, capturedAt: new Date().toISOString(), complete: true, text: bodyText(round), html: bodyHtml(round), qa: qa.html, qaTruncated: qa.truncated, citations, citationStatus: { scope: 'visible-answer-links', complete: true, reason: '豆包通常不联网检索；0 条不代表采集失败' }, visibility: document.visibilityState, screenshot: { status: 'not_requested' } };
  }
  // ProseMirror 只接受受信任输入：先用 debugger 的 Input.insertText 写入，
  // 失败再退回选区替换 / execCommand。
  // ProseMirror 的真实状态在 EditorState 里，DOM 只是投影。
  // 直接改 DOM 会让 React 的 canSend 保持 false，发送按钮一直禁用。
  // 这条兜底路径通过 React fiber 找到 EditorView，直接 dispatch 一个插入事务。
  function editorView() {
    const el = document.querySelector('.tiptap.ProseMirror, [contenteditable="true"]');
    if (!el) return null;
    const key = Object.keys(el).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
    let fiber = key ? el[key] : null;
    for (let i = 0; fiber && i < 200; i++, fiber = fiber.return) {
      const props = fiber.memoizedProps || fiber.pendingProps;
      const view = props?.editor?.view || props?.view || props?.state?.view;
      if (view?.dispatch && view.state?.tr) return view;
    }
    return globalThis.__tiptap_view__ || null;
  }
  function dispatchInsert(value) {
    const view = editorView();
    if (!view) return false;
    try {
      const { from, to } = view.state.selection;
      view.dispatch(view.state.tr.insertText(value, from, to).scrollIntoView());
      view.focus?.();
      return true;
    } catch { return false; }
  }
  function enabled(el) { return el && !el.disabled && el.getAttribute('aria-disabled') !== 'true'; }
  async function fill(node, value) {
    node.focus();
    const expected = normalize(value);
    let lastError = '';
    // 真实判据：文字进 DOM 且发送按钮解除禁用。只满足前者说明 ProseMirror 没接受输入。
    const settle = async (ms = 2500) => {
      const deadline = Date.now() + ms;
      let matched = false;
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 50));
        const same = node.isConnected && normalize(node.value ?? text(node)) === expected;
        if (same && matched) return true;
        matched = same;
      }
      return false;
    };
    const ready = () => {
      const same = node.isConnected && normalize(node.value ?? text(node)) === expected;
      let btn = null;
      try { btn = send({}); } catch { /* 还没有可用的发送按钮 */ }
      return same && enabled(btn);
    };
    const reachable = async ms => { const d = Date.now() + ms; while (Date.now() < d) { if (ready()) return true; await new Promise(r => setTimeout(r, 80)); } return false; };
    try {
      const r = node.getBoundingClientRect();
      const point = { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      const reply = await chrome.runtime.sendMessage({ type: 'input-text', text: value, point });
      if (reply?.ok && await settle()) {
        if (await reachable(2500)) return;
        lastError = `输入已写入但发送按钮仍不可用${reply.state ? `（${reply.state}）` : ''}`;
        // 事务没发生：直接用 EditorView 派发，绕过事件系统。
        if (dispatchInsert(value) && await reachable(2500)) return;
      }
      if (!reply?.ok) lastError = reply?.error?.message || '输入通道返回失败';
    } catch (e) { lastError = e?.message || '输入通道异常'; }
    node.focus();
    const range = document.createRange(); range.selectNodeContents(node);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    const ok = document.execCommand?.('insertText', false, value);
    if (!ok) {
      node.textContent = value;
      node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
      node.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (await settle() && await reachable(2000)) return;
    if (dispatchInsert(value) && await reachable(2000)) return;
    throw failure('input_mismatch', `填写后输入未生效${lastError ? `：${lastError}` : ''}`, 'input', lastError ? { channel: lastError } : {});
  }
  // 提交后校验：页面必须真的进入了这一轮对话。
  // 从首页发起时若提交没生效，URL 会停在 /chat/，此时等待只会白等到超时。
  async function verifySubmitted(keyword, config = {}) {
    const want = normalize(keyword);
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const onChat = /\/chat\/\d+/.test(location.pathname);
      const shown = rounds(config).some(r => r.question && questionText(r.question) === want);
      const streaming = generating();
      if ((onChat || shown) && (shown || streaming || rounds(config).length)) return true;
      await new Promise(r => setTimeout(r, 300));
    }
    throw failure('submission_failed', '提交后页面未出现本轮对话，问题未发出', 'send', { url: location.href, build: BUILD });
  }
  function bounds(config) {
    // 回答按分段渲染，截图范围必须覆盖全部分段的并集，否则只截到第一段。
    const round = current(config);
    const rects = round.answers.map(n => n.getBoundingClientRect());
    const left = Math.min(...rects.map(r => r.left)), top = Math.min(...rects.map(r => r.top));
    const right = Math.max(...rects.map(r => r.right)), bottom = Math.max(...rects.map(r => r.bottom));
    const r = { x: left, y: top, width: right - left, height: bottom - top };
    if (r.width <= 0 || r.height <= 0 || r.width > 8000 || r.height > 16000) throw failure('capture_bounds', '回答布局范围不适合截图', 'answer');
    return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height, scale: 1 };
  }
  // 豆包的发送按钮由框架监听指针事件；单纯 click() 在部分版本不触发提交。
  // 依次尝试真实指针序列、回车键，并在每次之后确认输入框已被清空。
  async function submit(node, config = {}) {
    const box = input({});
    const before = normalize(text(box));
    // 只认最硬的证据：输入框真的被清空。
    // 不能用"多了一轮"——从首页发起时本来就没有行，而列表里残留的上一轮也会让计数抖动。
    // 也不能用 generating()——那只是页面状态，不代表问题已发出。
    const done = () => {
      if (!box.isConnected) return true;
      return normalize(text(box)) !== before;
    };
    const fire = (el, type, init = {}) => el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, ...init }));
    node.scrollIntoView?.({ block: 'nearest' });
    const r = node.getBoundingClientRect();
    const at = { clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };
    const point = { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    // 优先真实 Enter：豆包的输入框对回车提交最可靠，按钮在某些布局下不可点。
    box.focus();
    try {
      const reply = await chrome.runtime.sendMessage({ type: 'input-key', key: 'Enter' });
      if (reply?.ok && await waitForSubmit(done, 5000)) return true;
    } catch { /* Fall through to pointer events. */ }
    // 再走浏览器级真实点击（框架只在受信任事件上提交）。
    try {
      const reply = await chrome.runtime.sendMessage({ type: 'input-click', point });
      if (reply?.ok && await waitForSubmit(done, 5000)) return true;
    } catch { /* Fall through to DOM events. */ }
    fire(node, 'pointerdown', at); fire(node, 'mousedown', at);
    if (node.focus) node.focus();
    fire(node, 'pointerup', at); fire(node, 'mouseup', at);
    fire(node, 'click', at);
    if (await waitForSubmit(done)) return true;
    box.focus();
    for (const type of ['keydown', 'keypress', 'keyup']) box.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    if (await waitForSubmit(done)) return true;
    node.click();
    return waitForSubmit(done, 3000);
  }
  async function waitForSubmit(done, ms = 2000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (done()) return true;
      await new Promise(r => setTimeout(r, 100));
    }
    return false;
  }
  function isPlatformUrl(href) { try { return ['www.doubao.com', 'doubao.com'].includes(new URL(href).hostname); } catch { return false; } }
  // 只看路径与域名：新会话地址常带 ?from_login=1，登录后依然保留，不能据此判未登录。
  function loginRequired(href = location.href) {
    try { const u = new URL(href); return /(^|\.)passport\.doubao\.com$/.test(u.hostname) || /^\/login(\/|$)/.test(u.pathname); } catch { return false; }
  }
  globalThis.GEOAdapter = { platformId: PLATFORM_ID, build: BUILD, normalize, text, visible, failure, input, send, submit, verifySubmitted, rounds, current, resolve, inspect, pruned, generating, completed, hasActionBar, extract, fill, bounds, isPlatformUrl, loginRequired, questionText, bodyText, answerText: bodyText, minAnswerChars: 60 };
})();
