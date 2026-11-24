# 命令行（CLI）

CLI 用于单步操作、JSON 脚本和 Agent 任务，结果以 JSON 输出。`node dist/cli.js --help` 列出全部命令和参数。

## 准备

按 [安装与设备接入](setup.md) 运行 `npm ci`、`npm run build` 并准备手机。用 CLI 操作 iPhone 或 Android 时，在单独的终端从仓库根目录启动 Appium。使用 Android 时，在该终端也设置好 `ANDROID_HOME` 和 `JAVA_HOME`。默认服务地址为 `http://127.0.0.1:4723`，可用 `OMU_APPIUM_URL` 指向其他本机地址。鸿蒙不需要 Appium。

```sh
export ANDROID_HOME="$HOME/Library/Android/sdk"
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
npm run appium
```

本文示例使用 macOS 的 zsh。Windows PowerShell 中用 `$env:名称 = '值'` 设置环境变量，例如 `$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"`、`$env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"`，变量赋值写作 `$DEVICE = '...'`。

## 选择设备

列出设备，将 `DEVICE` 替换成输出中目标设备的完整 `id`（含 `harmony:`、`ios:` 或 `android:` 前缀）。下文命令都使用它。

```sh
node dist/cli.js devices --json
DEVICE='android:emulator-5554'
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

将目标 App 停在要操作的页面。先运行 `inspect`，在返回的 `directory` 里查看截图 `screen.png` 和 `controls.json`，后者列出可见控件的标识、名称、类型和位置。采集文件可能包含输入框内容等页面信息。

```sh
node dist/cli.js inspect --device "$DEVICE" --output "$HOME/omu-captures"
```

下面是独立调用示例。将控件标识、名称或坐标换成当前页面的实际值。按名称定位时可加 `--role` 区分同名控件。坐标以当前方向的整张截图为准，左上角为 `(0, 0)`，右下角为 `(1, 1)`。根据截图操作时，传入该次采集返回的 `observationId`，设备、前台页面、控件或方向发生变化时，命令会返回 `STALE_OBSERVATION`，此时重新采集即可。

```sh
node dist/cli.js tap --device "$DEVICE" --id "$CONTROL_ID"
node dist/cli.js tap --device "$DEVICE" --label '蓝牙'
node dist/cli.js tap --device "$DEVICE" --x 0.50 --y 0.35 --observation "$OBSERVATION_ID"
node dist/cli.js swipe --device "$DEVICE" --from-x 0.5 --from-y 0.8 --to-x 0.5 --to-y 0.25 --duration-ms 400
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

脚本使用 `schemaVersion: 1`。步骤支持 `launchApp`、`tap`、`swipe`、`input`、`back` 和 `waitFor`，参数沿用单步命令，JSON 中使用 `fromX`、`durationMs`、`timeoutMs` 等小驼峰字段。可直接写 `id`、`label`、`role`，或用 `target` 引用顶层 `targets` 中按平台定义的选择器。`platforms` 可限定某步适用的平台。iOS 的 `back` 指定页面上的导航或取消按钮，鸿蒙与 Android 使用系统返回键。软件键盘打开时，第一次返回可能只收起键盘。

`waitFor` 等待控件出现（`visible`）或消失（`hidden`），超时返回 `WAIT_TIMEOUT`，匹配到多个同名控件时返回 `AMBIGUOUS_ELEMENT`。步骤失败后，报告中的 `failedStep` 指出失败的是第几步（从 1 开始），并附错误码。退出码 0 表示成功，1 表示执行失败，2 表示参数或脚本无效。桌面工作台导出的录制（`schemaVersion: 2`）只能在工作台中重放。

## Agent 自主导航

`agent` 按任务文件让模型逐步操作手机。主机只执行任务允许的动作，并根据新的观察独立核对检查点。`--repeat` 和 `--output` 的用法与 `run` 相同。

在运行 CLI 的终端设置模型凭据。省略 `--model` 会向 DeepSeek 的 OpenAI 兼容 `/chat/completions` 接口请求 `deepseek-flash`。[DeepSeek 接口文档](https://api-docs.deepseek.com/)

下例从 Android 简体中文设置首页打开搜索，其他设备换用对应的任务文件：[Android](../examples/agent-open-search-android.json) · [鸿蒙](../examples/agent-open-search-harmony.json) · [iPhone](../examples/agent-open-search-ios.json)。这个任务使用视觉定位，所选模型需要支持图像和函数调用。

```sh
read -rs 'DEEPSEEK_API_KEY?DeepSeek API key: ' && export DEEPSEEK_API_KEY
node dist/cli.js launch --device "$DEVICE" --app settings
node dist/cli.js agent --device "$DEVICE" --task examples/agent-open-search-android.json --vision --json
unset DEEPSEEK_API_KEY
```

Windows PowerShell 7 可用 `$env:DEEPSEEK_API_KEY = Read-Host 'DeepSeek API key' -MaskInput` 输入凭据，用完后执行 `Remove-Item Env:DEEPSEEK_API_KEY`。

其他支持函数调用的 Chat Completions 服务可用 `--base-url` 和 `--model` 指定，例如 `--base-url http://127.0.0.1:8000/v1 --model local-tool-model`。地址需使用 HTTPS，本机回环地址可用 HTTP。需要鉴权时，使用 `--api-key-env` 指定该端点专用的凭据变量。本地免鉴权服务可省略该参数。

报告中的状态：检查点全部通过为 `succeeded`；需要人工处理时为 `needs_review`，例如出现未授权 App、可识别的敏感输入或阻塞弹窗，或模型请求接管；模型协议、鉴权、设备故障或超出决策次数和时长时为 `failed`。

### 任务文件与视觉定位

任务 JSON 包含 `schemaVersion: 1`、`id`、`goal`、允许的前台 `apps`、命名的 `actions`、有序 `checkpoints`，以及可选的 `limits.turns`（默认 20，最多 100）、`limits.ms`（默认 120000，最多 600000）。每个动作指定所在 App 和一个通用脚本步骤。检查点指定所需动作 `afterAction`、目标 App、控件及所需状态。

模型只看到当前 App、允许的动作名称和检查点。需要看图才能定位的控件（例如包含图像的画布），在动作中声明 `visual: true`，并用 `id` 或 `label` 唯一定位该控件。启用 `--vision` 后，模型可以请求查看该控件区域的截图（`request_view`），在截图内选择点击位置（`tap_visual`），由主机换算成设备坐标执行。截图只在内存中保留。

## 诊断与恢复

`doctor` 依次检查连接、工具链、会话和界面读取，报告设备能否控制（`controllable`）和未确认的动作，失败时给出错误码和处理提示。桌面工作台的「连接诊断」执行同样的检查。

运行中按 Ctrl+C 会停止后续步骤并关闭会话。同一台设备同时只能运行一个命令，第二个会收到 `DEVICE_BUSY`。动作已发出但回执丢失时，报告返回 `ACTION_OUTCOME_UNKNOWN`。重新连接后运行 `doctor`，对照 `unconfirmed` 和当前页面核实，再决定从哪一步继续。
