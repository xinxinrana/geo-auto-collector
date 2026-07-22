// service-worker.js — 任务调度中心。串行执行、tab 管理、注入 adapter、状态机、保活。
// M1：跑通 Perplexity 单/多关键词的 输入→提交→判完成→提取。截图与导出为 M2/M3。

import { PLATFORMS } from './platforms.js';
import {
  saveResult, saveScreenshot,
  getActiveSessionId, setActiveSessionId, getAllSessions, createSession,
} from '../storage/db.js';
import { captureFullPage, captureQANode } from '../lib/screenshot.js';
import { captureNodeViaCDP } from '../lib/screenshot-cdp.js';
import { captureNodeViaLib } from '../lib/screenshot-node.js';

const STATE_KEY = 'geo_state';

// 把 HTML 正文里的 <img> 替换成 alt 占位文本,避免导出/渲染时图片喧宾夺主。
// 截图走独立的 DOM/图片流程,不受影响。
function replaceImagesWithAlt(html) {
  if (!html || typeof html !== 'string') return html;
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    doc.querySelectorAll('img').forEach((img) => {
      const alt = (img.getAttribute('alt') || '').trim();
      const placeholder = alt ? `[图片: ${alt}]` : '[图片]';
      const span = doc.createElement('span');
      span.textContent = placeholder;
      img.replaceWith(span);
    });
    return doc.body.innerHTML;
  } catch (e) {
    // DOMParser 异常时回退到简单正则兜底
    return html.replace(/<img[^>]*>/gi, (match) => {
      const alt = /alt=["']([^"']*)["']/i.exec(match)?.[1]?.trim() || '';
      return alt ? `[图片: ${alt}]` : '[图片]';
    });
  }
}

function sanitizeResultHtml(out) {
  if (!out || out.status !== 'ok') return out;
  if (out.answerHtml) out.answerHtml = replaceImagesWithAlt(out.answerHtml);
  if (out.qaHtml) out.qaHtml = replaceImagesWithAlt(out.qaHtml);
  return out;
}

// ---- 状态：持久化到 storage.session，popup 可随时拉取 ----
async function getState() {
  const o = await chrome.storage.session.get(STATE_KEY);
  return o[STATE_KEY] || { running: false, done: false, tasks: [], runId: null, stopRequested: false };
}
async function setState(state) {
  await chrome.storage.session.set({ [STATE_KEY]: state });
  // 主动推送给 popup（若打开）
  chrome.runtime.sendMessage({ type: 'STATE_UPDATE', state }).catch(() => {});
}

// ---- 保活：长任务期间用 alarm 唤醒 SW ----
function startKeepAlive() {
  chrome.alarms.create('geo-keepalive', { periodInMinutes: 0.4 });
}
function stopKeepAlive() {
  chrome.alarms.clear('geo-keepalive');
}
chrome.alarms.onAlarm.addListener(() => {}); // 唤醒即可，无需操作

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => Math.floor(min + Math.random() * (max - min));
// 文件名安全化：去掉路径/非法字符，限长
const sanitize = (s) => String(s).replace(/[^\w一-龥-]+/g, '_').slice(0, 40);

const task_label = (t) => `${t.keyword || '?'} · ${t.platform || '?'}`;

// 把采集结果/失败打印到扩展 SW 控制台，附带 adapter 回传的 trace
function logResult(tag, result) {
  const r = result || {};
  if (r.status === 'ok') {
    console.log(`[GEO] ${tag} ✓ status=ok chars=${r.answerChars || 0} citations=${(r.citations || []).length} timedOut=${!!r.timedOut}`);
  } else {
    console.warn(`[GEO] ${tag} ✗ status=${r.status} error=${r.error || '(无)'}`);
  }
  if (Array.isArray(r.trace) && r.trace.length) {
    console.groupCollapsed(`[GEO] ${tag} trace (${r.trace.length} 步)`);
    r.trace.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
    console.groupEnd();
  }
}

// 确保存在一个「活动会话」（抽屉）；没有或已删就新建一个默认抽屉。
// 采集结果都归入活动会话。返回活动会话 id。
async function ensureActiveSession() {
  const sessions = await getAllSessions();
  let activeId = await getActiveSessionId();
  const active = sessions.find((s) => s.id === activeId && !s.deleted);
  if (active) return active.id;

  // 退而求其次：用最近一个未删除的会话
  const alive = sessions.filter((s) => !s.deleted).sort((a, b) => b.createdAt - a.createdAt);
  if (alive.length) {
    await setActiveSessionId(alive[0].id);
    return alive[0].id;
  }

  // 都没有，新建默认抽屉
  const id = `sess_${Date.now()}`;
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const title = `采集 ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  await createSession({ id, title, createdAt: Date.now(), deleted: false });
  await setActiveSessionId(id);
  return id;
}

// ---- 消息入口 ----
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case 'GET_STATE':
        sendResponse(await getState());
        break;
      case 'START':
        sendResponse({ ok: true });
        runBatch(msg.keywords, msg.platforms); // 不 await，后台跑
        break;
      case 'COLLECT_CURRENT':
        sendResponse({ ok: true });
        collectCurrentPage(); // 采集当前活动标签页，追加到结果
        break;
      case 'STOP': {
        const s = await getState();
        s.stopRequested = true;
        await setState(s);
        sendResponse({ ok: true });
        break;
      }
      default:
        sendResponse({ ok: false, error: 'unknown message' });
    }
  })();
  return true; // 异步 sendResponse
});

// ---- 批量调度：严格串行 ----
async function runBatch(keywords, platforms) {
  const runId = `run_${Date.now()}`;
  const sessionId = await ensureActiveSession(); // 采集进当前打开的抽屉

  const tasks = [];
  for (const platform of platforms) {
    for (const keyword of keywords) {
      tasks.push({ platform, keyword, status: 'pending' });
    }
  }
  await setState({ running: true, done: false, tasks, runId, stopRequested: false });
  startKeepAlive();

  for (let i = 0; i < tasks.length; i++) {
    let state = await getState();
    if (state.stopRequested) break;

    tasks[i].status = 'running';
    await setState({ ...state, tasks });

    const result = await runOneTask(tasks[i]);
    Object.assign(tasks[i], result);
    logResult(`批量[${task_label(tasks[i])}]`, result);
    await saveResult({ sessionId, runId, ...tasks[i], ...result });

    state = await getState();
    await setState({ ...state, tasks });

    // 拟人间隔（最后一条不等）
    if (i < tasks.length - 1) await sleep(rand(8000, 15000));
  }

  const final = await getState();
  await setState({ ...final, running: false, done: true });
  stopKeepAlive();
}

// ---- 单任务：打开 tab → 注入 → 调用 adapter 入口 ----
async function runOneTask(task) {
  const cfg = PLATFORMS[task.platform];
  if (!cfg) {
    return { status: 'failed', error: `unsupported_platform: ${task.platform}（当前 SW 已注册：${Object.keys(PLATFORMS).join(', ')}）` };
  }

  let tab;
  try {
    // 复用已有该平台 tab，否则新开
    const existing = (await chrome.tabs.query({})).find((t) => t.url && cfg.match.test(t.url));
    if (existing) {
      tab = existing;
      await chrome.tabs.update(tab.id, { url: cfg.newConversationUrl, active: true });
    } else {
      tab = await chrome.tabs.create({ url: cfg.newConversationUrl, active: true });
    }
    await waitTabComplete(tab.id, 60000);
    await sleep(rand(2000, 3500));

    // 注入 common + adapter
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['src/content/common.js', ...cfg.files],
    });

    // 调用 adapter 入口
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (entryName, query, config) => globalThis[entryName](query, config),
      args: [cfg.entry, task.keyword, cfg.config || {}],
    });

    const out = sanitizeResultHtml(result) || { status: 'failed', error: 'no_result' };

    // 采集成功才截图（整页滚动拼接）
    if (out.status === 'ok') {
      await attachScreenshot(out, tab, task.platform, task.keyword);
    }

    return out;
  } catch (e) {
    return { status: 'failed', error: String(e && e.message || e) };
  }
}

// QA 节点截图:四级 fallback
//   1) html-to-image(推荐):节点独立渲染,不受 overflow / fixed / sticky 干扰,首选
//   2) chrome.debugger + Page.captureScreenshot(clip):还原 100%,弹官方黄条,慢一点
//   3) captureVisibleTab + 裁剪:无黄条,但受视口限制
//   4) 整页滚动拼接:兜底
async function attachScreenshot(out, tab, platform, keyword) {
  try {
    let blob = null;
    let via = null;
    if (out.qaSelector) {
      blob = await captureNodeViaLib(tab.id, out.qaSelector);
      if (blob) via = 'html-to-image';
      if (!blob) {
        blob = await captureNodeViaCDP(tab.id, out.qaSelector);
        if (blob) via = 'cdp';
      }
      if (!blob) {
        blob = await captureQANode(tab.id, tab.windowId, out.qaSelector);
        if (blob) via = 'visible-tab';
      }
    }
    if (!blob) {
      blob = await captureFullPage(tab.id, tab.windowId);
      if (blob) via = 'fullpage';
    }
    if (blob) {
      console.log(`[GEO] 截图成功 via=${via} size=${blob.size} selector=${out.qaSelector || '(none)'}`);
      const shotId = `${platform}_${sanitize(keyword)}_${Date.now()}`;
      await saveScreenshot(shotId, blob);
      out.screenshotId = shotId;
      out.screenshotVia = via;
    } else {
      console.warn('[GEO] 所有截图方案都失败');
    }
  } catch (e) {
    console.warn('[GEO] 截图阶段异常:', e);
  }
}

// ---- 仅采集当前页：不输入不导航，直接对已打开、已出答案的页面采集并追加入库 ----
async function collectCurrentPage() {
  const runId = `collect_${Date.now()}`;
  const sessionId = await ensureActiveSession();
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url) {
      await pushCollectResult({ sessionId, status: 'failed', error: 'no_active_tab' });
      return;
    }

    // 识别平台
    const platform = Object.keys(PLATFORMS).find((k) => PLATFORMS[k].match.test(tab.url));
    if (!platform) {
      await pushCollectResult({ sessionId, status: 'failed', error: 'unsupported_page', keyword: tab.title || tab.url });
      return;
    }
    const cfg = PLATFORMS[platform];
    if (!cfg.collectEntry) {
      await pushCollectResult({ sessionId, status: 'failed', error: 'collect_not_supported', platform, keyword: tab.title || '' });
      return;
    }

    startKeepAlive();

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['src/content/common.js', ...cfg.files],
    });

    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (entryName, config) => globalThis[entryName](config),
      args: [cfg.collectEntry, cfg.config || {}],
    });

    const out = sanitizeResultHtml(result) || { status: 'failed', error: 'no_result' };
    out.platform = platform;
    if (!out.keyword) out.keyword = tab.title || '当前页面';

    if (out.status === 'ok') {
      await attachScreenshot(out, tab, platform, out.keyword);
    }

    logResult(`采集当前页[${out.keyword} · ${platform}]`, out);
    await pushCollectResult({ sessionId, runId, ...out });
  } catch (e) {
    console.warn('[GEO] 采集当前页异常:', e);
    await pushCollectResult({ sessionId, status: 'failed', error: String(e && e.message || e) });
  } finally {
    stopKeepAlive();
  }
}

// 把单条采集结果存库并合并进当前任务列表（追加，不清空历史）
async function pushCollectResult(rec) {
  await saveResult(rec);
  const state = await getState();
  const tasks = Array.isArray(state.tasks) ? state.tasks.slice() : [];
  tasks.push({ platform: rec.platform || '当前页', keyword: rec.keyword || '当前页面', status: rec.status, answerChars: rec.answerChars, error: rec.error, trace: rec.trace });
  await setState({ ...state, tasks, done: true });
}

function waitTabComplete(tabId, timeout) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { cleanup(); resolve(); }, timeout);
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') { cleanup(); resolve(); }
    };
    function cleanup() {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}
