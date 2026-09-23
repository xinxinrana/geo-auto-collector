const $ = (id) => document.getElementById(id);
const DRAFTS_KEY = 'geo_selector_drafts';
const FIELDS = [
  ['input', '输入框'],
  ['question', '用户提问'],
  ['answer', '回答正文'],
  ['send', '发送按钮'],
];
const state = { catalog: [], active: {}, drafts: {}, platform: null, request: null, test: null };
const send = (message) => chrome.runtime.sendMessage(message);
const editable = (config) => {
  const output = {};
  for (const [field] of FIELDS) {
    if (config?.[`${field}Selector`]) {
      output[`${field}Selector`] = config[`${field}Selector`];
      if (config[`${field}Matcher`]) output[`${field}Matcher`] = config[`${field}Matcher`];
    }
  }
  return output;
};
const current = () => state.drafts[state.platform] || editable(state.active[state.platform]);
const dirty = () => JSON.stringify(current()) !== JSON.stringify(editable(state.active[state.platform]));

function feedback(message, error = false) {
  $('save-feedback').textContent = message;
  $('save-feedback').classList.toggle('error', error);
}

function renderPicking() {
  document.querySelectorAll('[data-pick-field]').forEach((button) => {
    const active = state.request?.field === button.dataset.pickField && state.request.platform === state.platform;
    button.textContent = active ? '取消点选' : '网页点选';
    button.classList.toggle('danger-outline', active);
  });
}

async function cancelPick() {
  const request = state.request;
  if (!request) return;
  state.request = null;
  renderPicking();
  const output = $(`selector-${request.field}`)?.closest('.field')?.querySelector('.preview');
  if (output) output.textContent = '已取消点选。';
  if (request.tabId) await send({ type: 'STOP_SELECTOR_PICK', tabId: request.tabId }).catch(() => {});
}

async function persistDraft(config) {
  state.drafts[state.platform] = editable(config);
  await chrome.storage.local.set({ [DRAFTS_KEY]: state.drafts });
  renderState();
}

function renderState() {
  $('config-state').textContent = dirty() ? '有未应用修改' : state.active[state.platform] ? '已应用' : '使用内置规则';
  $('config-state').classList.toggle('dirty', dirty());
  $('save-config').disabled = !dirty();
}

function errorText(code) {
  return ({
    wrong_platform_page: '请先打开当前平台网页，并保持该网页为活动标签页。',
    no_active_tab: '没有可用的网页标签页。',
    selector_empty: '请先填写或点选元素。',
    test_running: '已有试运行正在进行。',
    batch_running: '批量采集进行中，请完成后再试运行。',
    task_running: '已有任务正在进行。',
    invalid_url: '请输入有效的 HTTPS 地址。',
    invalid_platform: '平台名称和 HTTPS 地址不能为空。',
    platform_already_exists: '该网址已属于现有平台。',
  })[code] || code || '未知错误';
}

function fieldElement(field, label) {
  const section = document.createElement('div');
  section.className = 'field';
  const head = document.createElement('div');
  head.className = 'field-head';
  const title = document.createElement('label');
  title.textContent = label;
  title.htmlFor = `selector-${field}`;
  head.append(title);
  const controls = document.createElement('div');
  controls.className = 'field-controls';
  const input = document.createElement('input');
  input.id = `selector-${field}`;
  input.value = current()[`${field}Selector`] || '';
  input.placeholder = 'CSS 选择器（留空使用内置规则）';
  const pick = document.createElement('button');
  pick.dataset.pickField = field;
  pick.textContent = '网页点选';
  const preview = document.createElement('button');
  preview.textContent = '预览';
  const clear = document.createElement('button');
  clear.textContent = '清除';
  const output = document.createElement('div');
  output.className = 'preview';
  output.hidden = true;
  input.addEventListener('input', () => {
    const config = { ...current() };
    if (input.value.trim()) config[`${field}Selector`] = input.value.trim();
    else delete config[`${field}Selector`];
    delete config[`${field}Matcher`];
    persistDraft(config);
    output.hidden = true;
  });
  clear.addEventListener('click', () => {
    input.value = '';
    input.dispatchEvent(new Event('input'));
  });
  pick.addEventListener('click', async () => {
    if (state.request?.field === field && state.request.platform === state.platform) { await cancelPick(); return; }
    await cancelPick();
    const requestId = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const platform = state.platform;
    const request = { requestId, platform, field, tabId: null };
    state.request = request;
    renderPicking();
    output.hidden = false;
    output.classList.remove('warn');
    output.textContent = `请在网页中点击${label}。网页上不会出现遮挡层；按 Esc 或点“取消点选”退出。`;
    try {
      const result = await send({ type: 'START_SELECTOR_PICK', platform, field, requestId });
      if (state.request !== request) {
        if (result?.tabId) await send({ type: 'STOP_SELECTOR_PICK', tabId: result.tabId }).catch(() => {});
        return;
      }
      if (!result?.ok) {
        state.request = null;
        renderPicking();
        output.textContent = errorText(result?.error);
        output.classList.add('warn');
      } else request.tabId = result.tabId;
    } catch (error) {
      state.request = null;
      renderPicking();
      output.textContent = String(error?.message || error);
      output.classList.add('warn');
    }
  });
  preview.addEventListener('click', () => previewField(field, output));
  controls.append(input, pick, preview, clear);
  section.append(head, controls, output);
  return section;
}

async function previewField(field, output = $(`selector-${field}`)?.closest('.field')?.querySelector('.preview')) {
  if (!output) return;
  output.hidden = false;
  output.classList.remove('warn');
  output.textContent = '检查中…';
  try {
    const result = await send({ type: 'PREVIEW_SELECTOR', platform: state.platform, field, config: current() });
    if (!result?.ok) {
      output.textContent = result?.info?.selectorError || errorText(result?.error) || '未找到元素';
      output.classList.add('warn');
      return;
    }
    const count = result.info?.exactVisible || 0;
    const fuzzy = result.info?.fuzzyCandidates || 0;
    const text = result.selected?.text || '';
    output.textContent = `选择器可见匹配：${count} 个；特征候选：${fuzzy} 个${count === 0 ? '（当前依赖模糊匹配）' : ''}\n选中：${result.selected?.tag || '?'}${text ? ` · ${text.slice(0, 160)}` : ''}${count > 1 ? `\n其它候选：${(result.candidates || []).join(' | ').slice(0, 300)}` : ''}${fuzzy > 10 ? '\n提示：候选过多，建议在新聊天页重新点选更具体的元素。' : ''}`;
    output.classList.toggle('warn', count === 0 || fuzzy > 10 || (count > 1 && !current()[`${field}Matcher`]));
  } catch (error) {
    output.textContent = String(error?.message || error);
    output.classList.add('warn');
  }
}

function renderPlatform() {
  const item = state.catalog.find((entry) => entry.key === state.platform);
  if (!item) return;
  $('platform-select').value = state.platform;
  $('platform-url').textContent = item.url;
  $('delete-platform').hidden = !item.custom;
  $('reset-platform').textContent = item.custom ? '清空配置' : '恢复内置';
  $('element-fields').replaceChildren(...FIELDS.filter(([key]) => key !== 'send').map(([key, label]) => fieldElement(key, label)));
  $('send-field').replaceChildren(fieldElement('send', '发送按钮'));
  renderPicking();
  feedback('');
  renderState();
  renderTest(state.test);
}

async function selectPlatform(platform) {
  if (!state.catalog.some((entry) => entry.key === platform)) return;
  await cancelPick();
  state.platform = platform;
  await send({ type: 'SET_CONSOLE_PLATFORM', platform });
  renderPlatform();
}

function renderCatalog() {
  const select = $('platform-select');
  select.replaceChildren(...state.catalog.map((item) => {
    const option = document.createElement('option');
    option.value = item.key;
    option.textContent = item.name + (item.custom ? ' · 自定义' : '');
    return option;
  }));
}

function renderTest(test) {
  const box = $('test-result');
  box.className = 'test-result';
  if (!test || test.platform !== state.platform) {
    box.textContent = '尚未试运行。试运行使用上方编辑中的配置。';
    $('run-test').disabled = false;
    return;
  }
  $('run-test').disabled = !!test.running;
  if (test.running) { box.textContent = `正在试运行：${test.keyword}`; return; }
  box.classList.add(test.status === 'ok' ? 'ok' : 'error');
  const lines = [test.status === 'ok' ? `成功 · 回答 ${test.answerChars || 0} 字` : `失败 · ${test.error || '未知错误'}`];
  if (test.text) lines.push(`回答预览：\n${test.text}`);
  if (test.trace?.length) lines.push(`步骤：\n${test.trace.map((step, i) => `${i + 1}. ${step}`).join('\n')}`);
  box.textContent = lines.join('\n\n');
}

$('platform-select').addEventListener('change', (event) => selectPlatform(event.target.value));
$('add-toggle').addEventListener('click', () => { $('add-form').hidden = !$('add-form').hidden; });
$('add-cancel').addEventListener('click', () => { $('add-form').hidden = true; });
$('add-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const result = await send({ type: 'ADD_CUSTOM_PLATFORM', name: $('new-name').value, url: $('new-url').value });
  if (!result?.ok) { feedback(errorText(result?.error), true); return; }
  $('add-form').reset();
  $('add-form').hidden = true;
  state.catalog = await send({ type: 'GET_PLATFORM_CATALOG' });
  renderCatalog();
  await selectPlatform(result.key);
});
$('delete-platform').addEventListener('click', async () => {
  const item = state.catalog.find((entry) => entry.key === state.platform);
  if (!item?.custom || !confirm(`移除“${item.name}”及其元素配置？`)) return;
  await send({ type: 'DELETE_CUSTOM_PLATFORM', platform: item.key });
  delete state.drafts[item.key];
  delete state.active[item.key];
  await chrome.storage.local.set({ [DRAFTS_KEY]: state.drafts });
  state.catalog = await send({ type: 'GET_PLATFORM_CATALOG' });
  renderCatalog();
  await selectPlatform(state.catalog[0]?.key);
});
$('open-platform').addEventListener('click', async () => {
  const item = state.catalog.find((entry) => entry.key === state.platform);
  if (!item) return;
  const tabs = await chrome.tabs.query({});
  const host = new URL(item.url).hostname;
  const existing = tabs.find((tab) => { try { return new URL(tab.url).hostname === host; } catch { return false; } });
  if (existing) await chrome.tabs.update(existing.id, { active: true });
  else await chrome.tabs.create({ url: item.url, active: true });
});
$('save-config').addEventListener('click', async () => {
  for (const [field, label] of FIELDS) {
    const selector = current()[`${field}Selector`];
    if (!selector) continue;
    try { document.querySelector(selector); }
    catch { feedback(`${label}的 CSS 选择器格式无效。`, true); $(`selector-${field}`).focus(); return; }
  }
  const result = await send({ type: 'SAVE_SELECTOR_OVERRIDE', platform: state.platform, config: current() });
  if (!result?.ok) { feedback(errorText(result?.error), true); return; }
  state.active[state.platform] = result.config;
  delete state.drafts[state.platform];
  await chrome.storage.local.set({ [DRAFTS_KEY]: state.drafts });
  renderState();
  feedback('已保存并应用。后续采集将使用此配置。');
});
$('reset-platform').addEventListener('click', async () => {
  const result = await send({ type: 'CLEAR_SELECTOR_OVERRIDE', platform: state.platform });
  if (!result?.ok) { feedback(errorText(result?.error), true); return; }
  delete state.active[state.platform];
  delete state.drafts[state.platform];
  await chrome.storage.local.set({ [DRAFTS_KEY]: state.drafts });
  renderPlatform();
  feedback(state.catalog.find((item) => item.key === state.platform)?.custom ? '已清空配置。' : '已恢复内置规则。');
});
$('run-test').addEventListener('click', async () => {
  const keyword = $('test-keyword').value.trim();
  if (!keyword) { $('test-keyword').focus(); return; }
  const result = await send({ type: 'START_PLATFORM_TEST', platform: state.platform, keyword, config: current() });
  if (!result?.ok) {
    state.test = { platform: state.platform, status: 'failed', error: errorText(result?.error) };
    renderTest(state.test);
  }
});
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'CONSOLE_TEST_UPDATE') { state.test = message.state; renderTest(state.test); }
  if (message.type === 'SELECTOR_ELEMENT_PICKED') {
    const { requestId, platform, field, result } = message;
    if (state.request?.requestId !== requestId || state.request.platform !== platform || state.request.field !== field) return;
    state.request = null;
    renderPicking();
    const output = $(`selector-${field}`)?.closest('.field')?.querySelector('.preview');
    if (!result) { if (output) output.textContent = '已取消点选。'; return; }
    const config = { ...current(), [`${field}Selector`]: result.selector, [`${field}Matcher`]: result.matcher };
    persistDraft(config).then(() => {
      $(`selector-${field}`).value = result.selector;
      previewField(field, output);
    });
  }
});

async function init() {
  const [catalog, overrides, selected, test, local] = await Promise.all([
    send({ type: 'GET_PLATFORM_CATALOG' }), send({ type: 'GET_SELECTOR_OVERRIDES' }),
    send({ type: 'GET_CONSOLE_PLATFORM' }), send({ type: 'GET_PLATFORM_TEST' }),
    chrome.storage.local.get(DRAFTS_KEY),
  ]);
  state.catalog = catalog || [];
  state.active = overrides || {};
  state.drafts = local[DRAFTS_KEY] || {};
  state.test = test;
  renderCatalog();
  await selectPlatform(state.catalog.some((item) => item.key === selected) ? selected : state.catalog[0]?.key);
}
init().catch((error) => feedback(`控制台加载失败：${error?.message || error}`, true));
