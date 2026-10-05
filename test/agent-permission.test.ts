import { describe, expect, it } from 'vitest'
import { decidePermission, toolKey } from '../src/main/agent/permission'

describe('decidePermission', () => {
  it('asks for everything under ask-all', () => {
    expect(decidePermission('ask-all', 'read-only', null)).toBe('ask')
    expect(decidePermission('ask-all', 'destructive', null)).toBe('ask')
  })

  it('only asks for risky tools under ask-risky', () => {
    expect(decidePermission('ask-risky', 'read-only', null)).toBe('allow')
    expect(decidePermission('ask-risky', 'destructive', null)).toBe('ask')
  })

  it('never asks under auto', () => {
    expect(decidePermission('auto', 'read-only', null)).toBe('allow')
    expect(decidePermission('auto', 'destructive', null)).toBe('allow')
  })

  it('lets a per tool override win over the policy', () => {
    expect(decidePermission('auto', 'destructive', 'deny')).toBe('deny')
    expect(decidePermission('ask-all', 'destructive', 'allow')).toBe('allow')
  })

  it('allows an explicit ask override to add a prompt', () => {
    expect(decidePermission('ask-risky', 'read-only', 'ask')).toBe('ask')
    expect(decidePermission('auto', 'read-only', 'ask')).toBe('ask')
  })
})

describe('toolKey', () => {
  it('namespaces the tool under its server', () => {
    expect(toolKey({ serverId: 'fs', toolName: 'read' })).toBe('fs::read')
  })

  it('uses a stable bucket for built-in tools', () => {
    expect(toolKey({ serverId: null, toolName: 'skills_load' })).toBe('builtin::skills_load')
  })
})
