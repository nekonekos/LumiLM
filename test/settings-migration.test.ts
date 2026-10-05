import { describe, expect, it, vi } from 'vitest'

// The settings store resolves its file through electron's app paths.
vi.mock('electron', async () => {
  const { tmpdir } = await import('node:os')
  return {
    app: { getPath: () => tmpdir(), getAppPath: () => process.cwd(), isPackaged: false }
  }
})

const { normalizeSettings, DEFAULT_SETTINGS } = await import('../src/main/store/settings')
const {
  DEFAULT_AGENT_PREAMBLE,
  DEFAULT_MEMORY_TEMPLATE,
  DEFAULT_PERSONA_TEMPLATE,
  SUPERSEDED_AGENT_PREAMBLES,
  SUPERSEDED_PERSONA_TEMPLATES
} = await import('@shared/types')

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

  it('forces the stored settings version up to the current one', () => {
    const { settings, migrated } = normalizeSettings({ version: 1 })
    expect(migrated).toBe(true)
    expect(settings.version).toBe(DEFAULT_SETTINGS.version)
  })

  it('replaces a stored copy of an older default persona template', () => {
    const { settings, migrated } = normalizeSettings({
      companion: { personaTemplate: SUPERSEDED_PERSONA_TEMPLATES[0] }
    })
    expect(migrated).toBe(true)
    expect(settings.companion.personaTemplate).toBe(DEFAULT_PERSONA_TEMPLATE)
  })

  it('never overwrites a persona template the user wrote', () => {
    const { settings, migrated } = normalizeSettings({
      companion: { personaTemplate: '你是一只猫。' }
    })
    expect(migrated).toBe(false)
    expect(settings.companion.personaTemplate).toBe('你是一只猫。')
  })

  it('replaces a stored copy of an older default memory template', () => {
    const older = '旧的记忆模板 {{relationship}} {{memories}}'
    const { settings } = normalizeSettings({ companion: { memoryTemplate: older } })
    // An unknown template is the user's own text, so it is left alone.
    expect(settings.companion.memoryTemplate).toBe(older)
    const { settings: fresh } = normalizeSettings({
      companion: { memoryTemplate: DEFAULT_MEMORY_TEMPLATE }
    })
    expect(fresh.companion.memoryTemplate).toBe(DEFAULT_MEMORY_TEMPLATE)
  })

  it('fills in the whole companion section for an older install', () => {
    const { settings } = normalizeSettings({ version: 1, agent: {}, skills: {} })
    expect(settings.companion.enabled).toBe(false)
    expect(settings.companion.memoryEnabled).toBe(true)
    expect(settings.companion.skipThinking).toBe(true)
    expect(settings.companion.characterCardId).toBe('builtin-lumi')
    expect(settings.companion.quietHours).toEqual([23, 8])
  })
})
