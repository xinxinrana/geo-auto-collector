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

function formatDate(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// 文件态：data/ 目录下的 README
function buildDataReadme(title, count, generatedAt) {
  return [
    `# GEO 采集原始数据`,
    ``,
    `- 会话：${title}`,
    `- 导出时间：${formatDate(generatedAt)}`,
    `- 条目数：${count}`,
    ``,
    `## 目录结构`,
    ``,
    `每个子文件夹对应一次采集结果，命名规则：\`{keyword}_{platform}_{id}\`。`,
    ``,
    `文件夹内通常包含：`,
    ``,
    `| 文件 | 说明 |`,
    `|---|---|`,
    `| \`README.md\` | 该条目的摘要与正文预览 |`,
    `| \`metadata.json\` | 完整元数据（平台、URL、状态、字数、引用等） |`,
    `| \`answer.txt\` | 正文纯文本 |`,
    `| \`answer.html\` | 正文 HTML |`,
    `| \`qa.html\` | 完整 QA 容器 HTML |`,
    `| \`screenshot.png\` | 页面截图（采集成功且有时） |`,
    ``,
    `## 常用字段说明`,
    ``,
    `- \`status\`: ok / failed / login_required`,
    `- \`answerChars\`: 正文字符数`,
    `- \`timedOut\`: 是否因等待超时而结束`,
    `- \`citations\`: 引用链接列表（域名、次数、示例 URL）`,
    `- \`screenshotVia\`: 截图使用的 fallback 方案`,
  ].join('\n');
}

// 文件态：单条结果文件夹内的 README
function buildItemReadme(r) {
  const lines = [
    `# ${r.keyword || '(无关键词)'}`,
    '',
    `- 平台：${r.platform || '-' }`,
    `- 状态：${r.status || '-'}`,
    `- URL：${r.url || '-'}`,
    `- 字数：${r.answerChars || 0}`,
    `- 导出时间：${formatDate(r.savedAt || Date.now())}`,
    `- 截图：${r.screenshotId ? 'screenshot.png' : '无'}`,
  ];
  if (Array.isArray(r.citations) && r.citations.length) {
    lines.push('', '## 引用来源', '');
    for (const c of r.citations) {
      lines.push(`- ${c.domain || '?'}（${c.count || 0} 次）${c.sampleUrl || ''}`);
    }
  }
  lines.push('', '## 正文', '', r.text || '（无正文）');
  return lines.join('\n');
}

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

  // ---- 第二部分：文件态原始数据 ----
  const dataDir = zip.folder('data');
  dataDir.file('README.md', buildDataReadme(title, enriched.length, Date.now()));

  for (const r of enriched) {
    const folderName = `${sanitize(r.keyword)}_${r.platform}_${r.id}`;
    const itemDir = dataDir.folder(folderName);

    itemDir.file('README.md', buildItemReadme(r));
    itemDir.file('metadata.json', JSON.stringify({
      id: r.id,
      platform: r.platform,
      keyword: r.keyword,
      url: r.url,
      status: r.status,
      answerChars: r.answerChars,
      answerHtmlLength: r.answerHtml ? r.answerHtml.length : 0,
      qaHtmlLength: r.qaHtml ? r.qaHtml.length : 0,
      timedOut: r.timedOut,
      screenshotId: r.screenshotId,
      screenshotVia: r.screenshotVia,
      citations: r.citations,
      savedAt: r.savedAt,
      sessionTitle: r.sessionTitle,
    }, null, 2));

    if (r.text) itemDir.file('answer.txt', r.text);
    if (r.answerHtml) itemDir.file('answer.html', r.answerHtml);
    if (r.qaHtml) itemDir.file('qa.html', r.qaHtml);

    // 截图也复制到单条结果文件夹，方便独立分析
    if (r.screenshotId) {
      const blob = await getScreenshot(r.screenshotId);
      if (blob) itemDir.file('screenshot.png', blob);
    }
  }

  const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  const url = URL.createObjectURL(zipBlob);
  const filename = `GEO采集_${sanitize(title)}_${tsStamp()}.zip`;

  await chrome.downloads.download({ url, filename, saveAs: true });
  // 延迟释放，确保下载已读取
  setTimeout(() => URL.revokeObjectURL(url), 60000);

  return { count: enriched.length };
}
