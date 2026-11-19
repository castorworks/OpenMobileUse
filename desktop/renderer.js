'use strict';
const $ = (id) => document.getElementById(id);
const api = window.omu;
const states = new Map();
let devices = [],
  selected = '',
  gesture = null,
  model,
  mode = 'select',
  scanPending = false;
const names = {
  ios: 'iOS',
  android: 'Android',
  harmony: 'HarmonyOS',
  home: '设置首页',
  bluetooth: '蓝牙页',
  connected: '已连接的设备',
  preferences: '连接偏好设置',
  preflight: '准备',
  execution: '执行',
  verification: '复查',
  tap: '点击',
  back: '返回',
  forward: '进入',
  launchApp: '启动应用',
  launch: '启动应用',
  input: '输入',
  waitFor: '等待控件',
  wait: '等待',
  route: '导航',
  swipe: '滑动',
  dispatched: '已执行',
  succeeded: '已通过',
  observed: '已观察',
  running: '运行中',
  failed: '失败',
  needs_review: '待人工核查',
  cancelled: '已停止',
};
const issues = {
  DEVICE_BUSY: '设备正在执行其他操作。',
  STALE_OBSERVATION: '手机页面已变化，请刷新画面重新定位。',
  DEVICE_UNAVAILABLE: '请检查 USB 连接并重新扫描设备。',
  DEVICE_OFFLINE: '设备已离线，请重新连接。',
  AUTHORIZATION_REQUIRED: '请解锁手机并确认 USB 调试或信任授权。',
  DEVICE_LOCKED: '请解锁手机并保持亮屏。',
  APPIUM_UNREACHABLE: '本机 Appium 连接中断或未响应，下次连接会自动检查服务。',
  APPIUM_ENDPOINT_CONFLICT: '配置的端口没有返回 Appium 状态，请检查 OMU_APPIUM_URL 和端口占用。',
  APPIUM_NOT_INSTALLED: '项目缺少 Appium 依赖，请在项目根目录运行 npm ci。',
  APPIUM_START_FAILED: '本机 Appium 启动失败，请查看启动工作台的终端日志。',
  APPIUM_START_TIMEOUT: '等待本机 Appium 就绪超时，请检查服务日志和端口配置。',
  APPIUM_INVALID_URL: '请将 OMU_APPIUM_URL 设为本机回环地址，可包含端口和服务路径。',
  APPIUM_HTTPS_UNAVAILABLE: '配置的本机 HTTPS 服务尚未启动。请检查 TLS 服务，或使用 HTTP 回环地址以自动启动。',
  WDA_SIGNING_FAILED: '请检查 WDA 签名配置和开发者信任。',
  WDA_SESSION_FAILED: '请检查开发者模式及 Xcode 的 WDA 构建日志。',
  ACTION_OUTCOME_UNKNOWN: '操作已发出，回执丢失。请刷新画面并核对未决动作。',
  PORT_IN_USE: '转发端口已占用，请检查 OMU_WDA_PORT。',
  AMBIGUOUS_ELEMENT: '存在同名控件，请缩小选择范围或使用坐标。',
  NO_FOCUSED_FIELD: '请先选中普通输入框。',
  INVALID_JSON: '文件不是有效的 JSON。',
  INVALID_FILE: '请选择有效的任务 JSON 文件。',
  CANCELLED: '已停止调度后续步骤。',
};
const nice = (s) => names[s] || s || '—';
const describe = (s) => (issues[s] ? issues[s] + ' (' + s + ')' : s);
const clock = (time) => (time ? new Date(time).toLocaleTimeString('zh-CN', { hour12: false }) : '');
function state(id = selected) {
  if (!states.has(id))
    states.set(id, {
      history: [],
      frame: null,
      hit: null,
      point: null,
      busy: false,
      active: null,
      current: null,
      notice: '',
      diagnostic: null,
    });
  return states.get(id);
}
function element(tag, text, cls) {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  if (cls) n.className = cls;
  return n;
}
function label(t) {
  const title = t.platform === 'android' && t.connection === 'emulator' ? 'Android 模拟器' : t.model;
  return devices.some(
    (other) => other.id !== t.id && other.model === t.model && other.platform === t.platform,
  )
    ? title + ' · ' + t.id.slice(-5)
    : title;
}
function renderDevices() {
  $('devices').replaceChildren(
    ...devices.map((t) => {
      const b = element('button', undefined, 'device' + (t.available ? ' online' : ''));
      b.dataset.device = t.id;
      b.setAttribute('aria-current', String(t.id === selected));
      b.title = t.id;
      const wrap = element('span');
      wrap.append(
        element('strong', label(t)),
        element(
          'small',
          (t.connection === 'emulator'
            ? t.id.slice('android:'.length)
            : [
                t.platform === 'harmony' ? '鸿蒙' : nice(t.platform),
                t.connection === 'network' ? '网络' : (t.connection || '').toUpperCase(),
              ]
                .filter(Boolean)
                .join(' · ')) +
            ' · ' +
            (state(t.id).active
              ? '运行中'
              : !t.available
                ? '不可用'
                : state(t.id).diagnostic?.controllable === false
                  ? '诊断失败'
                  : state(t.id).frame
                    ? '可控制'
                    : '已发现'),
        ),
      );
      b.append(element('span', undefined, 'device-symbol'), wrap, element('i'));
      b.onclick = () => selectDevice(t);
      return b;
    }),
  );
}
async function scan() {
  if (scanPending) return;
  scanPending = true;
  $('scan').disabled = true;
  try {
    const r = await api.devices();
    devices = r.devices;
    if (selected && !devices.some((t) => t.id === selected) && !state().active) selected = '';
    $('scan-status').textContent = [
      devices.length ? '' : '尚未发现设备',
      ...r.unavailable.map((f) => nice(f) + ' 发现失败'),
    ]
      .filter(Boolean)
      .join(' · ');
    render();
  } catch (e) {
    $('scan-status').textContent = e.message;
  } finally {
    scanPending = false;
    $('scan').disabled = false;
  }
}
function markFrame(id, frame) {
  const s = state(id);
  s.frame = frame;
  s.hit = null;
  s.point = null;
  if (id === selected) renderFrame();
}
async function selectDevice(t) {
  selected = t.id;
  gesture = null;
  mode = 'select';
  $('text').value = '';
  render();
  const s = state(t.id);
  const history = api
    .history(t.id)
    .then((data) => {
      s.history = data.history;
      if (data.current?.status === 'running') s.active = data.current;
      if (!s.current) s.current = s.active || s.history[0];
      if (selected === t.id) renderJournal();
    })
    .catch((e) => message(t.id, e.message));
  if (!s.busy && !s.active && t.available) await refresh(t.id);
  await history;
}
function message(id, value) {
  state(id).notice = value || '';
  if (id === selected) renderNotice();
}
function renderNotice() {
  const note = selected ? state().notice : '';
  $('notice').hidden = !note;
  $('notice').textContent = note;
}
function canAct() {
  const s = state(),
    t = devices.find((x) => x.id === selected);
  return !!(
    s.frame &&
    displayedFrame === s.frame &&
    t?.available &&
    !s.busy &&
    !s.active &&
    s.frame?.observationId &&
    !s.frame.controlsChangedDuringCapture
  );
}
function renderButtons() {
  const s = state(),
    t = devices.find((x) => x.id === selected),
    enabled = canAct(),
    free = t?.available && !s.busy && !s.active;
  $('diagnose').disabled = !t || s.busy || !!s.active;
  $('refresh').disabled = !free;
  $('tap').disabled = !enabled || (!s.point && s.hit === null);
  $('back').disabled = !enabled;
  $('input').disabled = !enabled || !$('text').value;
  $('text').disabled = !enabled;
  $('control').disabled = !enabled;
  $('select-mode').disabled = !enabled;
  $('swipe-mode').disabled = !enabled;
  $('select-mode').setAttribute('aria-pressed', String(mode === 'select'));
  $('swipe-mode').setAttribute('aria-pressed', String(mode === 'swipe'));
  $('start').hidden = !!s.active;
  $('stop').hidden = !s.active;
  $('start').disabled = !free;
  $('task').disabled = !!s.active || s.busy;
  $('stop').disabled = !s.active || s.stopping;
  $('stop').textContent = s.stopping ? '正在停止…' : '■　停止任务';
}
function render() {
  const t = devices.find((x) => x.id === selected);
  $('device-name').textContent = t ? label(t) : '选择设备';
  renderDevices();
  renderFrame();
  renderJournal();
  renderNotice();
  renderButtons();
  composer();
}
async function busy(id, fn) {
  const s = state(id);
  if (s.busy || s.active) return;
  s.busy = true;
  s.notice = '';
  if (id === selected) {
    renderButtons();
    renderFrame();
    renderNotice();
  }
  try {
    await fn(s);
  } catch (e) {
    message(id, describe(e.message));
  } finally {
    s.busy = false;
    if (id === selected) render();
  }
}
function refresh(id = selected) {
  return busy(id, async (s) => {
    let result;
    try {
      result = await api.refresh(id);
    } catch (e) {
      markFrame(id, null);
      s.diagnostic = { controllable: false };
      throw e;
    }
    s.diagnostic = { controllable: true };
    markFrame(id, result.frame);
    if (result.unconfirmed.length)
      message(id, '本机有 ' + result.unconfirmed.length + ' 条未决操作，请对照当前画面和连接诊断核实。');
    else if (result.frame.controlsChangedDuringCapture) message(id, describe('STALE_OBSERVATION'));
  });
}
function fit() {
  const img = $('shot'),
    canvas = $('canvas'),
    screen = $('screen');
  if (!img.naturalWidth || screen.hidden) return;
  const scale = Math.min(
    (canvas.clientWidth - 30) / img.naturalWidth,
    (canvas.clientHeight - 30) / img.naturalHeight,
  );
  screen.style.width = Math.max(1, img.naturalWidth * scale) + 'px';
  screen.style.height = Math.max(1, img.naturalHeight * scale) + 'px';
}
let drawnFrame, displayedFrame;
new ResizeObserver(fit).observe($('canvas'));
$('shot').onload = () => {
  displayedFrame = drawnFrame;
  fit();
  renderButtons();
};
function renderFrame() {
  const s = state(),
    f = s.frame;
  $('no-frame').hidden = !!f;
  $('screen').hidden = !f;
  $('empty-label').textContent = !selected
    ? '选择左侧设备查看画面'
    : s.busy
      ? '正在连接设备并读取画面…'
      : '刷新以查看当前画面';
  if (f !== drawnFrame) {
    drawnFrame = f;
    displayedFrame = null;
    if (f) $('shot').src = f.image;
    else $('shot').removeAttribute('src');
    const list = [new Option('选择控件或在画面上定位', '')];
    for (const [i, c] of (f?.controls || []).entries()) {
      if (c.enabled && !c.secret && (c.id || c.labels.length))
        list.push(new Option((c.labels[0] || c.id) + ' · ' + c.role.split('.').pop(), String(i)));
    }
    $('control').replaceChildren(...list);
  }
  $('control').value = s.hit === null ? '' : String(s.hit);
  $('frame-time').textContent = f ? clock(f.observedAt) : '尚未采集';
  $('foreground').textContent = f?.app || (f ? '任务会话画面' : '等待采集');
  $('geometry').textContent = f?.width ? f.width + ' × ' + f.height : '';
  const control = f?.controls[s.hit],
    o = $('outline');
  o.hidden = !control;
  if (control) {
    const b = control.bounds;
    Object.assign(o.style, {
      left: (100 * b.x) / f.actionWidth + '%',
      top: (100 * b.y) / f.actionHeight + '%',
      width: (100 * b.width) / f.actionWidth + '%',
      height: (100 * b.height) / f.actionHeight + '%',
    });
  }
  const p = $('point');
  p.hidden = !s.point;
  if (s.point) {
    p.style.left = 100 * s.point.x + '%';
    p.style.top = 100 * s.point.y + '%';
  }
  $('manual-hint').textContent = s.active
    ? '任务运行中，画面随设备动作更新。'
    : mode === 'swipe'
      ? '在画面上拖动并松开以执行滑动。'
      : control
        ? control.id || control.role
        : s.point
          ? '将按选中坐标点击。'
          : '';
  renderButtons();
}
function coords(e) {
  const r = $('screen').getBoundingClientRect(),
    clamp = (x) => Math.min(1, Math.max(0, x));
  return { x: clamp((e.clientX - r.left) / r.width), y: clamp((e.clientY - r.top) / r.height) };
}
$('screen').onpointerdown = (e) => {
  if (!canAct() || e.button !== 0) return;
  gesture = {
    id: selected,
    observation: state().frame.observationId,
    from: coords(e),
    pointer: e.pointerId,
  };
  $('screen').setPointerCapture(e.pointerId);
};
$('screen').onpointercancel = () => {
  gesture = null;
};
$('screen').onpointerup = (e) => {
  const g = gesture;
  gesture = null;
  if (
    !g ||
    g.pointer !== e.pointerId ||
    g.id !== selected ||
    !canAct() ||
    g.observation !== state().frame.observationId
  )
    return;
  const p = coords(e),
    s = state(),
    f = s.frame;
  if (mode === 'swipe') {
    if (Math.hypot(p.x - g.from.x, p.y - g.from.y) > 0.025)
      action({ action: 'swipe', fromX: g.from.x, fromY: g.from.y, toX: p.x, toY: p.y });
    return;
  }
  const x = p.x * f.actionWidth,
    y = p.y * f.actionHeight;
  const hits = f.controls
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => {
      const b = c.bounds;
      return (
        c.enabled &&
        !c.secret &&
        (c.id || c.labels.length) &&
        x >= b.x &&
        x < b.x + b.width &&
        y >= b.y &&
        y < b.y + b.height
      );
    })
    .sort((a, b) => a.c.bounds.width * a.c.bounds.height - b.c.bounds.width * b.c.bounds.height);
  s.point = p;
  s.hit = hits[0]?.i ?? null;
  renderFrame();
};
$('control').onchange = () => {
  const s = state();
  s.hit = $('control').value === '' ? null : Number($('control').value);
  s.point = null;
  renderFrame();
};
$('select-mode').onclick = () => {
  mode = 'select';
  renderFrame();
};
$('swipe-mode').onclick = () => {
  mode = 'swipe';
  renderFrame();
};
function selector(c) {
  if (!c) return {};
  const peers = state().frame.controls.filter((node) => node.role === c.role);
  if (c.id && peers.filter((node) => node.id === c.id).length === 1) return { id: c.id, role: c.role };
  const uniqueLabel = c.labels.find(
    (label) => peers.filter((node) => node.labels.includes(label)).length === 1,
  );
  return uniqueLabel
    ? { label: uniqueLabel, role: c.role }
    : c.id
      ? { id: c.id, role: c.role }
      : { label: c.labels[0], role: c.role };
}
async function action(raw) {
  if (!canAct()) return;
  const id = selected,
    observation = state().frame.observationId;
  await busy(id, async (s) => {
    let r;
    try {
      r = await api.action(id, raw, observation);
    } catch (e) {
      if (['STALE_OBSERVATION', 'ACTION_OUTCOME_UNKNOWN'].includes(e.message)) markFrame(id, null);
      throw e;
    }
    if (raw.action === 'input' && selected === id) $('text').value = '';
    markFrame(id, r.frame || null);
    message(
      id,
      r.captureError
        ? '操作已执行，刷新画面失败。' + describe(r.captureError)
        : nice(raw.action) + '已执行。',
    );
  });
}
$('tap').onclick = () => {
  const s = state();
  action({ action: 'tap', ...(s.point ? s.point : selector(s.frame.controls[s.hit])) });
};
$('back').onclick = () => {
  const s = state();
  let loc = {};
  if (devices.find((t) => t.id === selected)?.platform === 'ios') {
    const c = s.frame.controls[s.hit];
    const choices = s.frame.controls.filter(
      (c) => c.navigation && c.enabled && (c.id || c.labels.length),
    );
    const target = c?.navigation ? c : choices.length === 1 ? choices[0] : null;
    if (!target) {
      message(selected, '请先选择当前页面的返回或取消按钮。');
      return;
    }
    loc = selector(target);
  }
  action({ action: 'back', ...loc });
};
$('input').onclick = () => {
  const s = state(),
    c = s.frame.controls[s.hit];
  action({ action: 'input', ...selector(c), text: $('text').value });
};
$('text').oninput = renderButtons;
function composer() {
  const value = $('task').value,
    agent = value.includes('agent');
  $('task-file').hidden = !value.startsWith('custom');
  $('vision-label').hidden = value !== 'custom-agent';
  $('model-line').textContent = agent
    ? (model?.model || 'deepseek-flash') + ' · ' + (model?.endpoint || 'https://api.deepseek.com')
    : '离线执行';
}
$('task').onchange = () => {
  $('task-file').value = '';
  $('vision').checked = false;
  composer();
};
function displayRun(s, r) {
  if (!r) return;
  const records = new Map(s.history.map((x) => [x.id, x]));
  records.set(r.id, r);
  s.history = [...records.values()].sort((a, b) => b.started.localeCompare(a.started)).slice(0, 30);
}
function renderJournal() {
  const s = state(),
    r = s.current;
  const options = s.history.filter((x) => x.id !== s.active?.id);
  if (s.active) options.unshift(s.active);
  $('history').hidden = !options.length;
  $('history').replaceChildren(
    ...options.map((x) => new Option(clock(x.started) + ' · ' + x.title, x.id)),
  );
  if (r) $('history').value = r.id;
  $('run-status').textContent = r ? nice(r.status) : '待运行';
  $('run-status').dataset.status = r?.status || '';
  const es = r?.events || [],
    result = r?.result;
  const lastPage = result?.evidence?.at(-1)?.page;
  $('result-message').textContent = r
    ? [
        r.reason
          ? describe(r.reason)
          : lastPage === 'home'
            ? '已回到设置首页'
            : r.status === 'running'
              ? '正在执行 ' + r.title
              : r.title,
        result?.failedStep ? '第 ' + result.failedStep + ' 步' : '',
        result?.modelCalls !== undefined ? '模型调用 ' + result.modelCalls + ' 次' : '',
        r.historyError || r.cleanupError || '',
      ]
        .filter(Boolean)
        .join(' · ')
    : '';
  const reads = ['preflight', 'execution', 'verification'].map(
    (phase) =>
      es.find((e) => e.kind === 'evidence' && e.phase === phase && typeof e.bluetooth === 'boolean')
        ?.bluetooth,
  );
  $('readings').hidden = !reads.some((v) => v !== undefined);
  $('readings')
    .querySelectorAll('b')
    .forEach((b, i) => (b.textContent = reads[i] === undefined ? '—' : reads[i] ? '开启' : '关闭'));
  $('events').replaceChildren(
    ...es
      .slice()
      .reverse()
      .map((e) => {
        const li = element('li');
        li.append(
          element(
            'span',
            [e.phase ? nice(e.phase) : '', nice(e.name), e.status ? nice(e.status) : '']
              .filter(Boolean)
              .join(' · '),
          ),
          element('time', clock(e.at)),
        );
        return li;
      }),
  );
  $('journal-empty').hidden = !!r;
}
$('history').onchange = () => {
  const s = state();
  s.current = [s.active, ...s.history].find((x) => x?.id === $('history').value);
  renderJournal();
};
$('start').onclick = async () => {
  const id = selected,
    choice = $('task').value;
  if (!id) return;
  if (choice.includes('agent') && model?.needsKey) {
    showModel();
    return;
  }
  await busy(id, async (s) => {
    let imported;
    if (choice.startsWith('custom')) {
      const file = $('task-file').files[0];
      if (!file || file.size > 262144) throw Error('INVALID_FILE');
      imported = await file.text();
    }
    await api.start(id, choice, imported, choice === 'custom-agent' && $('vision').checked);
  });
};
$('stop').onclick = async () => {
  const id = selected,
    s = state();
  if (!s.active) return;
  s.stopping = true;
  renderButtons();
  try {
    await api.stop(id, s.active.id);
  } catch (e) {
    message(id, describe(e.message));
    s.stopping = false;
    renderButtons();
  }
};
api.onEvent((event) => {
  const s = state(event.device);
  if (event.type === 'run') {
    const r = event.record;
    s.active = r.status === 'running' ? r : null;
    s.current = r;
    if (!s.active) {
      displayRun(s, r);
      s.stopping = false;
      if (r.reason === 'ACTION_OUTCOME_UNKNOWN') s.notice = describe(r.reason);
    }
    if (selected === event.device) render();
  } else if (s.active?.id === event.runId) {
    if (event.type === 'frame') markFrame(event.device, event.frame);
    if (event.type === 'frameError') {
      markFrame(event.device, null);
      message(event.device, '画面读取失败。' + describe(event.error));
    }
  }
});
function dialog(title, settings = false) {
  $('dialog-title').textContent = title;
  $('diagnostic-content').hidden = settings;
  $('model-content').hidden = !settings;
  if (!$('dialog').open) $('dialog').showModal();
}
function showModel() {
  dialog('模型设置', true);
  $('endpoint').textContent = model.model + ' · ' + model.endpoint;
  $('key').value = '';
  $('key').focus();
}
$('model-settings').onclick = showModel;
$('save-key').onclick = async () => {
  try {
    model = await api.setKey($('key').value);
    $('key').value = '';
    $('dialog').close();
    composer();
  } catch (e) {
    $('endpoint').textContent = describe(e.message);
  }
};
$('dialog').onclose = () => {
  $('key').value = '';
};
$('diagnose').onclick = () => {
  const id = selected;
  busy(id, async (s) => {
    const report = await api.probe(id);
    s.diagnostic = report;
    if (selected !== id) return;
    dialog('连接诊断');
    const rows = [
      report.controllable ? '设备可控制' : '设备尚不可控制',
      ...report.probes.map(
        (p) =>
          p.stage +
          ' · ' +
          (p.ok ? '通过' : describe(p.error)) +
          (p.next && !issues[p.error] ? ' · ' + p.next : ''),
      ),
      ...report.unconfirmed.map((u) => '待核查 · ' + u.kind + ' · ' + u.time),
    ];
    $('diagnostic-content').replaceChildren(...rows.map((v) => element('p', v)));
  });
};
$('scan').onclick = scan;
$('refresh').onclick = () => refresh();
render();
api.config().then((v) => {
  model = v;
  composer();
});
scan();
