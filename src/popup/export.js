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

// 返回 { count } 或抛错。只导出「未删除的会话」中「未删除的结果」。
export async function exportAll() {
  const JSZip = window.JSZip;
  if (!JSZip) throw new Error('JSZip 未加载');

  const [allRecords, sessions] = await Promise.all([getAllResults(), getAllSessions()]);

  // 被删除的会话 id
  const deletedSessions = new Set(sessions.filter((s) => s.deleted).map((s) => s.id));
  const sessionTitle = new Map(sessions.map((s) => [s.id, s.title]));

  // 过滤：跳过被删的记录、被删会话下的记录
  const records = allRecords.filter((r) => !r.deleted && !deletedSessions.has(r.sessionId));
  if (!records.length) throw new Error('没有可导出的结果（可能都已删除），请先采集或恢复');

  // 补上会话标题，供报告分组
  for (const r of records) {
    r.sessionTitle = sessionTitle.get(r.sessionId) || '未分组（历史）';
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
  const filename = `GEO采集_${tsStamp()}.zip`;

  await chrome.downloads.download({ url, filename, saveAs: true });
  // 延迟释放，确保下载已读取
  setTimeout(() => URL.revokeObjectURL(url), 60000);

  return { count: enriched.length };
}
