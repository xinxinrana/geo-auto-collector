// dev/probe-buttons-runtime.js — 页面注入的按钮侦查器
// 流程:
//   1. 找到输入框(不同平台不同选择器)
//   2. 快照「输入前」的可见按钮
//   3. 用平台特化方式输入问题(React setter / Lexical / Quill / execCommand)
//   4. 快照「输入后」的按钮 → diff → 发送键候选
//   5. 点击发送候选 或 回车 fallback
//   6. 快照「发送后立即」→ diff → 停止键候选(消失=可能是发送/新增=可能是停止)
//   7. 轮询 20 秒采集所有「输入后新出现」按钮,聚合去重

async function probeButtons(question, platform) {
  const trace = [];
  const t = (m, e) => trace.push(m + (e !== undefined ? ' ' + (typeof e === 'object' ? JSON.stringify(e) : e) : ''));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const describeInput = (el) => el ? {
    tag: el.tagName.toLowerCase(),
    id: el.id || null,
    cls: String(el.className || '').replace(/\s+/g, ' ').trim().slice(0, 200),
    dataAttrs: [...el.attributes].filter(a => a.name.startsWith('data-')).map(a => `${a.name}=${(a.value || '').slice(0, 30)}`),
    editable: !!el.isContentEditable,
    value: el.value ? el.value.slice(0, 80) : (el.innerText || '').slice(0, 80),
  } : null;

  // 按钮描述(用于识别):不用 innerText 中间的文本(可能含变化的时间),
  // 而用 aria-label / testid / title / icon path / 排除 innerText 长度限定字符
  const describeButton = (b) => {
    const svg = b.querySelector('svg');
    const svgClass = svg ? (svg.getAttribute('class') || '').slice(0, 60) : null;
    const svgPath = svg ? [...svg.querySelectorAll('path')].map(p => (p.getAttribute('d') || '').slice(0, 40)).slice(0, 2).join('|') : null;
    const rect = b.getBoundingClientRect();
    return {
      aria: b.getAttribute('aria-label') || null,
      testid: b.getAttribute('data-testid') || null,
      title: b.getAttribute('title') || null,
      role: b.getAttribute('role') || null,
      type: b.getAttribute('type') || null,
      cls: String(b.className || '').replace(/\s+/g, ' ').trim().slice(0, 100),
      text: (b.innerText || '').trim().slice(0, 30),
      svgClass, svgPath,
      matIcon: b.querySelector('mat-icon')?.getAttribute('data-mat-icon-name') || null,
      dataAttrs: [...b.attributes].filter(a => a.name.startsWith('data-')).map(a => `${a.name}=${(a.value || '').slice(0, 30)}`).slice(0, 5),
      disabled: b.disabled,
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
    };
  };

  const snapshotButtons = () => {
    return [...document.querySelectorAll('button, [role=button]')]
      .filter(b => b.offsetParent !== null)
      .filter(b => {
        const r = b.getBoundingClientRect();
        return r.width > 6 && r.height > 6; // 排除极小的隐藏按钮
      })
      .map(describeButton);
  };

  const keyOf = (b) => JSON.stringify([b.aria, b.testid, b.title, b.svgPath || b.svgClass || b.matIcon, b.text, b.cls.slice(0, 40)]);

  try {
    t('start', { url: location.href, platform, q: question });

    // ---- 1) 定位输入框 ----
    const inputSelectors = {
      doubao: ['textarea.semi-input-textarea', 'textarea', 'div[contenteditable=true]'],
      kimi: ['div[contenteditable=true][data-lexical-editor=true]', 'div[contenteditable=true]', 'textarea'],
      yuanbao: ['div[contenteditable=true][data-prevent-quill-blur]', 'div[contenteditable=true].ql-editor', 'div[contenteditable=true]', 'textarea'],
      perplexity: ['div[role=textbox][contenteditable=true]', 'textarea', 'div[contenteditable=true]'],
    };
    const sels = inputSelectors[platform] || ['textarea', 'div[contenteditable=true]'];
    let input = null;
    for (let attempt = 0; attempt < 20 && !input; attempt++) {
      for (const sel of sels) {
        const candidates = [...document.querySelectorAll(sel)].filter(e => e.offsetParent !== null);
        // 选取可视区最靠下/最大的(输入框一般在底部)
        candidates.sort((a, b) => {
          const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
          return (rb.top * rb.width) - (ra.top * ra.width);
        });
        if (candidates[0]) { input = candidates[0]; break; }
      }
      if (!input) await sleep(500);
    }
    if (!input) return { ok: false, error: 'input_not_found', trace };
    t('input_found', { tag: input.tagName, cls: String(input.className).slice(0, 60) });
    const inputInfo = describeInput(input);

    // ---- 2) 输入前按钮快照 ----
    await sleep(500);
    const buttonsBefore = snapshotButtons();
    const beforeKeys = new Set(buttonsBefore.map(keyOf));
    t('before_snapshot', { count: buttonsBefore.length });

    // ---- 3) 平台特化输入 ----
    input.focus();
    await sleep(200);

    const typeReactNative = (el, text) => {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      nativeSetter.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };

    const typeContentEditable = (el, text) => {
      // 清空 + 逐字插入
      const range = document.createRange();
      range.selectNodeContents(el);
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(range);
      document.execCommand('delete', false);
      // 一次性插入更快,大多数编辑器都支持
      document.execCommand('insertText', false, text);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
    };

    if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
      typeReactNative(input, question);
      t('typed_react');
    } else if (input.isContentEditable) {
      typeContentEditable(input, question);
      t('typed_contenteditable');
    }
    await sleep(1500); // 让 UI 重新计算按钮状态

    // ---- 4) 输入后按钮快照 ----
    const buttonsAfterType = snapshotButtons();
    const afterTypeKeys = new Set(buttonsAfterType.map(keyOf));
    const newAfterType = buttonsAfterType.filter(b => !beforeKeys.has(keyOf(b)));
    const disappearedAfterType = buttonsBefore.filter(b => !afterTypeKeys.has(keyOf(b)));
    // 「状态改变」的按钮:key 一样但 disabled 变化(输入前 disabled=true,输入后 disabled=false → 发送键)
    const stateChanged = [];
    for (const b of buttonsAfterType) {
      const before = buttonsBefore.find(x => keyOf(x) === keyOf(b));
      if (before && before.disabled !== b.disabled) stateChanged.push({ ...b, wasDisabled: before.disabled });
    }
    t('after_type_snapshot', { added: newAfterType.length, removed: disappearedAfterType.length, stateChanged: stateChanged.length });

    // ---- 5) 发送:优先点新出现按钮里最像发送的(位置最靠下靠右、非菜单类) ----
    // 过滤明显不是发送的
    const notSendPattern = /menu|option|模式|模型|工具|设置|attach|upload|文件|附件|图片|清空|历史|新对话|new chat|share|分享/i;
    const sendCandidates = [
      ...stateChanged.filter(b => !b.disabled && !notSendPattern.test(`${b.aria || ''}${b.text || ''}${b.title || ''}`)),
      ...newAfterType.filter(b => !b.disabled && !notSendPattern.test(`${b.aria || ''}${b.text || ''}${b.title || ''}`)),
    ];
    // 按 y 排序(输入框附近的按钮),取最下方最右的
    sendCandidates.sort((a, b) => (b.y - a.y) || (b.x - a.x));
    t('send_candidates', { total: sendCandidates.length, top3: sendCandidates.slice(0, 3) });

    let sentBy = null;
    if (sendCandidates.length > 0) {
      // 找回真实 DOM 元素
      const inputRect = input.getBoundingClientRect();
      const c = sendCandidates[0];
      const btn = [...document.querySelectorAll('button, [role=button]')].find(b => {
        if (!b.offsetParent) return false;
        const r = b.getBoundingClientRect();
        return Math.abs(Math.round(r.left + r.width / 2) - c.x) < 3 && Math.abs(Math.round(r.top + r.height / 2) - c.y) < 3;
      });
      if (btn) {
        btn.click();
        sentBy = 'click_candidate';
        t('send_click', { aria: c.aria, testid: c.testid, title: c.title, cls: c.cls.slice(0, 40) });
      }
    }
    if (!sentBy) {
      // 回车 fallback
      input.focus();
      const evOpts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
      input.dispatchEvent(new KeyboardEvent('keydown', evOpts));
      input.dispatchEvent(new KeyboardEvent('keypress', evOpts));
      input.dispatchEvent(new KeyboardEvent('keyup', evOpts));
      sentBy = 'enter_fallback';
      t('send_enter');
    }

    // ---- 6) 发送后 300ms 快照 → 定位真正的发送按钮 ----
    await sleep(500);
    const buttonsAfterSend = snapshotButtons();
    const afterSendKeys = new Set(buttonsAfterSend.map(keyOf));
    const disappearedAfterSend = buttonsAfterType.filter(b => !afterSendKeys.has(keyOf(b)) && !beforeKeys.has(keyOf(b)));
    const newAfterSend = buttonsAfterSend.filter(b => !afterTypeKeys.has(keyOf(b)));
    t('after_send_snapshot', { disappeared: disappearedAfterSend.length, added: newAfterSend.length });

    // ---- 7) 轮询采集停止按钮(前 20 秒) ----
    const stopSnapshots = [];
    const stopCandidatesMap = new Map();
    const stopPattern = /stop|停止|中止|pause|中断/i;
    const stopIconPath = /M6 6h12v12H6z|M6\.75 5\.75|square|rect/i; // 方块图标

    const durations = [1000, 2000, 3500, 5500, 8000, 12000, 16000, 20000];
    let elapsed = 500;
    for (const step of durations) {
      await sleep(step - elapsed);
      elapsed = step;
      const cur = snapshotButtons();
      const newHere = cur.filter(b => !beforeKeys.has(keyOf(b)) && !afterTypeKeys.has(keyOf(b)));
      const stops = newHere.filter(b => stopPattern.test(`${b.aria || ''}${b.testid || ''}${b.title || ''}${b.text || ''}`) || stopIconPath.test(b.svgPath || ''));
      for (const s of stops) {
        const k = keyOf(s);
        if (!stopCandidatesMap.has(k)) stopCandidatesMap.set(k, s);
      }
      // 记录所有"生成期间新出现"的按钮(不只是显式 stop 关键字的)
      stopSnapshots.push({
        atMs: elapsed,
        allNewCount: newHere.length,
        stopKeywordCount: stops.length,
        newHere: newHere.slice(0, 6).map(b => ({ aria: b.aria, testid: b.testid, title: b.title, text: b.text, cls: b.cls.slice(0, 30), svgPath: (b.svgPath || '').slice(0, 30) })),
      });
    }
    t('stop_probe_done', { snapshots: stopSnapshots.length, uniqueStopCandidates: stopCandidatesMap.size });

    return {
      ok: true, trace,
      inputInfo,
      buttonsBefore,
      newAfterType,
      disappearedAfterType,
      stateChanged,
      sendCandidates: sendCandidates.slice(0, 8),
      sentBy,
      disappearedAfterSend,
      newAfterSend: newAfterSend.slice(0, 10),
      stopSnapshots,
      stopCandidates: [...stopCandidatesMap.values()],
    };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e), trace };
  }
}
