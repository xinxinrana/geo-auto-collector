// export.js — 在 popup 上下文中导出：读 IndexedDB → 生成 report.html + 截图 → JSZip 打包 → 下载。
// 放在 popup（普通页面）而非 SW：可用 URL.createObjectURL、可直接加载 UMD 版 JSZip。

import { getAllResults, getScreenshot, getAllSessions } from '../storage/db.js';
import { buildReportHtml } from '../export/html-template.js';

function tsStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const sanitize = (s) => String(s).replace(/[^\w一-龥-]+/g, '_').slice(0, 40);

// 只导出指定会话（当前选中的会话）内、未删除的结果。
// sessionId 必填：由 popup 传入当前活动会话 id。
export async function exportAll(sessionId) {
  const JSZip = window.JSZip;
  if (!JSZip) throw new Error('JSZip 未加载');
  if (!sessionId) throw new Error('请先选择（打开）一个会话再导出');

  const [allRecords, sessions] = await Promise.all([getAllResults(), getAllSessions()]);

  const session = sessions.find((s) => s.id === sessionId);
  const title = session ? session.title : '未分组（历史）';

  // 只取当前会话、未删除的结果
  const records = allRecords.filter((r) => !r.deleted && r.sessionId === sessionId);
  if (!records.length) throw new Error('当前会话没有可导出的结果，请先采集或恢复');

  // 补上会话标题，供报告分组
  for (const r of records) {
    r.sessionTitle = title;
  }

  const zip = new JSZip();
  const shotsDir = zip.folder('screenshots');

  // 逐条取截图 Blob，写入 zip，并在记录上补 screenshotFile 相对路径
  const enriched = [];
  for (const r of records) {
    const rec = { ...r };
    if (r.screenshotId) {
      const blob = await getScreenshot(r.screenshotId);
      if (blob) {
        const fname = `${sanitize(r.keyword)}_${r.platform}_${r.id}.png`;
        shotsDir.file(fname, blob);
        rec.screenshotFile = `screenshots/${fname}`;
      }
    }
    enriched.push(rec);
  }

  const html = buildReportHtml(enriched, { generatedAt: Date.now() });
  zip.file('report.html', html);

  const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  const url = URL.createObjectURL(zipBlob);
  const filename = `GEO采集_${sanitize(title)}_${tsStamp()}.zip`;

  await chrome.downloads.download({ url, filename, saveAs: true });
  // 延迟释放，确保下载已读取
  setTimeout(() => URL.revokeObjectURL(url), 60000);

  return { count: enriched.length };
}
