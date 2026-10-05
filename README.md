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
| **可选 Agent** | 默认纯对话；切到 Agent 模式后可接入 MCP 工具与技能包，操作本地文件、Shell 等外部环境 |
| **提示词透明** | Agent 注入的每一段提示词都可查看、可编辑、可关闭，模板与 token 占用一目了然 |
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

## 扩展系统（Skills 与 MCP）

LumiLM 默认是**纯对话**客户端：不注入任何提示词，也不向模型暴露任何工具。
需要它动手做事时，在输入框左下角把模式切到 **Agent**。

| 模式 | 行为 |
|---|---|
| **纯对话**（默认） | 与旧版本完全一致：只发送你自己写的系统提示词，请求中不出现 `tools` |
| **Agent** | 注入 Agent 说明 + 工具定义，可多轮调用工具并读取结果 |

Agent 模式下的权限三档：

- **每次询问**：任何工具调用都需要你确认
- **仅高风险询问**（默认）：只读工具自动执行，可能改动内容的工具需要确认
- **全自动**：全部直接执行（高风险）

### MCP 服务

在「设置 → MCP」中添加服务，配置写入 `<数据目录>/mcp.json`，
兼容 Claude Desktop 与 VS Code 的配置格式，也可以直接导入它们的配置文件。

```jsonc
{
  "mcpServers": {
    "filesystem": {
      // stdio：LumiLM 会自行启动该命令并与之通信
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "D:/work"],
      "enabled": true,
      "autoConnect": true,
      "toolAllowlist": ["read_file", "list_directory"]
    },
    "remote": {
      // http / sse 属于远程传输，需要在「设置 → Agent」中显式允许
      "transport": "http",
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer …" }
    }
  }
}
```

- 使用 stdio 服务需要本机已安装 **Node.js**（LumiLM 会自动探测 `node` 与 `npx`，
  未检测到时会明确提示，且不影响纯对话使用）。
- MCP 服务是第三方程序，会以你的身份运行代码。添加时会弹窗警示；
  导入的配置一律以「停用」状态落地，需要你逐个启用。
- 连接成功后，服务的 `prompts` 会成为输入框里的 `/` 斜杠命令。

### 技能（Skills）

在「设置 → 技能」中添加技能目录，LumiLM 会递归查找 `SKILL.md`：

```markdown
---
name: pdf-tools
description: 读取、拆分与合并 PDF 文件
allowed-tools:          # 可选：限定模型可见的工具
  - mcp__filesystem__read_file
---

正文：模型加载该技能时才会看到的详细指令。
```

也可以用一个简单 JSON 文件代替：`{ "name": …, "description": …, "systemPrompt": … }`。

技能采用三级渐进披露以节省上下文：元数据（始终注入）→ 正文（模型调用
`skills.load` 时）→ 附带文件（`skills.read_resource` 时）。

### 上下文预算

工具结果最容易撑爆上下文，因此在 8 GB 显存这类低配机器上 LumiLM 会：

- 把单个工具结果截断到设定上限（默认 8000 字符）
- 超出预算时优先把**较早的工具结果**替换为一行省略说明
- 仍然超出时再成对丢弃最旧的「工具调用轮次」，绝不会留下孤立的结果
- 展示工具定义本身占用的 token，便于精简用不到的工具

## 关键设计

- **子进程而非绑定**：通过 `llama-server` 子进程 + 本地 OpenAI 兼容 HTTP/SSE 接口通信，
  因此不需要任何 Node 原生模块，也就没有 node-gyp / ABI 兼容问题。
- **自动调参**：`computeRecommendation()` 依据模型体积、层数、KV 头数、显存余量计算
  可 offload 的层数，并在内存受限时收缩上下文。
- **模型就地引用**：模型不会复制进应用数据目录，只记录路径，升级 / 重装不影响已有模型。
- **上下文裁剪**：按中英文字符混合估算 token，保留约 82% 上下文预算给历史消息。
- **扩展默认关闭**：扩展相关的依赖全部编译进主进程包，不需要额外的运行时目录；
  纯对话路径完全不经过扩展代码。

## 数据存放位置

| 内容 | 路径 |
|---|---|
| 设置 | `%APPDATA%\LumiLM\settings.json` |
| 对话 | `%APPDATA%\LumiLM\conversations\*.json` |
| 预设 | `%APPDATA%\LumiLM\presets.json` |
| 附件 | `%APPDATA%\LumiLM\attachments\` |
| 技能（默认目录） | `%APPDATA%\LumiLM\skills\` |
| MCP 配置 | `%APPDATA%\LumiLM\mcp.json` |
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
