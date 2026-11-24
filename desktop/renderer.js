'use strict';
const $ = (id) => document.getElementById(id);
const api = window.omu;
const states = new Map();
let devices = [],
  selected = '',
  gesture = null,
  model,
  mode = 'select',
  scanPending,
  scanErrors = {},
  androidSetup,
  androidPreparing = false,
  androidScanTimer;
let workspaceMode = 'chat',
  scripts = [],
  scriptsVersion = 0,
  managedScript = null;
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
  tapScreenText: '点击画面文字',
  checkScreenText: '核对画面文字',
  tapImage: '点击画面目标',
  checkImage: '核对画面目标',
  ask_user: '等待回复',
  finish: '完成',
  check: '核对界面',
  pause: '等待',
  input_text: '输入文字',
  launch_app: '启动应用',
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
  STALE_OBSERVATION: '操作目标或前台窗口已变化',
  FOREGROUND_WINDOW_AMBIGUOUS: '前台窗口正在切换',
  FOREGROUND_APP_UNAVAILABLE: '暂时读不到前台应用',
  HDC_LAYOUT_UNAVAILABLE: '暂时读不到手机界面',
  LAYOUT_UNAVAILABLE: '控件树不完整',
  OBSERVATION_INCOMPLETE: '设备返回的界面数据不完整',
  OBSERVATION_TIMEOUT: '读取手机界面超时',
  DISPLAY_GEOMETRY_UNAVAILABLE: '暂时读不到屏幕尺寸',
  DISPLAY_ROTATION_UNAVAILABLE: '暂时读不到屏幕方向',
  SCREENSHOT_GEOMETRY_MISMATCH: '截图与当前屏幕尺寸不符',
  SCREENSHOT_UNAVAILABLE: '暂时读不到截图',
  INVALID_PNG: '截图数据不完整',
  ELEMENT_NOT_FOUND: '当前页面找不到目标',
  AMBIGUOUS_ELEMENT: '有多个控件符合目标',
  AMBIGUOUS_OR_MISSING_ELEMENT: '无法唯一定位控件',
  ELEMENT_DISABLED: '控件暂不可操作',
  ELEMENT_OUTSIDE_SCREEN: '控件已移出屏幕',
  NO_FOCUSED_FIELD: '当前没有获得焦点的输入框',
  INPUT_TARGET_CHANGED: '输入目标或内容已变化',
  INPUT_FOCUS_UNCONFIRMED: '输入框焦点尚未确认',
  INPUT_NOT_VERIFIED: '文字已发送，尚未核实',
  INPUT_ALREADY_ATTEMPTED: '相同文字已发送过',
  APP_NOT_FOREGROUND: '启动后尚未确认目标应用已在前台',
  APP_LAUNCH_ALREADY_ATTEMPTED: '已向同一应用发送过启动命令',
  BUNDLE_INFO_UNAVAILABLE: '暂时读不到应用入口',
  MODEL_REPLY_TRUNCATED: '模型回复被截断',
  MODEL_TOOL_CALL_REQUIRED: '模型缺少操作指令',
  MODEL_INVALID_TOOL_CALL: '模型操作指令格式有误',
  MODEL_INVALID_JSON: '暂时无法解析模型回复',
  NO_PROGRESS: '目标状态未变化',
  VISUAL_TARGET_UNCLEAR: '未能唯一定位画面目标',
  cancelled: '已停止',
};
const issues = {
  SETUP_CANCELLED: '已取消环境配置。',
  ANDROID_DOWNLOAD_FAILED: '下载 Android 工具失败，请检查网络连接后重试。',
  ANDROID_DOWNLOAD_CHECKSUM: '下载文件校验失败，请重试。',
  ANDROID_JAVA_INCOMPATIBLE: '当前 Java 版本无法运行 Android SDK 安装工具，请检查 Java 后重试。',
  ANDROID_SDK_INSTALL_FAILED: 'Android 工具安装失败，请检查网络、磁盘空间和 SDK 许可后重试。',
  ANDROID_SDK_FOLDER_INVALID: '请选择包含 platform-tools、build-tools 或 cmdline-tools 的 SDK 根目录。',
  ANDROID_STUDIO_REQUIRED: '请使用 Android Studio 的设备管理器准备并启动模拟器。',
  AVD_CREATE_FAILED: '无法创建工作台模拟器，请检查 SDK 镜像与可用磁盘空间。',
  EMULATOR_START_FAILED: '模拟器启动失败，请检查虚拟化支持和可用磁盘空间。',
  EMULATOR_BOOT_TIMEOUT: '模拟器仍在启动，可稍后重新扫描。',
  DEVICE_BUSY: '设备正在执行其他操作。',
  STALE_OBSERVATION: '操作目标或前台窗口已变化，请核对当前画面。',
  INPUT_TARGET_CHANGED: '输入目标或原有内容已变化，本次文字尚未写入。',
  INPUT_FOCUS_UNCONFIRMED: '无法确认目标输入框已获得焦点，本次文字尚未写入。',
  INPUT_NOT_VERIFIED: '输入命令已执行，请核对手机上的文字后再继续。',
  FOREGROUND_WINDOW_AMBIGUOUS: '手机正在切换前台窗口，暂时无法确认操作目标。',
  APP_NOT_INSTALLED: '设备上没有找到对应的应用。',
  APP_NOT_LAUNCHABLE: '没有找到可以直接启动的应用入口。',
  APP_LAUNCH_REJECTED: '手机拒绝了启动应用的请求。',
  ELEMENT_NOT_FOUND: '当前页面上找不到刚才选中的控件。',
  SCREEN_TEXT_NOT_UNIQUE_OR_MISSING: '画面上的目标文字已消失或出现多次，请核对当前画面。',
  SCREEN_TEXT_UNAVAILABLE: '本机暂时无法识别画面文字。可在右侧手机画面上定位，再点击选区。',
  VISUAL_TARGET_UNCLEAR: '画面目标已变化或无法唯一区分，请核对手机画面。',
  MODEL_IMAGES_UNSUPPORTED: '此模型不支持截图。可选择 deepseek-flash，或关闭截图选项。',
  SCREENSHOT_GEOMETRY_MISMATCH: '截图与手机触控区域的方向或比例不一致，请刷新画面。',
  AMBIGUOUS_OR_MISSING_ELEMENT: '设备没有找到唯一匹配的控件。',
  DEVICE_UNAVAILABLE: '请检查 USB 连接并重新扫描设备。',
  DEVICE_OFFLINE: '设备已离线，请重新连接。',
  AUTHORIZATION_REQUIRED: '请解锁手机并确认 USB 调试或信任授权。',
  DEVICE_LOCKED: '请解锁手机并保持亮屏。',
  APPIUM_UNREACHABLE: '本机 Appium 连接中断或未响应，下次连接会自动检查服务。',
  APPIUM_ENDPOINT_CONFLICT: '配置的端口没有返回 Appium 状态，请检查 OMU_APPIUM_URL 和端口占用。',
  APPIUM_NOT_INSTALLED: '应用缺少内置 Appium，请重新打开完整的工作台应用。',
  APPIUM_START_FAILED: '本机 Appium 启动失败，请检查本机端口后重新连接。',
  APPIUM_START_TIMEOUT: '等待本机 Appium 就绪超时，请检查服务日志和端口配置。',
  APPIUM_INVALID_URL: '请将 OMU_APPIUM_URL 设为本机回环地址，可包含端口和服务路径。',
  MODEL_HTTP_401: '模型服务拒绝了凭据，请在工作台设置中更新 API Key。',
  MODEL_HTTP_403: '此凭据无权调用当前模型，请检查工作台设置。',
  MODEL_HTTP_404: '模型或接口不存在，请检查模型名称和接口地址。',
  MODEL_CONTENT_FILTERED: '模型服务过滤了本轮回复。',
  MODEL_REFUSED: '模型拒绝执行本轮请求。',
  MODEL_PROVIDER_ERROR: '模型服务返回了错误。',
  APPIUM_HTTPS_UNAVAILABLE:
    '配置的本机 HTTPS 服务尚未启动。请检查 TLS 服务，或使用 HTTP 回环地址以自动启动。',
  WDA_SIGNING_FAILED: '请检查 WDA 签名配置和开发者信任。',
  WDA_SESSION_FAILED: '请检查开发者模式及 Xcode 的 WDA 构建日志。',
  ACTION_OUTCOME_UNKNOWN: '操作已发出，回执丢失。请刷新画面并核对未决动作。',
  PORT_IN_USE: '转发端口已占用，请检查 OMU_WDA_PORT。',
  AMBIGUOUS_ELEMENT: '存在同名控件，请缩小选择范围或使用坐标。',
  NO_FOCUSED_FIELD: '请先选中普通输入框。',
  INVALID_JSON: '文件不是有效的 JSON。',
  INVALID_SCRIPT_NAME: '脚本名称需要 1 到 100 个字符。',
  INVALID_SCRIPT: '脚本格式无效。请导入符合当前格式的 JSON 文件。',
  INVALID_SCRIPT_STEP: '脚本含有无法执行的步骤。',
  INVALID_CONVERSATION_RECORDING: '此对话的录制格式已失效。请新建对话再录制。',
  SCRIPT_PLATFORM_MISMATCH: '请选择与脚本兼容的设备。',
  UNKNOWN_SCRIPT: '脚本已从脚本库移除。',
  INVALID_FILE: '请选择有效的任务 JSON 文件。',
  CANCELLED: '已停止调度后续步骤。',
  RECORDING_STATE_MISMATCH: '当前应用、控件或读数与录制不同。请恢复此步骤的起始界面。',
  RECORDING_WRITE_FAILED: '保存录制失败，操作可能已执行。请检查磁盘后核对画面。',
  RECORDING_TARGET_UNAVAILABLE: '录制此操作需要能唯一定位的控件，请选择目标。',
  RECORDING_FULL: '本段录制已满，请新建对话继续。',
  SENSITIVE_OR_BLOCKED_SCREEN: '请先在设备上处理密码或系统弹窗，再回复以继续。',
  NO_PROGRESS: '连续几次尝试都没有进展，已暂停。可展开本轮执行过程查看原因。',
  DECISION_BUDGET: '已到本轮决策上限，可以回复以继续。',
  TIME_BUDGET: '本轮已超时，可以回复以继续。',
  MODEL_KEY_REQUIRED: '请在工作台设置中填写 API Key。',
  INVALID_SETTINGS: '请检查接口地址、模型名称和签名配置。',
  KEYCHAIN_UNAVAILABLE: '无法保存密钥，请检查系统凭据存储后重试。',
};
const nice = (s) => names[s] || s || '—';
const describe = (s) => (issues[s] ? issues[s] + ' (' + s + ')' : s);
const clock = (time) => (time ? new Date(time).toLocaleTimeString('zh-CN', { hour12: false }) : '');
function state(id = selected) {
  if (!states.has(id))
    states.set(id, {
      history: [],
      chats: [],
      chat: null,
      draft: '',
      libraryVersion: 0,
      loadingChat: false,
      recordManual: false,
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
      const s = state(t.id);
      const status = s.active
        ? 'running'
        : !t.available
          ? 'offline'
          : s.diagnostic?.controllable === false
            ? 'warning'
            : s.frame
              ? 'ready'
              : 'discovered';
      b.dataset.state = status;
      b.dataset.device = t.id;
      b.setAttribute('aria-current', String(t.id === selected));
      b.title = t.id;
      const connection = t.platform === 'android' && t.connection === 'unknown' ? '' : t.connection;
      const wrap = element('span');
      wrap.append(
        element('strong', label(t)),
        element(
          'small',
          (t.connection === 'emulator'
            ? t.id.slice('android:'.length)
            : [
                t.platform === 'harmony' ? '鸿蒙' : nice(t.platform),
                connection === 'network' ? '网络' : (connection || '').toUpperCase(),
              ]
                .filter(Boolean)
                .join(' · ')) +
            ' · ' +
            {
              running: '运行中',
              offline: t.state === 'unauthorized' ? '待授权' : t.state === 'offline' ? '离线' : '不可用',
              warning: '诊断失败',
              ready: '可控制',
              discovered: '已发现',
            }[status],
        ),
      );
      b.append(element('span', undefined, 'device-symbol'), wrap, element('i'));
      b.onclick = () => selectDevice(t);
      return b;
    }),
  );
}
function updateAndroidSetupButton() {
  const button = $('prepare-android');
  button.hidden = !androidSetup?.supported || (!androidSetup.missing.length && !androidPreparing);
  button.disabled = androidPreparing;
  button.textContent = androidPreparing ? '正在准备 Android 环境…' : '准备 Android 环境';
}
function scan() {
  scanPending ??= scanDevices().finally(() => {
    scanPending = undefined;
    $('scan').disabled = androidPreparing;
  });
  return scanPending;
}
async function scanDevices() {
  $('scan').disabled = true;
  try {
    const r = await api.devices();
    const previous = devices.find((t) => t.id === selected);
    devices = r.devices;
    scanErrors = r.scanErrors ?? {};
    androidSetup = r.androidSetup;
    if (selected && !devices.some((t) => t.id === selected) && !state().active) selected = '';
    const androidDevices = devices.filter((t) => t.platform === 'android');
    if (!androidPreparing) {
      if (androidSetup?.supported && androidSetup.missing.length) {
        $('scan-status').textContent = '电脑缺少 Android 调试组件。请点「准备 Android 环境」并按提示完成。';
      } else if (
        r.unavailable.includes('android') && (previous ? previous.platform === 'android' : !devices.length)
      ) {
        $('scan-status').textContent = '暂时无法扫描 Android 手机。请点「重新扫描」。';
      } else if (
        previous?.platform === 'android' &&
        previous.connection !== 'emulator' &&
        !androidDevices.some((t) => t.id === previous.id)
      ) {
        $('scan-status').textContent =
          '找不到刚才连接的手机。' +
          (previous.connection === 'usb' ? '请重新插拔数据线' : '请检查手机连接') +
          '，再点「重新扫描」。';
      } else if (androidDevices.some((t) => t.state === 'unauthorized')) {
        $('scan-status').textContent = '请解锁 Android 手机，并在手机上允许 USB 调试。';
      } else if (androidDevices.some((t) => t.state === 'offline')) {
        $('scan-status').textContent = 'Android 设备已离线。请重新连接后点「重新扫描」。';
      } else {
        $('scan-status').textContent = devices.length ? '' : '尚未发现设备。请连接手机后重新扫描。';
      }
    }
    updateAndroidSetupButton();
    render();
    const online = devices.filter((t) => t.available);
    if (!selected && online.length === 1 &&
        (online[0].platform !== 'android' || !androidSetup?.missing.length))
      await selectDevice(online[0]);
  } catch {
    if (!androidPreparing) $('scan-status').textContent = '暂时无法扫描设备。请点「重新扫描」。';
  }
}
async function rescanAndroid() {
  clearTimeout(androidScanTimer);
  const deadline = Date.now() + 60000;
  const check = async () => {
    if (androidPreparing) return;
    const previous = selected;
    await scanPending;
    await scan();
    if (devices.some((t) => t.platform === 'android' && t.available)) {
      if (previous && previous === selected && selected.startsWith('android:') && !state().frame)
        await refresh();
    } else if (Date.now() < deadline && androidSetup?.missing.length === 0) {
      androidScanTimer = setTimeout(check, 1500);
    }
  };
  await check();
}
async function prepareAndroid() {
  if (androidPreparing) return;
  androidPreparing = true;
  clearTimeout(androidScanTimer);
  updateAndroidSetupButton();
  $('scan').disabled = true;
  $('scan-status').textContent = '正在检查已安装的 Android 工具…';
  try {
    await api.platformSetup('android');
  } catch (e) {
    const detail = describe(e.message);
    $('scan-status').textContent = detail;
    feedback('settings-status', detail, 'error');
    return;
  } finally {
    androidPreparing = false;
    updateAndroidSetupButton();
    $('scan').disabled = !!scanPending;
  }
  await rescanAndroid();
  feedback('settings-status', 'Android 环境已就绪。', 'info');
  if ($('dialog').open && !$('model-content').hidden) await showPlatformTools();
}
function markFrame(id, frame) {
  const s = state(id);
  s.frame = frame;
  if (frame?.observationId) s.diagnostic = { controllable: true };
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
  const chats = refreshLibrary(t.id, s.chat?.id);
  const history = api
    .history(t.id, true)
    .then((data) => {
      s.history = data.history;
      if (data.current?.status === 'running') {
        s.active = data.current;
        if (s.active.mode === 'chat' && s.chat?.id !== s.active.chatId)
          refreshLibrary(t.id, s.active.chatId);
      }
      if (!s.current) s.current = s.active?.mode === 'script' ? s.active : s.history[0];
      if (selected === t.id) render();
    })
    .catch((e) => message(t.id, e.message));
  if (!s.busy && !s.active && t.available) await refresh(t.id);
  await Promise.all([history, chats]);
}
function message(id, value, tone = 'error') {
  state(id).notice = value || '';
  state(id).noticeTone = tone;
  if (id === selected) renderNotice();
}
function feedback(id, text, tone) {
  const node = $(id);
  node.dataset.tone = tone;
  node.textContent = text;
}
function renderNotice() {
  const note = selected ? state().notice : '';
  $('notice').hidden = !note;
  feedback('notice', note, state().noticeTone || 'info');
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
    s.frame?.observationId
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
  $('chat-stop').hidden = !s.active;
  $('stop').hidden = !s.active || s.active.mode === 'chat';
  $('start').disabled = !free || s.loadingChat || !s.draft.trim();
  $('open-recording').disabled = s.loadingChat || !!s.active;
  $('new-chat').disabled = !selected || !free || s.loadingChat;
  $('chats').disabled = !selected || !free || s.loadingChat;
  $('prompt').disabled = !t?.available;
  $('manual-record').disabled = !free;
  if (workspaceMode === 'script') {
    $('script-target').textContent = t?.available
      ? '运行设备 · ' + label(t)
      : '选择设备后可运行兼容的脚本。';
    for (const button of $('script-list').querySelectorAll('[data-platforms]')) {
      const compatible = !!t && button.dataset.platforms.split(',').includes(t.platform);
      button.disabled = !free || !compatible;
      button.title = t && !compatible ? '请选择与脚本兼容的设备' : '';
    }
  }
  $('stop').disabled = !s.active || s.stopping;
  $('chat-stop').disabled = !s.active || s.stopping;
  $('chat-stop').textContent = s.stopping
    ? '正在停止…'
    : s.active?.mode === 'script'
      ? '停止脚本'
      : '停止';
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
    markFrame(id, result.frame);
    if (result.unconfirmed.length)
      message(
        id,
        '本机有 ' + result.unconfirmed.length + ' 条未决操作，请对照当前画面和连接诊断核实。',
        'warning',
      );
    else if (result.frame.controlsChangedDuringCapture)
      message(id, '画面有动态内容，操作前会重新核对目标。', 'info');
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
    ? '任务运行中，显示最近一次采集的手机画面。'
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
      // Prefer a stable control selector for recorded manual taps.
      const chatId = s.recordManual && workspaceMode === 'chat' && s.chat?.recordingId && s.chat.id;
      if (raw.action === 'tap' && chatId && s.hit !== null) {
        const loc = selector(s.frame.controls[s.hit]);
        const hits = s.frame.controls.filter(
          (n) => n.role === loc.role && (loc.id ? n.id === loc.id : n.labels.includes(loc.label)),
        );
        if (hits.length === 1) raw = { action: 'tap', ...loc };
      }
      r = await api.action(id, raw, observation, chatId || undefined);
      if (chatId) {
        await refreshLibrary(id, chatId);
        if (workspaceMode === 'script') await refreshScripts();
      }
    } catch (e) {
      if (
        [
          'STALE_OBSERVATION',
          'INPUT_TARGET_CHANGED',
          'INPUT_FOCUS_UNCONFIRMED',
          'INPUT_NOT_VERIFIED',
          'ACTION_OUTCOME_UNKNOWN',
        ].includes(e.message)
      )
        markFrame(id, null);
      throw e;
    }
    if (raw.action === 'input' && selected === id) $('text').value = '';
    markFrame(id, r.frame || null);
    message(
      id,
      r.captureError
        ? '操作已执行，刷新画面失败。' + describe(r.captureError)
        : nice(raw.action) + '已执行。',
      r.captureError ? 'warning' : 'success',
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
      message(selected, '请先选择当前页面的返回或取消按钮。', 'warning');
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
async function refreshLibrary(id, requested) {
  const s = state(id),
    version = ++s.libraryVersion;
  s.loadingChat = true;
  if (id === selected) renderButtons();
  try {
    const chats = await api.library(id);
    const chat =
      requested && chats.some((c) => c.id === requested) ? await api.conversation(id, requested) : null;
    if (version !== s.libraryVersion) return;
    s.chats = chats;
    s.chat = chat;
    if (chat?.turns.some((turn) => s.lastChatRun && turn.runId === s.lastChatRun.id))
      s.lastChatRun = null;
    if (id === selected) {
      drawChat();
      renderButtons();
    }
  } catch (e) {
    message(id, describe(e.message));
  } finally {
    if (version === s.libraryVersion) {
      s.loadingChat = false;
      if (id === selected) renderButtons();
    }
  }
}
function drawChat() {
  const s = state();
  const chat = s.chat;
  $('chats').replaceChildren(
    new Option('新对话', ''),
    ...s.chats.map((c) => new Option(c.title + ' · ' + c.stepCount + ' 步', c.id)),
  );
  $('chats').value = chat?.id || '';
  if ($('prompt').value !== s.draft) $('prompt').value = s.draft;
  const run = s.active?.mode === 'chat' ? s.active : s.lastChatRun;
  const turns = [...(chat?.turns || [])];
  if (run && (!chat || chat.id === run.chatId)) {
    const overlay = {
      runId: run.id,
      user: run.user || run.title,
      events: run.events,
      started: run.started,
      ended: run.ended,
      activity: run.activity,
      status: run.status,
      reason: run.reason,
      assistant: run.result?.answer,
      replyRequested: run.result?.replyRequested,
      historyError: run.historyError || run.cleanupError,
    };
    const index = turns.findIndex((t) => t.runId === run.id);
    if (index < 0) turns.push(overlay);
    else turns[index] = { ...turns[index], ...overlay };
  }
  const stream = $('chat-stream'),
    transcript = $('transcript');
  const chatKey = selected + '/' + (chat?.id || run?.chatId || '');
  const changed = stream.dataset.chat !== chatKey;
  const follow = changed || stream.scrollHeight - stream.clientHeight - stream.scrollTop < 40;
  if (changed) transcript.replaceChildren();
  stream.dataset.chat = chatKey;
  for (const [i, saved] of turns.entries()) {
    const turn =
      saved.status === 'running' && (!s.active || saved.runId !== s.active.id)
        ? { ...saved, status: 'interrupted' }
        : saved;
    const key = turn.runId || String(i);
    let row = transcript.children[i];
    if (!row || row.dataset.key !== key) {
      const newRow = element('article', undefined, 'chat-turn');
      newRow.dataset.key = key;
      if (row) row.replaceWith(newRow);
      else transcript.append(newRow);
      row = newRow;
    }
    updateTurn(row, turn, i < turns.length - 1);
  }
  while (transcript.children.length > turns.length) transcript.lastChild.remove();
  $('chat-empty').hidden = !!turns.length;
  const last = turns.at(-1);
  $('prompt').placeholder = s.active
    ? '可以先写下下一条消息…'
    : last?.replyRequested
      ? '回复这个问题…'
      : last
        ? '继续对话…'
        : '输入任务或补充说明…';
  $('chat-empty-hint').textContent = selected
    ? '在下方描述任务，或打开一段历史对话。'
    : '选择设备后，在下方输入任务。';
  if (follow) stream.scrollTop = stream.scrollHeight;
  $('open-recording').hidden = !chat?.recordingId || !chat.stepCount;
  $('open-recording').textContent = chat?.recordingHidden
    ? '恢复到脚本库'
    : '查看录制 · ' + (chat?.stepCount || 0) + ' 步';
  $('manual-record-label').hidden = !chat?.recordingId || workspaceMode !== 'chat';
  $('manual-record').checked = !!s.recordManual;
}
$('chats').onchange = () => {
  const s = state();
  s.draft = '';
  s.lastChatRun = null;
  s.recordManual = false;
  refreshLibrary(selected, $('chats').value);
};
$('new-chat').onclick = () => {
  const s = state();
  s.libraryVersion++;
  s.chat = null;
  s.lastChatRun = null;
  s.draft = '';
  s.recordManual = false;
  drawChat();
  renderButtons();
  $('prompt').focus();
};
$('manual-record').onchange = () => {
  state().recordManual = $('manual-record').checked;
};
$('prompt').oninput = () => {
  state().draft = $('prompt').value;
  renderButtons();
};
$('prompt').onkeydown = (e) => {
  if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.keyCode === 229) return;
  if (!$('start').disabled && !$('start').hidden) {
    e.preventDefault();
    $('start').click();
  }
};
function composer() {
  if (workspaceMode === 'chat') drawChat();
  $('model-line').textContent = model?.model || 'deepseek-flash';
  $('model-line').title = model?.endpoint || '';
}
function switchMode(value) {
  workspaceMode = value;
  const chatting = value === 'chat';
  $('workspace-title').textContent = chatting ? '对话' : '脚本库';
  $('chat-panel').hidden = !chatting;
  $('script-panel').hidden = chatting;
  $('script-journal').hidden = chatting;
  $('new-chat').hidden = !chatting;
  $('import-script').hidden = chatting;
  $(chatting ? 'chat-mode' : 'script-mode').setAttribute('aria-current', 'page');
  $(chatting ? 'script-mode' : 'chat-mode').removeAttribute('aria-current');
  $('manual-record-label').hidden = !chatting || !state().chat?.recordingId;
  render();
}
$('chat-mode').onclick = () => switchMode('chat');
$('script-mode').onclick = () => {
  switchMode('script');
  refreshScripts();
};

function drawScripts() {
  const query = $('script-search').value.trim().toLocaleLowerCase();
  const rows = scripts
    .filter((entry) => entry.title.toLocaleLowerCase().includes(query))
    .map((entry) => {
      const row = element('article', undefined, 'script-row');
      row.dataset.id = entry.id;
      row.tabIndex = -1;
      const body = element('div', undefined, 'script-info');
      const platformText =
        entry.platforms.length === 3 ? '全平台' : entry.platforms.map(nice).join(' / ');
      const source = { builtin: '内置', import: '导入', record: '对话录制' }[entry.source];
      const meta = [source, platformText, entry.stepCount + ' 步'];
      if (entry.partial) meta.push('部分录制');
      body.append(element('h3', entry.title), element('p', meta.join(' · '), 'muted'));
      const run = element('button', '运行', 'outline run-script');
      run.dataset.platforms = entry.platforms.join(',');
      run.setAttribute('aria-label', '运行 ' + entry.title);
      run.onclick = () => {
        const id = selected;
        if (!id) return;
        busy(id, async () => {
          await api.start(id, 'script', entry.id);
          if (id === selected) setJournal(true);
        });
      };
      const manage = element('button', '管理', 'outline');
      manage.setAttribute('aria-label', '管理 ' + entry.title);
      manage.onclick = () => {
        managedScript = entry;
        $('script-name').value = entry.title;
        $('script-name').readOnly = entry.source === 'builtin';
        $('save-name').hidden = $('remove-script').hidden = entry.source === 'builtin';
        $('remove-confirm').hidden = true;
        $('manage-feedback').textContent = '';
        $('script-dialog').showModal();
      };
      const icon = element('span', undefined, 'script-glyph');
      icon.setAttribute('aria-hidden', 'true');
      row.append(icon, body, run, manage);
      return row;
    });
  $('script-list').replaceChildren(
    ...(rows.length ? rows : [element('p', '没有找到匹配的脚本。', 'muted')]),
  );
  renderButtons();
}
async function refreshScripts(focusId) {
  const version = ++scriptsVersion;
  try {
    const rows = await api.scripts();
    if (version !== scriptsVersion) return;
    scripts = rows;
    drawScripts();
    if (focusId && workspaceMode === 'script')
      Array.from($('script-list').children)
        .find((r) => r.dataset.id === focusId)
        ?.focus();
  } catch (e) {
    feedback('script-feedback', describe(e.message), 'error');
  }
}
$('script-search').oninput = drawScripts;
$('import-script').onclick = () => $('script-file').click();
$('script-file').onchange = async () => {
  const file = $('script-file').files[0];
  $('script-file').value = '';
  if (!file) return;
  $('import-script').disabled = true;
  try {
    if (file.size > 8 * 1024 * 1024) throw Error('INVALID_FILE');
    const name = file.name.replace(/\.json$/i, '').slice(0, 100) || '导入脚本';
    const id = await api.importScript(name, await file.text());
    $('script-search').value = '';
    feedback('script-feedback', '已导入「' + name + '」。', 'success');
    await refreshScripts(id);
  } catch (e) {
    feedback('script-feedback', describe(e.message), 'error');
  } finally {
    $('import-script').disabled = false;
  }
};
$('open-recording').onclick = async () => {
  const chat = state().chat;
  if (!chat?.recordingId) return;
  try {
    if (chat.recordingHidden) {
      await api.restoreRecording(chat.recordingId);
      chat.recordingHidden = false;
    }
    $('script-search').value = '';
    switchMode('script');
    await refreshScripts(chat.recordingId);
  } catch (e) {
    message(selected, describe(e.message));
  }
};
async function manageScript(action) {
  const entry = managedScript;
  if (!entry || $('script-dialog').dataset.busy) return;
  $('script-dialog').dataset.busy = 'true';
  try {
    if (action === 'rename') await api.renameScript(entry.id, $('script-name').value);
    if (action === 'remove') {
      await api.removeScript(entry.id);
      for (const s of states.values())
        if (s.chat?.recordingId === entry.id) s.chat.recordingHidden = true;
    }
    if (action === 'export' && !(await api.exportScript(entry.id))) return;
    $('script-dialog').close();
    feedback(
      'script-feedback',
      {
        rename: '脚本名称已保存。',
        remove: '已从脚本库移除。',
        export: '脚本已导出。',
      }[action],
      'success',
    );
    await refreshScripts(action === 'remove' ? undefined : entry.id);
  } catch (e) {
    feedback('manage-feedback', describe(e.message), 'error');
  } finally {
    delete $('script-dialog').dataset.busy;
  }
}
$('save-name').onclick = () => manageScript('rename');
$('export-script').onclick = () => manageScript('export');
$('remove-script').onclick = () => {
  $('remove-question').textContent =
    '从脚本库移除「' +
    managedScript.title +
    '」？' +
    (managedScript.source === 'record' ? '原对话仍可查看，也可从对话中恢复录制。' : '');
  $('remove-confirm').hidden = false;
  $('cancel-remove').focus();
};
$('cancel-remove').onclick = () => {
  $('remove-confirm').hidden = true;
};
$('confirm-remove').onclick = () => manageScript('remove');
function setJournal(expanded) {
  $('journal-content').hidden = !expanded;
  $('journal-toggle').setAttribute('aria-expanded', String(expanded));
}
$('journal-toggle').onclick = () => setJournal($('journal-content').hidden);
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
  if (s.active && s.active.mode !== 'chat') options.unshift(s.active);
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
  const id = selected;
  if (!id || !state().draft.trim()) return;
  if (model?.needsKey) {
    showModel();
    return;
  }
  await busy(id, async (s) => {
    const submitted = s.draft;
    await api.start(id, 'chat', { message: submitted.trim(), chatId: s.chat?.id });
    if (s.draft === submitted) s.draft = '';
  });
};
$('stop').onclick = $('chat-stop').onclick = async () => {
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
  if (event.type === 'setup') {
    $('scan-status').textContent = event.message;
    feedback('settings-status', event.message, 'info');
    return;
  }
  const s = state(event.device);
  if (event.type === 'run') {
    const r = event.record;
    s.active = r.status === 'running' ? r : null;
    if (r.mode !== 'chat') s.current = r;
    if (!s.active) {
      if (r.mode !== 'chat') displayRun(s, r);
      else s.lastChatRun = r;
      if (r.mode === 'chat') {
        refreshLibrary(event.device, r.chatId);
        if (workspaceMode === 'script') refreshScripts();
      }
      s.stopping = false;
      if (r.reason === 'ACTION_OUTCOME_UNKNOWN') message(event.device, describe(r.reason), 'warning');
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
function showPlatformTools() {
  return api
    .environment()
    .then((env) => {
      $('teams').replaceChildren(...env.teams.map((t) => new Option(t, t)));
      $('platforms').replaceChildren(
        ...(model.macHost ? ['ios', 'android', 'harmony'] : ['android', 'harmony']).map((k) => {
          const row = element('p', nice(k) + (env[k] ? ' · 已找到工具链' : ' · 缺少平台工具'));
          if (scanErrors[k]) row.append(' · 上次扫描失败 · ' + scanErrors[k]);
          if (k === 'android' && env.androidSetup.supported) {
            if (!env.android) {
              const setup = element('button', '准备环境', 'text-button');
              setup.onclick = prepareAndroid;
              row.append(setup);
            }
            const choose = element('button', '选择已安装的 SDK…', 'text-button');
            choose.onclick = async () => {
              if (androidPreparing) return;
              choose.disabled = true;
              try {
                if (await api.chooseAndroidSdk()) {
                  await rescanAndroid();
                  await showPlatformTools();
                }
              } catch (e) {
                feedback('settings-status', describe(e.message), 'error');
              } finally {
                choose.disabled = false;
              }
            };
            row.append(choose);
          } else if (!env[k]) {
            const link = element('button', '获取平台工具', 'text-button');
            link.onclick = async () => {
              link.disabled = true;
              try {
                await api.platformSetup(k);
              } catch (e) {
                feedback('settings-status', describe(e.message), 'error');
              } finally {
                link.disabled = false;
              }
            };
            row.append(link);
          }
          return row;
        }),
      );
    })
    .catch((e) => {
      feedback('settings-status', describe(e.message), 'error');
    });
}
function showModel() {
  if (!model) return;
  dialog('工作台设置', true);
  $('endpoint').value = model.endpoint;
  $('model-id').value = model.model;
  $('use-images').checked = model.useImages === true;
  $('team').value = model.team;
  $('wda-bundle').value = model.bundle;
  $('settings-status').textContent = '';
  $('key').placeholder = model.hasKey ? '已配置，留空沿用当前端点的密钥' : '输入此端点的密钥';
  showPlatformTools();
  $('key').value = '';
  $('key').focus();
}
$('model-settings').onclick = showModel;
$('save-key').onclick = async () => {
  try {
    $('save-key').disabled = true;
    model = await api.saveSettings({
      endpoint: $('endpoint').value,
      model: $('model-id').value,
      useImages: $('use-images').checked,
      key: $('key').value,
      team: $('team').value.trim(),
      bundle: $('wda-bundle').value.trim(),
    });
    $('key').value = '';
    $('dialog').close();
    composer();
  } catch (e) {
    feedback('settings-status', describe(e.message), 'error');
  } finally {
    $('save-key').disabled = false;
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
$('emulator').onclick = async () => {
  $('emulator').disabled = true;
  $('emulator').textContent = '正在准备 Android 模拟器…';
  try {
    await api.startEmulator();
    await scan();
  } catch (e) {
    $('scan-status').textContent = describe(e.message);
  } finally {
    $('emulator').disabled = false;
    $('emulator').textContent = '启动 Android 模拟器';
  }
};
$('scan').onclick = scan;
$('prepare-android').onclick = prepareAndroid;
$('refresh').onclick = () => refresh();
render();
api.config().then((v) => {
  model = v;
  $('emulator').hidden = !model.macHost;
  composer();
});
scan();
