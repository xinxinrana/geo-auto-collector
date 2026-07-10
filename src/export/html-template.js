// html-template.js — 把采集结果渲染成单一 report.html（自包含，可离线打开）。
// 截图不内嵌 base64（体积大），改为引用同 zip 内 screenshots/ 目录的图片文件。

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// 供 iframe srcdoc 属性使用的转义（只需处理 & 和 引号）
function escAttr(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;');
}

// 正文原样嵌入：优先用采集到的 HTML（保留段落/列表/链接），放进 sandbox iframe 隔离，
// 没有 HTML 时回退到纯文本。
function answerBlock(r) {
  const html = r.answerHtml || '';
  if (html) {
    const doc = `<!DOCTYPE html><html><head><meta charset="UTF-8"><base target="_blank">`
      + `<style>body{font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;`
      + `line-height:1.7;font-size:14px;color:#1a1a2e;margin:0;padding:4px;}`
      + `img{max-width:100%;height:auto;}a{color:#2d5bff;word-break:break-all;}`
      + `pre{white-space:pre-wrap;word-break:break-all;}table{border-collapse:collapse;}`
      + `td,th{border:1px solid #ddd;padding:4px 8px;}</style></head><body>${html}</body></html>`;
    return `<iframe class="answer-frame" sandbox="allow-popups allow-same-origin"
      srcdoc="${escAttr(doc)}" onload="try{this.style.height=(this.contentWindow.document.body.scrollHeight+16)+'px';}catch(e){}"></iframe>`;
  }
  const text = r.text || r.answerText || '';
  return `<div class="answer">${esc(text)}</div>`;
}

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const STATUS_LABEL = {
  ok: '成功',
  failed: '失败',
  login_required: '需登录',
  pending: '未执行',
  running: '中断',
};

function citationsHtml(citations) {
  if (!citations || !citations.length) return '<p class="muted">未提取到引用来源</p>';
  const rows = citations
    .sort((a, b) => (b.count || 0) - (a.count || 0))
    .map(
      (c) => `<tr>
        <td>${esc(c.domain)}</td>
        <td>${esc(c.count)}</td>
        <td><a href="${esc(c.sampleUrl)}" target="_blank" rel="noreferrer">${esc(c.sampleUrl)}</a></td>
      </tr>`
    )
    .join('');
  return `<table class="cite">
    <thead><tr><th>来源域名</th><th>出现次数</th><th>示例链接</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

// records: [{ platform, keyword, savedAt, status, answerText, answerChars,
//             citations, domHtml, screenshotId, url, error, timedOut, screenshotФile }]
// screenshotFile: zip 内相对路径（无则不显示图）
function recordCard(r, idx) {
  const shot = r.screenshotFile
    ? `<div class="shot"><a href="${esc(r.screenshotFile)}" target="_blank">
         <img src="${esc(r.screenshotFile)}" loading="lazy" alt="页面截图" /></a></div>`
    : '<p class="muted">无截图</p>';

  const domId = `dom-${idx}`;
  return `<article class="card">
    <h2>${esc(r.keyword)} <span class="badge badge-${esc(r.status)}">${esc(STATUS_LABEL[r.status] || r.status)}</span></h2>
    <table class="meta">
      <tr><th>平台</th><td>${esc(r.platform)}</td></tr>
      <tr><th>采集时间</th><td>${esc(fmtTime(r.savedAt))}</td></tr>
      <tr><th>页面地址</th><td>${r.url ? `<a href="${esc(r.url)}" target="_blank">${esc(r.url)}</a>` : ''}</td></tr>
      <tr><th>正文字数</th><td>${esc(r.answerChars || 0)}${r.timedOut ? ' <span class="warn">(超时截断)</span>' : ''}</td></tr>
      ${r.error ? `<tr><th>错误</th><td class="warn">${esc(r.error)}</td></tr>` : ''}
    </table>

    <h3>AI 回答正文</h3>
    ${answerBlock(r)}

    <h3>引用来源</h3>
    ${citationsHtml(r.citations)}

    <h3>页面截图</h3>
    ${shot}

    <h3>完整对话 DOM</h3>
    <button class="dom-toggle" onclick="var e=document.getElementById('${domId}');e.style.display=e.style.display==='none'?'block':'none';">展开 / 折叠 DOM</button>
    <pre id="${domId}" class="dom" style="display:none">${esc(r.domHtml || '')}</pre>
  </article>`;
}

export function buildReportHtml(records, meta = {}) {
  // 按会话分组：保持记录顺序，先出现的会话排前
  const groups = [];
  const idx = new Map();
  records.forEach((r) => {
    const key = r.sessionTitle || '未分组（历史）';
    if (!idx.has(key)) { idx.set(key, groups.length); groups.push({ title: key, items: [] }); }
    groups[idx.get(key)].items.push(r);
  });

  let ci = 0;
  const sections = groups.map((g) => {
    const okN = g.items.filter((r) => r.status === 'ok').length;
    const cards = g.items.map((r) => recordCard(r, ci++)).join('\n');
    return `<section class="session">
      <h2 class="session-title">${esc(g.title)} <span class="session-meta">${g.items.length} 条 · 成功 ${okN}</span></h2>
      ${cards}
    </section>`;
  }).join('\n');

  const okCount = records.filter((r) => r.status === 'ok').length;
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<title>GEO 采集报告 ${esc(fmtTime(meta.generatedAt))}</title>
<style>
  body { font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; margin: 0; background: #f5f6f8; color: #1a1a2e; }
  .container { max-width: 900px; margin: 0 auto; padding: 24px; }
  header.report { background: #2d5bff; color: #fff; padding: 24px; border-radius: 10px; margin-bottom: 20px; }
  header.report h1 { margin: 0 0 6px; font-size: 20px; }
  header.report .sub { opacity: .85; font-size: 13px; }
  .session { margin-bottom: 28px; }
  .session-title { font-size: 16px; margin: 0 0 12px; padding: 8px 14px; background: #e8edff; color: #2d3f8f; border-radius: 8px; }
  .session-meta { font-size: 12px; color: #6b7280; font-weight: normal; margin-left: 8px; }
  .card { background: #fff; border-radius: 10px; padding: 20px; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  .card h2 { font-size: 17px; margin: 0 0 12px; }
  .card h3 { font-size: 14px; color: #555; border-bottom: 1px solid #eee; padding-bottom: 4px; margin: 18px 0 8px; }
  .badge { font-size: 12px; padding: 2px 8px; border-radius: 10px; font-weight: normal; vertical-align: middle; }
  .badge-ok { background: #e3f9e5; color: #1b7a2f; }
  .badge-failed { background: #fde8e8; color: #c0392b; }
  .badge-login_required { background: #fef3cd; color: #8a6d1b; }
  .badge-pending, .badge-running { background: #eee; color: #666; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  table.meta th { text-align: left; width: 90px; color: #777; font-weight: normal; padding: 3px 8px 3px 0; vertical-align: top; }
  table.cite th, table.cite td { border: 1px solid #eee; padding: 6px 8px; text-align: left; }
  table.cite th { background: #fafafa; }
  .answer { white-space: pre-wrap; line-height: 1.7; font-size: 14px; background: #fafbfc; padding: 14px; border-radius: 6px; }
  .answer-frame { width: 100%; border: 1px solid #eee; border-radius: 6px; background: #fafbfc; min-height: 80px; }
  .dom { max-height: 360px; overflow: auto; background: #1e1e2e; color: #cdd6f4; padding: 12px; border-radius: 6px; font-size: 11px; white-space: pre-wrap; word-break: break-all; }
  .dom-toggle { cursor: pointer; font-size: 12px; padding: 4px 10px; border: 1px solid #ccc; background: #fff; border-radius: 6px; }
  .shot img { max-width: 100%; border: 1px solid #ddd; border-radius: 6px; }
  .muted { color: #999; font-size: 13px; }
  .warn { color: #c0392b; }
  a { color: #2d5bff; word-break: break-all; }
</style>
</head>
<body>
<div class="container">
  <header class="report">
    <h1>GEO 自动采集报告</h1>
    <div class="sub">生成时间：${esc(fmtTime(meta.generatedAt))} ｜ 共 ${records.length} 条，成功 ${okCount} 条 ｜ ${groups.length} 个会话</div>
  </header>
  ${sections}
</div>
</body>
</html>`;
}

export { esc, fmtTime };
