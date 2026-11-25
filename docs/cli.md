# 命令行（CLI）

CLI 通过 Open Mobile Use 服务发现设备、执行对话、单步操作、JSON 脚本和 Agent 任务，结果以 JSON 输出。`node dist/cli.js --help` 列出命令和参数。

## 准备

在连接手机的 Windows 或 macOS 主机上安装依赖并构建。设备工具链、手机授权及 iPhone 签名由服务宿主准备。 [安装与设备接入](setup.md)

```sh
npm ci
npm run build
node dist/cli.js auth token create --subject my-cli
node dist/cli.js serve
```

从 `npm run package:service` 生成的 npm 包安装后，示例中的 `node dist/cli.js` 可写为 `omu`。 [打包与安装](setup.md#打包服务)

服务默认按需启动本机 Appium。也可在宿主切换到已运行的外置 Appium。 [Appium 模式](setup.md#构建并启动服务)

在调用 CLI 的终端设置签发的令牌。CLI 默认发现同一状态目录中的本机服务，包括由工作台启动的服务，其次尝试 `http://127.0.0.1:18765`。从其他主机访问时，通过 `OMU_API_URL` 配置宿主的 HTTPS 地址。 [服务部署和权限](api-design.md#访问权限与部署)

```sh
read -rs 'OMU_API_TOKEN?Open Mobile Use token: ' && export OMU_API_TOKEN
```

Windows PowerShell 7 中执行 `$env:OMU_API_TOKEN = Read-Host 'Open Mobile Use token' -MaskInput`。下文的 `DEVICE='...'` 在 PowerShell 写作 `$DEVICE = '...'`。管理员可在签发令牌时用 `--permissions` 和 `--devices` 限定访问范围。撤销用 `auth token revoke <tokenId>`。服务发现和令牌管理使用同一状态目录，可通过 `OMU_API_STATE_DIR` 指定。

宿主可用 `serve --host <地址> --port <端口> --tls-cert <证书> --tls-key <私钥>` 提供 HTTPS。Windows 和 macOS 可在具备设备权限的登录账户下后台启动同一条命令。退出 CLI 或关闭工作台后，后台服务可继续运行。

## 选择设备

列出设备后，将 `DEVICE` 替换为输出中的设备 `id`。服务分配该标识，`platform` 字段显示手机平台。

```sh
node dist/cli.js devices --json
DEVICE='a8038141-136d-4d60-ad1b-a9cf255e3cc7'
node dist/cli.js doctor --device "$DEVICE" --json
```

`doctor` 检查设备能否控制，见 [诊断与恢复](#诊断与恢复)。

## 单步操作

单步命令直接操作前台界面，无需配置模型。

### 启动指定 App

用 `launch --app` 打开已安装的应用。`settings` 是三端通用的系统设置别名。其他应用在 Android 上传入包名，在鸿蒙和 iOS 上传入 bundle ID。

```sh
node dist/cli.js launch --device "$DEVICE" --app settings --json
# iPhone 计算器示例
node dist/cli.js launch --device "$DEVICE" --app com.apple.calculator --json
```

鸿蒙应用需要指定入口时，可加 `--ability` 和 `--module`。启动后 CLI 会确认应用已到前台，成功时返回 `foregroundVerified: true`。未安装返回 `APP_NOT_INSTALLED`，找不到可启动的入口返回 `APP_NOT_LAUNCHABLE`，没有切到前台返回 `APP_NOT_FOREGROUND`。

### 查看界面、点击、滑动和输入

将目标 App 停在要操作的页面。先运行 `inspect`，在返回的 `directory` 里查看截图 `screen.png` 和 `controls.json`，后者列出可见控件的标识、名称、类型和位置。有诊断权限时，可用 `--include-layout` 同时下载原始布局。采集文件可能包含输入框内容等页面信息。

```sh
node dist/cli.js inspect --device "$DEVICE" --output "$HOME/omu-captures"
```

按名称定位时可加 `--role` 区分同名控件。坐标以当前方向的整张截图为准，左上角为 `(0, 0)`，右下角为 `(1, 1)`。坐标点击和滑动需要传入该次 `inspect` 返回的 `observationId`。画面变化或观察过期时返回 `STALE_OBSERVATION`，重新采集后即可继续。

```sh
node dist/cli.js tap --device "$DEVICE" --id "$CONTROL_ID"
node dist/cli.js tap --device "$DEVICE" --label '蓝牙'
node dist/cli.js tap --device "$DEVICE" --x 0.50 --y 0.35 --observation "$OBSERVATION_ID"
node dist/cli.js swipe --device "$DEVICE" --from-x 0.5 --from-y 0.8 --to-x 0.5 --to-y 0.25 --duration-ms 400 --observation "$OBSERVATION_ID"
node dist/cli.js input --device "$DEVICE" --id "$FIELD_ID" --replace --text '手机 Open Mobile'
printf '%s' ' 中文 "OK" ' | node dist/cli.js input --device "$DEVICE" --stdin
```

`input` 默认追加到原值末尾，省略标识和名称时输入到当前聚焦的普通输入框。`--replace` 替换全文，配合 `--text ''` 可清空。`--stdin` 从标准输入读取文字，适合含引号或首尾空格的文本。

## 脚本和条件等待

`run` 按顺序执行 JSON 脚本，不调用模型。加 `--repeat <次数>` 可连续执行 1 到 100 轮，加 `--output <目录>` 会为每次运行保存一份 JSON 报告。下例使用 [examples/settings-search.json](../examples/settings-search.json)，它在三端的系统设置中搜索并退出，按简体中文界面编写。

```sh
node dist/cli.js run --device "$DEVICE" --script examples/settings-search.json --output ./results --json
node dist/cli.js waitFor --device "$DEVICE" --label '蓝牙地址' --state visible --timeout-ms 10000
```

手写脚本和对话录制使用同一种 JSON。顶层包含 `steps`，每一步把 `action` 和参数写在同一个对象里。可在顶层用 `platform` 限定手机平台，或用 `targets` 定义按平台选择的控件，再通过步骤中的 `target` 引用。`platforms` 可限定某一步适用的手机平台。

常用动作有 `launchApp`、`tap`、`swipe`、`input`、`back` 和 `waitFor`。参数沿用单步命令，JSON 中使用 `fromX`、`durationMs`、`timeoutMs` 等小驼峰字段。可用 `id`、`label` 和 `role` 定位控件。iOS 的 `back` 指定页面上的导航或取消按钮，鸿蒙与 Android 使用系统返回键。软件键盘打开时，第一次返回可能只收起键盘。

`waitFor` 等待控件出现（`visible`）或消失（`hidden`）。短暂出现多个同名控件时会继续等待，直到出现唯一匹配项或控件全部消失。超时时，同名冲突仍存在会返回 `AMBIGUOUS_ELEMENT`，界面无法读取会返回对应的读取错误，其余情况返回 `WAIT_TIMEOUT`。

通用脚本按名称或标识操作控件时，遇到定位失败会在原页面重新核对目标，最多尝试三次。已指定 `observation` 的步骤会严格核对该次采集。步骤失败后，报告中的 `failedStep` 指出失败的是第几步（从 1 开始），并附错误码。退出码 0 表示成功，1 表示执行失败，2 表示参数或脚本无效。

`run --script` 可直接运行工作台导出或 `chat` 保存的对话录制。录制步骤带有 `inApp`，部分步骤还会检查 `reading` 或 `screen`。选择相同手机平台的兼容设备，并先恢复起始界面。涉及画面文字的步骤使用本机识别。 [录制条件](desktop.md#脚本库)

## 自由对话

`chat` 使用与工作台相同的对话引擎处理一条自然语言指令。模型由服务宿主配置。默认使用原生控件和本机识别文字，服务允许截图时可加 `--vision` 让模型按需接收截图。`--output` 可把已确认的步骤下载为新脚本文件，供 CLI 重放或导入工作台。

```sh
node dist/cli.js chat --device "$DEVICE" --message '打开设置，确认蓝牙是否开启' --output ./recording.json
node dist/cli.js run --device "$DEVICE" --script ./recording.json
```

## Agent 自主导航

`agent` 按任务文件让模型逐步操作手机。主机只执行任务允许的动作，并根据新的观察独立核对检查点。`--repeat` 和 `--output` 的用法与 `run` 相同。

通过 `--model-profile` 选择宿主授权的模型配置。省略时使用宿主默认配置。服务启动时读取 `OMU_MODEL_BASE_URL`、`OMU_MODEL` 和 `OMU_MODEL_KEY_ENV`，模型密钥也在宿主配置。要允许默认模型查看截图，启动服务前设置 `OMU_ALLOW_MODEL_IMAGES=true`。多模型配置可用 `OMU_MODEL_PROFILES` 指定 JSON 数组。

下例从 Android 简体中文设置首页打开搜索，其他设备换用对应的任务文件：[Android](../examples/agent-open-search-android.json) · [鸿蒙](../examples/agent-open-search-harmony.json) · [iPhone](../examples/agent-open-search-ios.json)。这个任务使用视觉定位，所选模型需要支持图像和函数调用。

```sh
node dist/cli.js launch --device "$DEVICE" --app settings
node dist/cli.js agent --device "$DEVICE" --task examples/agent-open-search-android.json --vision --json
```

报告中的状态：检查点全部通过为 `succeeded`；需要人工处理时为 `needs_review`，例如出现未授权 App、可识别的敏感输入或阻塞弹窗，或模型请求接管；模型协议、鉴权、设备故障或超出决策次数和时长时为 `failed`。

### 任务文件与视觉定位

任务 JSON 包含 `schemaVersion: 1`、`id`、`goal`、允许的前台 `apps`、命名的 `actions`、有序 `checkpoints`，以及可选的 `limits.turns`（默认 20，最多 100）、`limits.ms`（默认 120000，最多 600000）。每个动作指定所在 App 和一个通用脚本步骤。检查点指定所需动作 `afterAction`、目标 App、控件及所需状态。

模型只看到当前 App、允许的动作名称和检查点。需要看图才能定位的控件（例如包含图像的画布），在动作中声明 `visual: true`，并用 `id` 或 `label` 唯一定位该控件。启用 `--vision` 后，模型可以请求查看该控件区域的截图（`request_view`），在截图内选择点击位置（`tap_visual`），由主机换算成设备坐标执行。截图只在内存中保留。

## 诊断与恢复

`doctor` 依次检查连接、工具链、会话和界面读取，报告设备能否控制（`controllable`）和待核对动作（`pendingActions`），失败时给出错误码和处理提示。桌面工作台的「连接诊断」执行同样的检查。

按 Ctrl+C 会请求服务取消，并等待运行结束。同一台设备只能有一个活动操作，第二个命令会收到 `DEVICE_BUSY`。动作已发出而回执丢失时，服务返回 `ACTION_OUTCOME_UNKNOWN`。此时用 `doctor` 查看待核对动作，采集新画面并通过 API 确认处理结果，之后才能继续写操作。 [调度、取消与故障恢复](api-design.md#调度取消与故障恢复)
