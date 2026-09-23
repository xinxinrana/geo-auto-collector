// 平台控制台的单元素点选器。配置流程状态由控制台保存。
(function () {
  function visible(element) {
    const style = getComputedStyle(element);
    return element.getClientRects().length > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  }

  function stableClass(name) {
    return name && !/^css-[\w-]+$/i.test(name) && !/-[A-Za-z0-9]{5,}$/.test(name) && !/[A-Z][A-Za-z0-9]{5,}/.test(name);
  }

  function targetFor(element, field) {
    if (field === 'input') return element.closest('textarea, input, [contenteditable="true"], [role="textbox"]') || element.querySelector('textarea, input, [contenteditable="true"], [role="textbox"]') || element;
    if (field === 'send') return element.closest('button, [role="button"]') || element;
    const semantic = /answer|response|message|markdown|prose|bubble|query|prompt|content/i;
    for (let node = element; node && node !== document.body; node = node.parentElement) {
      if (['data-testid', 'data-test', 'role'].some((name) => node.hasAttribute(name)) || [...node.classList].some((name) => stableClass(name) && semantic.test(name))) return node;
    }
    return element;
  }

  function selectorFor(element) {
    const unique = (selector) => {
      try { return document.querySelectorAll(selector).length === 1; } catch { return false; }
    };
    if (element.id && !/\d{5,}/.test(element.id) && unique(`#${CSS.escape(element.id)}`)) return `#${CSS.escape(element.id)}`;
    for (const attr of ['data-testid', 'data-test', 'name', 'aria-label', 'role', 'contenteditable', 'type']) {
      const value = element.getAttribute(attr);
      if (!value) continue;
      const selector = `${element.tagName.toLowerCase()}[${attr}="${CSS.escape(value)}"]`;
      if (unique(selector)) return selector;
    }
    const classes = [...element.classList].filter(stableClass).slice(0, 3);
    return element.tagName.toLowerCase() + classes.map((name) => `.${CSS.escape(name)}`).join('');
  }

  function matcherFor(element, role) {
    const attributes = {};
    for (const name of ['data-testid', 'data-test', 'name', 'aria-label', 'role', 'contenteditable', 'type']) {
      if (element.hasAttribute(name)) attributes[name] = element.getAttribute(name);
    }
    const ancestors = [];
    for (let node = element.parentElement; node && ancestors.length < 4; node = node.parentElement) {
      const classes = [...node.classList].filter(stableClass).slice(0, 3);
      if (classes.length) ancestors.push({ tag: node.tagName.toLowerCase(), classes });
    }
    return { role, tag: element.tagName.toLowerCase(), classes: [...element.classList].filter(stableClass).slice(0, 4), attributes, ancestors };
  }

  globalThis.startGEOElementPicker = ({ field, platform, requestId }) => new Promise((resolve) => {
    globalThis.__geoElementPickerCancel?.();
    const labels = { input: '输入框', question: '用户提问', answer: '回答正文', send: '发送按钮' };
    if (!labels[field]) { resolve(null); return; }
    let hovered = null;
    let previousOutline = '';
    let previousOffset = '';
    function clearHover() {
      if (!hovered) return;
      hovered.style.outline = previousOutline;
      hovered.style.outlineOffset = previousOffset;
      hovered = null;
    }
    function finish(result) {
      clearHover();
      document.removeEventListener('mouseover', onOver, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKey, true);
      if (globalThis.__geoElementPickerCancel === cancel) globalThis.__geoElementPickerCancel = null;
      chrome.runtime.sendMessage({ type: 'SELECTOR_ELEMENT_PICKED', platform, field, requestId, result }).catch(() => {});
      resolve(result);
    }
    function cancel() { finish(null); }
    function onOver(event) {
      if (!visible(event.target)) return;
      clearHover();
      hovered = event.target;
      previousOutline = hovered.style.outline;
      previousOffset = hovered.style.outlineOffset;
      hovered.style.outline = '2px solid #2563eb';
      hovered.style.outlineOffset = '2px';
    }
    function onClick(event) {
      event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
      const element = targetFor(event.target, field);
      finish({ selector: selectorFor(element), matcher: matcherFor(element, labels[field]) });
    }
    function onKey(event) { if (event.key === 'Escape') { event.preventDefault(); cancel(); } }
    document.addEventListener('mouseover', onOver, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
    globalThis.__geoElementPickerCancel = cancel;
  });
})();
