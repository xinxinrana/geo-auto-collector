export const PROTOCOL = 1;
export const TERMINAL = ['done', 'failed', 'suspended', 'interrupted'];
export const FIELDS = ['input', 'send', 'question', 'answer'];
export const PLATFORMS = {
  perplexity: {
    id: 'perplexity', name: 'Perplexity', url: 'https://www.perplexity.ai/',
    hosts: ['www.perplexity.ai', 'perplexity.ai'],
    tabPatterns: ['https://www.perplexity.ai/*', 'https://perplexity.ai/*'],
    newChatUrl: 'https://www.perplexity.ai/',
    adapter: 'extension/perplexity.js',
    loginPattern: '^/(login|signin)(/|\\?|$)',
    capabilities: ['run', 'collect', 'inspect', 'dom', 'fix', 'shot'],
    verification: 'fixture-tested; live-site-unverified',
    citationScope: '本轮回答中可见的外部链接；不自动展开来源弹层'
  },
  doubao: {
    id: 'doubao', name: '豆包', url: 'https://www.doubao.com/chat/',
    hosts: ['www.doubao.com', 'doubao.com'],
    tabPatterns: ['https://www.doubao.com/*', 'https://doubao.com/*'],
    newChatUrl: 'https://www.doubao.com/chat/',
    adapter: 'extension/doubao.js',
    loginPattern: '/login|from_login=1|passport\\.',
    capabilities: ['run', 'collect', 'inspect', 'dom', 'fix', 'shot'],
    verification: 'live-verified',
    citationScope: '回答正文中可见的外链；豆包通常不联网检索，0 条不代表采集失败'
  }
};
// Back-compat: the original single-platform export.
export const PLATFORM = PLATFORMS.perplexity;
export const platformIds = () => Object.keys(PLATFORMS);
export function platformOf(id) { return Object.hasOwn(PLATFORMS, id) ? PLATFORMS[id] : null; }
export function tabPatterns() { return Object.values(PLATFORMS).flatMap(p => p.tabPatterns); }
export const ACTIONS = {
  run: { description: '新建标签页并提问，等待当前轮次完成后采集', fields: ['platform', 'keyword', 'focus', 'timeoutMs'], required: ['platform', 'keyword'], effects: '创建新标签页、填写并提交问题；默认前置。失败不自动重提。' },
  collect: { description: '采集已有对话，不提交问题', fields: ['platform', 'tabId', 'focus', 'timeoutMs'], required: ['platform'], effects: '默认前置目标页；等待最后一轮完成，多标签页必须指定 tabId。' },
  inspect: { description: '验证当前页面的一类角色', fields: ['platform', 'tabId', 'field'], required: ['platform'], effects: '只读当前页面。' },
  dom: { description: '读取当前页面角色的剪枝 DOM', fields: ['platform', 'tabId', 'field', 'maxChars'], required: ['platform'], effects: '只读当前页面，结果使用 view=data 读取。' },
  fix: { description: '验证并按明确参数保存选择器', fields: ['platform', 'tabId', 'field', 'selector', 'testOnly', 'expectedRevision'], required: ['platform', 'field', 'selector'], effects: '默认仅实测；testOnly=false 且 expectedRevision 匹配时重新验证并保存。只修复定位，不重提问题。' },
  shot: { description: '截图当前回答的可见布局区域', fields: ['platform', 'tabId'], required: ['platform'], effects: '短暂连接 Chrome debugger；不主动前置、不滚动；虚拟化内容不保证完整。' },
  anchors: { description: '读取当前选择器覆盖配置', fields: [], required: [], effects: '只读配置。' },
  stop: { description: '请求停止插件自动化，等待 runner 确认', fields: ['taskId'], required: [], effects: '停止插件后续操作，不点击网站停止生成按钮。原任务以 interrupted / stopped 结束；无法确认时不会释放执行归属。' }
};
export class GeoError extends Error {
  constructor(code, message, status = 400, details = {}) {
    super(message); this.code = code; this.status = status; this.details = details;
  }
}
export function errorBody(error) {
  return { error: { code: error.code || 'internal_error', message: error.code ? error.message : '内部错误，请查看本机服务日志', ...error.details } };
}
export function validateCommand(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new GeoError('invalid_command', '请求必须为 JSON 对象');
  const spec = Object.hasOwn(ACTIONS, input.action) ? ACTIONS[input.action] : null;
  if (!spec) throw new GeoError('invalid_action', '未知动作', 400, { field: 'action', docs: '/help' });
  const fail = (field, message) => { throw new GeoError('invalid_argument', message, 400, { field, docs: `/docs/${input.action}` }); };
  for (const k of Object.keys(input)) if (k !== 'action' && !spec.fields.includes(k)) fail(k, '不支持的参数');
  for (const k of spec.required) if (input[k] == null || input[k] === '') fail(k, '缺少必填参数');
  const value = { ...input };
  if ('platform' in value && !platformOf(value.platform)) fail('platform', `可选平台：${platformIds().join(', ')}`);
  for (const k of ['keyword', 'selector', 'taskId']) if (k in value) {
    if (typeof value[k] !== 'string' || !value[k].trim() || value[k].length > (k === 'keyword' ? 20000 : 2000)) fail(k, '字符串为空、过长或类型错误');
    value[k] = value[k].trim();
  }
  for (const k of ['focus', 'testOnly']) if (k in value && typeof value[k] !== 'boolean') fail(k, '必须是布尔值');
  for (const [k, min, max] of [['tabId', 0, 2147483647], ['timeoutMs', 5000, 600000], ['maxChars', 100, 20000], ['expectedRevision', 0, 1000000000]]) {
    if (k in value && (!Number.isInteger(value[k]) || value[k] < min || value[k] > max)) fail(k, `必须是 ${min}–${max} 的整数`);
  }
  if ('field' in value && !FIELDS.includes(value.field)) fail('field', `可选值：${FIELDS.join(', ')}`);
  if (['run', 'collect'].includes(value.action)) { value.focus ??= true; value.timeoutMs ??= 180000; }
  if (['inspect', 'dom'].includes(value.action)) value.field ??= 'answer';
  if (value.action === 'dom') value.maxChars ??= 6000;
  if (value.action === 'fix') { value.testOnly ??= true; if (!value.testOnly && value.expectedRevision == null) fail('expectedRevision', '保存时必须提供实测返回的配置版本'); }
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
}
export function help(version) {
  return { name: 'GEO browser collector', version, protocol: PROTOCOL, connection: '/docs/connection', status: '/status', platforms: '/platforms', docs: '/docs', actions: Object.fromEntries(Object.entries(ACTIONS).map(([k, v]) => [k, { description: v.description, docs: `/docs/${k}` }])) };
}
export function documentation(topic) {
  const topics = ['connection', 'tasks', 'results', ...Object.keys(ACTIONS)];
  if (!topic) return { topics: topics.map(name => ({ name, href: `/docs/${name}` })) };
  if (topic === 'connection') return {
    topic, steps: ['Node 24.13+：在项目目录 npm install，然后 ./geo up（前台运行）', 'Chrome 扩展页面开启开发者模式，加载项目根目录', '点击扩展图标打开侧栏，直接点击连接', './geo status 核对 extension.connected 与 ready，再登录 Perplexity'],
    endpoint: 'http://127.0.0.1:8787', home: 'GEO_BRIDGE_HOME 或 ~/.geo-bridge',
    offlineHelp: './geo help 和 ./geo docs <topic> 不需要服务',
    errors: { service_offline: '启动 ./geo up', extension_offline: '在侧栏连接扩展', login_required: '本人在网页完成登录' },
    connection: '本机直接连接；同时使用一个扩展连接',
    cli: './geo up [--port 8787]，GEO_BRIDGE_PORT 同时作用于 CLI 与服务；侧栏填写相同端口'
  };
  if (topic === 'tasks') return {
    topic, states: { queued: '已接受，未确认执行', running: '正在执行，不重复提交', done: '动作成功', failed: '动作失败', suspended: '定位需检查，当前执行已结束', interrupted: '停止或执行上下文消失' },
    terminal: TERMINAL, queries: ['GET /tasks/{id}', 'GET /tasks?limit=20', 'GET /events?taskId={id}&since=0&wait=0'],
    events: { wait: '0–25000 毫秒有界长轮询', limit: 100, cursor: '下次 since 使用返回 cursor，hasMore=true 时继续读取', payload: '只含状态摘要，无正文' },
    idempotency: 'POST /command 携带 Idempotency-Key。同键同规范化参数返回原任务，不同参数 409。持久化到数据目录。',
    recovery: '重连重放未确认事件，提交结果不明时不自动重提。断线不是任务失败。停止未确认时原任务保持占用。',
    cli: './geo task <id>；./geo events <id> --since 0 --wait 10000',
    exitCodes: { 0: '成功/已接受', 1: '失败/中断', 2: '需修复', 3: '冲突/忙', 4: 'CLI 等待超时，页面任务继续', 5: '连接不可用' }
  };
  if (topic === 'results') return {
    topic, endpoint: 'GET /tasks/{id}/result?view=summary',
    views: { summary: '默认字数、引用数、可用链接', text: '正文', html: '回答 HTML（不可信原始数据）', qa: '剪枝问答 DOM', citations: '可见引用', data: '检查/修复/配置数据', full: '完整结构化结果，显式请求' },
    paging: { offset: '从 0 开始，text/html/qa 使用 Unicode 码点位置', maxChars: '默认 4000，最多 20000', limit: '引用默认 50，最多 200' },
    screenshot: 'GET /tasks/{id}/artifacts/screenshot；只有实际存在时返回链接',
    diagnostics: 'GET /diagnostic/{id}，?view=full 读取失败时保存的剪枝 DOM',
    pending: '202 表示结果未就绪，继续查询原任务；终态无产物返回 404',
    cli: './geo result <id> --view text --max-chars 4000；./geo result <id> --view screenshot --out /tmp/geo.png'
  };
  const spec = Object.hasOwn(ACTIONS, topic) ? ACTIONS[topic] : null;
  if (!spec) throw new GeoError('not_found', '文档不存在', 404);
  const sample = { action: topic };
  if (spec.fields.includes('platform')) sample.platform = 'perplexity';
  if (topic === 'run') sample.keyword = 'GEO 是什么';
  if (topic === 'fix') Object.assign(sample, { field: 'input', selector: 'textarea', testOnly: true });
  return {
    topic, ...spec, prerequisites: ['bridge 在线', '扩展已连接且完成恢复', ...(topic === 'run' ? [`${PLATFORMS.perplexity.name} 已登录`] : spec.fields.includes('tabId') ? ['已打开目标平台页面；多个标签页需 tabId'] : [])],
    platforms: Object.values(PLATFORMS).map(p => ({ id: p.id, name: p.name, url: p.url, capabilities: p.capabilities, citationScope: p.citationScope })),
    request: { method: 'POST', path: '/command', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': '<每次逻辑操作唯一，重试沿用>' }, body: sample },
    parameters: Object.fromEntries(spec.fields.map(k => [k, parameter(k)])),
    accepted: { httpStatus: 202, body: { id: '<taskId>', status: 'queued', links: { task: '/tasks/{id}', result: '/tasks/{id}/result' } } },
    next: ['按 pollAfterMs 查询 /tasks/{id}', '到终态后读取结果摘要或错误；需要正文再选择 view=text', 'suspended 时读取 diagnostic 链接；修复不会自动重提'],
    errors: { 400: '参数错误，查看 field', 409: '忙或幂等冲突，见 task 链接', 503: '扩展未连接/未恢复', execution: ['ambiguous', 'not_found', 'timeout', 'submission_unknown', 'stopped', 'interrupted'] },
    cli: `./geo ${topic}${sample.platform ? ' --platform perplexity' : ''}${topic === 'run' ? ' --keyword "GEO 是什么"' : ''}${topic === 'fix' ? ' --field input --selector textarea --test-only' : ''} --wait 0`,
    waiting: '--wait 单位毫秒，默认 0；CLI 超时不取消页面任务', resultDocs: '/docs/results'
  };
}
function parameter(k) {
  return {
    platform: { type: 'string', enum: platformIds() }, keyword: { type: 'string', maxLength: 20000 }, tabId: { type: 'integer', minimum: 0 },
    focus: { type: 'boolean', default: true, note: '--no-focus 不前置，不保证后台持续执行' }, timeoutMs: { type: 'integer', default: 180000, minimum: 5000, maximum: 600000 },
    field: { type: 'string', enum: FIELDS, default: 'inspect/dom: answer' }, maxChars: { type: 'integer', default: 6000, minimum: 100, maximum: 20000 },
    selector: { type: 'string', maxLength: 2000 }, testOnly: { type: 'boolean', default: true }, expectedRevision: { type: 'integer', note: 'testOnly=false 必填；保存重新验证' }, taskId: { type: 'string', note: '默认当前非 stop 任务' }
  }[k];
}
export function taskLinks(id) { return { task: `/tasks/${id}`, result: `/tasks/${id}/result`, events: `/events?taskId=${id}`, docs: '/docs/tasks' }; }
export function isPlatformUrl(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && Object.values(PLATFORMS).some(p => p.hosts.includes(u.hostname));
  } catch { return false; }
}
export function platformOfUrl(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' ? Object.values(PLATFORMS).find(p => p.hosts.includes(u.hostname)) || null : null;
  } catch { return null; }
}
