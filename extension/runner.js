(() => {
  // 与适配器同理：只按存在性判重会让页面一直跑最早注入的旧 runner。
  // 但绝不能替换正在执行任务的 runner，否则它会丢失归属与进度。
  const BUILD = 'runner-2026-11-13a';
  const existing = globalThis.GEORunner;
  if (existing && (existing.build === BUILD || (existing.state && !existing.state.finished))) return;
  const A = globalThis.GEOAdapter;
  let state = null;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  function check() {
    if (state.stopped) throw A.failure('stopped', '插件自动化已停止');
    if (Date.now() > state.deadline) throw A.failure('timeout', '等待超时，未证明本轮回答完成', 'answer');
    if (!A.isPlatformUrl(location.href)) throw A.failure('navigation_changed', '页面已离开目标平台');
    if (A.loginRequired()) throw A.failure('login_required', '请先在网页完成登录');
  }
  async function emit(data) {
    const event = { ...data, taskId: state.task.id, runnerId: state.runnerId, seq: ++state.seq };
    state.pending = event;
    for (;;) {
      try {
        const response = await chrome.runtime.sendMessage({ type: 'runner-event', event });
        if (response?.ok) { state.pending = null; return; }
        if (response?.error?.code === 'runner_conflict') throw A.failure('runner_conflict', '执行归属已失效');
      } catch (e) { if (e.code === 'runner_conflict') throw e; }
      // A critical event must be durably acknowledged before the next side effect.
      await sleep(1000);
      // Keep replaying the same sequence until acknowledged; check() prevents any
      // subsequent page side effect if a stop/deadline occurred while disconnected.
    }
  }
  async function change() {
    check();
    await new Promise(resolve => {
      let timer;
      const observer = new MutationObserver(finish);
      function finish() { clearTimeout(timer); observer.disconnect(); resolve(); }
      observer.observe(document.querySelector('main') || document.body, { childList: true, subtree: true, characterData: true, attributes: true });
      timer = setTimeout(finish, 500);
    });
    check();
  }
  async function waitFor(fn, maxMs = 30000) {
    const until = Math.min(state.deadline, Date.now() + maxMs); let last;
    while (Date.now() <= until) {
      check();
      try { return fn(); } catch (e) { last = e; if (!['not_found'].includes(e.code)) throw e; }
      await change();
    }
    throw last || A.failure('timeout', '页面元素等待超时');
  }
  async function execute() {
    const { command } = state.task, config = state.config.selectors || {};
    try {
      check();
      if (command.action === 'inspect' || command.action === 'dom' || command.action === 'fix') {
        const candidate = command.action === 'fix' ? { ...config, [command.field]: command.selector } : config;
        const inspection = A.inspect(command.field, candidate);
        let data = { ...inspection, revision: state.config.revision, documentUrl: location.href };
        if (command.action === 'dom') data = { ...data, ...A.pruned(A.resolve(command.field, candidate), command.maxChars) };
        if (command.action === 'fix' && !command.testOnly) {
          check();
          const reply = await chrome.runtime.sendMessage({ type: 'save-anchor', taskId: state.task.id, runnerId: state.runnerId, field: command.field, selector: command.selector, expectedRevision: command.expectedRevision });
          if (!reply?.ok) throw A.failure(reply?.error?.code || 'save_failed', reply?.error?.message || '配置保存失败', command.field);
          data = { ...data, saved: true, revision: reply.revision };
        }
        await emit({ status: 'done', step: 'completed', result: { data } }); return;
      }
      if (command.action === 'shot') {
        const clip = A.bounds(config);
        const response = await chrome.runtime.sendMessage({ type: 'capture', taskId: state.task.id, runnerId: state.runnerId, clip });
        if (!response?.ok) throw A.failure('screenshot_failed', response?.error?.message || '截图失败', 'answer');
        await emit({ status: 'done', step: 'completed', result: { screenshotBase64: response.data, data: { scope: 'answer-layout', capturedAt: new Date().toISOString(), url: location.href } } }); return;
      }
      const baseline = A.rounds(config).map(r => A.normalize(A.text(r.question)));
      if (command.action === 'run') {
        // 受信任输入需要页面真正在前台；页面自己的适配器也能置前时优先用它。
        if (A.foreground) await A.foreground();
        else {
          try { await chrome.runtime.sendMessage({ type: 'foreground' }); } catch { /* Best effort. */ }
        }
        const box = await waitFor(() => A.input(config));        await A.fill(box, command.keyword);
        const send = await waitFor(() => A.send(config));
        await emit({ status: 'running', step: 'submission_intent', submissionState: 'intent' });
        check();
        if (A.submit) { if (!await A.submit(send, config)) throw A.failure('submission_failed', '点击发送后输入未被提交', 'send'); }
        else send.click();
        state.submitted = true;
        // 提交后必须真的出现本轮消息；否则宁可立刻失败，也不要空等整个超时。
        // （首页提交失败时 URL 会停留在 /chat/，输入框被清空但问题根本没发出去。）
        if (A.verifySubmitted) await A.verifySubmitted(command.keyword, config);
        await emit({ status: 'running', step: 'waiting', submissionState: 'submitted' });
      } else await emit({ status: 'running', step: 'waiting' });
      let lastText = '', lastChanged = Date.now(), seenGenerating = false, grownAt = 0;
      while (true) {
        check();
        seenGenerating ||= A.generating();
        try {
          const round = A.current(config, command.action === 'run' ? command.keyword : null, baseline);
          // 多段渲染的平台（如豆包）需要拼合全部段落来判断正文是否仍在增长。
          const value = A.answerText ? A.answerText(round) : A.text(round.answer);
          if (value !== lastText) { lastText = value; lastChanged = Date.now(); }
          if (value.length > (grownAt || 0)) grownAt = value.length;
          state.partial = A.extract(round, command.keyword);
          // 开场白陷阱：豆包会先输出"我先查一下…"再检索，这段也可能短暂满足完成条件。
          // 因此只有正文长度足够（或平台明确给出完成信号）时才允许收尾。
          const substantial = !A.minAnswerChars || value.length >= A.minAnswerChars;
          const settled = value && !A.generating() && (seenGenerating || A.completed(round)) && Date.now() - lastChanged >= 2500;
          if (settled && substantial && Date.now() - lastChanged >= (A.minAnswerChars ? 6000 : 2500)) {
            check();
            const result = A.extract(round, command.keyword);
            if (JSON.stringify(result).length > 8 * 1024 * 1024) throw A.failure('result_too_large', '结果超过 8 MiB，无法安全交付');
            await emit({ status: 'done', step: 'completed', submissionState: state.submitted ? 'confirmed' : 'not_submitted', result }); return;
          }
        } catch (e) {
          if (e.code !== 'not_found') throw e;
        }
        await change();
      }
    } catch (e) {
      const error = { code: e.code || 'execution_error', message: e.message, ...(e.field ? { field: e.field } : {}), ...(e.details || {}) };
      const suspended = ['not_found', 'ambiguous', 'wrong_role', 'invalid_selector', 'input_mismatch', 'submission_failed'].includes(error.code);
      const status = error.code === 'stopped' ? 'interrupted' : suspended ? 'suspended' : 'failed';
      const diagnostic = { error, url: location.href, at: new Date().toISOString(), visibility: document.visibilityState, dom: A.pruned(null, 8000), selectors: config };
      await emit({ status, step: 'ended', error, diagnostic, ...(state.partial ? { result: { ...state.partial, complete: false } } : {}) });
    } finally { state.finished = true; }
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message.type === 'runner-probe') { respond({ present: true, taskId: state?.task.id, runnerId: state?.runnerId, finished: state?.finished || false }); return; }
    if (message.type === 'runner-stop') {
      if (state?.task.id === message.taskId && !state.finished) { state.stopped = true; respond({ requested: true }); }
      else respond({ requested: false, finished: state?.finished || false });
      return;
    }
    if (message.type !== 'runner-start') return;
    if (state?.task.id === message.task.id) { respond({ accepted: state.runnerId === message.runnerId }); return; }
    if (state && !state.finished) { respond({ accepted: false }); return; }
    state = { task: message.task, runnerId: message.runnerId, config: message.config, started: Date.now(), deadline: Date.now() + (message.task.command.timeoutMs || 30000), seq: message.seq, stopped: false, finished: false, submitted: false };
    respond({ accepted: true });
    execute().catch(() => { state.finished = true; });
  });
  globalThis.GEORunner = { build: BUILD, get state() { return state; } };
})();
