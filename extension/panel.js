const $ = id => document.getElementById(id);
let status, selectedId, selectedResult, tested, displayedKey, noticeTimer;
const labels = { queued: '等待执行', running: '执行中', done: '已完成', failed: '失败', suspended: '需检查定位', interrupted: '已中断' };
async function call(type, values = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...values });
  if (!response?.ok) throw new Error(response?.error?.message || '扩展后台没有回应');
  return response.data;
}
function notify(message) { $('notice').textContent = message; $('notice').hidden = false; clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { $('notice').hidden = true; }, 7000); }
function guard(fn) { return async event => { try { await fn(event); } catch (e) { notify(e.message); } }; }
function page() { return { platform: $('platform').value, ...($('tab').value ? { tabId: Number($('tab').value) } : {}) }; }
function handoff() {
  const keyword = $('keyword').value.trim();
  $('handoff').textContent = `${keyword ? `请使用本机 GEO 采集工具，在 ${$('platform').selectedOptions[0]?.textContent || 'Perplexity'} 采集以下问题的回答与引用：${keyword}` : '请检查本机 GEO 采集工具的连接状态与能力，暂不提交问题。'}\n帮助入口：http://127.0.0.1:${status?.port || 8787}/help。先读帮助，再按需查询动作文档；连接说明见 /docs/connection。\n若服务未启动，在${status?.projectDir ? `项目目录 ${status.projectDir}` : '项目目录'}执行 ./geo up；./geo help 可离线使用。`;
}
async function command(command) {
  const task = await call('ui-command', { command, idempotencyKey: crypto.randomUUID() });
  selectedId = task.id; displayedKey = null; await refresh(); return task;
}
async function tabs() {
  const data = await call('ui-tabs'), previous = $('tab').value;
  $('tab').replaceChildren(new Option('自动选择唯一标签页', ''), ...data.tabs.map(t => new Option(`${t.id} · ${t.title || t.platform || ''}`, t.id)));
  if (data.tabs.some(t => String(t.id) === previous)) $('tab').value = previous;
}
async function showResult(task) {
  const data = await call('ui-result', { taskId: task.id }); selectedResult = data;
  $('result-section').hidden = false;
  const result = data.result || {};
  $('result-meta').textContent = `${labels[data.status]}${result.complete === false ? ' · 部分内容，未确认完成' : ''}${result.citationStatus ? ' · 引用仅包含回答中的可见外链' : ''}${result.screenshot?.status === 'saved' || task.command.action === 'shot' && task.status === 'done' ? ' · PNG 可通过 CLI 下载' : ''}`;
  $('result-text').textContent = result.text || data.error?.message || (result.data ? JSON.stringify(result.data, null, 2) : '暂无正文');
  $('result-data').textContent = JSON.stringify(data, null, 2);
  $('citations').replaceChildren();
  for (const citation of result.citations || []) {
    try { if (!['http:', 'https:'].includes(new URL(citation.url).protocol)) continue; } catch { continue; }
    const li = document.createElement('li'), a = document.createElement('a'); a.href = citation.url; a.textContent = citation.title || citation.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; li.append(a); $('citations').append(li);
  }
  if (task.command.action === 'fix' && task.command.testOnly && task.status === 'done' && task.command.field === $('field').value && task.command.selector === $('selector').value.trim()) {
    tested = { field: task.command.field, selector: task.command.selector, revision: result.data.revision };
    $('anchor-status').textContent = `实测通过，配置版本 ${tested.revision}。保存时将再次验证。`; $('save-anchor').disabled = false;
  }
}
async function refresh() {
  status = await call('ui-status');
  $('version').textContent = `v${status.version}`; $('connection-status').textContent = status.connectionMessage; $('dot').classList.toggle('online', status.connected);
  $('task-count').textContent = String(status.tasks.length);
  const busy = status.tasks.some(t => ['queued', 'running'].includes(t.status));
  for (const id of ['run', 'collect', 'shot', 'inspect', 'test-anchor']) $(id).disabled = !status.connected || busy;
  $('stop').disabled = !status.connected || !busy;
  const key = JSON.stringify(status.tasks);
  if ($('tasks').dataset.key !== key) {
    $('tasks').dataset.key = key; $('tasks').replaceChildren();
    if (!status.tasks.length) { const p = document.createElement('p'); p.className = 'empty'; p.textContent = '还没有采集任务'; $('tasks').append(p); }
    for (const task of status.tasks) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'task';
      const top = document.createElement('div'); top.className = 'task-top';
      const title = document.createElement('span'); title.className = 'task-label'; title.textContent = task.command.keyword || task.command.action;
      const state = document.createElement('span'); state.className = `task-state ${task.status}`; state.textContent = labels[task.status] || task.status;
      const meta = document.createElement('span'); meta.className = 'task-id'; meta.textContent = `${task.id.slice(0, 18)} · ${task.step}`;
      top.append(title, state); button.append(top, meta); button.onclick = guard(async () => { selectedId = task.id; displayedKey = null; await showResult(task); }); $('tasks').append(button);
    }
  }
  const selected = status.tasks.find(t => t.id === selectedId);
  const selectionKey = selected ? `${selected.id}:${selected.status}:${selected.step}` : null;
  if (selected && selectionKey !== displayedKey) { await showResult(selected); displayedKey = selectionKey; }
  handoff();
}
$('connect-form').onsubmit = guard(async event => { event.preventDefault(); await call('ui-connect', { port: Number($('port').value) }); await refresh(); });
$('disconnect').onclick = guard(async () => { await call('ui-disconnect'); await refresh(); });
$('run-form').onsubmit = guard(async event => { event.preventDefault(); const keyword = $('keyword').value.trim(); if (!keyword) throw new Error('请填写提问内容'); await command({ action: 'run', ...page(), keyword, focus: $('focus').checked }); });
$('collect').onclick = guard(() => command({ action: 'collect', ...page(), focus: $('focus').checked }));
$('shot').onclick = guard(() => command({ action: 'shot', ...page() }));
$('stop').onclick = guard(() => command({ action: 'stop' }));
$('refresh-tabs').onclick = guard(tabs);
$('inspect').onclick = guard(() => command({ action: 'inspect', ...page(), field: $('field').value }));
$('test-anchor').onclick = guard(() => command({ action: 'fix', ...page(), field: $('field').value, selector: $('selector').value.trim(), testOnly: true }));
$('save-anchor').onclick = guard(async () => { if (!tested) return; $('save-anchor').disabled = true; await command({ action: 'fix', ...page(), field: tested.field, selector: tested.selector, testOnly: false, expectedRevision: tested.revision }); tested = null; $('anchor-status').textContent = '保存结果见任务'; });
for (const id of ['field', 'selector', 'tab']) $(id).addEventListener('input', () => { tested = null; $('save-anchor').disabled = true; $('anchor-status').textContent = ''; });
$('keyword').addEventListener('input', handoff);
$('copy').onclick = guard(async () => { await navigator.clipboard.writeText($('handoff').textContent); notify('已复制 Agent 接管入口'); });
$('export').onclick = guard(async () => {
  if (!selectedResult) return;
  download(JSON.stringify(selectedResult, null, 2), 'application/json', `geo-${selectedResult.taskId}.json`);
});
function download(body, type, name) {
  const blob = new Blob([body], { type });
  const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('export-html').onclick = guard(async () => {
  if (!selectedResult) return;
  const doc = document.implementation.createHTMLDocument('GEO 采集报告');
  doc.documentElement.lang = 'zh-CN';
  const charset = doc.createElement('meta'); charset.setAttribute('charset', 'utf-8'); doc.head.prepend(charset);
  const style = doc.createElement('style'); style.textContent = 'body{max-width:860px;margin:48px auto;padding:0 24px;font:16px/1.8 system-ui;color:#24342d}pre{font:inherit;white-space:pre-wrap;overflow-wrap:anywhere}small{color:#65766b}a{color:#176450}'; doc.head.append(style);
  const result = selectedResult.result || {};
  for (const [tag, content] of [['h1', result.keyword || 'GEO 采集报告'], ['small', `${selectedResult.taskId} · ${labels[selectedResult.status]} · ${result.capturedAt || ''}`], ['p', result.url || ''], ['p', result.complete === false ? '以下为部分内容，未确认回答完成。' : ''], ['pre', result.text || $('result-text').textContent], ['h2', '引用来源'], ['p', '仅包含回答中的可见外链，未自动展开来源弹层。']]) { const el = doc.createElement(tag); el.textContent = content; doc.body.append(el); }
  const list = doc.createElement('ul');
  for (const link of $('citations').querySelectorAll('a')) { const li = doc.createElement('li'), a = doc.createElement('a'); a.href = link.href; a.textContent = `${link.textContent} — ${link.href}`; li.append(a); list.append(li); }
  doc.body.append(list);
  download(`<!doctype html>\n${doc.documentElement.outerHTML}`, 'text/html;charset=utf-8', `geo-${selectedResult.taskId}.html`);
});
await guard(async () => { await refresh(); $('port').value = status.port; $('setup').open = !status.connected; await tabs(); })();
chrome.runtime.onMessage?.addListener(message => { if (message.type === 'view-updated') void refresh().catch(() => {}); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void refresh().catch(() => {}); });
setInterval(() => { void refresh().catch(() => {}); }, 2000);
