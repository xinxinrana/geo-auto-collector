// selector-picker.js — 让用户直接在当前页面点选可变的采集元素。
(function () {
  if (globalThis.startGEOSelectorPicker) return;

  function isVisible(el) {
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && el.getClientRects().length > 0;
  }

  function escape(value) {
    return CSS.escape(String(value));
  }

  function stableClass(name) {
    return name && !/^css-[\w-]+$/i.test(name) && !/[A-Z][A-Za-z0-9]{5,}/.test(name) && !/^[a-z]+-[a-z0-9]{6,}$/i.test(name);
  }

  function editableElement(element) {
    if (element.matches('textarea, input, [contenteditable="true"], [role="textbox"]')) return element;
    return element.querySelector('textarea, input, [contenteditable="true"], [role="textbox"]') || element;
  }

  function stableElement(element) {
    let node = element;
    while (node && node !== document.body) {
      const hasStableAttr = ['data-testid', 'data-test', 'name', 'aria-label', 'role'].some((name) => !!node.getAttribute(name));
      if (hasStableAttr || [...node.classList].some(stableClass)) return node;
      node = node.parentElement;
    }
    return element;
  }

  // 仅保留稳定属性与类名；不把动态 class、父级路径、nth-of-type 写入规则。
  function selectorFor(element) {
    if (!(element instanceof Element)) return null;
    const unique = (selector) => {
      try { return document.querySelectorAll(selector).length === 1 ? selector : null; } catch { return null; }
    };
    if (element.id) {
      const selector = `#${escape(element.id)}`;
      if (unique(selector)) return selector;
    }
    for (const attr of ['data-testid', 'data-test', 'name', 'aria-label', 'role', 'contenteditable', 'type']) {
      const value = element.getAttribute(attr);
      if (value) {
        const selector = `${element.tagName.toLowerCase()}[${attr}="${CSS.escape(value)}"]`;
        if (unique(selector)) return selector;
      }
    }
    const classes = [...element.classList].filter(stableClass).slice(0, 3);
    return element.tagName.toLowerCase() + classes.map((c) => `.${escape(c)}`).join('');
  }

  function matcherFor(element, role) {
    const attributes = {};
    for (const name of ['data-testid', 'data-test', 'name', 'aria-label', 'role', 'contenteditable', 'type']) {
      if (element.getAttribute(name)) attributes[name] = element.getAttribute(name);
    }
    return {
      role,
      tag: element.tagName.toLowerCase(),
      classes: [...element.classList].filter(stableClass).slice(0, 4),
      attributes,
    };
  }

  globalThis.startGEOSelectorPicker = ({ mode = 'all', report = null } = {}) => new Promise((resolve) => {
    document.getElementById('geo-selector-picker-root')?.remove();
    const allSteps = [
      { key: 'inputSelector', label: '输入框', hint: '请点击用于输入提问内容的输入框' },
      { key: 'questionSelector', label: '用户提问', hint: '请点击对话中用户发出的那条提问' },
      { key: 'answerSelector', label: '回答结果', hint: '请点击 AI 回答正文的最外层容器' },
    ];
    const steps = mode === 'input' ? [allSteps[0]] : mode === 'response' ? allSteps.slice(1) : allSteps;
    const values = {};
    let stepIndex = 0;
    let hovered = null;
    let waitingForNewChat = false;

    const root = document.createElement('div');
    root.id = 'geo-selector-picker-root';
    root.attachShadow({ mode: 'open' });
    root.shadowRoot.innerHTML = `
      <style>
        :host { all: initial; }
        #panel { position: fixed; z-index: 2147483647; top: 18px; right: 18px; width: 310px; padding: 16px; border-radius: 12px; background: #172033; color: #f8fafc; box-shadow: 0 16px 40px #0008; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
        strong { display:block; font-size:16px; } p { margin:8px 0 12px; color:#dbeafe; } #status { font-size:12px; color:#94a3b8; } button { border:0; border-radius:6px; padding:6px 10px; color:#e2e8f0; background:#334155; cursor:pointer; float:right; margin-left:6px; } button:hover { background:#475569; } #continue { display:none; background:#2563eb; }
      </style><div id="panel"><strong>配置元素 · <span id="step"></span></strong><p id="hint"></p><span id="status"></span><button id="cancel" type="button">取消</button><button id="continue" type="button">继续选择</button></div>`;
    document.documentElement.appendChild(root);
    const panel = root.shadowRoot.getElementById('panel');
    const stepText = root.shadowRoot.getElementById('step');
    const hint = root.shadowRoot.getElementById('hint');
    const status = root.shadowRoot.getElementById('status');
    const continueBtn = root.shadowRoot.getElementById('continue');

    const clearHover = () => {
      if (hovered) { hovered.style.outline = ''; hovered.style.outlineOffset = ''; hovered = null; }
    };
    const finish = (result) => {
      clearHover();
      document.removeEventListener('mouseover', onOver, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKey, true);
      root.remove();
      if (report?.type) chrome.runtime.sendMessage({ type: report.type, flowId: report.flowId, result }).catch(() => {});
      resolve(result);
    };
    const render = () => {
      if (waitingForNewChat) {
        stepText.textContent = '准备测试回答';
        hint.textContent = '请先手动发送一条测试问题并等待回答完成，然后点击“开始选择”。';
        status.textContent = '此时页面可正常操作。';
        continueBtn.textContent = '开始选择';
        continueBtn.style.display = 'block';
        return;
      }
      const step = steps[stepIndex];
      const displayStep = mode === 'response' ? stepIndex + 2 : stepIndex + 1;
      stepText.textContent = `${displayStep}/3 · ${step.label}`;
      hint.textContent = step.hint;
      status.textContent = '鼠标移到元素上预览，点击即可选中；按 Esc 取消。';
    };
    const onOver = (event) => {
      if (waitingForNewChat || root.contains(event.target) || !isVisible(event.target)) return;
      clearHover();
      hovered = event.target;
      hovered.style.outline = '2px solid #2563eb';
      hovered.style.outlineOffset = '2px';
    };
    const onClick = (event) => {
      if (waitingForNewChat || root.contains(event.target)) return;
      event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
      const step = steps[stepIndex];
      const target = step.key === 'inputSelector' ? editableElement(event.target) : stableElement(event.target);
      const selector = selectorFor(target);
      if (!selector) { status.textContent = '无法为这个元素生成有效选择器，请点击其容器或子元素重试。'; return; }
      values[step.key] = selector;
      values[step.key.replace('Selector', 'Matcher')] = matcherFor(target, step.label);
      stepIndex += 1;
      clearHover();
      if (stepIndex === steps.length) finish(values); else render();
    };
    const onKey = (event) => { if (event.key === 'Escape') { event.preventDefault(); finish(null); } };
    root.shadowRoot.getElementById('cancel').addEventListener('click', () => finish(null));
    continueBtn.addEventListener('click', () => { waitingForNewChat = false; continueBtn.style.display = 'none'; render(); });
    document.addEventListener('mouseover', onOver, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
    panel.addEventListener('click', (e) => e.stopPropagation());
    if (mode === 'response') waitingForNewChat = true;
    render();
  });
})();
