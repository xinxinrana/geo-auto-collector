import { allTasks, getTask, putTask, getSetting, putSetting } from './db.js';
import { PROTOCOL, TERMINAL, GeoError, errorBody, isPlatformUrl, platformOf, platformOfUrl, tabPatterns } from '../shared/protocol.js';

let socket, ready = false, connectionMessage = '未连接', projectDir = '', retryTimer, retryMs = 1000;
let connectionAttempt;
let queue = Promise.resolve();
const launching = new Set();
const serial = fn => { const result = queue.then(fn); queue = result.catch(() => {}); return result; };
const terminal = task => TERMINAL.includes(task.status);
const timeout = (promise, ms = 5000) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new GeoError('response_timeout', '页面没有及时回应')), ms))]);
const wire = message => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); };
const publish = () => { void chrome.runtime.sendMessage({ type: 'view-updated' }).catch(() => {}); };
const emitStored = task => { if (ready) for (const event of task.outbox) wire({ type: 'event', event }); };
async function addEvent(task, values) {
  const event = { ...values, taskId: task.id, runnerId: task.runnerId, seq: task.lastSeq + 1, ...(task.tabId != null ? { tabId: task.tabId } : {}) };
  task.lastSeq = event.seq; task.status = event.status; task.step = event.step; task.updatedAt = new Date().toISOString();
  if (event.submissionState) task.submissionState = event.submissionState;
  if (event.result) task.result = event.result;
  if (event.error) task.error = event.error;
  if (event.diagnostic) task.diagnostic = event.diagnostic;
  task.outbox.push(event);
  await putTask(task); emitStored(task); publish();
  return event;
}
async function anchors() { return await getSetting('anchors') || { revision: 0, selectors: {}, history: [] }; }
async function settings() { const saved = await getSetting('connection'); return { enabled: saved?.enabled || false, port: saved?.port || 8787 }; }
async function finishLocal(id, values) { return serial(async () => { const t = await getTask(id); if (t && !terminal(t)) await addEvent(t, values); }); }
async function probe(task) {
  return timeout(chrome.tabs.sendMessage(task.tabId, { type: 'runner-probe' }, task.documentId ? { documentId: task.documentId } : { frameId: 0 }));
}
async function recover() {
  const tasks = await allTasks();
  for (const task of tasks.filter(t => !terminal(t))) {
    if (launching.has(task.id)) continue;
    if (task.command.action === 'stop') continue;
    if (!task.documentId) {
      await finishLocal(task.id, { status: 'interrupted', step: 'recovery', error: { code: 'execution_lost', message: '准备过程被中断；不会自动重启任务' } }); continue;
    }
    try {
      const p = await probe(task);
      if (p.taskId !== task.id || p.runnerId !== task.runnerId || p.finished) await finishLocal(task.id, { status: 'interrupted', step: 'recovery', error: { code: task.submissionState === 'intent' ? 'submission_unknown' : 'execution_lost', message: '原 runner 已结束或身份不符；不会重新提问' } });
    } catch (error) {
      // A frozen page is not proof of a destroyed runner. Keep its execution claim.
      try {
        const tab = await chrome.tabs.get(task.tabId);
        if (!tab.discarded && platformOfUrl(tab.url)?.id === task.command.platform) {
          try {
            const current = await timeout(chrome.scripting.executeScript({ target: { tabId: task.tabId, frameIds: [0] }, func: () => true }));
            if (current[0]?.documentId === task.documentId) continue;
          } catch { continue; }
        }
      } catch { /* Closed tab. */ }
      await finishLocal(task.id, { status: 'interrupted', step: 'recovery', error: { code: 'execution_lost', message: '原标签页已关闭、丢弃或离开目标平台' } });
    }
  }
  for (const task of (await allTasks()).filter(t => t.command.action === 'stop' && !terminal(t))) void stopTask(task);
}
function connection() {
  if (!connectionAttempt) connectionAttempt = connectOnce().finally(() => { connectionAttempt = null; });
  return connectionAttempt;
}
async function connectOnce() {
  const cfg = await settings();
  if (!cfg.enabled || socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(socket.readyState)) return;
  const ws = new WebSocket(`ws://127.0.0.1:${cfg.port}/extension`); socket = ws; ready = false; connectionMessage = '正在连接';
  ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', protocol: PROTOCOL, version: chrome.runtime.getManifest().version }));
  ws.onmessage = ({ data }) => {
    let m; try { m = JSON.parse(data); } catch { return; }
    if (socket !== ws) return;
    if (m.type === 'welcome') {
      projectDir = m.projectDir; connectionMessage = '正在恢复任务';
      void recover().then(() => serial(async () => {
        const tasks = await allTasks();
        for (const task of tasks) for (const event of task.outbox) wire({ type: 'event', event });
        wire({ type: 'sync', knownTasks: tasks.map(t => t.id) });
      })).catch(e => { connectionMessage = e.message; ws.close(); });
    } else if (m.type === 'ready') { ready = true; retryMs = 1000; connectionMessage = '已连接'; publish(); void serial(async () => { for (const task of await allTasks()) emitStored(task); }); }
    else if (m.type === 'ack') void serial(async () => { const t = await getTask(m.taskId); if (t) { t.outbox = t.outbox.filter(e => e.seq > m.seq); await putTask(t); } });
    else if (m.type === 'command') void accept(m.task).catch(e => { connectionMessage = e.message; });
  };
  ws.onerror = () => { connectionMessage = '无法连接本机服务，请运行 ./geo up'; };
  ws.onclose = event => {
    if (socket !== ws) return;
    socket = null; ready = false; connectionMessage = event.code === 1008 ? `连接异常：${event.reason}，请核对服务与扩展版本` : '连接断开，等待重连';
    publish();
    clearTimeout(retryTimer); retryTimer = setTimeout(() => void connection(), retryMs); retryMs = Math.min(retryMs * 2, 30000);
  };
}
async function accept(task) {
  let launch = false;
  await serial(async () => {
    const old = await getTask(task.id);
    if (old) { emitStored(old); return; }
    const local = { ...task, runnerId: crypto.randomUUID(), lastSeq: 0, outbox: [], status: 'queued', config: await anchors() };
    await putTask(local);
    const busy = (await allTasks()).find(t => t.id !== task.id && !terminal(t) && t.command.action !== 'stop');
    if (busy && task.command.action !== 'stop') {
      await addEvent(local, { status: 'failed', step: 'busy', error: { code: 'busy', message: `任务 ${busy.id} 尚未结束` } }); return;
    }
    await addEvent(local, { status: 'running', step: 'preparing' }); launching.add(task.id); launch = true;
  });
  if (launch) void launchTask(task.id).catch(e => finishLocal(task.id, { status: e.code === 'stopped' ? 'interrupted' : 'failed', step: 'preparing', error: { code: e.code || 'execution_error', message: e.message, ...(e.details || {}) } })).finally(() => launching.delete(task.id));
}
async function selectTab(command) {
  const platform = platformOf(command.platform);
  if (!platform) throw new GeoError('wrong_platform', `未知平台 ${command.platform}`);
  if (command.action === 'run') return chrome.tabs.create({ url: platform.newChatUrl, active: command.focus });
  if (command.tabId != null) {
    const tab = await chrome.tabs.get(command.tabId);
    if (!platformOfUrl(tab.url) || platformOfUrl(tab.url).id !== platform.id) throw new GeoError('wrong_platform', `指定标签页不是 ${platform.name}`);
    return tab;
  }
  const tabs = await chrome.tabs.query({ url: platform.tabPatterns });
  if (tabs.length !== 1) throw new GeoError(tabs.length ? 'ambiguous_tabs' : 'no_tab', tabs.length ? `有多个 ${platform.name} 标签页，请指定 tabId` : `请先打开 ${platform.name} 对话`, 400, { candidates: tabs.slice(0, 10).map(t => ({ tabId: t.id, title: t.title, url: t.url })) });
  return tabs[0];
}
async function launchTask(id) {
  let task = await getTask(id);
  if (task.command.action === 'anchors') return finishLocal(id, { status: 'done', step: 'completed', result: { data: await anchors() } });
  if (task.command.action === 'stop') return stopTask(task);
  const tab = await selectTab(task.command);
  await serial(async () => { task = await getTask(id); task.tabId = tab.id; await putTask(task); });
  const until = Date.now() + 60000;
  while ((await chrome.tabs.get(tab.id)).status !== 'complete') {
    if (Date.now() > until) throw new GeoError('page_loading', '页面加载超时');
    if ((await getTask(id)).stopRequested) throw new GeoError('stopped', '插件自动化已停止');
    try {
      const state = await timeout(chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, injectImmediately: true, func: () => document.readyState !== 'loading' && Boolean(document.body) }));
      if (state[0]?.result) break;
    } catch { /* Navigation may not have created an injectable document yet. */ }
    await new Promise(r => setTimeout(r, 300));
  }
  if (task.command.focus) { await chrome.tabs.update(tab.id, { active: true }); await chrome.windows.update(tab.windowId, { focused: true }); }
  if (!isPlatformUrl((await chrome.tabs.get(tab.id)).url)) throw new GeoError('wrong_platform', '页面已离开目标平台');
  const platform = platformOf(task.command.platform);
  if (!platform) throw new GeoError('wrong_platform', `未知平台 ${task.command.platform}`);
  const injected = await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, injectImmediately: true, files: [platform.adapter, 'extension/runner.js'] });
  const documentId = injected[0]?.documentId;
  if (!documentId) throw new GeoError('missing_document', '无法确认页面执行上下文');
  await serial(async () => { task = await getTask(id); task.documentId = documentId; await putTask(task); });
  if (terminal(task)) return;
  if (task.stopRequested) return finishLocal(id, { status: 'interrupted', step: 'ended', error: { code: 'stopped', message: '插件自动化已停止' } });
  const response = await timeout(chrome.tabs.sendMessage(tab.id, { type: 'runner-start', task: { id: task.id, command: task.command }, runnerId: task.runnerId, config: task.config, seq: task.lastSeq }, { documentId }));
  if (!response?.accepted) throw new GeoError('runner_conflict', '页面已被其他任务占用');
}
async function stopTask(stop) {
  const target = await getTask(stop.command.taskId);
  if (!target) return finishLocal(stop.id, { status: 'failed', step: 'ended', error: { code: 'not_found', message: '目标任务不存在' } });
  await serial(async () => { const t = await getTask(target.id); t.stopRequested = true; await putTask(t); });
  if (!terminal(target) && target.documentId) {
    try { await timeout(chrome.tabs.sendMessage(target.tabId, { type: 'runner-stop', taskId: target.id }, { documentId: target.documentId })); } catch { /* Confirmation comes from the target's durable terminal event. */ }
  }
  for (let i = 0; i < 20; i++) {
    const t = await getTask(target.id);
    if (terminal(t)) return finishLocal(stop.id, { status: 'done', step: 'completed', result: { data: { taskId: target.id, confirmed: true, targetStatus: t.status, websiteGenerationStopped: false } } });
    await new Promise(r => setTimeout(r, 500));
  }
  return finishLocal(stop.id, { status: 'failed', step: 'unconfirmed', error: { code: 'stop_unconfirmed', message: '页面未确认停止，原任务继续保留执行归属' } });
}
async function matchRunner(message, sender) {
  const id = message.event?.taskId || message.taskId;
  const task = await getTask(id);
  if (!task || task.runnerId !== (message.event?.runnerId || message.runnerId) || sender.tab?.id !== task.tabId || sender.documentId !== task.documentId || sender.frameId !== 0 || platformOfUrl(sender.url)?.id !== task.command.platform) throw new GeoError('runner_conflict', '执行归属不匹配');
  return task;
}
async function capture(task, clip) {
  if (terminal(task) || task.command.action !== 'shot') throw new GeoError('runner_conflict', '当前任务不允许截图');
  if (!clip || ['x', 'y', 'width', 'height'].some(k => !Number.isFinite(clip[k])) || clip.x < 0 || clip.y < 0 || clip.width <= 0 || clip.height <= 0 || clip.width > 8000 || clip.height > 16000) throw new GeoError('capture_bounds', '截图范围无效');
  const target = { tabId: task.tabId };
  let attached = false;
  try {
    await chrome.debugger.attach(target, '1.3'); attached = true;
    const response = await chrome.debugger.sendCommand(target, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { ...clip, scale: 1 } });
    if (!response.data || response.data.length > 16 * 1024 * 1024) throw new GeoError('capture_size', '截图为空或超过传输限制');
    return { ok: true, data: response.data };
  } finally { if (attached) await chrome.debugger.detach(target).catch(() => {}); }
}
async function foreground(task) {
  const tab = await chrome.tabs.get(task.tabId);
  await chrome.tabs.update(task.tabId, { active: true });
  if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true, state: 'normal' });
  // 等页面真正拿到焦点：后台标签的编辑器收不到受信任输入。
  const until = Date.now() + 10000;
  while (Date.now() < until) {
    try {
      const r = await timeout(chrome.scripting.executeScript({ target: { tabId: task.tabId, frameIds: [0] }, func: () => ({ focused: document.hasFocus(), visibility: document.visibilityState }) }));
      if (r[0]?.result?.focused && r[0].result.visibility === 'visible') return true;
    } catch { /* Navigation may not have created an injectable document yet. */ }
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}
// 反复 attach/detach 会让 Chrome 报"内部错误"（前一个会话尚未完全释放）。
// 附着失败时重试更久；detach 后等一下再让下一次附着，避免上一会话还没释放。
async function withDebugger(task, fn) {
  const target = { tabId: task.tabId };
  let last;
  for (let i = 0; i < 6; i++) {
    let attached = false;
    try {
      await chrome.debugger.attach(target, '1.3'); attached = true;
      const result = await fn(target);
      return result;
    } catch (e) {
      last = e;
      // 别的调试器占用时重试无意义。
      if (/Another debugger|already attached/i.test(e?.message || '')) break;
      await new Promise(r => setTimeout(r, 400 * (i + 1)));
    } finally {
      if (attached) {
        await chrome.debugger.detach(target).catch(() => {});
        // 给 Chrome 一点时间真正释放会话，否则下一次 attach 会直接失败。
        await new Promise(r => setTimeout(r, 120));
      }
    }
  }
  const detail = last?.message || String(last);
  const err = new Error(`调试器附着失败：${detail}`);
  err.code = last?.code || 'debugger_failed';
  throw err;
}
async function inputKey(task, key) {
  if (terminal(task) || task.command.action !== 'run') throw new GeoError('runner_conflict', '当前任务不允许发送按键');
  try {
    await withDebugger(task, async target => {
      const enter = key === 'Enter';
      // Enter 必须带 text 才能产生默认动作；没有 text 的 keyDown 只是"按了一下"，
      // 编辑器不会把它当成提交。rawKeyDown 用于不带字符的修饰键场景，这里不用。
      const base = enter
        ? { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }
        : { key, code: key, windowsVirtualKeyCode: 0, nativeVirtualKeyCode: 0 };
      await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { type: enter ? 'keyDown' : 'rawKeyDown', ...base, ...(enter ? { text: '\r', unmodifiedText: '\r' } : {}) });
      await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    });
    return { ok: true };
  } catch (e) { return { ok: false, error: { code: e.code || 'input_key_failed', message: e.message } }; }
}
async function inputClick(task, point) {
  if (terminal(task) || task.command.action !== 'run') throw new GeoError('runner_conflict', '当前任务不允许点击页面');
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new GeoError('invalid_argument', '需要有效的点击坐标');
  try {
    await withDebugger(task, async target => {
      const base = { x: point.x, y: point.y, button: 'left', clickCount: 1 };
      await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
      await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
      await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
    });
    return { ok: true };
  } catch (e) { return { ok: false, error: { code: e.code || 'input_click_failed', message: e.message } }; }
}
async function inputText(task, text, point) {
  if (terminal(task) || task.command.action !== 'run') throw new GeoError('runner_conflict', '当前任务不允许输入文字');
  try {
    await withDebugger(task, async target => {
      // 后台标签的编辑器拿不到真实焦点：先在输入框几何中心点一下，再插入文字。
      if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) {
        const base = { x: point.x, y: point.y, button: 'left', clickCount: 1 };
        await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
        await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
        await new Promise(r => setTimeout(r, 150));
      }
      await chrome.debugger.sendCommand(target, 'Input.insertText', { text });
    });
    return { ok: true };
  } catch (e) { return { ok: false, error: { code: e.code || 'input_text_failed', message: e.message } }; }
}
async function api(path, init = {}) {
  const cfg = await settings();
  const response = await fetch(`http://127.0.0.1:${cfg.port}${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...init.headers }, signal: AbortSignal.timeout(10000) });
  const data = await response.json();
  if (!response.ok) throw new GeoError(data.error?.code || 'api_error', data.error?.message || '请求失败', response.status, data.error || {});
  return data;
}
async function ui(message) {
  if (message.type === 'ui-status') {
    const cfg = await settings();
    return { connected: ready, connectionMessage, port: cfg.port, enabled: cfg.enabled, projectDir, version: chrome.runtime.getManifest().version, tasks: (await allTasks()).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 30).map(t => ({ id: t.id, status: t.status, step: t.step, command: t.command, error: t.error, hasResult: Boolean(t.result), tabId: t.tabId })) };
  }
  if (message.type === 'ui-connect') {
    if (!Number.isInteger(message.port) || message.port < 1 || message.port > 65535) throw new GeoError('invalid_argument', '端口无效');
    await putSetting('connection', { enabled: true, port: message.port });
    socket?.close(); socket = null; ready = false; await connection(); return { connecting: true };
  }
  if (message.type === 'ui-disconnect') { const cfg = await settings(); await putSetting('connection', { ...cfg, enabled: false }); clearTimeout(retryTimer); socket?.close(); socket = null; ready = false; connectionMessage = '已断开'; return { disconnected: true }; }
  if (message.type === 'ui-command') return api('/command', { method: 'POST', headers: { 'Idempotency-Key': message.idempotencyKey || crypto.randomUUID() }, body: JSON.stringify(message.command) });
  if (message.type === 'ui-result') { const t = await getTask(message.taskId); if (!t) throw new GeoError('not_found', '本地任务不存在'); const { screenshotBase64, ...result } = t.result || {}; return { taskId: t.id, status: t.status, result, diagnostic: t.diagnostic, error: t.error }; }
  if (message.type === 'ui-tabs') return { tabs: (await chrome.tabs.query({ url: tabPatterns() })).map(t => ({ id: t.id, title: t.title, url: t.url, platform: platformOfUrl(t.url)?.id || null })) };
  throw new GeoError('invalid_message', '未知界面消息');
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  const work = async () => {
    if (message.type?.startsWith('ui-')) {
      if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('extension/panel.html')) throw new GeoError('forbidden', '只允许扩展界面调用');
      return { ok: true, data: await ui(message) };
    }
    if (message.type === 'capture') return capture(await matchRunner(message, sender), message.clip);
    if (message.type === 'input-key') return inputKey(await matchRunner(message, sender), message.key);
    if (message.type === 'input-text') return inputText(await matchRunner(message, sender), message.text, message.point);
    if (message.type === 'input-click') return inputClick(await matchRunner(message, sender), message.point);
    if (message.type === 'foreground') return foreground(await matchRunner(message, sender));
    return serial(async () => {
      const task = await matchRunner(message, sender);
      if (message.type === 'runner-event') {
        const event = message.event;
        if (event.seq <= task.lastSeq) return { ok: true };
        if (terminal(task) || event.seq !== task.lastSeq + 1) throw new GeoError('runner_conflict', '任务已结束或事件顺序无效');
        if (!['running', ...TERMINAL].includes(event.status)) throw new GeoError('invalid_event', '事件状态无效');
        await addEvent(task, event); return { ok: true };
      }
      if (message.type === 'save-anchor') {
        const c = task.command;
        if (terminal(task) || c.action !== 'fix' || c.testOnly || c.field !== message.field || c.selector !== message.selector) throw new GeoError('forbidden', '当前任务不允许保存配置');
        const value = await anchors();
        if (value.revision !== message.expectedRevision) throw new GeoError('config_conflict', '配置版本已变化，请重新实测', 409);
        const history = [...value.history, { revision: value.revision, selectors: value.selectors, at: new Date().toISOString() }].slice(-20);
        const next = { revision: value.revision + 1, selectors: { ...value.selectors, [c.field]: c.selector }, history };
        await putSetting('anchors', next); return { ok: true, revision: next.revision };
      }
      throw new GeoError('invalid_message', '未知 runner 消息');
    });
  };
  work().then(respond, e => respond({ ok: false, ...errorBody(e) })); return true;
});
chrome.tabs.onRemoved.addListener(tabId => { void serial(async () => { for (const t of await allTasks()) if (t.tabId === tabId && !terminal(t)) await addEvent(t, { status: 'interrupted', step: 'page_closed', error: { code: 'execution_lost', message: '标签页已关闭，不会自动重提' } }); }); });
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (!['loading', 'complete'].includes(info.status)) return;
  // SPA navigation can report loading while the original document is alive.
  // Recovery probes that runner and verifies document identity before interrupting.
  void recover().catch(() => {});
});
chrome.alarms.onAlarm.addListener(() => { void recover().then(connection).catch(() => {}); });
chrome.runtime.onStartup.addListener(() => { void recover().then(connection).catch(() => {}); });
chrome.runtime.onInstalled.addListener(() => { void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }); });
void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
void chrome.alarms.create('geo-reconnect', { periodInMinutes: 0.5 });
setInterval(() => wire({ type: 'ping' }), 20000);
void recover().then(connection).catch(e => { connectionMessage = e.message; });
