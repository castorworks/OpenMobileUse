# Open Mobile Use

从 Mac 操作已授权的鸿蒙、iPhone 和 Android 设备。CLI 支持启动应用、查看界面、点击、滑动、中英文输入、返回和条件等待。可以编写离线脚本，也可以让使用 OpenAI 兼容接口的 Agent 根据当前页面选择下一步。默认模型为 `deepseek-flash`。主机负责执行动作、检查任务结果和保留未决操作记录。

## 安装

在 macOS 上准备 Node.js（22.x 需 22.13.0 及以上，或使用 24.0.0 及以上版本）和 npm 10 及以上版本。在仓库根目录运行：

```sh
npm ci
npm run build
```

- **鸿蒙** 安装 DevEco Studio，在手机上开启开发者模式和 USB 调试，连接 Mac 并完成授权。工具默认使用 DevEco Studio 内置的 HDC，可用 `HDC_PATH` 指定其绝对路径。鸿蒙可以单独运行。
- **iPhone** 使用支持该 iOS 版本的 Xcode，通过 USB 配对并信任 Mac，开启开发者模式和 UI 自动化。保持手机解锁。在运行 CLI 的终端设置 `OMU_IOS_TEAM_ID`，或用 `OMU_IOS_XCCONFIG` 指向本机签名配置文件。自动签名配置可使用 `DEVELOPMENT_TEAM`、`CODE_SIGN_STYLE = Automatic` 和 `CODE_SIGN_IDENTITY = Apple Development`。WDA 的默认 Bundle ID 为 `com.castorworks.openmobileuse.wda`，可用 `OMU_WDA_BUNDLE_ID` 选择开发团队能签名的标识。
- **Android 模拟器** 安装 Android Studio、SDK Command-line Tools、Platform-Tools 和 Emulator。选择有蓝牙系统服务的镜像。Google APIs API 35 ARM64 镜像可在 Apple Silicon Mac 上用下列命令启动。首次创建 AVD 时采用默认硬件配置即可。

```sh
export ANDROID_HOME="$HOME/Library/Android/sdk"
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/emulator:$ANDROID_HOME/platform-tools:$PATH"
sdkmanager 'system-images;android-35;google_apis;arm64-v8a'
avdmanager create avd -n OMU_API35 -k 'system-images;android-35;google_apis;arm64-v8a'
emulator -avd OMU_API35
```

用 CLI 操作 iPhone 或 Android 时，在单独的终端从仓库根目录启动 Appium。使用 Android 时，在该终端也设置好上面的 `ANDROID_HOME` 和 `JAVA_HOME`。默认服务地址为 `http://127.0.0.1:4723`。桌面工作台会自动管理本机连接。

```sh
npm run appium
```

## Mac 桌面工作台（预览）

工作台可以选择设备、查看手机当前画面、手动操作和运行任务。先按上节准备设备与驱动。在仓库根目录执行以下命令，首次启动 Electron 时会准备桌面运行时。

```sh
npm ci
npm ci --prefix desktop
npm run desktop
```

- 在左侧选择 iPhone 或 Android 时，工作台会复用已就绪的 Appium 服务；本机 HTTP 地址没有服务监听时，会自动启动项目内的 Appium，等待就绪并继续读取手机画面。服务中途退出后，下次连接会自动恢复。退出工作台时会关闭本窗口启动的服务。可用 `OMU_APPIUM_URL` 指定回环地址、端口和服务路径，使用 HTTPS 时需自行配置 TLS 服务。鸿蒙通过 HDC 直连。
- 连接诊断可查看失败阶段、处理提示和未决动作。接入或拔出设备后点左栏的刷新按钮重新扫描。
- 在画面上点选位置，然后点「点击选区」按坐标操作。也可以在控件列表里选择目标再点击或输入。在「滑动」模式中直接拖动画面。iOS 的「返回」使用可定位的导航按钮，有多个候选时需先选中。页面变化后点「刷新画面」重新定位。
- 在右侧运行内置蓝牙 Agent、离线蓝牙脚本或中文设置搜索脚本，也可导入本地任务 JSON。蓝牙导航从设置首页开始，中文搜索脚本需要简体中文设置。Agent 默认使用 `deepseek-flash`，可在「模型设置」输入仅供本次会话使用的 Key，或启动时提供 `DEEPSEEK_API_KEY`。自定义 OpenAI 兼容端点可设置 `OMU_MODEL_BASE_URL`、`OMU_MODEL` 和端点专用的 `OMU_MODEL_KEY_ENV`。
- 任务使用自己的设备会话更新画面。右侧展示执行步骤、主机读到的蓝牙初值、到达读数和独立复查值。点击「停止任务」会停止后续动作。退出工作台会停止运行中的任务并关闭设备会话。已结束的运行按设备保存在 `~/.openmobileuse/workbench/` 或 `OMU_STATE_DIR` 下，截图仅留在窗口内存中。自定义视觉任务须显式勾选发送控件裁剪图。

## 运行蓝牙导航

解锁目标设备，把系统设置停在首页。在 CLI 终端列出设备，将 `DEVICE` 替换成输出中目标设备的完整 `id`（含 `harmony:`、`ios:` 或 `android:` 前缀）。

```sh
node dist/cli.js devices --json
DEVICE='android:emulator-5554'
node dist/cli.js doctor --device "$DEVICE" --json
node dist/cli.js run --device "$DEVICE" --script examples/settings-bluetooth.json \
  --repeat 5 --output "$HOME/omu-results" --json
```

`doctor` 报告设备连接状态和执行结果未知的历史动作。`run` 每轮先记录蓝牙初值，再执行脚本并按顺序核对首页、蓝牙页和首页，最后独立重访蓝牙页复查开关并退回首页。成功时退出码为 0，输出目录内每次运行有一份 JSON 报告。未识别的页面或无法唯一定位的控件会使任务失败。

## 通用单步操作

### 启动指定 App

用 `launch --app` 打开已安装的应用。`settings` 是三端通用的系统设置别名。其他应用在 Android 上传入包名，在鸿蒙和 iOS 上传入 bundle ID。下面的命令都使用上文从 `devices` 选出的目标设备。

```sh
node dist/cli.js launch --device "$DEVICE" --app settings --json
# iPhone 计算器示例
node dist/cli.js launch --device "$DEVICE" --app com.apple.calculator --json
```

鸿蒙默认从已安装应用的元数据解析入口，需要选择特定入口时可加 `--ability` 和 `--module`。Android 按当前用户查找应用的桌面入口。启动后，CLI 连续两次读到的前台标识都与目标完全匹配，才返回 `foregroundVerified: true`。结果中的 `targetApp` 是解析后的包名或 bundle ID，`foregroundApp` 是设备实测值。未安装返回 `APP_NOT_INSTALLED`，入口无法解析返回 `APP_NOT_LAUNCHABLE`，前台校验未通过返回 `APP_NOT_FOREGROUND`。

### 查看界面、点击、滑动和输入

将目标 App 停在要操作的页面，使用前面得到的 `DEVICE`。单步命令直接操作前台界面，无需配置模型。先运行 `inspect`，在返回的 `directory` 里查看 `screen.png`、原生布局和 `controls.json`。后者列出可见控件的标识、名称、类型、边界和归一化中心。截图与控件树依次采集。如果此间控件发生变化，结果中的 `controlsChangedDuringCapture` 为 `true`。采集文件保存在本机，可能包含输入框内容和其他页面信息。

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

`input` 默认追加到原值末尾。省略标识和名称时使用当前聚焦的普通输入框。`--replace` 替换全文，配合 `--text ''` 可清空。命令逐字回读最终值，通过时返回 `inputVerified: true`。上例使用 `printf '%s'`，会保留首尾空格，也便于通过标准输入传入文件或含引号的文本。

## 通用脚本和条件等待

`run` 每轮独占一台设备，在同一个会话里按序执行。下面的中文设置搜索示例可在三个平台运行。它输入「蓝牙」、等待具体搜索结果、退出搜索，再确认搜索界面已消失且首页入口可见。iOS 示例使用简体中文设置。

```sh
node dist/cli.js run --device "$DEVICE" --script examples/settings-search.json --output ./results --json
node dist/cli.js waitFor --device "$DEVICE" --label '蓝牙地址' --state visible --timeout-ms 10000
```

脚本使用 `schemaVersion: 1`。步骤支持 `launchApp`、`tap`、`swipe`、`input`、`back` 和 `waitFor`，参数沿用单步命令，JSON 中使用 `fromX`、`durationMs`、`timeoutMs` 等小驼峰字段。可直接写 `id`、`label`、`role`，或用 `target` 引用顶层 `targets` 中按平台定义的选择器。`platforms` 可限定某步适用的平台。iOS 的 `back` 指定页面上的导航或取消按钮，鸿蒙与 Android 使用系统返回键。软件键盘打开时，第一次返回可能只收起键盘。[完整示例](examples/settings-search.json)

`waitFor` 接受 `visible` 和 `hidden`，对当前前台页面进行有界轮询。未找到可继续等，重名返回 `AMBIGUOUS_ELEMENT`。步骤失败后，报告返回原脚本中从 1 开始的 `failedStep`、已执行步骤的耗时和错误码。退出码 0 表示成功，1 表示执行失败，2 表示参数或脚本无效。原有蓝牙脚本继续执行独立的开关初值和终值核查。

### 诊断和恢复

`devices` 返回设备状态和连接方式。`doctor` 依次探测连接、工具链、会话和界面读取，报告 `controllable`、前台应用、观察标识及未决动作。ADB 的 `unauthorized` 和 `offline` 有独立错误码，WDA 签名、锁屏和 Appium 连接失败提供对应的处理提示。在同一台 Mac 运行多个 Appium 服务时，为各个 iOS 会话选择不同的 WDA 转发端口，例如为第二个服务的 CLI 设置 `OMU_WDA_PORT=8165`。端口已被占用时，`doctor` 返回 `PORT_IN_USE`。

脚本运行中按 Ctrl+C 会停止调度后续步骤并关闭会话。同设备第二个运行会收到 `DEVICE_BUSY`。动作已发出但回执丢失时，JSON 报告返回 `ACTION_OUTCOME_UNKNOWN`。重新连接后运行 `doctor`，对照 `unconfirmed` 和当前页面核实，再决定从哪一步继续。持久记录仅含动作类型、序号、时间和运行编号。

## 用 Agent 自主导航

完成上面的设备接入，在运行 CLI 的终端设置模型凭据。以下为 macOS 默认 zsh 的输入方式。省略 `--model` 会向 DeepSeek 的 OpenAI 兼容 `/chat/completions` 接口请求 `deepseek-flash`。[DeepSeek 接口文档](https://api-docs.deepseek.com/)

```sh
read -rs 'DEEPSEEK_API_KEY?DeepSeek API key: ' && export DEEPSEEK_API_KEY
node dist/cli.js agent --device "$DEVICE" --task settings.bluetoothRoundTrip \
  --repeat 5 --output "$HOME/omu-agent-results" --json
unset DEEPSEEK_API_KEY
```

主机先读取初值并恢复设置首页。执行期间，模型每轮看到当前页面的导航行名称、临时节点编号、可用动作和已完成的检查点。它可以选择点按某一行、返回、等待、提议完成或请求人工接管。主机在点按前重新读取页面，只允许本任务的导航操作。模型请求中包含控件摘要，原始截图、附近设备名和账户信息留在本机。

每轮任务最多 20 次模型决策、120 秒。只有执行阶段依次观察到蓝牙页和返回首页，且最后独立重访读得相同的开关值并再次回到首页，才记为成功。JSON 报告记录模型 ID、模型调用次数、动作前后的观察编号、检查点和耗时。遇到无法辨认的页面会报告 `needs_review`，模型协议、鉴权或设备故障会报告 `failed`。

其他支持函数调用的 Chat Completions 服务可用 `--base-url` 和 `--model` 指定。需要鉴权时，使用 `--api-key-env` 指定该端点专用的凭据变量。本地免鉴权服务可省略该参数。

```sh
node dist/cli.js agent --device "$DEVICE" --task settings.bluetoothRoundTrip \
  --base-url http://127.0.0.1:8000/v1 --model local-tool-model --json
```

### 自定义任务与视觉定位

`--task` 也接受本地任务 JSON。定义包含 `id`、`goal`、允许的前台 `apps`、命名的 `actions`、有序 `checkpoints`，以及可选的 `limits.turns`、`limits.ms`。每个动作指定所在 App 和一个通用脚本步骤。检查点指定所需动作 `afterAction`、目标 App、控件及所需状态。主机根据新观察独立复核，模型仅能提议已授权的动作。蓝牙内置任务另外验证开关原值及往返顺序。

下例从 Android 简体中文设置首页打开搜索。按设备选择对应任务文件，所选模型需要支持图像和函数调用。[Android 任务](examples/agent-open-search-android.json) · [鸿蒙任务](examples/agent-open-search-harmony.json) · [iPhone 任务](examples/agent-open-search-ios.json)

```sh
node dist/cli.js launch --device "$DEVICE" --app settings
node dist/cli.js agent --device "$DEVICE" --task examples/agent-open-search-android.json --vision --json
```

普通任务向模型提供当前 App、允许的动作名称和检查点。视觉动作需在任务中声明 `visual: true` 并指定可唯一定位的控件，可以是包含图像的画布。启用 `--vision` 后，模型可用 `request_view` 请求该控件的可见区域。主机核对采集前后的观察，裁剪 PNG，在工具结果之后发送带来源调用 ID 的图片；`tap_visual` 接受裁剪图中的归一化位置，主机将其换算为设备触控坐标并再次核对观察。图像只在内存中保留，运行报告记录动作和证据。遇到未授权 App、可识别的敏感输入或阻塞弹窗，任务交由人工处理。
