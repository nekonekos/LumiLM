import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

const root = process.cwd()

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(root, 'src/shared')
    }
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globals: true,
    reporters: ['default']
  }
})
