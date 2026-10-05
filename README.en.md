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
| **Optional agent** | Plain chat by default; switch to Agent mode to reach MCP tools and skills that act on files, shells and other environments |
| **Digital companion** | A third mode: layered memory and proactive wake-ups, with character cards imported from SillyTavern V2 or written from scratch |
| **Transparent memory** | The memory library shows every fact the companion holds, ready to edit, pin or delete; nothing reaches the prompt before you accept it |
| **Quiet memory** | Silent consolidation removes duplicates and rejects noise, and a repeated event is kept as one row with a dated timeline instead of a pile of paraphrases |
| **Transparent prompting** | Every injected prompt block can be inspected, edited or switched off, with its token cost shown |
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

# Icons: build/icons/{light,dark}/ are the sources; this derives build/icon.ico and
# src/shared/app-icons.ts. `npm run build` runs it for you, so it is only needed
# after replacing the artwork.
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
npm run release -- --version=0.1.1
```

### About the icons

There are two colourways, one for each theme:

```
build/icons/
├── light/   light theme mark (also baked into LumiLM.exe and the portable zip)
│   └── 16.png 32.png 64.png 128.png 256.png
└── dark/    dark theme mark (title bar, taskbar, in-app logo)
    └── 16.png 32.png 64.png 128.png 256.png
```

`npm run icon` reads both folders and writes `build/icon.ico` (used by the packager,
always the light mark), `build/icon.png`, and `src/shared/app-icons.ts` — inlined data
URLs that let the main process swap the window icon and the renderer swap the in-app
logo and favicon as the theme changes.

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

## Extensions (skills and MCP)

Out of the box LumiLM is a **plain chat** client: it injects no prompt and exposes no
tools. Switch the mode selector under the composer to **Agent** when you want it to act.

| Mode | Behaviour |
|---|---|
| **Chat** (default) | Exactly the old behaviour: only your own system prompt is sent and `tools` never appears in the request |
| **Agent** | Injects an agent preamble plus tool definitions, and can call tools over several rounds |

Agent mode and plain chat are separate paths: the agent owns its own think → call tool → read
result loop, its own block-per-step view (not chat bubbles) and its own IPC channel, and
neither path branches on the other.

Agent mode offers three permission levels: *ask every time*, *ask for risky only* (default)
and *automatic*.

### MCP servers

Add servers under *Settings → MCP*. Configuration lives in `<data dir>/mcp.json` and is
compatible with Claude Desktop and VS Code, so their config files can be imported directly.

```jsonc
{
  "mcpServers": {
    "filesystem": {
      // stdio: LumiLM launches this command and talks to it
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "D:/work"],
      "enabled": true,
      "autoConnect": true,
      "toolAllowlist": ["read_file", "list_directory"]
    },
    "remote": {
      // http / sse are remote transports and must be allowed in Settings → Agent
      "transport": "http",
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer …" }
    }
  }
}
```

- stdio servers need **Node.js** on the machine. LumiLM probes for `node` and `npx` and
  says so clearly when they are missing; plain chat still works either way.
- An MCP server is third-party code running as you. Adding one shows a warning, and
  imported configs always land **disabled** so you enable them one by one.
- Prompts exposed by a connected server become `/` slash commands in the composer.

### Skills

Add skill folders under *Settings → Skills*. LumiLM looks recursively for `SKILL.md`:

```markdown
---
name: pdf-tools
description: Read, split and merge PDF files
allowed-tools:          # optional: narrow the tools this skill may see
  - mcp__filesystem__read_file
---

The detailed instructions the model only sees once it loads the skill.
```

A plain JSON file (`{ "name": …, "description": …, "systemPrompt": … }`) works too.

Skills are disclosed in three levels to keep the context small: metadata (always) → body
(when the model calls `skills.load`) → bundled files (via `skills.read_resource`).

### Built-in tools (loaded on demand)

The model can act without any MCP server. Built-in tools are **off by default**; enable them
per group in the Tools panel of the Inspector or under *Settings → Agent*:

| Group | Tools | Permission |
| --- | --- | --- |
| File tools | `read_file` `write_file` `list_files` `search_files` | reads are read-only; `write_file` asks |
| Command tool | `run_command` | asks on every call |

- The five definitions cost roughly 300 tokens. For a small local model a lean tool list
  beats a complete one, so only **enabled** tools reach the model's tool list.
- The **working directory** bounds the file tools and defaults to your home directory.
  `run_command` runs a real shell command, and a command can leave that directory, which is
  why it is rated destructive and always needs an approval.
- When the model asks for a tool that is not loaded, the UI says so instead of failing
  silently.
- Commands time out after 60 seconds, their output is capped, and cancelling a turn kills
  the whole process tree.

#### How the model calls a tool

Small local models do not use OpenAI's native `tool_calls` field; they write the call as a
JSON block. So the agent prompt states the convention explicitly and requires the model to
stop and wait right after writing it:

````json
{"name": "builtin__list_files", "arguments": {"path": "."}}
````

- The prompt forbids inventing, describing or summarising a result, and forbids continuing as
  though the tool had already run.
- LumiLM parses the call, actually executes it, and hands the real result back as the next
  message.
- Parsing is lenient: `name` / `tool` / `tool_name` / `action` / `function` are all accepted,
  parameters may be nested under `arguments` or flattened next to the name, and `//` comments
  plus trailing commas are stripped first.
- **Text after a call is discarded.** Whatever the model writes once it has emitted a call is
  usually an invented result, so only the prose before the call is kept.
- When the model asks for a tool that is not loaded, the UI says so instead of failing
  silently.

### Thinking intensity

Above the agent composer there is a three-position switch — **Unlimited / Brief / Minimal** —
with a default for new conversations under *Settings → Agent*.

Thinking is real generation time, which hurts most on low-end machines, so LumiLM caps it with
llama.cpp's `--reasoning-budget` (roughly 256 / 64 tokens) and injects a short nudge to answer
when the budget runs out.

Two caveats worth knowing:

- The flag only applies at model start-up, so changing the level reloads the model. It is not a
  request parameter because the mainstream DeepSeek-V3/R1-style templates ignore
  `enable_thinking` and `reasoning_effort`, a `reasoning_budget` in the request body has no
  effect, and `/props` does not support runtime changes.
- The levels **cap** thinking rather than turn it off. A budget of 0 does not remove the
  reasoning — it leaks it into the visible answer — so LumiLM deliberately offers no "off".

### Context budget

Tool output is what blows up a context window, so on low-end machines LumiLM:

- truncates each tool result to a configurable limit (8000 characters by default),
- replaces the **oldest** tool results with a one-line placeholder when the budget is tight,
- then drops the oldest tool-calling rounds in pairs, never leaving an orphaned result,
- and reports how many tokens the tool definitions themselves cost so you can prune them.

## Digital companion

A third mode beside plain chat and Agent. It carries no tools at all — only a persona and
its memory — and is meant to be a local companion that remembers you over time.

### How the three modes differ

| Mode | Prompt injection | Tools | Memory |
|---|---|---|---|
| Plain chat | none | none | none |
| Companion | persona + relationship + memories | none | L1 / L2 / L3 |
| Agent | customisable template | MCP / skills | none |

Leaving the tool schemas out frees roughly 1400 tokens for the persona and memory.

### Character cards

- A built-in sample card, "Lumi", whose default relationship is a close companion
- Import and export **SillyTavern V2** cards (`.json` / `.png`)
- Or start from a blank card and write only the persona you want
- Personas are capped by a token limit (960 by default) and trimmed on line boundaries,
  with a warning when that happens
- A companion conversation is marked with a heart in the sidebar and its mode is locked
  once you have talked in it — an empty one can still be switched back, so a stray click
  is recoverable. Companion is never the inherited default for 新建对话

### Layered memory

| Layer | Content | Stored in |
|---|---|---|
| L1 working | the relationship and facts injected this turn | the request only — never written, never shown in the transcript |
| L2 session | rolling summary and turn count | per conversation, for continuity |
| L3 long-term | structured facts and an event timeline | `memory.json` (atomic writes), exportable and importable |

Recall scores by `0.6 × lexical + 0.2 × recency + 0.2 × importance`. Chinese is indexed
with bigrams, so short phrases still hit. Pinned and boundary facts are **guaranteed a
slot** and cannot be budgeted out; a fact that comes up again is merged and its
reinforcement count incremented rather than duplicated.

**KV-cache friendly.** The persona is a stable prefix (byte-identical turn to turn, so it
stays cacheable) while the relationship and memories are appended to the newest user
message as an injection block that exists only for the duration of the request.

### Background memory extraction

600 ms after a reply, an extraction pass runs in the background reusing the **KV cache of
the turn that just finished** — about 2.7 s in practice.

It reads only the user's own words. It does **not** read:

- the assistant's replies, which it would otherwise re-learn as facts about you,
- the injected memory block, which it would otherwise index as new facts
  ("affinity 60/100" and so on, accumulating every turn),
- hedged statements — "some kind of", "probably", "inferred from", "not stated" are all dropped,
- "nothing special happened today" style reports, which are the absence of a fact,
- comparisons of the assistant with other people, and armchair psychology like
  "wants attention" that the user never actually said.

Results land in a pending queue and take part in nothing until you accept them.

### Silent consolidation (deduplication)

After extraction, a **separate call** decides what each new fact is in relation to what is
already stored: `same` (the same thing), `supersede` (a contradiction, the newer one wins) or
`new`.

- **It can only ever return a decision, never text.** The output is just `{i, op, of}`, and
  every field is validated: the index must address a real draft, the number must resolve to a
  real row, and anything else falls back to the lexical check. Even if the model echoed the
  memory-strategy prompt verbatim, none of it could reach the store.
- Its context is two short tables (≤12 catalogue rows + ≤6 candidates) and **does not grow with
  the conversation**. The catalogue is deliberately *not* folded into the extraction call —
  measured, the model then copies a catalogue entry straight into its facts array.
- **The model never judges dates.** Asked to tell "the same event again" from "a different
  event", accuracy dropped to 10/13 on a one-line wording change. With the model answering only
  `new` / `same` / `supersede` and the turn's own timestamp deciding whether a timeline entry is
  added, it measured 13/13. The cost is ~490 prompt tokens, ~25 generated tokens, no thinking
  tokens, about a second.
- A merge **never rewrites the stored wording**, and no failure path loses a fact: anything that
  cannot be applied is stored as new with the lexical backstop.

### Temporal depth

An objective event that happens repeatedly is kept as **one row** with one dated occurrence per
instance (date, the wording used at the time, the conversation it came from):

- mentioning it twice in one day counts once,
- the library shows `×3 · 04-12` and expands to the full timeline, where single entries can be
  deleted,
- the prompt gets "用户加班到很晚（已发生 3 次，最近一次是昨天）" — "worked late again
  (3×, most recently yesterday)",
- opinions, feelings, goals and preferences never get a timeline: repeating those is `same`,
  not another occurrence.

### Tidy up

A one-off check over what is **already** stored, for the noise that accumulated before these
rules existed: the tightened filters, verbatim duplicates (pure lexical, **no model needed**),
and semantic duplicates via the consolidation pass.

It only ever proposes. Each suggestion is a checkbox, and applying one archives the losing row
rather than deleting it, so it can be brought back at any time. The offline half works with the
model unloaded.

### Proactive wake-ups

A main-process timer combines system idle detection (`powerMonitor`) with a probability:

- consecutive wake-ups back off exponentially (`0.5^streak`, floor 1/16), with a randomised
  5–20 minute cooldown so it never becomes a nuisance,
- quiet hours (including across midnight) and a manual snooze are supported,
- it raises a system notification that focuses the window when clicked, and proactive
  messages are marked as such in the transcript,
- above the composer you can trigger one right now, or ask it to "dream" (reflect).

### Thinking intensity

Companion mode **skips the thinking block by default**: measured time-to-first-token drops
from 13167 ms to 1741 ms, a greeting takes 638 ms, and the output stays better in
character. It can be turned on when you want the reasoning.

The skip works by prefilling one space into the assistant turn so the model continues from
there. It is a per-request parameter and needs **no model reload** — unlike the Agent
mode's `--reasoning-budget`, which only takes effect at start-up.

### Memory library (data sovereignty)

The memory library in the sidebar lets you:

- browse every fact like a diary, filter by kind / subject / status, and search,
- edit, pin, hide, archive or delete individual facts, or forget everything at once,
- bring back a fact that was replaced, at the click of a button,
- see `×3 · <date>` on anything that repeats and expand its full timeline,
- filter to "repeats only" to see what keeps coming back,
- run "Tidy up" to review duplicate and noisy rows before anything changes,
- accept or reject the pending queue in bulk,
- see and hand-edit affinity, nickname, stage and mood in the relationship panel,
- read the event timeline and session summaries.

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
- **Extensions are opt-in.** Their dependencies are compiled into the main process bundle,
  so no extra runtime folder is shipped and the plain chat path never touches them.

## Where data lives

| Content | Path |
|---|---|
| Settings | `%APPDATA%\LumiLM\settings.json` |
| Conversations | `%APPDATA%\LumiLM\conversations\*.json` |
| Presets | `%APPDATA%\LumiLM\presets.json` |
| Attachments | `%APPDATA%\LumiLM\attachments\` |
| Skills (default folder) | `%APPDATA%\LumiLM\skills\` |
| MCP configuration | `%APPDATA%\LumiLM\mcp.json` |
| Memory library | `%APPDATA%\LumiLM\memory\memory.json` |
| Companion state (heartbeat, relationship) | `%APPDATA%\LumiLM\memory\heartbeat.json` |
| Character cards | `%APPDATA%\LumiLM\personas\*.json` |
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
