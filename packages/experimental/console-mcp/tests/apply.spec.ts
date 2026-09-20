/**
 * The console MCP row's lifecycle: what it mounts, what it refuses, and what
 * it puts on the wire for a server that names a credential.
 *
 * Isolated file so the MCP SDK mock does not reach the other suite.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type {
  CredentialInfo, CredentialKey, CredentialRecord, CredentialRecordEntry,
  CredentialRecordInfo, CredentialRef, ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'

const { mockConnect, mockClose, mockRequest, MockClient, MockHttpTransport, transportCalls } = vi.hoisted(() => {
  const mockConnect = vi.fn<() => Promise<void>>()
  const mockClose = vi.fn<() => Promise<void>>()
  const mockRequest = vi.fn(async (request: { method: string }): Promise<unknown> => {
    if (request.method === 'tools/list') {
      return await Promise.resolve({ tools: [{ name: 'ping', description: 'ping', inputSchema: { type: 'object' } }] })
    }
    throw new Error(`unexpected MCP request: ${request.method}`)
  })
  class MockClient {
    connect = mockConnect
    close = mockClose
    request = mockRequest
    setNotificationHandler = vi.fn()
  }
  const transportCalls: { url: URL; options: { requestInit?: { headers?: Record<string, string> } } }[] = []
  // A constructor function rather than a class: the only thing under test is
  // what the bridge hands the transport, and the SDK is only ever `new`ed.
  function MockHttpTransport(
    this: object, url: URL, options: { requestInit?: { headers?: Record<string, string> } },
  ): void {
    transportCalls.push({ url, options })
  }
  return { mockConnect, mockClose, mockRequest, MockClient, MockHttpTransport, transportCalls }
})

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({ Client: MockClient }))
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({ StdioClientTransport: vi.fn() }))
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: MockHttpTransport,
}))

import { apply, inject, name, Config as ConfigSchema } from '@deepseek-ai/dsh-experimental-console-mcp/src/index.ts'

/** The one secret this suite stores, and the only place its text appears. */
const SECRET = 's3cret-token-value'

/** A credentials provider holding exactly the references a test stored. */
class TestCredentials extends CredentialProvider {
  readonly values = new Map<string, string>()

  override resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const value = this.values.get(ref)
    return Promise.resolve(value === undefined ? undefined : { value, source: 'env' })
  }

  override describe(_ref: CredentialRef): Promise<CredentialInfo> {
    return Promise.resolve({ configured: false, writable: false })
  }

  override set(_ref: CredentialRef, _value: string): Promise<void> {
    return Promise.resolve()
  }

  override unset(_ref: CredentialRef): Promise<void> {
    return Promise.resolve()
  }

  override readRecord(_key: CredentialKey): Promise<CredentialRecord | undefined> {
    return Promise.resolve(undefined)
  }

  override describeRecord(_key: CredentialKey): Promise<CredentialRecordInfo> {
    return Promise.resolve({ configured: false, writable: false })
  }

  override listRecords(): Promise<readonly CredentialRecordEntry[]> {
    return Promise.resolve([])
  }

  override modifyRecord(
    _key: CredentialKey,
    _mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    return Promise.resolve(undefined)
  }

  override deleteRecord(_key: CredentialKey): Promise<void> {
    return Promise.resolve()
  }
}

/**
 * A host carrying the tool registry and a credentials provider.
 * @returns the context and the credential store a test writes into.
 */
async function mountHost(): Promise<{ ctx: Context; credentials: TestCredentials }> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const credentials = new TestCredentials(ctx)
  return { ctx, credentials }
}

/**
 * Whether a bridged tool is on the model's roster.
 * @param ctx - the host context.
 * @param name - the public tool name.
 * @returns true once the tool is registered.
 */
function hasTool(ctx: Context, name: string): boolean {
  return ctx.tools.get(name) !== undefined
}

beforeEach(() => {
  transportCalls.length = 0
  mockConnect.mockReset()
  mockConnect.mockResolvedValue(undefined)
  mockClose.mockReset()
  mockClose.mockResolvedValue(undefined)
  mockRequest.mockClear()
})

describe('console-mcp module exports', () => {
  it('names itself and requires only the credential seam', () => {
    expect(name).toBe('console-mcp')
    expect(inject).toEqual(['credentials'])
  })

  it('defaults the server list to empty', () => {
    expect(ConfigSchema({}).servers).toEqual([])
  })

  it('defaults a credential scheme to no prefix', () => {
    const resolved = ConfigSchema({
      servers: [{ id: 'iot', url: 'https://mcp.example.test/mcp', auth: { header: 'Authorization', credential: 'T' } }],
    })
    expect(resolved.servers[0]?.auth?.scheme).toBe('')
  })
})

describe('console-mcp apply', () => {
  it('loads idle with no server: no connection, no tool', async () => {
    const { ctx } = await mountHost()
    await apply(ctx, { servers: [] })
    expect(transportCalls).toEqual([])
    expect(mockConnect).not.toHaveBeenCalled()
    expect(hasTool(ctx, 'mcp__iot__ping')).toBe(false)
  })

  it('mounts one bridge per server under its own tool namespace', async () => {
    const { ctx } = await mountHost()
    await apply(ctx, {
      servers: [
        { id: 'iot', url: 'https://mcp.example.test/mcp' },
        { id: 'crm', url: 'https://crm.example.test/mcp' },
      ],
    })
    expect(hasTool(ctx, 'mcp__iot__ping')).toBe(true)
    expect(hasTool(ctx, 'mcp__crm__ping')).toBe(true)
    expect(transportCalls.map(call => call.url.href)).toEqual([
      'https://mcp.example.test/mcp', 'https://crm.example.test/mcp',
    ])
  })

  it('spends a named credential on the configured header, behind its scheme', async () => {
    const { ctx, credentials } = await mountHost()
    credentials.values.set('IOT_MCP_TOKEN', SECRET)
    await apply(ctx, {
      servers: [{
        id: 'iot',
        url: 'https://mcp.example.test/mcp',
        auth: { header: 'Authorization', credential: 'IOT_MCP_TOKEN', scheme: 'Bearer ' },
      }],
    })
    expect(transportCalls[0]?.options.requestInit?.headers).toEqual({ Authorization: `Bearer ${SECRET}` })
  })

  it('attaches no header for a server that names no credential', async () => {
    const { ctx } = await mountHost()
    await apply(ctx, { servers: [{ id: 'iot', url: 'https://mcp.example.test/mcp' }] })
    expect(transportCalls[0]?.options.requestInit?.headers).toEqual({})
  })

  it('fails loud when a named credential has no value, naming the reference only', async () => {
    const { ctx } = await mountHost()
    await expect(apply(ctx, {
      servers: [{
        id: 'iot',
        url: 'https://mcp.example.test/mcp',
        auth: { header: 'Authorization', credential: 'IOT_MCP_TOKEN', scheme: 'Bearer ' },
      }],
    })).rejects.toThrow(/server "iot" names credential "IOT_MCP_TOKEN", which nothing has stored a value for/)
    expect(hasTool(ctx, 'mcp__iot__ping')).toBe(false)
  })

  it('mounts nothing when one entry of the list is unusable', async () => {
    const { ctx } = await mountHost()
    await expect(apply(ctx, {
      servers: [
        { id: 'iot', url: 'https://mcp.example.test/mcp' },
        { id: 'iot', url: 'https://other.example.test/mcp' },
      ],
    })).rejects.toThrow(/two servers claim the id "iot"/)
    expect(transportCalls).toEqual([])
    expect(hasTool(ctx, 'mcp__iot__ping')).toBe(false)
  })

  it('passes the call timeout and startup policy a deployment set through', async () => {
    const { ctx } = await mountHost()
    await apply(ctx, {
      servers: [{
        id: 'iot', url: 'https://mcp.example.test/mcp', toolCallTimeoutMs: 5_000, failOnStartupError: true,
      }],
    })
    expect(hasTool(ctx, 'mcp__iot__ping')).toBe(true)
  })
})
