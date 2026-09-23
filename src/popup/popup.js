// Popup: 收集输入、发起任务、渲染进度与会话抽屉。真实状态由 service worker 持有，
// popup 关闭不影响任务；重新打开时拉取当前状态。

import { exportAll } from './export.js';
import {
  getAllResults, getAllSessions, createSession, setSessionDeleted, renameSession,
  setResultDeleted, getActiveSessionId, setActiveSessionId,
} from '../storage/db.js';

const $ = (id) => document.getElementById(id);

const POPUP_INPUT_KEY = 'geo_popup_input';

const els = {
  keywords: $('keywords'),
  platforms: $('platforms'),
  startBtn: $('start-btn'),
  stopBtn: $('stop-btn'),
  collectBtn: $('collect-btn'),
  exportBtn: $('export-btn'),
  newSessionBtn: $('new-session-btn'),
  openConsoleBtn: $('open-console-btn'),
  sessions: $('sessions'),
  progressSection: $('progress-section'),
  progressLabel: $('progress-label'),
  progressCount: $('progress-count'),
  progressFill: $('progress-fill'),
  taskLog: $('task-log'),
};

let running = false; // 批量进行中，禁用会话操作以免混乱
let viewExpandedId = null; // 额外展开查看的抽屉（用于已删/历史抽屉，不改变活动会话）

// ---- popup 表单持久化：关键词 + 平台勾选 ----
async function loadFormState() {
  try {
    const saved = await chrome.storage.local.get(POPUP_INPUT_KEY);
    const data = saved[POPUP_INPUT_KEY];
    if (!data) return;
    if (typeof data.keywords === 'string') els.keywords.value = data.keywords;
    if (Array.isArray(data.platforms)) {
      els.platforms.querySelectorAll('input[type=checkbox]').forEach((cb) => {
        cb.checked = data.platforms.includes(cb.value);
      });
    }
  } catch (e) {
    console.warn('[GEO] 加载 popup 表单状态失败:', e);
  }
}

function saveFormState() {
  const data = {
    keywords: els.keywords.value,
    platforms: selectedPlatforms(),
  };
  chrome.storage.local.set({ [POPUP_INPUT_KEY]: data }).catch(() => {});
}

function parseKeywords() {
  return els.keywords.value
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

function selectedPlatforms() {
  return [...els.platforms.querySelectorAll('input:checked')].map((i) => i.value);
}

function send(msg) {
  return chrome.runtime.sendMessage(msg);
}

async function loadPlatformCatalog() {
  const catalog = await send({ type: 'GET_PLATFORM_CATALOG' });
  els.platforms.querySelectorAll('[data-custom-platform]').forEach((label) => label.remove());
  for (const item of catalog.filter((entry) => entry.custom)) {
    const label = document.createElement('label');
    label.className = 'platform';
    label.dataset.customPlatform = item.key;
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = item.key;
    label.append(input, document.createTextNode(` ${item.name}`));
    els.platforms.append(label);
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const active = catalog.find((item) => { try { return new URL(item.url).hostname === new URL(tab?.url).hostname; } catch { return false; } });
  if (active) await send({ type: 'SET_CONSOLE_PLATFORM', platform: active.key });
}

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function statusText(status, t = {}) {
  switch (status) {
    case 'ok': return `✓ ${t.answerChars || 0}字`;
    case 'running': return '采集中…';
    case 'failed': return `✗ ${t.error || '失败'}`;
    case 'login_required': return '需登录';
    case 'pending': return '等待';
    default: return status;
  }
}

// 失败详情（含 error + trace）拼成可读文本，用于 tooltip / 展开
function failDetail(t = {}) {
  const lines = [];
  if (t.error) lines.push('错误：' + t.error);
  if (Array.isArray(t.trace) && t.trace.length) {
    lines.push('步骤：');
    t.trace.forEach((s, i) => lines.push(`  ${i + 1}. ${s}`));
  }
  return lines.join('\n');
}

// ---- 会话抽屉 ----
// 确保至少有一个可用会话，并有一个活动会话（本地无 SW 时也能建）
async function ensureActiveSession() {
  const sessions = await getAllSessions();
  let activeId = await getActiveSessionId();
  const active = sessions.find((s) => s.id === activeId && !s.deleted);
  if (active) return active.id;
  const alive = sessions.filter((s) => !s.deleted).sort((a, b) => b.createdAt - a.createdAt);
  if (alive.length) { await setActiveSessionId(alive[0].id); return alive[0].id; }
  return newSession(); // 一个都没有就建一个
}

async function newSession() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const id = `sess_${Date.now()}`;
  const title = `采集 ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  await createSession({ id, title, createdAt: Date.now(), deleted: false });
  await setActiveSessionId(id);
  return id;
}

async function renderSessions() {
  const [sessions, results] = await Promise.all([getAllSessions(), getAllResults()]);
  let activeId = await getActiveSessionId();

  // 按会话分组结果
  const byS = new Map();
  for (const r of results) {
    const sid = r.sessionId || '__legacy__';
    if (!byS.has(sid)) byS.set(sid, []);
    byS.get(sid).push(r);
  }

  // 归拢会话：真实会话 + 遗留（无 sessionId）分组
  const list = sessions.slice().sort((a, b) => b.createdAt - a.createdAt);
  if (byS.has('__legacy__')) {
    list.push({ id: '__legacy__', title: '未分组（历史）', createdAt: 0, deleted: false, legacy: true });
  }

  els.sessions.innerHTML = '';
  if (!list.length) {
    els.sessions.innerHTML = '<p class="muted">暂无会话，采集会自动创建，或点「＋ 新建会话」。</p>';
    return;
  }

  for (const s of list) {
    const items = (byS.get(s.id) || []).slice().sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
    const isActive = s.id === activeId && !s.deleted && !s.legacy;
    const expanded = isActive || s.id === viewExpandedId;
    els.sessions.appendChild(drawerEl(s, items, isActive, expanded));
  }
}

function drawerEl(s, items, isActive, expanded) {
  const drawer = document.createElement('div');
  drawer.className = 'drawer' + (s.deleted ? ' deleted' : '') + (isActive ? ' active' : '');

  // 头部
  const head = document.createElement('div');
  head.className = 'drawer-head';

  const caret = document.createElement('span');
  caret.className = 'caret';
  caret.textContent = expanded ? '▾' : '▸';

  const title = document.createElement('span');
  title.className = 'drawer-title';
  title.textContent = s.title;
  title.title = isActive ? '当前采集将存入此会话' : '点击展开并设为当前会话';

  const badge = document.createElement('span');
  badge.className = 'drawer-count';
  const okN = items.filter((i) => i.status === 'ok' && !i.deleted).length;
  badge.textContent = `${items.length} 条 · ${okN} 成功`;

  const actions = document.createElement('span');
  actions.className = 'drawer-actions';
  if (!s.legacy) {
    const del = document.createElement('button');
    del.className = 'link-btn';
    del.textContent = s.deleted ? '恢复' : '删除';
    del.title = s.deleted ? '恢复此会话' : '置灰删除（可恢复，导出时忽略）';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (running) return;
      await setSessionDeleted(s.id, !s.deleted);
      // 若删的是当前活动会话，切换活动会话到别的可用会话
      if (!s.deleted && (await getActiveSessionId()) === s.id) {
        const alive = (await getAllSessions()).filter((x) => !x.deleted).sort((a, b) => b.createdAt - a.createdAt);
        await setActiveSessionId(alive.length ? alive[0].id : null);
      }
      renderSessions();
    });
    actions.appendChild(del);
  }

  head.append(caret, title, badge, actions);

  // 点头部：可用抽屉 → 设为当前活动（=打开），其它自动关闭。
  // 已删/历史抽屉 → 仅切换查看展开（不改变活动会话，便于恢复里面的项）。
  head.addEventListener('click', async () => {
    if (running) return;
    if (!s.deleted && !s.legacy) {
      viewExpandedId = null;
      await setActiveSessionId(s.id);
    } else {
      viewExpandedId = (viewExpandedId === s.id) ? null : s.id;
    }
    renderSessions();
  });

  drawer.dataset.id = s.id;

  // 主体（item 列表）—— 活动或被查看展开时显示
  const body = document.createElement('div');
  body.className = 'drawer-body';
  body.hidden = !expanded;

  if (!items.length) {
    const empty = document.createElement('p');
    empty.className = 'muted small';
    empty.textContent = '（空会话）';
    body.appendChild(empty);
  } else {
    const ul = document.createElement('ul');
    ul.className = 'item-list';
    for (const it of items) {
      ul.appendChild(itemEl(it));
    }
    body.appendChild(ul);
  }

  drawer.append(head, body);
  return drawer;
}

function itemEl(it) {
  const li = document.createElement('li');
  li.className = 'item' + (it.deleted ? ' deleted' : '');

  const name = document.createElement('span');
  name.className = 'item-name';
  name.textContent = `${it.keyword || '(无关键词)'} · ${it.platform || ''}`;
  name.title = it.url || '';

  const st = document.createElement('span');
  st.className = `item-status status-${it.status}`;
  st.textContent = statusText(it.status, it);
  if (it.status === 'failed') st.title = failDetail(it) || '失败';

  const del = document.createElement('button');
  del.className = 'link-btn';
  del.textContent = it.deleted ? '恢复' : '删除';
  del.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (running) return;
    await setResultDeleted(it.id, !it.deleted);
    renderSessions();
  });

  li.append(name, st, del);
  return li;
}

// ---- 事件绑定 ----
els.startBtn.addEventListener('click', async () => {
  const keywords = parseKeywords();
  const platforms = selectedPlatforms();
  if (!keywords.length) return alert('请输入至少一个关键词');
  if (!platforms.length) return alert('请选择至少一个平台');
  await ensureActiveSession(); // 保证有抽屉接住结果
  const result = await send({ type: 'START', keywords, platforms });
  if (!result?.ok) alert(result?.error === 'task_running' ? '已有采集或试运行任务正在进行。' : `启动失败：${result?.error || '未知错误'}`);
});

els.stopBtn.addEventListener('click', () => send({ type: 'STOP' }));

els.collectBtn.addEventListener('click', async () => {
  els.collectBtn.disabled = true;
  const original = els.collectBtn.textContent;
  els.collectBtn.textContent = '采集中…';
  try {
    await ensureActiveSession();
    await send({ type: 'COLLECT_CURRENT' });
    els.collectBtn.textContent = '已提交采集';
  } catch (e) {
    alert('采集失败：' + (e && e.message || e));
  }
  setTimeout(() => { els.collectBtn.textContent = original; els.collectBtn.disabled = false; }, 2500);
});

els.openConsoleBtn.addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.sidePanel.open({ windowId: tab.windowId });
    window.close();
  } catch (error) {
    await chrome.tabs.create({ url: chrome.runtime.getURL('src/console/console.html') });
    window.close();
  }
});

els.exportBtn.addEventListener('click', async () => {
  els.exportBtn.disabled = true;
  const original = els.exportBtn.textContent;
  els.exportBtn.textContent = '导出中…';
  try {
    const activeId = await getActiveSessionId();
    if (!activeId) throw new Error('请先打开一个会话再导出');
    const { count } = await exportAll(activeId);
    els.exportBtn.textContent = `已导出 ${count} 条`;
    setTimeout(() => { els.exportBtn.textContent = original; els.exportBtn.disabled = false; }, 2500);
  } catch (e) {
    alert('导出失败：' + (e && e.message || e));
    els.exportBtn.textContent = original;
    els.exportBtn.disabled = false;
  }
});

els.newSessionBtn.addEventListener('click', async () => {
  if (running) return;
  await newSession();
  await renderSessions();
});

// 接收 SW 主动推送的状态更新
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'STATE_UPDATE') { render(msg.state); renderSessions(); }
  if (msg.type === 'SELECTOR_CONFIG_UPDATE') loadPlatformCatalog().catch(() => {});
});

function render(state) {
  if (!state) return;
  running = !!state.running;
  const { tasks = [], done } = state;
  const total = tasks.length;
  const finished = tasks.filter((t) => t.status !== 'pending' && t.status !== 'running').length;

  els.progressSection.hidden = total === 0;
  els.startBtn.disabled = running;
  els.stopBtn.disabled = !running;
  els.collectBtn.disabled = running;
  els.exportBtn.disabled = running;
  els.newSessionBtn.disabled = running;

  els.progressCount.textContent = `${finished} / ${total}`;
  els.progressFill.style.width = total ? `${(finished / total) * 100}%` : '0';
  els.progressLabel.textContent = running ? '检测中…' : done ? '检测完成' : '待开始';

  els.taskLog.innerHTML = '';
  for (const t of tasks) {
    const li = document.createElement('li');
    const row = document.createElement('div');
    row.className = 'log-row';
    const name = document.createElement('span');
    name.textContent = `${t.keyword} · ${t.platform}`;
    const st = document.createElement('span');
    st.className = `status-${t.status}`;
    st.textContent = statusText(t.status, t);
    row.append(name, st);
    li.appendChild(row);

    // 失败：附可折叠的 trace/错误详情，方便排查
    const detail = failDetail(t);
    if (t.status === 'failed' && detail) {
      const pre = document.createElement('pre');
      pre.className = 'log-detail';
      pre.textContent = detail;
      row.style.cursor = 'pointer';
      row.title = '点击展开/折叠详情';
      row.addEventListener('click', () => {
        pre.style.display = pre.style.display === 'block' ? 'none' : 'block';
      });
      li.appendChild(pre);
    }
    els.taskLog.appendChild(li);
  }
}

// 打开时：恢复表单状态、拉取当前状态、渲染会话
loadPlatformCatalog().then(loadFormState).catch(() => loadFormState());
$('version').textContent = `v${chrome.runtime.getManifest().version}`;
send({ type: 'GET_STATE' }).then(render).catch(() => {});
renderSessions();

// 表单变化时自动持久化
els.keywords.addEventListener('input', saveFormState);
els.platforms.addEventListener('change', saveFormState);
