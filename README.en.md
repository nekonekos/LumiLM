<div align="center">

# LumiLM

**A local LLM desktop client — fully offline, friendly to low-end machines**

Electron + React + llama.cpp, tuned for GPUs with ~8 GB of VRAM.

[中文文档](./README.md) · [Changelog](./CHANGELOG.md) · [Third-party notices](./THIRD-PARTY-NOTICES.md)

</div>

---

## Features

| | |
|---|---|
| **Fully offline** | No network requests beyond the local `llama-server`. No telemetry, no account |
| **Low-end first** | Probes CPU / RAM / VRAM and budgets for realistic 8 GB GPUs, then picks GPU layers, context size and KV cache quantisation automatically |
| **Automatic degradation** | If loading fails on out-of-memory, LumiLM steps down through a ladder (half the offload → smaller context → pure CPU) without manual tuning |
| **Three backends** | Ships CPU, Vulkan and CUDA 12.4 builds of llama.cpp and picks the fastest usable one at start-up |
| **Multimodal** | Understands `mmproj` vision projectors, so pasted or dropped images can be used as prompts |
| **No preset prompts** | No built-in personas or prompt templates. System prompts, sampling parameters and presets are entirely yours |
| **Highly configurable** | Every conversation stores its own sampling parameters and system prompt, and can be saved as a reusable preset |
| **Polished UI** | Light-blue theme with a dark mode, system-preference following, custom accent colour and font size |
| **Bilingual** | Simplified Chinese (default) and English |

## Requirements

- Windows 10 / 11 x64
- 8 GB RAM minimum (16 GB recommended)
- Optional GPU: NVIDIA (CUDA) or AMD / Intel (Vulkan). Falls back to CPU automatically
- Disk: ~1.5 GB of application plus your model files

> **No models are bundled.** LumiLM only reads `.gguf` files already on your machine and never downloads any.

## Quick start (portable build)

1. Download `LumiLM-x.y.z-win-x64-portable.zip` from [Releases](https://github.com/nekonekos/LumiLM/releases)
2. Extract it anywhere
3. Run `LumiLM.exe`
4. The first-run wizard scans common model directories; you can also add files or folders manually
5. Pick a model and start chatting

## Building from source

```bash
# Node.js >= 20
npm install

# Fetch the prebuilt llama.cpp backends (~1.2 GB, once)
npm run fetch:llama

# Generate the application icons
npm run icon

# Development
npm run dev

# Type check / lint / unit tests
npm run typecheck
npm run lint
npm test

# Package the Windows portable zip
npm run dist

# Build and publish a GitHub release (requires an authenticated gh)
npm run release -- --version=0.1.0
```

### About the llama.cpp backends

`resources/llama/` is not committed because of its size; `npm run fetch:llama` downloads it:

```
resources/llama/
├── cpu/          pure CPU inference
├── vulkan/       AMD / Intel / NVIDIA
├── cuda/         NVIDIA + cuBLAS runtime
└── VERSION.json  which llama.cpp build is in use
```

The script scrapes the official Windows x64 release archives, validates that each
downloaded zip is complete, and supports mirrors and proxies:

```bash
# Use a proxy
LLAMA_PROXY=http://127.0.0.1:7897 npm run fetch:llama

# Pin a specific llama.cpp build
LLAMA_TAG=b11390 npm run fetch:llama

# Only some backends
npm run fetch:llama -- --backends=cpu,vulkan
```

## Design notes

- **Child process, not bindings.** LumiLM talks to a `llama-server` child process over a
  local OpenAI-compatible HTTP/SSE API, so it needs no Node native modules and has no
  node-gyp or ABI headaches.
- **Automatic tuning.** `computeRecommendation()` derives the offloadable layer count from
  the model size, block count, KV head count and free VRAM, and shrinks the context when
  system memory is the limiting factor.
- **Models are referenced in place.** They are never copied into the application data
  directory, so upgrades and re-installs leave your library untouched.
- **Context trimming.** Token cost is estimated with a CJK-aware heuristic and about 82% of
  the context window is reserved for retained history.

## Where data lives

| Content | Path |
|---|---|
| Settings | `%APPDATA%\LumiLM\settings.json` |
| Conversations | `%APPDATA%\LumiLM\conversations\*.json` |
| Presets | `%APPDATA%\LumiLM\presets.json` |
| Attachments | `%APPDATA%\LumiLM\attachments\` |
| Logs | `%APPDATA%\LumiLM\logs\lumilm.log` |

A custom data directory can be chosen under *Settings → General*.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+N` | New conversation |
| `Ctrl+B` | Toggle the sidebar |
| `Ctrl+J` | Toggle the parameter panel |
| `Ctrl+L` | Open the runtime log |
| `Ctrl+,` | Open settings |
| `Enter` | Send (never fires while an IME composition is active) |
| `Shift+Enter` | New line |

## License

[MIT](./LICENSE). See [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md) for bundled
third-party components.
