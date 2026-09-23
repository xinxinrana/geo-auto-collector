// screenshot-lib.js — 用页面内注入的 html-to-image 截 DOM 节点
// 优势:节点独立渲染,不受父容器 overflow / fixed / sticky 干扰,一次出图无拼接
// 依赖:src/lib/html-to-image.min.js(UMD,20KB)。common.js 已由 SW 在调用前注入,
//      所以这里只补充 html-to-image 库本身。

const LIB_FILE = 'src/lib/html-to-image.min.js';

function dataUrlToBlob(dataUrl) {
  const [head, b64] = dataUrl.split(',');
  const mime = /data:([^;]+);/.exec(head)?.[1] || 'image/png';
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return new Blob([buf], { type: mime });
}

/**
 * 通过页面内 html-to-image 截取 qaSelector 命中的最后一个节点。
 * @param {number} tabId
 * @param {string} selector
 * @returns {Promise<Blob|null>}
 */
export async function captureNodeViaLib(tabId, selector) {
  if (!selector) return null;
  try {
    // 1) 注入 html-to-image 库。common.js 已由 SW 提前注入并挂载 GEO.captureNode。
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [LIB_FILE],
    });

    // 2) 调用 GEO.captureNode(selector) → { dataUrl } 或 { error }
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: async (sel) => {
        if (!globalThis.GEO || !globalThis.GEO.captureNode) return { error: 'geo_not_ready' };
        return await globalThis.GEO.captureNode(sel);
      },
      args: [selector],
    });

    if (!result || result.error) {
      console.warn('[GEO] html-to-image 截图失败:', result && result.error);
      return null;
    }
    if (!result.dataUrl) return null;
    return dataUrlToBlob(result.dataUrl);
  } catch (e) {
    console.warn('[GEO] captureNodeViaLib 异常:', e && e.message);
    return null;
  }
}
