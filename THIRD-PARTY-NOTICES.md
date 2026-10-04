# 第三方组件许可 / Third-party notices

LumiLM 自身以 MIT 许可证发布。发布包中还包含以下第三方组件，
它们各自遵循自己的许可条款。

## llama.cpp（随包分发的推理后端）

- 项目：<https://github.com/ggml-org/llama.cpp>
- 使用方式：以预编译的 Windows x64 二进制形式随包分发
  （`resources/llama/{cpu,vulkan,cuda}`，版本记录于 `resources/llama/VERSION.json`）
- 许可证：MIT License

```
MIT License

Copyright (c) 2023-2024 The ggml authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

CUDA 构建中额外包含 NVIDIA CUDA 运行时库（`cudart`），
其分发受 [NVIDIA CUDA Toolkit EULA](https://docs.nvidia.com/cuda/eula/index.html) 约束。

## 运行时与界面依赖

以下依赖会被打包进渲染进程产物，全部为 MIT 或同等宽松许可：

| 组件 | 许可证 | 主页 |
|---|---|---|
| Electron | MIT | <https://github.com/electron/electron> |
| React / React DOM | MIT | <https://github.com/facebook/react> |
| zustand | MIT | <https://github.com/pmndrs/zustand> |
| lucide-react | ISC | <https://github.com/lucide-icons/lucide> |
| react-markdown | MIT | <https://github.com/remarkjs/react-markdown> |
| remark-gfm / remark-math | MIT | <https://github.com/remarkjs> |
| rehype-highlight / rehype-katex | MIT | <https://github.com/rehypejs> |
| KaTeX | MIT | <https://github.com/KaTeX/KaTeX> |
| highlight.js | BSD-3-Clause | <https://github.com/highlightjs/highlight.js> |
| Tailwind CSS | MIT | <https://github.com/tailwindlabs/tailwindcss> |
| clsx | MIT | <https://github.com/lukeed/clsx> |
| tailwind-merge | MIT | <https://github.com/dcastil/tailwind-merge> |

## 模型文件

LumiLM **不包含也不下载任何模型文件**。用户使用的 `.gguf` 模型由用户自行获取，
其许可条款取决于模型发布方，与本项目无关。
