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
| **数字伴侣** | 第三种模式：分层记忆 + 主动唤醒，人格卡可导入 SillyTavern V2 或从空白开始写 |
| **记忆透明** | 记忆库面板可像翻日记一样查看、编辑、置顶、删除伴侣记住的每一件事；待确认的记忆不会进入提示词 |
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

LumiLM 默认是**纯对话**客户端：不注入任何提示词，也不向模型暴露任何工具。需要它动手做事时，在输入框左下角把模式切到 **Agent**。

| 模式 | 行为 |
|---|---|
| **纯对话**（默认） | 与旧版本完全一致：只发送你自己写的系统提示词，请求中不出现 `tools` |
| **Agent** | 注入 Agent 说明 + 工具定义，可多轮调用工具并读取结果 |

Agent 模式与纯对话模式是两条独立的路径：Agent 有自己的一轮「思考 → 调用工具 → 读取结果」
循环、独立的视图（按步骤分块而不是聊天气泡）以及独立的 IPC 通道，两者互不分支。

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

### 内置工具（按需加载）

不装任何 MCP 服务也能让模型动手。内置工具**默认全部关闭**，在右侧 Inspector 的
「工具」页或「设置 → Agent」里按需打开，分两组：

| 分组 | 工具 | 权限 |
| --- | --- | --- |
| 文件工具 | `read_file` `write_file` `list_files` `search_files` | 读只读；`write_file` 需确认 |
| 命令工具 | `run_command` | 每次调用都需要确认 |

- 五个工具的定义合计约 300 token —— 对本地小模型来说，精简的定义比齐全的功能更重要，
  因此只有**启用**的工具才会出现在模型的工具列表里。
- **工作目录**决定文件工具的作用范围，留空则使用用户主目录。注意 `run_command` 执行的是
  真实 shell 命令，命令本身可以离开该目录，所以它被标为高风险、每次都要求批准。
- 命令超时 60 秒、输出限长，且中止对话时会连同子进程一起结束。

#### 模型是怎么调用工具的

小型本地模型不会用 OpenAI 的原生 `tool_calls` 字段，而是把调用写成一段 JSON。因此
LumiLM 的 Agent 提示词里会明确写出约定，并要求模型在写完调用后**立刻停下等待**：

````json
{"name": "builtin__list_files", "arguments": {"path": "."}}
````

- 提示词明确禁止模型**编造或描述结果**，也禁止它"假装"工具已经运行过。
- 主进程会解析出调用、真的执行它，再把真实结果作为下一条消息交回去。
- 解析是容错的：`name` / `tool` / `tool_name` / `action` / `function` 都认，参数既支持嵌套的
  `arguments`，也支持平铺在名字旁边；`//` 注释与末尾多余逗号也会先被清掉。
- **调用之后的正文会被丢弃。** 模型在发出调用后接着写的内容，通常就是对"还没发生的结果"
  的编造，所以只保留调用之前的说明文字。
- 模型请求了未加载的工具时，界面会明确提示「请先在工具面板启用」，而不是静默失败。

### 思考强度

Agent 视图输入框上方有三档开关：**不限 / 简短 / 极简**（并在「设置 → Agent」里为新会话
设定默认值）。

本地模型的思考是实打实的生成时间，在低配机器上尤其明显，因此 LumiLM 通过 llama.cpp 的
`--reasoning-budget` 给思考设上限（约 256 / 64 token），并在预算用尽时插入一句提示让模型
直接作答。

需要说明的是：

- 这个参数**只能在模型启动时生效**，所以切换档位会重新加载模型；之所以不做成请求级，
  是因为实测当前主流的 DeepSeek-V3/R1 风格模板既不吃 `enable_thinking`，也不吃
  `reasoning_effort`，`reasoning_budget` 写在请求体里同样无效，`/props` 也不支持运行时改。
- 档位是**限流而不是关闭**：把预算设为 0 时思考不会消失，反而会从 `reasoning_content`
  泄漏进正文，所以 LumiLM 不提供「关闭思考」这一档。

### 上下文预算

工具结果最容易撑爆上下文，因此在 8 GB 显存这类低配机器上 LumiLM 会：

- 把单个工具结果截断到设定上限（默认 8000 字符）
- 超出预算时优先把**较早的工具结果**替换为一行省略说明
- 仍然超出时再成对丢弃最旧的「工具调用轮次」，绝不会留下孤立的结果
- 展示工具定义本身占用的 token，便于精简用不到的工具

## 数字伴侣

除「纯对话」与「Agent」之外的第三种模式。它不注入任何工具，只带人格与记忆，
目标是成为一个长期记得你的本地伙伴。

### 三种模式的区别

| 模式 | 提示词注入 | 工具 | 记忆 |
|---|---|---|---|
| 纯对话 | 无 | 无 | 无 |
| 伴侣 | 人格 + 关系 + 记忆 | 无 | L1 / L2 / L3 |
| Agent | 可自定义模板 | MCP / 技能 | 无 |

伴侣模式省下工具 schema 占用的约 1400 token，全部留给人格与记忆。

### 人格卡

- 内置示例卡「Lumi」，默认关系是「亲近的伴侣」
- 支持导入 / 导出 **SillyTavern V2** 角色卡（`.json` / `.png`）
- 也可以从空白卡开始，只写你自己想要的人设
- 人设受 token 上限约束（默认 960），超长会在行边界处截断并给出提示

### 分层记忆

| 层 | 内容 | 落地 |
|---|---|---|
| L1 工作记忆 | 本轮要注入的关系与事实 | 只存在于当次请求，不写盘、不进聊天记录 |
| L2 会话记忆 | 滚动摘要与轮次 | 会话维度，用于跨轮衔接 |
| L3 长期记忆 | 结构化事实、事件时间线 | `memory.json`（原子写入），可导出 / 导入 |

召回按「0.6×词法 + 0.2×新鲜度 + 0.2×重要度」打分；中文用二元组切分，
所以「养猫」这类短词也能命中。置顶与边界类事实**强制占位**，不会被预算挤掉；
同一件事重复出现会合并并累加强化次数，而不是堆成两条。

**KV 缓存友好**：人格是稳定前缀（逐轮逐字节相同，可被缓存复用），关系与记忆作为
「注入块」拼在最新一条用户消息之后，只在发请求时存在。这样既省钱又不会污染历史。

### 后台记忆提炼

一轮回复结束后延迟 600 ms，在后台复用**刚跑完那轮的 KV 缓存**做一次提炼，实测约 2.7 s。

提炼器只读：

- 用户自己说过的话

提炼器不读：

- 助手自己的回复（否则会把自己的话当事实重新记住）
- 注入的记忆块（否则会把「亲密度 60/100」这类内容当成新事实反复累积）
- 带保留措辞的内容（「某种」「可能」「根据…推断」「未明确说明」一律丢弃）

结果默认进入**待确认队列**，在你接受之前不会参与注入。

### 主动唤醒

主进程定时器结合系统空闲检测（`powerMonitor`）与随机概率决定是否开口：

- 连续唤醒会指数退避（`0.5^连击数`，下限 1/16），冷却期随机 5–20 分钟
- 支持跨零点的静默时段与手动「小睡」
- 触发时发系统通知，点击回到应用；主动消息在会话里单独标记
- 输入框上方可手动「现在就说一句」或「现在做个梦」（主动反思）

### 思考强度

伴侣模式**默认跳过思考块**：实测首字延迟 13167 ms → 1741 ms，一次问候 638 ms，
且输出更贴合人设。需要看推理过程时可以打开。

跳过的方式是在助手轮预填一个空格让它直接续写，属于请求级参数，**不需要重新加载模型**
（与 Agent 的 `--reasoning-budget` 不同，后者只能启动时生效）。

### 记忆库（数据主权）

侧边栏「记忆库」入口：

- 像翻日记一样浏览全部事实，按类型 / 主体 / 状态筛选、搜索
- 逐条编辑、置顶、隐藏、归档、删除；也可一键「忘掉一切」
- 待确认队列可批量接受 / 拒绝
- 关系面板显示亲密度、称呼、阶段与心情，可手改
- 事件时间线与会话摘要分区展示

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
| 记忆库 | `%APPDATA%\LumiLM\memory\memory.json` |
| 伴侣状态（心跳 / 关系） | `%APPDATA%\LumiLM\memory\heartbeat.json` |
| 人格卡 | `%APPDATA%\LumiLM\personas\*.json` |
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
