# Open Mobile Use

用自然语言操作已授权的手机。AI 根据当前界面执行一步，再观察结果，直到取得完成依据或需要你补充说明。对话中的操作会自动录制成脚本，之后可以离线重放。

在连接手机的主机运行 `omu serve`。服务管理设备、运行、对话、脚本和截图，以下客户端使用同一套接口。

- **桌面工作台**：Electron 应用，包含对话、手机画面、单步操作和脚本库。
- **CLI**：`node dist/cli.js`，支持自由对话、单步操作、JSON 脚本和预定义 Agent 任务，结果以 JSON 输出。
- **HTTP API**：支持自动化和外部应用调用，可通过受保护的 HTTPS 接入设备宿主。 [API 设计](docs/api-design.md) · [OpenAPI 契约](docs/openapi.yaml)

## 平台支持

| 功能 | macOS 主机 | Windows 主机 |
| --- | --- | --- |
| 桌面工作台 | 从源码运行，或打包为 `.app` | 从源码运行 |
| 独立服务与 CLI | 支持 | 支持（鸿蒙、Android） |
| 鸿蒙真机 | 支持，需要 DevEco Studio 的 HDC | 支持，需要 DevEco Studio 的 HDC |
| Android 真机 | 支持，需要 Android SDK 和 Java | 支持，需要 Android SDK 和 Java |
| Android 模拟器 | 工作台可创建并启动 API 35 模拟器 | 用 Android Studio 设备管理器启动 |
| iPhone 真机 | 支持，需要 Xcode 和开发者签名 | 不支持 |
| 本机识别画面文字 | 支持（Apple Vision 或 Tesseract） | 支持（Tesseract） |
| 模型识图 | 支持 | 支持 |

## 快速开始

macOS 可直接打开打包后的 `Open Mobile Use.app`。从源码运行时，在 Windows 或 macOS 上安装 Node.js（22.x 需 22.13.0 及以上，或使用 24.0.0 及以上版本）和 npm 10 及以上版本，在仓库根目录执行：

```sh
npm ci
npm ci --prefix desktop
npm run desktop
```

工作台会自动启动或复用本机 `omu serve`，并配置自己的访问令牌。连接手机并完成授权即可查看设备。已配置模型时，可以在对话中输入「打开设置，告诉我蓝牙是否开启」。 [启动工作台](docs/setup.md#启动工作台) · [设备接入](docs/setup.md#设备接入)

CLI 可凭单独签发的令牌连接同一个服务。也可通过 `npm run package:service` 打包 `omu`，在设备主机上独立部署。 [CLI 配置](docs/cli.md#准备) · [打包服务](docs/setup.md#打包服务)

## 文档

- [安装与设备接入](docs/setup.md)：从源码运行或打包，鸿蒙、iPhone、Android 的首次准备
- [桌面工作台](docs/desktop.md)：对话、识图、脚本库和工作台设置
- [命令行（CLI）](docs/cli.md)：单步操作、脚本、Agent 任务和诊断
- [独立服务与 HTTP API](docs/api-design.md)：接入、权限和运行契约

开发约定见 [AGENTS.md](AGENTS.md)。

## 许可证

[MIT](LICENSE)
