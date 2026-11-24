# 安装与设备接入

## 安装

需要 Node.js（22.x 需 22.13.0 及以上，或使用 24.0.0 及以上版本）和 npm 10 及以上版本。macOS 上构建桌面工作台还需要 Xcode 命令行工具。在仓库根目录安装依赖：

```sh
npm ci
npm ci --prefix desktop
```

从源码启动桌面工作台（macOS、Windows）：

```sh
npm run desktop
```

首次运行会下载 Electron 运行时，默认从 npmmirror 下载，可以通过 `ELECTRON_MIRROR` 环境变量指定其他下载地址。[默认镜像配置](../desktop/electron.env)

在 macOS 上打包应用。第一行下载 Electron 运行时，运行过 `npm run desktop` 后可以省略。生成的应用可在 `desktop/dist/Open Mobile Use.app` 双击打开。Windows 目前只能从源码运行。

```sh
node --env-file=desktop/electron.env desktop/node_modules/electron/install.js
npm run package:desktop
```

只用 CLI 时，运行 `npm ci` 和 `npm run build` 即可，用法见 [CLI](cli.md)。

## 设备接入

连接前先解锁手机。桌面工作台内置 Appium 和移动端驱动，按需启动本机服务，并检测已安装的平台工具、配置路径。在「工作台设置 → 设备环境与 iPhone 签名」可查看检测结果、获取缺少的平台工具，或选择 Apple 签名团队。CLI 操作 iPhone 或 Android 时需要自行启动 Appium，见 [CLI](cli.md#准备)。

### 鸿蒙

安装 DevEco Studio，在手机上开启开发者模式和 USB 调试，连接电脑并完成授权。工作台自动定位 DevEco Studio 内置的 HDC。CLI 在 macOS 上默认使用 DevEco Studio 内置的 HDC，在 Windows 上调用 `PATH` 中的 `hdc.exe`，也可以用 `HDC_PATH` 指定其绝对路径。鸿蒙不需要 Appium，可以单独运行。

### iPhone（仅 macOS）

安装与设备系统兼容的 Xcode，在 Xcode 登录开发者账户并准备签名证书。通过 USB 配对并信任 Mac，开启开发者模式和 UI 自动化，保持手机解锁。

- 桌面工作台检测到唯一可用的签名团队时自动采用，多个团队时可在工作台设置中选择并保存 Team ID 和 WDA Bundle ID。
- CLI 在运行的终端设置 `OMU_IOS_TEAM_ID`，或用 `OMU_IOS_XCCONFIG` 指向本机签名配置文件。自动签名配置可使用 `DEVELOPMENT_TEAM`、`CODE_SIGN_STYLE = Automatic` 和 `CODE_SIGN_IDENTITY = Apple Development`。WDA 的默认 Bundle ID 为 `com.castorworks.openmobileuse.wda`，可用 `OMU_WDA_BUNDLE_ID` 选择开发团队能签名的标识。

### Android

在 Windows 或 macOS 上连接真机并开启 USB 调试。在桌面工作台中，设备区提示缺少工具时，点「准备 Android 环境」，按提示确认 SDK 许可。工作台复用已有 SDK 和 Java，补齐缺项后自动扫描手机。在「设备环境与 iPhone 签名」可以选择非默认位置的 SDK。CLI 需要 Android SDK Platform-Tools 和 Java。

启动 Android 模拟器：

- macOS 桌面工作台：点「启动 Android 模拟器」，工作台会准备 API 35 镜像、创建并启动专用模拟器。
- Windows：通过 Android Studio 设备管理器启动模拟器，再在工作台重新扫描设备。
- CLI：安装 Android Studio、SDK Command-line Tools、Platform-Tools 和 Emulator。Google APIs API 35 ARM64 镜像可在 Apple Silicon Mac 上用下列命令启动，首次创建 AVD 时采用默认硬件配置即可。

```sh
export ANDROID_HOME="$HOME/Library/Android/sdk"
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/emulator:$ANDROID_HOME/platform-tools:$PATH"
sdkmanager 'system-images;android-35;google_apis;arm64-v8a'
avdmanager create avd -n OMU_API35 -k 'system-images;android-35;google_apis;arm64-v8a'
emulator -avd OMU_API35
```
