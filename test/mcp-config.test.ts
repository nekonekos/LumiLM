import { describe, expect, it } from 'vitest'
import { parseMcpConfig, parseServerEntry, slugifyId } from '../src/main/mcp/parse'

describe('slugifyId', () => {
  it('produces ids that are safe inside a function name', () => {
    expect(slugifyId('My Server!')).toBe('my_server')
    expect(slugifyId('a/b.c')).toBe('a_b_c')
  })

  it('never returns an empty id', () => {
    expect(slugifyId('!!!')).toBe('server')
  })
})

describe('parseServerEntry', () => {
  it('reads a stdio entry', () => {
    const server = parseServerEntry('filesystem', {
      command: 'npx',
      args: ['-y', 'pkg', 'D:/work'],
      env: { TOKEN: 'x' }
    })
    expect(server).toMatchObject({
      id: 'filesystem',
      name: 'filesystem',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'pkg', 'D:/work'],
      env: { TOKEN: 'x' },
      enabled: true,
      autoConnect: true,
      trusted: false
    })
  })

  it('infers the http transport when only a url is given', () => {
    expect(parseServerEntry('remote', { url: 'https://x.dev/mcp' })?.transport).toBe('http')
  })

  it('honours an explicit type field from a VS Code config', () => {
    const server = parseServerEntry('remote', { type: 'sse', url: 'https://x.dev/sse' })
    expect(server?.transport).toBe('sse')
  })

  it('rejects a stdio entry without a command', () => {
    expect(parseServerEntry('bad', { args: [] })).toBeNull()
  })

  it('rejects a remote entry without a url', () => {
    expect(parseServerEntry('bad', { transport: 'http' })).toBeNull()
  })

  it('rejects a non-object entry', () => {
    expect(parseServerEntry('bad', 'nope')).toBeNull()
    expect(parseServerEntry('bad', ['a'])).toBeNull()
  })

  it('defaults enabled flags to true but keeps an explicit false', () => {
    expect(parseServerEntry('a', { command: 'x', enabled: false })?.enabled).toBe(false)
    expect(parseServerEntry('a', { command: 'x', autoConnect: false })?.autoConnect).toBe(false)
  })

  it('drops non string values from arrays and records', () => {
    const server = parseServerEntry('a', {
      command: 'x',
      args: ['ok', 3, null],
      env: { A: 'keep', B: 2 }
    })
    expect(server?.args).toEqual(['ok'])
    expect(server?.env).toEqual({ A: 'keep', B: '2' })
  })

  it('never trusts an imported server implicitly', () => {
    expect(parseServerEntry('a', { command: 'x', trusted: true })?.trusted).toBe(true)
    expect(parseServerEntry('a', { command: 'x' })?.trusted).toBe(false)
  })
})

describe('parseMcpConfig', () => {
  it('accepts the Claude Desktop shape', () => {
    const parsed = parseMcpConfig({ mcpServers: { fs: { command: 'npx', args: ['-y', 'p'] } } })
    expect(parsed.servers).toHaveLength(1)
    expect(parsed.servers[0]?.id).toBe('fs')
  })

  it('accepts the VS Code shape', () => {
    const parsed = parseMcpConfig({ servers: { fs: { type: 'stdio', command: 'npx' } } })
    expect(parsed.servers).toHaveLength(1)
  })

  it('accepts the snake_case variant', () => {
    const parsed = parseMcpConfig({ mcp_servers: { fs: { command: 'npx' } } })
    expect(parsed.servers).toHaveLength(1)
  })

  it('reports a config with no server object', () => {
    const parsed = parseMcpConfig({ nothing: true })
    expect(parsed.servers).toEqual([])
    expect(parsed.rejected).toHaveLength(1)
  })

  it('reports unusable entries by name without failing the whole file', () => {
    const parsed = parseMcpConfig({
      mcpServers: { good: { command: 'npx' }, bad: { args: [] } }
    })
    expect(parsed.servers.map((server) => server.id)).toEqual(['good'])
    expect(parsed.rejected).toEqual(['bad'])
  })

  it('tolerates a scalar payload', () => {
    expect(parseMcpConfig('nope').servers).toEqual([])
    expect(parseMcpConfig(null).servers).toEqual([])
  })
})
