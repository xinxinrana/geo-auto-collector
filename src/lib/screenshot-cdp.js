// screenshot-cdp.js — 用 chrome.debugger + Page.captureScreenshot 截 QA 节点
//
// 处理三类干扰:
//   1) 滚动祖先(overflow: auto/hidden + max-height)剪切内容 → 展开
//   2) fixed/sticky 元素(顶栏/输入框/工具栏)在每一段重绘 → 临时隐藏
//   3) 节点在页面深处 → 把 QA 节点定位到 y=0 附近方便定位

const PROTOCOL = '1.3';

function attach(target) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach(target, PROTOCOL, () => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      resolve();
    });
  });
}
function detach(target) {
  return new Promise((resolve) => {
    chrome.debugger.detach(target, () => resolve());
  });
}
function send(target, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(target, method, params, (result) => {
      if (chrome.runtime.lastError) return reject(new Error(`${method}: ${chrome.runtime.lastError.message}`));
      resolve(result);
    });
  });
}

// 页面内:准备截图环境(展开滚动祖先 + 隐藏 fixed/sticky) + 测量绝对坐标
function prepareAndMeasureInPage(selector) {
  const list = [...document.querySelectorAll(selector)].filter((e) => e.offsetParent !== null);
  const node = list[list.length - 1];
  if (!node) return null;

  // 记录所有 style 修改,失败/成功都能精确还原
  const modifications = [];
  const patchStyle = (el, patch) => {
    const original = {};
    for (const k of Object.keys(patch)) original[k] = el.style[k];
    modifications.push({ el, original });
    Object.assign(el.style, patch);
  };

  // 收集 node 的祖先链,不要动 QA 节点自己/其祖先的 position(即便是 sticky/fixed)
  const ancestorSet = new Set();
  {
    let n = node;
    while (n) { ancestorSet.add(n); n = n.parentElement; }
  }

  // 1) 展开所有祖先的 overflow / max-height / body-html 高度
  {
    let n = node;
    while (n) {
      const cs = getComputedStyle(n);
      const patch = {};
      if (cs.overflow !== 'visible') patch.overflow = 'visible';
      if (cs.overflowY !== 'visible') patch.overflowY = 'visible';
      if (cs.overflowX !== 'visible') patch.overflowX = 'visible';
      if (cs.maxHeight !== 'none') patch.maxHeight = 'none';
      if (n === document.documentElement || n === document.body) {
        if (cs.height && cs.height !== 'auto') patch.height = 'auto';
      }
      if (Object.keys(patch).length > 0) patchStyle(n, patch);
      if (n === document.documentElement) break;
      n = n.parentElement;
    }
  }

  // 2) 隐藏页面里所有 fixed / sticky 元素(非 QA 节点自己或其祖先)
  // 这些元素会随内部滚动分段截图重复出现(顶栏/输入框/悬浮按钮等)
  const all = document.querySelectorAll('*');
  for (const el of all) {
    if (ancestorSet.has(el)) continue;
    // el 是 node 的后代也要保留(比如答案里嵌套的 sticky 表头,虽然罕见)
    if (node.contains(el)) continue;
    const cs = getComputedStyle(el);
    if (cs.position === 'fixed' || cs.position === 'sticky') {
      patchStyle(el, { visibility: 'hidden' });
    }
  }

  // 3) 把节点滚到文档顶部附近(减小 clip.y,避免 CDP 拍上方大片空白)
  node.scrollIntoView({ block: 'start', behavior: 'auto' });
  // 再往上滚一点让节点顶到 0(scrollIntoView 有时会留些边距)
  window.scrollBy(0, -20);

  // 存 restoreId
  if (!globalThis.__geoRestoreMap) globalThis.__geoRestoreMap = new Map();
  const id = 'r_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  globalThis.__geoRestoreMap.set(id, modifications);

  // 强制读一次 layout 触发同步 reflow
  void document.documentElement.offsetHeight;

  const rect = node.getBoundingClientRect();
  return {
    restoreId: id,
    x: Math.max(0, rect.left + window.scrollX),
    y: Math.max(0, rect.top + window.scrollY),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    dpr: window.devicePixelRatio || 1,
    modificationsCount: modifications.length,
  };
}

function restoreInPage(id) {
  const map = globalThis.__geoRestoreMap;
  if (!map || !map.has(id)) return false;
  const mods = map.get(id);
  for (const { el, original } of mods) {
    for (const k of Object.keys(original)) {
      // 空字符串等价于删除 inline 属性,恢复原始层叠
      el.style[k] = original[k];
    }
  }
  map.delete(id);
  return true;
}

async function prepareAndMeasure(tabId, selector) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: prepareAndMeasureInPage,
    args: [selector],
  });
  return result;
}
async function restore(tabId, restoreId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: restoreInPage,
      args: [restoreId],
    });
  } catch (e) {
    console.warn('[GEO] restore 失败:', e && e.message);
  }
}
async function remeasure(tabId, selector) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (sel) => {
      const list = [...document.querySelectorAll(sel)].filter((e) => e.offsetParent !== null);
      const node = list[list.length - 1];
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      return {
        x: Math.max(0, rect.left + window.scrollX),
        y: Math.max(0, rect.top + window.scrollY),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    },
    args: [selector],
  });
  return result;
}

function base64ToBlob(b64, mime = 'image/png') {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return new Blob([buf], { type: mime });
}

/**
 * 截取指定选择器最后一个可见节点的完整 DOM 截图。
 * @param {number} tabId
 * @param {string} selector
 * @returns {Promise<Blob|null>}
 */
export async function captureNodeViaCDP(tabId, selector) {
  if (!selector) return null;
  const target = { tabId };
  let attached = false;
  let restoreId = null;
  try {
    const m1 = await prepareAndMeasure(tabId, selector);
    if (!m1 || m1.width <= 0 || m1.height <= 0) {
      console.warn('[GEO] CDP 截图:测量失败或节点无尺寸', m1);
      return null;
    }
    restoreId = m1.restoreId;
    console.log(`[GEO] CDP 准备完成: modifications=${m1.modificationsCount} rect=${m1.width}x${m1.height} at (${m1.x},${m1.y})`);

    // 等布局稳定 + 让懒加载图片有机会解析
    await new Promise((r) => setTimeout(r, 600));

    // 重测,拿稳定坐标
    const m = (await remeasure(tabId, selector)) || m1;

    await attach(target);
    attached = true;

    const shot = await send(target, 'Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      fromSurface: true,
      clip: {
        x: m.x,
        y: m.y,
        width: m.width,
        height: m.height,
        scale: 1,
      },
    });
    if (!shot || !shot.data) return null;
    return base64ToBlob(shot.data, 'image/png');
  } catch (e) {
    console.warn('[GEO] CDP 截图失败:', e && e.message);
    return null;
  } finally {
    if (attached) await detach(target);
    if (restoreId) await restore(tabId, restoreId);
  }
}
