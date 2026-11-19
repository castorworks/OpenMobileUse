# Open Mobile Use

从 Mac 操作已授权的手机。当前 CLI 已实现第一个场景：在系统设置中进入蓝牙页，读取蓝牙开关，再返回设置首页。三个平台共用一份 [JSON 脚本](examples/settings-bluetooth.json)，执行和验收都在本机完成，无需模型或 API Key。

## 已验证的设备

2026-11-19 在简体中文设置界面连续执行，每轮都从控件树读取蓝牙初值、执行时的值和独立复查值，并确认最终回到设置首页。三台设备的蓝牙初值均为开启。

| 设备与系统 | 控制方式 | 实际进入路径（从设置首页起） | 逐轮记录 |
| --- | --- | --- | --- |
| 鸿蒙 BRA-AL00 真机，7.0.0.111，API 26 | USB · HDC 3.2.0d / UITest 7.0.0.1 | 星闪和蓝牙，按蓝牙专属标识读取开关 | [5/5 通过](docs/validation/2026-11-19/harmony.json) |
| iPhone 15 真机，iOS 26.6.1 | USB · Xcode 27.2 / XCUITest 12.22.8 / 已签名 WDA | 蓝牙 | [5/5 通过](docs/validation/2026-11-19/ios.json) |
| Android 15 模拟器，API 35，Google APIs ARM64 | ADB / UiAutomator2 8.7.3 | 已连接的设备 → 连接偏好设置 → 蓝牙 | [5/5 通过](docs/validation/2026-11-19/android.json) |

三端均已通过 CLI 采集并回读设置首页的 PNG 和原生控件树。蓝牙关闭初值已有离线测试覆盖。Android 厂商真机、通用单步操作和由模型决定动作的 Agent 仍在 [1.0 方案](docs/v1.0-design.md) 的后续验收范围内。

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

在已支持的设置页面，可用 `inspect` 将截图与控件树保存到指定的本机目录。文件可能包含账户名或附近设备名。

```sh
node dist/cli.js inspect --device "$DEVICE" --output "$HOME/omu-captures"
npm test
```
