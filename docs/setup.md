# 安装与设备接入

## 构建并启动服务

在连接手机的 Windows 或 macOS 主机上安装 Node.js（22.x 需 22.13.0 及以上，或使用 24.0.0 及以上版本）和 npm 10 及以上版本。在仓库根目录构建服务和 CLI。

```sh
npm ci
npm run build
node dist/cli.js auth token create --subject local
node dist/cli.js serve
```

保留签发结果中的访问令牌，供 CLI、外部程序或自定义连接模式的工作台使用。手动启动的服务默认监听 `127.0.0.1:18765`。服务和令牌管理命令使用同一个状态目录，默认在 `~/.openmobileuse/api`，可用 `OMU_API_STATE_DIR` 或 `--state-dir` 指定。CLI 用 `OMU_API_TOKEN` 配置令牌。可用 `OMU_API_URL` 指定连接地址。 [命令行配置](cli.md#准备)

- **托管 Appium**。默认模式，也可显式指定 `serve --appium-mode managed`。服务在 Android 或 iPhone 会话需要时启动本机 Appium，并在关闭时回收其进程。
- **外置 Appium**。先启动本机 Appium，再执行 `serve --appium-mode external --appium-url http://127.0.0.1:4723`。可在仓库目录用 `npm run appium` 启动 Appium。此模式的默认 Appium 地址为 `http://127.0.0.1:4723`。鸿蒙直接使用 HDC。

后台部署可由具备设备权限的宿主登录账户启动，macOS 可使用用户 LaunchAgent，Windows 可使用该用户的后台任务。远程连接需要在宿主指定 `--host`、`--tls-cert`、`--tls-key`，客户端填入证书对应的 HTTPS 地址和授权令牌。 [服务部署与鉴权](api-design.md#访问权限与部署)

## 打包服务

在仓库根目录运行 `npm run package:service`，生成包含 CLI、HTTP 服务、离线 OCR 数据及接口契约的 npm 压缩包。macOS 打包时编译 Apple Vision 辅助程序，需要 Xcode 命令行工具。

```sh
npm run package:service
```

将生成的 `.tgz` 复制到部署主机。安装 Node.js 和 npm 后，使用实际包名安装并执行 `omu`。

```sh
npm install --global ./open-mobile-use-0.1.0.tgz
omu auth token create --subject local
omu serve
```

## 启动工作台

Windows 和 macOS 都可在仓库根目录执行以下命令。

```sh
npm ci
npm ci --prefix desktop
npm run desktop
```

首次运行会下载 Electron 运行时，默认从 npmmirror 下载，可以通过 `ELECTRON_MIRROR` 环境变量指定其他下载地址。[默认镜像配置](../desktop/electron.env)

打开工作台时会自动启动或复用本机 `omu serve`，并通过系统凭据存储保存访问令牌。工作台启动新服务时会探测本机已安装的工具链，并读取已有模型配置。未配置模型时，服务会探测本机已运行的 Ollama，使用已安装且支持工具调用的本地模型。退出工作台后，服务及已受理的运行会继续工作。连接手动部署的服务时，在「工作台设置」切换为自定义服务并填写地址和令牌。 [工作台用法](desktop.md)

macOS 打包出的 `desktop/dist/Open Mobile Use.app` 自带运行时、服务及驱动依赖，可直接启动。首次打包先下载 Electron 运行时。Windows 工作台从源码运行。

```sh
node --env-file=desktop/electron.env desktop/node_modules/electron/install.js
npm run package:desktop
```

## 设备接入

先解锁手机并连接服务所在的主机，再在手机上确认调试或信任提示。启动服务时使用能访问工具链和设备的账户。可在工作台重新扫描，或运行 `node dist/cli.js devices --json` 查看设备，再用 `doctor` 检查连接。

### 鸿蒙

安装 DevEco Studio，在手机上开启开发者模式和 USB 调试，连接主机并完成授权。服务查找默认目录和 `PATH` 中的 HDC。启动服务前也可用 `HDC_PATH` 指定绝对路径。鸿蒙直连 HDC。

### iPhone（仅 macOS）

安装与设备系统兼容的 Xcode，在 Xcode 登录开发者账户并准备签名证书。通过 USB 配对并信任 Mac，开启开发者模式和 UI 自动化，保持手机解锁。

在启动服务的环境中设置 `OMU_IOS_TEAM_ID`，或用 `OMU_IOS_XCCONFIG` 指向本机签名配置文件。自动签名配置可使用 `DEVELOPMENT_TEAM`、`CODE_SIGN_STYLE = Automatic` 和 `CODE_SIGN_IDENTITY = Apple Development`。WDA 的默认 Bundle ID 为 `com.castorworks.openmobileuse.wda`，可用 `OMU_WDA_BUNDLE_ID` 选择开发团队能签名的标识。在计划长期运行的账户下确认 Xcode、钥匙串和设备授权能访问。

### Android

宿主需要 Android SDK Platform-Tools、相关 SDK 组件和 Java。在 Windows 或 macOS 上连接真机并开启 USB 调试。本机工作台会探测现有工具。缺少组件时，在「准备 Android 环境」中按提示确认安装。手动启动服务或外置 Appium 时，可通过环境变量指定 SDK 和 JDK 路径。

macOS 示例。

```sh
export ANDROID_HOME="$HOME/Library/Android/sdk"
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
node dist/cli.js serve
```

Windows PowerShell 示例。

```powershell
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
$env:JAVA_HOME = 'C:\Program Files\Android\Android Studio\jbr'
node dist/cli.js serve
```

启动 Android 模拟器：

- macOS 本机工作台：点「启动 Android 模拟器」，工作台会准备 API 35 镜像、创建并启动专用模拟器。
- Windows：通过 Android Studio 设备管理器启动模拟器，再在工作台重新扫描设备。
- 设备宿主也可使用 Android Studio 或 SDK 命令行工具创建和启动模拟器。Apple Silicon Mac 上可按下列命令启动 Google APIs API 35 ARM64 镜像，首次创建 AVD 时采用默认硬件配置即可。

```sh
export ANDROID_HOME="$HOME/Library/Android/sdk"
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/emulator:$ANDROID_HOME/platform-tools:$PATH"
sdkmanager 'system-images;android-35;google_apis;arm64-v8a'
avdmanager create avd -n OMU_API35 -k 'system-images;android-35;google_apis;arm64-v8a'
emulator -avd OMU_API35
```
