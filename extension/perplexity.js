(() => {
  if (globalThis.GEOAdapter) return;
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
  const defaults = {
    input: 'main [role="textbox"][contenteditable="true"], main textarea, main [contenteditable="true"][data-lexical-editor="true"]',
    send: 'button[aria-label="Submit"], button[aria-label="Send"], button[aria-label="提交"], button[aria-label="发送"]',
    question: 'main [class~="group/user-bubble"] > [class~="whitespace-pre-wrap"]', answer: '.prose'
  };
  function editable(n) { return n.matches('textarea,input:not([type=password]):not([type=hidden])') || n.getAttribute('contenteditable') === 'true'; }
  function input(config) {
    let nodes = select(config.input || defaults.input).filter(editable);
    if (!config.input && !nodes.length) nodes = select('[role="textbox"][contenteditable="true"], textarea, [contenteditable="true"][data-lexical-editor="true"]').filter(editable);
    return unique(nodes.filter(n => !n.disabled && !n.readOnly), 'input');
  }
  function send(config) {
    const box = input(config);
    const nodes = select(config.send || defaults.send).filter(n => (n.matches('button,[role="button"]')) && !n.disabled && n.getAttribute('aria-disabled') !== 'true' && /^(submit|send|ask|search|提交|发送|提问|搜索)$/i.test(normalize(n.getAttribute('aria-label') || n.getAttribute('title') || text(n))));
    const form = box.closest('form');
    return unique(nodes.filter(n => !form || form.contains(n)), 'send');
  }
  function rounds(config = {}) {
    const containers = select('main .focus\\:outline-none div.flex.flex-col.gap-y-md').filter(n => n.children.length >= 2);
    if (containers.length) return containers.filter(n => !containers.some(other => other !== n && n.contains(other))).map(container => {
      const question = config.question ? unique(select(config.question, container), 'question') : container.children[0];
      const assistant = container.children[1];
      const candidates = select(config.answer || defaults.answer, assistant).filter(n => !n.closest('[data-testid*="thinking"], [data-testid*="reasoning"], details'));
      return { container, question, answers: candidates };
    });
    // Session pages keep the user bubble and final answer in sibling partitions.
    const questions = select(config.question || defaults.question);
    const answers = select(config.answer || 'main [class~="group/final-text"] .prose');
    return questions.map(question => {
      let container = question.parentElement;
      while (container && !container.matches('main,body,html') && !answers.some(a => container.contains(a))) container = container.parentElement;
      if (!container || container.matches('main,body,html') || questions.filter(q => container.contains(q)).length !== 1) return null;
      return { container, question, answers: answers.filter(a => container.contains(a)) };
    }).filter(Boolean);
  }
  function current(config, expected, baseline = []) {
    let candidates = rounds(config).filter(r => visible(r.question) && text(r.question));
    if (expected) {
      candidates = candidates.filter(r => normalize(text(r.question)) === normalize(expected));
      if (baseline.some(t => t === normalize(expected))) throw failure('ambiguous', '提交前已有相同问题，无法证明当前轮次', 'question');
    } else if (candidates.length) candidates = [candidates[candidates.length - 1]];
    const round = unique(candidates, 'question');
    const answer = unique(round.answers, 'answer');
    if (!round.container.contains(answer) || answer.contains(round.question) || !(round.question.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING) || answer.matches('main,body,html') || answer.closest('nav,aside,[data-testid*="thinking"],details')) throw failure('wrong_role', '回答不属于本轮正文', 'answer');
    return { ...round, answer };
  }
  function resolve(field, config = {}) {
    if (field === 'input') return input(config);
    if (field === 'send') return send(config);
    if (field === 'question') {
      const rs = rounds(config); if (!rs.length) throw failure('not_found', '无法识别当前问题', field);
      const round = rs[rs.length - 1], q = round.question;
      if (!visible(q) || !text(q) || q.matches('main,body,html')) throw failure('wrong_role', '问题角色验证失败', field);
      if (round.answers.some(a => a === q || a.contains(q) || q.contains(a) || !(q.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING))) throw failure('wrong_role', '问题不能指向回答或包含回答的容器', field);
      return q;
    }
    return current(config).answer;
  }
  function inspect(field, config) {
    const node = resolve(field, config);
    return { field, valid: true, tag: node.tagName.toLowerCase(), textPreview: text(node).slice(0, 180), selector: config[field] || defaults[field] || 'known round first child', count: 1 };
  }
  function pruned(root, maxChars = 6000) {
    let count = 0, cut = false;
    const visit = (node, depth) => {
      if (++count > 600 || depth > 24) { cut = true; return ''; }
      if (node.nodeType === Node.TEXT_NODE) return (node.textContent || '').replace(/\s+/g, ' ').slice(0, 240).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
      if (node.nodeType !== Node.ELEMENT_NODE || node.matches('script,style,svg,noscript,iframe,input[type=password]')) return '';
      const tag = node.tagName.toLowerCase();
      const attrs = ['id', 'class', 'role', 'aria-label', 'data-testid'].map(k => node.hasAttribute(k) ? ` ${k}=${JSON.stringify(node.getAttribute(k).slice(0, 160)).replace(/</g, '&lt;')}` : '').join('');
      return `<${tag}${attrs}>${[...node.childNodes].map(n => visit(n, depth + 1)).join('')}</${tag}>`;
    };
    const scope = root || document.querySelector('main .scrollable-container') || document.querySelector('main') || document.body;
    const raw = visit(scope, 0);
    const landmarks = root ? undefined : select('h1,h2,h3,[data-testid],.prose,[role="textbox"],button[aria-label]', scope).slice(0, 60).map(n => ({ tag: n.tagName.toLowerCase(), id: n.id, class: n.className, testId: n.getAttribute('data-testid'), label: n.getAttribute('aria-label'), text: text(n).slice(0, 220) }));
    return { html: raw.slice(0, maxChars), truncated: cut || raw.length > maxChars, maxChars, ...(landmarks ? { landmarks, textPreview: text(scope).slice(0, 4000) } : {}) };
  }
  function generating() { return select('button[aria-label^="Stop response"], button[aria-label="Stop generating"], button[aria-label="停止生成"], button[aria-label="停止回答"]').length > 0; }
  function completed(round) {
    return select('button[aria-label*="Copy"], button[aria-label*="复制"], button[title*="Copy"], button[title*="复制"]', round.container).some(n =>
      !n.closest('[class~="group/user-bubble"]') && !/query|question|问题|提问/i.test(n.getAttribute('aria-label') || n.getAttribute('title') || '') &&
      Boolean(round.answer.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING));
  }
  const PLATFORM_ID = 'perplexity';
  function extract(round, keyword) {
    const citations = [], seen = new Set();
    for (const a of round.answer.querySelectorAll('a[href]')) {
      try {
        const url = new URL(a.getAttribute('href'), location.href);
        if (!['http:', 'https:'].includes(url.protocol) || /^(www\.)?perplexity\.ai$/.test(url.hostname) || seen.has(url.href)) continue;
        seen.add(url.href); citations.push({ url: url.href, title: text(a).slice(0, 500) || url.hostname });
      } catch { /* Invalid or script links are not citations. */ }
    }
    const qa = pruned(round.container, 20000);
    return { platform: PLATFORM_ID, keyword: keyword || text(round.question), url: location.href, capturedAt: new Date().toISOString(), complete: true, text: text(round.answer), html: round.answer.innerHTML, qa: qa.html, qaTruncated: qa.truncated, citations, citationStatus: { scope: 'visible-answer-links', complete: false, reason: '来源弹层未自动展开；0 条不代表没有引用' }, visibility: document.visibilityState, screenshot: { status: 'not_requested' } };
  }
  async function fill(node, value) {
    node.focus();
    if (node.matches('input,textarea')) {
      const proto = node.matches('textarea') ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(node, value);
      node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
      node.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      const range = document.createRange(); range.selectNodeContents(node);
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
      const ok = document.execCommand?.('insertText', false, value);
      if (!ok) {
        node.textContent = value;
        node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
        node.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
    // Controlled editors may commit their input event in a later render.
    // Observe the committed value before allowing the runner to submit.
    const expected = normalize(value), deadline = Date.now() + 2000;
    let matched = false;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
      const same = node.isConnected && normalize(node.value ?? text(node)) === expected;
      if (same && matched) return;
      matched = same;
    }
    throw failure('input_mismatch', '填写后输入内容不匹配', 'input');
  }
  function bounds(config) {
    const n = resolve('answer', config), r = n.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0 || r.width > 8000 || r.height > 16000) throw failure('capture_bounds', '回答布局范围不适合截图', 'answer');
    return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height, scale: 1 };
  }
  function isPlatformUrl(href) { try { return ['www.perplexity.ai', 'perplexity.ai'].includes(new URL(href).hostname); } catch { return false; } }
  function loginRequired(href = location.href) { return /^https:\/\/(www\.)?perplexity\.ai\/(login|signin)/.test(href); }
  globalThis.GEOAdapter = { normalize, text, visible, failure, input, send, rounds, current, resolve, inspect, pruned, generating, completed, extract, fill, bounds, isPlatformUrl, loginRequired };
})();
