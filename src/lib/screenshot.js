// screenshot.js — 页面截图。
// 两个入口:
//   captureFullPage(tabId, windowId)   —— 分段滚动 + 拼接,兼容旧路径
//   captureQANode(tabId, windowId, selector, opts)  —— 只截 QA 节点(优先),复用 tabs.captureVisibleTab + 裁剪
// 都在 service worker 里跑:tabs.captureVisibleTab 只能 SW 调用,OffscreenCanvas 也在 SW 可用。

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// captureVisibleTab 有频控（约 2 次/秒），段间至少间隔 550ms。
const CAPTURE_INTERVAL = 550;
// 上限，避免超长页面生成巨图 / 触发频控
const MAX_SEGMENTS = 20;

// 注入页面读取滚动尺寸
async function getMetrics(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => ({
      scrollHeight: Math.max(
        document.documentElement.scrollHeight,
        document.body ? document.body.scrollHeight : 0
      ),
      clientHeight: document.documentElement.clientHeight,
      dpr: window.devicePixelRatio || 1,
    }),
  });
  return result;
}

async function scrollTo(tabId, y) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (top) => {
      window.scrollTo(0, top);
      return window.scrollY;
    },
    args: [y],
  });
  return result; // 实际滚动到的 y（触底时会小于请求值）
}

// 恢复滚动到顶部
async function resetScroll(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => window.scrollTo(0, 0),
  });
}

async function dataUrlToBitmap(dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  return createImageBitmap(blob);
}

/**
 * 整页截图，返回 PNG Blob（失败返回 null，不阻断采集主流程）。
 * @param {number} tabId
 * @param {number} windowId  captureVisibleTab 需要 windowId
 */
export async function captureFullPage(tabId, windowId) {
  try {
    const { scrollHeight, clientHeight, dpr } = await getMetrics(tabId);
    if (!clientHeight) return null;

    const segments = Math.min(Math.ceil(scrollHeight / clientHeight), MAX_SEGMENTS);
    const shots = []; // { y, bitmap }

    for (let i = 0; i < segments; i++) {
      const targetY = i * clientHeight;
      const actualY = await scrollTo(tabId, targetY);
      await sleep(i === 0 ? 300 : CAPTURE_INTERVAL);
      let dataUrl;
      try {
        dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
      } catch (e) {
        // 频控偶发失败：退避重试一次
        await sleep(CAPTURE_INTERVAL);
        dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
      }
      const bitmap = await dataUrlToBitmap(dataUrl);
      shots.push({ y: actualY, bitmap });
      // 已经触底就停
      if (actualY + clientHeight >= scrollHeight - 2) break;
    }

    await resetScroll(tabId);
    if (!shots.length) return null;

    const width = shots[0].bitmap.width;
    const totalHeight = Math.ceil(scrollHeight * dpr);
    const canvas = new OffscreenCanvas(width, totalHeight);
    const ctx = canvas.getContext('2d');

    for (const { y, bitmap } of shots) {
      ctx.drawImage(bitmap, 0, Math.round(y * dpr));
      bitmap.close();
    }

    return await canvas.convertToBlob({ type: 'image/png' });
  } catch (e) {
    console.warn('[GEO] 截图失败:', e);
    return null;
  }
}

// ---- QA 节点截图:滚动到可见 → 分段截 → 裁剪拼接 ----
// 优点:样式还原 100%(直接来自浏览器渲染),不需要 html2canvas 这类库
// 参数 selector: adapter 返回的 qaSelector,例如 '.chat-content-list'

async function measureQANode(tabId, selector) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (sel) => {
      // 选最后一个可见的
      const list = [...document.querySelectorAll(sel)].filter((e) => e.offsetParent !== null);
      const node = list[list.length - 1];
      if (!node) return null;
      node.scrollIntoView({ block: 'start', behavior: 'auto' });
      const rect = node.getBoundingClientRect();
      return {
        x: Math.max(0, Math.round(rect.left)),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        scrollY: window.scrollY,
        clientHeight: document.documentElement.clientHeight,
        clientWidth: document.documentElement.clientWidth,
        dpr: window.devicePixelRatio || 1,
      };
    },
    args: [selector],
  });
  return result;
}

// 相对可视区裁剪一张 bitmap
function cropBitmap(bitmap, srcX, srcY, srcW, srcH) {
  const canvas = new OffscreenCanvas(srcW, srcH);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, srcX, srcY, srcW, srcH, 0, 0, srcW, srcH);
  return canvas;
}

// 截 QA 节点(单张截图,若节点大于一屏则滚动分段拼接)
export async function captureQANode(tabId, windowId, selector) {
  try {
    if (!selector) return null;
    let m = await measureQANode(tabId, selector);
    if (!m) return null;

    // 滚动进入可见:重测,确保 top ≥ 0
    await sleep(400);
    m = await measureQANode(tabId, selector);
    if (!m) return null;

    const { width, height, dpr, clientHeight, clientWidth } = m;
    if (width <= 0 || height <= 0) return null;

    // 目标画布尺寸(设备像素)
    const outW = Math.min(width, clientWidth) * dpr;
    const outH = height * dpr;
    const canvas = new OffscreenCanvas(Math.round(outW), Math.round(outH));
    const ctx = canvas.getContext('2d');

    // 需要多少段:每段最多 clientHeight
    const segments = Math.max(1, Math.ceil(height / clientHeight));
    let drawnY = 0; // 已在输出画布上填充到的 Y (device px)

    for (let i = 0; i < segments && i < MAX_SEGMENTS; i++) {
      // 目标是让节点的 (i * clientHeight ~ (i+1)*clientHeight) 那段出现在可视区顶部
      const nodeAbsY = m.scrollY + m.y; // 节点绝对 Y
      const scrollTarget = nodeAbsY + i * clientHeight;
      await scrollTo(tabId, scrollTarget);
      await sleep(i === 0 ? 300 : CAPTURE_INTERVAL);

      // 重新测量,拿到节点在当前视口内的 top(可能已滚过头)
      const rem = await measureQANode(tabId, selector);
      if (!rem) break;

      let dataUrl;
      try {
        dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
      } catch {
        await sleep(CAPTURE_INTERVAL);
        dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
      }
      const bitmap = await dataUrlToBitmap(dataUrl);

      // 裁剪本段:x = node.x*dpr, y = node.y*dpr (若 y<0 说明已滚上去,取 0 并调整 srcY = -node.y*dpr)
      const srcX = Math.max(0, Math.round(rem.x * dpr));
      const srcY = Math.max(0, Math.round(rem.y * dpr));
      const remainH = outH - drawnY;
      const srcH = Math.min(bitmap.height - srcY, remainH);
      const srcW = Math.min(bitmap.width - srcX, Math.round(width * dpr));
      if (srcH <= 0 || srcW <= 0) { bitmap.close(); break; }
      ctx.drawImage(bitmap, srcX, srcY, srcW, srcH, 0, drawnY, srcW, srcH);
      drawnY += srcH;
      bitmap.close();
      if (drawnY >= outH - 1) break;
    }

    await resetScroll(tabId);
    return await canvas.convertToBlob({ type: 'image/png' });
  } catch (e) {
    console.warn('[GEO] QA 节点截图失败:', e);
    return null;
  }
}
