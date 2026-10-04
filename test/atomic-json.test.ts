import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readJsonSync, writeJsonAtomicSync } from '../src/main/util/atomic-json'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lumilm-atomic-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('writeJsonAtomicSync', () => {
  it('writes readable JSON and creates missing directories', () => {
    const file = join(dir, 'nested', 'deep', 'settings.json')
    writeJsonAtomicSync(file, { theme: 'light', count: 2 })

    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ theme: 'light', count: 2 })
  })

  it('does not leave a temp file behind', () => {
    const file = join(dir, 'a.json')
    writeJsonAtomicSync(file, { ok: true })
    expect(() => readFileSync(`${file}.tmp`, 'utf8')).toThrow()
  })

  it('keeps the previous revision as a backup', () => {
    const file = join(dir, 'a.json')
    writeJsonAtomicSync(file, { revision: 1 })
    writeJsonAtomicSync(file, { revision: 2 })

    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ revision: 2 })
    expect(JSON.parse(readFileSync(`${file}.bak`, 'utf8'))).toEqual({ revision: 1 })
  })
})

describe('readJsonSync', () => {
  it('returns null for a missing file', () => {
    expect(readJsonSync(join(dir, 'missing.json'))).toBeNull()
  })

  it('returns null for an empty file', () => {
    const file = join(dir, 'empty.json')
    writeFileSync(file, '   ', 'utf8')
    expect(readJsonSync(file)).toBeNull()
  })

  it('falls back to the backup when the primary file is corrupt', () => {
    const file = join(dir, 'a.json')
    writeJsonAtomicSync(file, { revision: 1 })
    writeJsonAtomicSync(file, { revision: 2 })

    writeFileSync(file, '{ not json', 'utf8')
    expect(readJsonSync<{ revision: number }>(file)).toEqual({ revision: 1 })
  })

  it('returns null when both the file and its backup are unusable', () => {
    const file = join(dir, 'a.json')
    writeFileSync(file, 'garbage', 'utf8')
    writeFileSync(`${file}.bak`, 'garbage too', 'utf8')
    expect(readJsonSync(file)).toBeNull()
  })
})
