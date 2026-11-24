# Open Mobile Use

在桌面工作台上，用自然语言操作已授权的手机。AI 根据当前界面执行一步，再观察结果，直到取得完成依据或需要你补充说明。对话中的操作会自动录制成脚本，之后可以不调用模型直接重放。

项目提供两种入口：

- **桌面工作台**：Electron 应用，包含对话、手机画面、单步操作和脚本库。
- **CLI**：`node dist/cli.js`，支持自由对话、单步操作、JSON 脚本和预定义 Agent 任务，结果以 JSON 输出。

## 平台支持

| 功能 | macOS 主机 | Windows 主机 |
| --- | --- | --- |
| 桌面工作台 | 从源码运行，或打包为 `.app` | 从源码运行 |
| CLI | 支持 | 支持（鸿蒙、Android） |
| 鸿蒙真机 | 支持，需要 DevEco Studio 的 HDC | 支持，需要 DevEco Studio 的 HDC |
| Android 真机 | 支持，工作台可补齐 SDK 和 Java | 支持，工作台可补齐 SDK 和 Java |
| Android 模拟器 | 工作台可创建并启动 API 35 模拟器 | 用 Android Studio 设备管理器启动 |
| iPhone 真机 | 支持，需要 Xcode 和开发者签名 | 不支持 |
| 本机识别画面文字 | 支持（Apple Vision 或 Tesseract） | 支持（Tesseract） |
| 模型识图 | 支持 | 支持 |

## 快速开始

准备 Node.js（22.x 需 22.13.0 及以上，或使用 24.0.0 及以上版本）和 npm 10 及以上版本，macOS 还需要 Xcode 命令行工具。在仓库根目录运行：

```sh
npm ci
npm ci --prefix desktop
npm run desktop
```

工作台启动后：

1. 连接已解锁的手机并完成 USB 授权。各平台的首次准备见 [设备接入](docs/setup.md#设备接入)。
2. 在「工作台设置」填写模型的 API Key。默认使用 DeepSeek，也可以换成其他支持工具调用的接口或本机 Ollama 模型。
3. 在「对话」中输入任务，例如「打开设置，找到蓝牙，告诉我当前开关状态」。

## 文档

- [安装与设备接入](docs/setup.md)：从源码运行或打包，鸿蒙、iPhone、Android 的首次准备
- [桌面工作台](docs/desktop.md)：对话、识图、脚本库和工作台设置
- [命令行（CLI）](docs/cli.md)：单步操作、脚本、Agent 任务和诊断

开发约定见 [AGENTS.md](AGENTS.md)。

## 许可证

[MIT](LICENSE)
