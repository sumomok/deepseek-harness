/** The self-contained checks one console composition file answers by itself. */

import { describe, expect, it } from 'vitest'
import { resolveServers } from '@deepseek-ai/dsh-experimental-console-mcp/src/servers.ts'
import type { ServerRequest } from '@deepseek-ai/dsh-experimental-console-mcp/src/servers.ts'

/**
 * One usable server, for a test to spoil in exactly one way.
 * @param overrides - the fields this case is about.
 * @returns the server request.
 */
function server(overrides: Partial<ServerRequest> = {}): ServerRequest {
  return { id: 'iot', url: 'https://mcp.example.test/mcp', ...overrides }
}

describe('resolveServers', () => {
  it('returns an empty list unchanged', () => {
    expect(resolveServers([])).toEqual([])
  })

  it('keeps the written order and normalizes the endpoint', () => {
    const specs = resolveServers([server({ id: 'a' }), server({ id: 'b', url: 'https://mcp.example.test/mcp' })])
    expect(specs.map(spec => spec.id)).toEqual(['a', 'b'])
    expect(specs[0]?.url).toBe('https://mcp.example.test/mcp')
  })

  it('carries a server that names no credential', () => {
    expect(resolveServers([server()])[0]?.auth).toBeUndefined()
  })

  it('carries the pass-through fields a deployment set', () => {
    const [spec] = resolveServers([server({ toolCallTimeoutMs: 5_000, failOnStartupError: true })])
    expect(spec?.toolCallTimeoutMs).toBe(5_000)
    expect(spec?.failOnStartupError).toBe(true)
  })

  it('refuses an id outside the tool-namespace grammar', () => {
    expect(() => resolveServers([server({ id: 'has space' })])).toThrow(/server id "has space"/)
    expect(() => resolveServers([server({ id: 'x'.repeat(33) })])).toThrow(/must match/)
  })

  it('refuses two servers claiming one id', () => {
    expect(() => resolveServers([server(), server()])).toThrow(/two servers claim the id "iot"/)
  })

  it('refuses a url the parser cannot read, without quoting it', () => {
    const thrown = (): void => { resolveServers([server({ url: 'not a url' })]) }
    expect(thrown).toThrow(/not an absolute URL/)
    expect(thrown).not.toThrow(/not a url/)
  })

  it('refuses a non-http scheme', () => {
    expect(() => resolveServers([server({ url: 'ftp://mcp.example.test/mcp' })])).toThrow(/http or https/)
  })

  it('refuses credentials written into the url', () => {
    expect(() => resolveServers([server({ url: 'https://user:pw@mcp.example.test/mcp' })]))
      .toThrow(/must not write a user name or password/)
  })

  it('refuses a fragment the transport would never send', () => {
    expect(() => resolveServers([server({ url: 'https://mcp.example.test/mcp#frag' })]))
      .toThrow(/must not write a fragment/)
  })

  it('refuses a header name that is not a header name', () => {
    expect(() => resolveServers([server({ auth: { header: 'bad header', credential: 'IOT_TOKEN', scheme: '' } })]))
      .toThrow(/which is not a header name/)
  })

  it('refuses a credential reference outside the reference grammar', () => {
    expect(() => resolveServers([server({ auth: { header: 'Authorization', credential: 'not-a-ref', scheme: '' } })]))
      .toThrow(/which is not a credential reference/)
  })

  it('accepts a server that names a credential', () => {
    const [spec] = resolveServers([server({
      auth: { header: 'Authorization', credential: 'IOT_MCP_TOKEN', scheme: 'Bearer ' },
    })])
    expect(spec?.auth).toEqual({ header: 'Authorization', credential: 'IOT_MCP_TOKEN', scheme: 'Bearer ' })
  })
})
