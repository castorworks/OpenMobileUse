# Open Mobile Use

从 Mac 操作已授权的鸿蒙、iPhone 和 Android 设备。CLI 可以启动指定的已安装 App、查看当前界面、按控件或坐标点击、滑动，并在普通输入框中输入中英文。系统设置中的蓝牙导航还支持运行同一份离线脚本，或让 Agent 按实时控件树选择下一步。两种导航模式均由主机检查实际页面和蓝牙读数。[蓝牙脚本](examples/settings-bluetooth.json)

## 已验证的设备

2026-11-19 在简体中文设置界面连续执行，每轮都从控件树读取蓝牙初值、执行时的值和独立复查值，并确认最终回到设置首页。三台设备的蓝牙初值均为开启。

| 设备与系统 | 控制方式 | 实际进入路径（从设置首页起） | 逐轮记录 |
| --- | --- | --- | --- |
| 鸿蒙 BRA-AL00 真机，7.0.0.111，API 26 | USB · HDC 3.2.0d / UITest 7.0.0.1 | 星闪和蓝牙，按蓝牙专属标识读取开关 | [5/5 通过](docs/validation/2026-11-19/harmony.json) |
| iPhone 15 真机，iOS 26.6.1 | USB · Xcode 27.2 / XCUITest 12.22.8 / 已签名 WDA | 蓝牙 | [5/5 通过](docs/validation/2026-11-19/ios.json) |
| Android 15 模拟器，API 35，Google APIs ARM64 | ADB / UiAutomator2 8.7.3 | 已连接的设备 → 连接偏好设置 → 蓝牙 | [5/5 通过](docs/validation/2026-11-19/android.json) |

三端均已通过 CLI 采集并回读设置首页的 PNG 和原生控件树。蓝牙关闭初值已有离线测试覆盖。Android 厂商真机仍待验收。[1.0 方案](docs/v1.0-design.md)

## 安装

本次使用 macOS、Node.js 22.22.1、npm 10 和 Appium 3.9.1。在仓库根目录运行：

```sh
npm ci
npm run build
```

- **鸿蒙** 安装 DevEco Studio，在手机上开启开发者模式和 USB 调试，连接 Mac 并完成授权。工具默认使用 DevEco Studio 内置的 HDC，可用 `HDC_PATH` 指定其绝对路径。鸿蒙可以单独运行。
- **iPhone** 使用支持该 iOS 版本的 Xcode，通过 USB 配对并信任 Mac，开启开发者模式和 UI 自动化。保持手机解锁。在运行 CLI 的终端设置 `OMU_IOS_TEAM_ID`，或用 `OMU_IOS_XCCONFIG` 指向本机签名配置文件。本次配置使用 `DEVELOPMENT_TEAM`、`CODE_SIGN_STYLE = Automatic` 和 `CODE_SIGN_IDENTITY = Apple Development`。WDA 的默认 Bundle ID 为 `com.castorworks.openmobileuse.wda`，可用 `OMU_WDA_BUNDLE_ID` 选择开发团队能签名的标识。
- **Android 模拟器** 安装 Android Studio、SDK Command-line Tools、Platform-Tools 和 Emulator。选择有蓝牙系统服务的镜像。实测的 Google APIs API 35 ARM64 镜像可在 Apple Silicon Mac 上用下列命令启动。首次创建 AVD 时采用默认硬件配置即可。

```sh
export ANDROID_HOME="$HOME/Library/Android/sdk"
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/emulator:$ANDROID_HOME/platform-tools:$PATH"
sdkmanager 'system-images;android-35;google_apis;arm64-v8a'
avdmanager create avd -n OMU_API35 -k 'system-images;android-35;google_apis;arm64-v8a'
emulator -avd OMU_API35
```

运行 iPhone 或 Android 前，在单独的终端从仓库根目录启动 Appium。使用 Android 时，在该终端也设置好上面的 `ANDROID_HOME` 和 `JAVA_HOME`。默认服务地址为 `http://127.0.0.1:4723`。

```sh
npm run appium
```

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

| 设备 | 通过单步命令打开的目标 | 独立复查 |
| --- | --- | --- |
| 鸿蒙 BRA-AL00 真机 | 系统设置、计算器 `com.huawei.hmos.calculator`，另验证显式指定 `--module phone --ability CalculatorAbility` | [验证记录](docs/validation/2026-11-19/launch/harmony.json) |
| iPhone 13 真机，iOS 18.7.7 | 系统设置、计算器 `com.apple.calculator` | [验证记录](docs/validation/2026-11-19/launch/ios.json) |
| Android 15 模拟器，API 35 | 系统设置、时钟 `com.google.android.deskclock` | [验证记录](docs/validation/2026-11-19/launch/android.json) |

三端均从设置切换到目标 App，在目标已位于前台时再次执行启动，再用 `settings` 返回设置。每次成功后都用独立的 `inspect` 命令核对前台标识。对未安装的包名，三端均返回失败，复查时原应用仍在前台。

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

### 单步验证记录

2026-11-19，每端均通过 10 项实测，覆盖按控件点击、竖屏和横屏坐标点击、滑动、拒绝旋转前的观察、英文、中文、带引号及尾随空格的混合文本、焦点框追加和清空。每次输入后用单独的 `inspect` 再次核对完整内容。

| 设备 | 验证界面及可观察结果 | 记录 |
| --- | --- | --- |
| 鸿蒙 BRA-AL00 真机，7.0.0.111 | 在系统设置搜索框输入，滚动设置列表，按坐标进入蓝牙页。在浏览器全屏播放器按坐标返回竖屏 | [10/10](docs/validation/2026-11-19/steps/harmony.json) |
| iPhone 13 真机，iOS 18.7.7 | 在临时 UIKit 测试 App 中回读输入和点击计数，滚动后检查按钮移出屏幕。竖屏截图为 1170×2532 像素，触控空间为 390×844 点 | [10/10](docs/validation/2026-11-19/steps/ios.json) |
| Android 15 模拟器，API 35 | 在系统设置及其搜索页回读输入，滚动设置列表，竖屏进入“已连接的设备”，横屏按坐标打开搜索框 | [10/10](docs/validation/2026-11-19/steps/android.json) |

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

### Agent 验证记录

2026-11-19 通过默认端点连续运行，每端 5 轮。请求与服务回复的模型 ID 均为 `deepseek-flash`。耗时为五轮任务实测之和，包含基线采集、模型决策、设备动作和结束复查。

| 设备 | 设置语言 | 结果 | 模型调用 | 五轮耗时 |
| --- | --- | --- | ---: | ---: |
| 鸿蒙 BRA-AL00 真机，7.0.0.111 | 简体中文 | [5/5](docs/validation/2026-11-19/agent/harmony.json) | 10 | 215.9 秒 |
| iPhone 13 真机，iOS 18.7.7 | 英文 | [5/5](docs/validation/2026-11-19/agent/ios.json) | 10 | 226.8 秒 |
| Android 15 模拟器，Google APIs ARM64，API 35 | 简体中文 | [5/5](docs/validation/2026-11-19/agent/android.json) | 30 | 164.3 秒 |

三端每轮的初始、到达和复查读数均为开启，每轮均结束在设置首页。iPhone 13 使用机主现有的英文设置界面，页面识别依据该版 iOS 的蓝牙导航栏、开关和返回按钮。Android 每轮由模型选择六次动作，进入和返回各经过三级菜单。
