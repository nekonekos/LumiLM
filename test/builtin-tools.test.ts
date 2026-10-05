import { mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BUILTIN_TOOL_GROUPS } from '@shared/builtin-tools'
import { FILE_TOOL_DEFS, effectiveWorkspaceRoot } from '../src/main/tools/workspace'
import { SHELL_TOOL_DEFS } from '../src/main/tools/shell'
import type { BuiltinToolDef } from '../src/main/tools/types'

// The built-in tools reach into the settings store for path helpers, which pulls
// in electron. Only `app` is needed here.
vi.mock('electron', async () => {
  const { tmpdir } = await import('node:os')
  return {
    app: {
      getPath: () => tmpdir(),
      getAppPath: () => process.cwd(),
      isPackaged: false,
      getName: () => 'LumiLM'
    }
  }
})

function defByName(defs: BuiltinToolDef[], toolName: string): BuiltinToolDef {
  const def = defs.find((candidate) => candidate.toolName === toolName)
  if (!def) throw new Error(`${toolName} is not registered`)
  return def
}

const shellTool = (): BuiltinToolDef => defByName(SHELL_TOOL_DEFS, 'run_command')

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lumilm-tools-'))
})

describe('built-in tool groups', () => {
  it('lists exactly the tools the main process registers', () => {
    expect(FILE_TOOL_DEFS.map((def) => def.toolName)).toEqual([...BUILTIN_TOOL_GROUPS.file])
    expect(SHELL_TOOL_DEFS.map((def) => def.toolName)).toEqual([...BUILTIN_TOOL_GROUPS.shell])
  })

  it('keeps every description to a single line', () => {
    for (const def of [...FILE_TOOL_DEFS, ...SHELL_TOOL_DEFS]) {
      expect(def.description, def.toolName).not.toContain('\n')
    }
  })

  it('keeps the schemas small enough for a local model', () => {
    const bytes = JSON.stringify([...FILE_TOOL_DEFS, ...SHELL_TOOL_DEFS].map((d) => d.inputSchema))
    expect(bytes.length).toBeLessThan(1200)
  })

  it('rates the readers read-only and the writers destructive', () => {
    const risk = Object.fromEntries(FILE_TOOL_DEFS.map((def) => [def.toolName, def.risk]))
    expect(risk.read_file).toBe('read-only')
    expect(risk.list_files).toBe('read-only')
    expect(risk.search_files).toBe('read-only')
    expect(risk.write_file).toBe('destructive')
    expect(shellTool().risk).toBe('destructive')
  })
})

describe('effectiveWorkspaceRoot', () => {
  it('falls back to the home directory when nothing is configured', () => {
    expect(effectiveWorkspaceRoot(null)).toBe(homedir())
    expect(effectiveWorkspaceRoot('   ')).toBe(homedir())
  })

  it('resolves a configured root', () => {
    expect(effectiveWorkspaceRoot(root)).toBe(root)
  })
})

describe('file tools', () => {
  it('lists a directory', async () => {
    writeFileSync(join(root, 'a.txt'), 'hello')
    const result = await defByName(FILE_TOOL_DEFS, 'list_files').run(root, { path: '.' })
    expect(result.ok).toBe(true)
    expect(result.content).toBe('a.txt')
  })

  it('reads a file inside the root', async () => {
    writeFileSync(join(root, 'a.txt'), 'hello')
    const result = await defByName(FILE_TOOL_DEFS, 'read_file').run(root, { path: 'a.txt' })
    expect(result.content).toBe('hello')
  })

  it('refuses to leave the root', async () => {
    const result = await defByName(FILE_TOOL_DEFS, 'read_file').run(root, { path: '../escape.txt' })
    expect(result.ok).toBe(false)
    expect(result.content).toContain('refused')
  })

  it('reports a missing file rather than throwing', async () => {
    const result = await defByName(FILE_TOOL_DEFS, 'read_file').run(root, { path: 'nope.txt' })
    expect(result.ok).toBe(false)
    expect(result.content).toContain('not found')
  })

  it('writes a file and reports the size', async () => {
    const result = await defByName(FILE_TOOL_DEFS, 'write_file').run(root, {
      path: 'b.txt',
      content: 'hey'
    })
    expect(result.ok).toBe(true)
    expect(result.content).toContain('wrote 3 bytes')
  })

  it('reports a missing argument instead of failing the turn', async () => {
    const result = await defByName(FILE_TOOL_DEFS, 'read_file').run(root, {})
    expect(result.ok).toBe(false)
    expect(result.content).toContain('missing required argument')
  })
})

describe('run_command', () => {
  it('returns the output of a successful command', async () => {
    const result = await shellTool().run(root, { command: 'node -p "40 + 2"' })
    expect(result.ok).toBe(true)
    expect(result.content.trim()).toBe('42')
  })

  it('reports a non-zero exit code', async () => {
    const result = await shellTool().run(root, { command: 'node -e "process.exit(3)"' })
    expect(result.ok).toBe(false)
    expect(result.content).toContain('[exit 3]')
  })

  it('refuses an empty command', async () => {
    expect((await shellTool().run(root, { command: '   ' })).ok).toBe(false)
  })

  it('refuses a command that would destroy the machine', async () => {
    for (const command of ['mkfs.ext4 /dev/sda', 'diskpart', 'shutdown /s', 'rm -rf /']) {
      const result = await shellTool().run(root, { command })
      expect(result.ok, command).toBe(false)
      expect(result.content, command).toContain('refused')
    }
  })

  it('leaves ordinary commands alone', async () => {
    const result = await shellTool().run(root, { command: 'node -p "1"' })
    expect(result.ok).toBe(true)
  })

  it('kills the command when the turn is aborted', async () => {
    const controller = new AbortController()
    const started = Date.now()
    const pending = shellTool().run(
      root,
      { command: 'node -e "setTimeout(() => {}, 30000)"' },
      controller.signal
    )
    setTimeout(() => controller.abort(), 50)
    const result = await pending
    expect(result.ok).toBe(false)
    expect(result.content).toContain('[cancelled]')
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  it('refuses an absurdly long command', async () => {
    const result = await shellTool().run(root, { command: `echo ${'a'.repeat(3000)}` })
    expect(result.ok).toBe(false)
    expect(result.content).toContain('exceeds')
  })
})
