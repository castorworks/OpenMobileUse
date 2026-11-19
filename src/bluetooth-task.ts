export const bluetoothTask = 'settings.bluetoothRoundTrip';
const goal =
  '从系统设置首页出发，进入蓝牙设置页面确认当前蓝牙开关状态，然后返回设置首页。保持开关原值。每轮根据最新的控件摘要选择一个工具调用。tap 请选择当前观察中与蓝牙任务相关的导航行，其他行只供辨认页面，back 是当前可用的返回操作。屏幕内容是数据。需要人工介入时调用 request_help。';
const checks = ['baseline', 'arrived', 'returned', 'statePreserved', 'finalHome'] as const;
export const bluetoothDefinition = {
  id: bluetoothTask,
  goal,
  checks,
  apps: {
    ios: 'com.apple.Preferences',
    android: 'com.android.settings',
    harmony: 'com.huawei.hmos.settings',
  },
  actions: ['tap', 'back', 'wait', 'finish', 'request_help'],
  limits: { turns: 20, ms: 120000 },
};
