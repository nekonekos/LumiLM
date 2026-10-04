<div align="center">

# LumiLM

**本地大模型桌面客户端 · 全离线 · 低配友好**

基于 Electron + React + llama.cpp，为 8 GB 显存级别的电脑优化。

[English](./README.en.md) · [更新日志](./CHANGELOG.md) · [第三方许可](./THIRD-PARTY-NOTICES.md)

</div>

---

## 特性

| | |
|---|---|
| **完全离线** | 除本地 `llama-server` 之外不发起任何网络请求，无遥测、无账号 |
| **低配优先** | 自动探测 CPU / 内存 / 显存，按 8 GB 显存等真实场景计算显存预算，自动决定 GPU 层数、上下文与 KV 缓存量化方式 |
| **自动降级** | 显存不足导致加载失败时自动分级降级（减半 offload → 缩小上下文 → 纯 CPU），无需手动调参 |
| **三套后端** | 内置 CPU / Vulkan / CUDA(12.4) 三份 llama.cpp 二进制，启动时自动选择可用的最快后端 |
| **多模态** | 支持 `mmproj` 视觉投影模型，可直接粘贴 / 拖拽图片提问 |
| **无预置提示词** | 不附带任何内置人格或提示词模板；系统提示词、采样参数、预设全部由你自己建立 |
| **高度自由** | 每个对话独立保存采样参数与系统提示词；可保存为自定义预设随时复用 |
| **美观界面** | 浅蓝配色，可切换深色 / 跟随系统，可自定义主色调与字号 |
| **中文优先** | 简体中文与 English 双语界面 |

## 系统要求

- Windows 10 / 11 x64
- 8 GB 内存起（推荐 16 GB）
- 显卡可选：NVIDIA（CUDA）、AMD / Intel（Vulkan），无独显时自动使用 CPU
- 磁盘：约 1.5 GB 程序体积 + 模型文件本身

> **不包含任何模型文件。** LumiLM 只读取你本机已有的 `.gguf` 文件，不会下载模型。

## 快速开始（便携版）

1. 从 [Releases](https://github.com/nekonekos/LumiLM/releases) 下载 `LumiLM-x.y.z-win-x64-portable.zip`
2. 解压到任意目录（路径不要包含中文以外的特殊字符）
3. 运行 `LumiLM.exe`
4. 首次启动向导会自动扫描常见模型目录；也可以手动「添加文件 / 添加文件夹」
5. 选好模型后直接开始对话

## 从源码构建

```bash
# 环境：Node.js >= 20
npm install

# 下载 llama.cpp 预编译后端（约 1.2 GB，只需执行一次）
npm run fetch:llama

# 图标：build/icons/{light,dark}/ 为源文件，生成 build/icon.ico 与 src/shared/app-icons.ts
# （已被 `npm run build` 自动调用，仅在替换美术资源后需要手动执行）
npm run icon

# 开发模式
npm run dev

# 类型检查 / 代码检查 / 单元测试
npm run typecheck
npm run lint
npm test

# 打包 Windows 便携版 zip
npm run dist

# 构建并发布到 GitHub Release（需要 gh 已登录）
npm run release -- --version=0.1.1
```

### 关于图标

应用图标有两套配色，分别用于浅色与深色主题：

```
build/icons/
├── light/   浅色主题图标（同时用作 LumiLM.exe 与便携包图标）
│   └── 16.png 32.png 64.png 128.png 256.png
└── dark/    深色主题图标（窗口标题栏、任务栏、应用内 logo）
    └── 16.png 32.png 64.png 128.png 256.png
```

`npm run icon` 会读取这两个目录，生成 `build/icon.ico`（打包用，固定为浅色版本）、
`build/icon.png` 以及 `src/shared/app-icons.ts`（内联 data URL，供主进程的窗口图标
与渲染进程的应用内 logo / favicon 按主题切换使用）。

### 关于 llama.cpp 后端

`resources/llama/` 不随仓库分发（体积过大），由 `npm run fetch:llama` 按需下载：

```
resources/llama/
├── cpu/          纯 CPU 推理
├── vulkan/       AMD / Intel / NVIDIA
├── cuda/         NVIDIA + cuBLAS 运行时
└── VERSION.json  记录所用 llama.cpp 构建版本
```

下载脚本会从 GitHub Release 抓取 Windows x64 预编译包，自动校验 zip 完整性，
并支持镜像与代理加速：

```bash
# 使用代理
LLAMA_PROXY=http://127.0.0.1:7897 npm run fetch:llama

# 固定某个 llama.cpp 构建
LLAMA_TAG=b11390 npm run fetch:llama

# 只下载部分后端
npm run fetch:llama -- --backends=cpu,vulkan
```

## 关键设计

- **子进程而非绑定**：通过 `llama-server` 子进程 + 本地 OpenAI 兼容 HTTP/SSE 接口通信，
  因此不需要任何 Node 原生模块，也就没有 node-gyp / ABI 兼容问题。
- **自动调参**：`computeRecommendation()` 依据模型体积、层数、KV 头数、显存余量计算
  可 offload 的层数，并在内存受限时收缩上下文。
- **模型就地引用**：模型不会复制进应用数据目录，只记录路径，升级 / 重装不影响已有模型。
- **上下文裁剪**：按中英文字符混合估算 token，保留约 82% 上下文预算给历史消息。

## 数据存放位置

| 内容 | 路径 |
|---|---|
| 设置 | `%APPDATA%\LumiLM\settings.json` |
| 对话 | `%APPDATA%\LumiLM\conversations\*.json` |
| 预设 | `%APPDATA%\LumiLM\presets.json` |
| 附件 | `%APPDATA%\LumiLM\attachments\` |
| 日志 | `%APPDATA%\LumiLM\logs\lumilm.log` |

可在「设置 → 通用」中改用自定义数据目录。

## 快捷键

| 快捷键 | 功能 |
|---|---|
| `Ctrl+N` | 新建对话 |
| `Ctrl+B` | 显示 / 隐藏侧边栏 |
| `Ctrl+J` | 显示 / 隐藏参数面板 |
| `Ctrl+L` | 查看运行日志 |
| `Ctrl+,` | 打开设置 |
| `Enter` | 发送（中文输入法组字中不会误发） |
| `Shift+Enter` | 换行 |

## 许可证

本项目采用 [MIT 许可证](./LICENSE)。随附的第三方组件许可见
[THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md)。
