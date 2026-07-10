// screenshot.js — 整页截图。插件不能改 viewport，改用分段滚动 + captureVisibleTab + OffscreenCanvas 拼接。
// 在 service worker 中运行：captureVisibleTab 只能在 SW 调用，OffscreenCanvas/createImageBitmap 在 SW 可用。

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
