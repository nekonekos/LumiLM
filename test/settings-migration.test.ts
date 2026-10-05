import { describe, expect, it, vi } from 'vitest'

// The settings store resolves its file through electron's app paths.
vi.mock('electron', async () => {
  const { tmpdir } = await import('node:os')
  return {
    app: { getPath: () => tmpdir(), getAppPath: () => process.cwd(), isPackaged: false }
  }
})

const { normalizeSettings, DEFAULT_SETTINGS } = await import('../src/main/store/settings')
const { DEFAULT_AGENT_PREAMBLE, SUPERSEDED_AGENT_PREAMBLES } = await import('@shared/types')

describe('normalizeSettings', () => {
  it('fills in every missing key', () => {
    const { settings } = normalizeSettings({})
    expect(settings).toEqual(DEFAULT_SETTINGS)
  })

  it('keeps stored values', () => {
    const { settings } = normalizeSettings({ general: { locale: 'en-US' } })
    expect(settings.general.locale).toBe('en-US')
    expect(settings.general.themeMode).toBe(DEFAULT_SETTINGS.general.themeMode)
  })

  it('migrates the old workspaceToolsEnabled switch onto the file tools', () => {
    const { settings, migrated } = normalizeSettings({ agent: { workspaceToolsEnabled: true } })
    expect(migrated).toBe(true)
    expect(settings.agent.fileToolsEnabled).toBe(true)
    expect(settings.agent.shellToolsEnabled).toBe(false)
    expect('workspaceToolsEnabled' in settings.agent).toBe(false)
  })

  it('leaves the file tools off when the old switch was off', () => {
    const { settings, migrated } = normalizeSettings({ agent: { workspaceToolsEnabled: false } })
    expect(migrated).toBe(true)
    expect(settings.agent.fileToolsEnabled).toBe(false)
    expect('workspaceToolsEnabled' in settings.agent).toBe(false)
  })

  it('does not report a migration when there is nothing to migrate', () => {
    const { migrated } = normalizeSettings({ agent: { workspaceRoot: '/w' } })
    expect(migrated).toBe(false)
  })

  it('replaces a stored copy of an older default preamble', () => {
    const { settings, migrated } = normalizeSettings({
      agent: { preambleTemplate: SUPERSEDED_AGENT_PREAMBLES[0] }
    })
    expect(migrated).toBe(true)
    expect(settings.agent.preambleTemplate).toBe(DEFAULT_AGENT_PREAMBLE)
  })

  it('recognises an older default written with windows line endings', () => {
    const crlf = SUPERSEDED_AGENT_PREAMBLES[0].replace(/\r?\n/g, '\r\n')
    const { settings, migrated } = normalizeSettings({ agent: { preambleTemplate: crlf } })
    expect(migrated).toBe(true)
    expect(settings.agent.preambleTemplate).toBe(DEFAULT_AGENT_PREAMBLE)
  })

  it('never overwrites a preamble the user wrote', () => {
    const { settings, migrated } = normalizeSettings({ agent: { preambleTemplate: 'be terse' } })
    expect(migrated).toBe(false)
    expect(settings.agent.preambleTemplate).toBe('be terse')
  })

  it('leaves the current default alone', () => {
    const { settings, migrated } = normalizeSettings({
      agent: { preambleTemplate: DEFAULT_AGENT_PREAMBLE }
    })
    expect(migrated).toBe(false)
    expect(settings.agent.preambleTemplate).toBe(DEFAULT_AGENT_PREAMBLE)
  })

  it('defaults both groups to off', () => {
    const { settings } = normalizeSettings({})
    expect(settings.agent.fileToolsEnabled).toBe(false)
    expect(settings.agent.shellToolsEnabled).toBe(false)
  })
})
