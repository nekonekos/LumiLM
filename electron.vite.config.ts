import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'

const root = process.cwd()

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve(root, 'src/shared')
      }
    },
    build: {
      outDir: 'out/main',
      rollupOptions: {
        input: { index: resolve(root, 'src/main/index.ts') }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve(root, 'src/shared')
      }
    },
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: { index: resolve(root, 'src/preload/index.ts') }
      }
    }
  },
  renderer: {
    root: resolve(root, 'src/renderer'),
    resolve: {
      alias: {
        '@': resolve(root, 'src/renderer/src'),
        '@shared': resolve(root, 'src/shared')
      }
    },
    plugins: [react(), tailwindcss()],
    build: {
      outDir: 'out/renderer',
      rollupOptions: {
        input: { index: resolve(root, 'src/renderer/index.html') },
        output: {
          manualChunks: {
            markdown: [
              'react-markdown',
              'remark-gfm',
              'remark-math',
              'rehype-katex',
              'rehype-highlight'
            ]
          }
        }
      }
    }
  }
})
