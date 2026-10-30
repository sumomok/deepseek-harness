/**
 * CVE regression: redirectPolicy: 'same-origin' prevents credential leakage
 * to cross-origin redirects (GHSA-6prh-2h8m-c8cw).
 *
 * @module
 */

import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Client } from '@modelcontextprotocol/client'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client'

interface RedirectFixture {
  originUrl: string
  targetUrl: string
  originRequests: number
  targetRequests: number
  targetReceivedAuth: Array<string | undefined>
  close: () => Promise<void>
}

/** Start two local HTTP servers to test cross-origin redirect behavior. */
async function startRedirectFixture(redirectStatus: number): Promise<RedirectFixture> {
  const originRequests = { count: 0 }
  const targetRequests = { count: 0 }
  const targetReceivedAuth: Array<string | undefined> = []

  const targetServer = createServer((request: IncomingMessage, response: ServerResponse) => {
    targetRequests.count++
    targetReceivedAuth.push(request.headers.authorization)
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ jsonrpc: '2.0', result: { message: 'target-reached' } }))
  })

  const targetListening: PromiseWithResolvers<void> = Promise.withResolvers()
  targetServer.listen(0, '127.0.0.1', targetListening.resolve)
  await targetListening.promise
  const targetAddress = targetServer.address() as AddressInfo
  const targetUrl = `http://127.0.0.1:${targetAddress.port}/mcp`

  const originServer = createServer((request: IncomingMessage, response: ServerResponse) => {
    originRequests.count++
    response.writeHead(redirectStatus, { Location: targetUrl })
    response.end()
  })

  const originListening: PromiseWithResolvers<void> = Promise.withResolvers()
  originServer.listen(0, '127.0.0.1', originListening.resolve)
  await originListening.promise
  const originAddress = originServer.address() as AddressInfo
  const originUrl = `http://127.0.0.1:${originAddress.port}/mcp`

  return {
    originUrl,
    targetUrl,
    get originRequests() { return originRequests.count },
    get targetRequests() { return targetRequests.count },
    targetReceivedAuth,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        originServer.close((error) => { if (error === undefined) resolve(); else reject(error) })
      })
      await new Promise<void>((resolve, reject) => {
        targetServer.close((error) => { if (error === undefined) resolve(); else reject(error) })
      })
    },
  }
}

describe('MCP client redirect policy (CVE regression)', () => {
  let fixture: RedirectFixture | undefined

  afterEach(async () => {
    if (fixture !== undefined) {
      await fixture.close()
      fixture = undefined
    }
  })

  describe('cross-origin redirects with authentication headers', () => {
    const redirectStatuses = [301, 302, 303, 307, 308] as const

    for (const status of redirectStatuses) {
      it(`blocks ${status} cross-origin redirect with auth header (credential leak prevention)`, async () => {
        fixture = await startRedirectFixture(status)

        const transport = new StreamableHTTPClientTransport(new URL(fixture.originUrl), {
          requestInit: { headers: { Authorization: 'Bearer secret-token' } },
          redirectPolicy: 'same-origin',
        })

        const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} })

        try {
          await client.connect(transport)
          expect.fail('Should have failed due to blocked cross-origin redirect')
        } catch {
          expect(fixture.originRequests).toBe(1)
          expect(fixture.targetRequests).toBe(0)
          expect(fixture.targetReceivedAuth).toHaveLength(0)
        } finally {
          await client.close()
        }
      })
    }
  })

  describe('same-origin redirects still work', () => {
    it('documents that same-origin policy blocks all HTTP redirects', async () => {
      let requestCount = 0

      const server = createServer((request: IncomingMessage, response: ServerResponse) => {
        requestCount++

        if (requestCount === 1) {
          const address = server.address() as AddressInfo
          response.writeHead(302, { Location: `http://127.0.0.1:${address.port}/redirected` })
          response.end()
        } else {
          response.writeHead(200, { 'Content-Type': 'text/event-stream' })
          response.write('event: message\n')
          response.write('data: {"jsonrpc":"2.0","method":"initialized","params":{}}\n\n')
          response.end()
        }
      })

      const listening: PromiseWithResolvers<void> = Promise.withResolvers()
      server.listen(0, '127.0.0.1', listening.resolve)
      await listening.promise
      const address = server.address() as AddressInfo
      const url = `http://127.0.0.1:${address.port}/mcp`

      const transport = new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { Authorization: 'Bearer secret-token' } },
        redirectPolicy: 'same-origin',
      })

      const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} })

      try {
        await client.connect(transport)
        expect.fail('Should have failed due to blocked redirect')
      } catch (error: unknown) {
        expect(String(error)).toContain('not followed')
        expect(requestCount).toBe(1)
      } finally {
        await client.close()
        await new Promise<void>((resolve, reject) => {
          server.close((error) => { if (error === undefined) resolve(); else reject(error) })
        })
      }
    })
  })
  describe('stdio transport unaffected', () => {
    it('stdio transport continues to work normally', async () => {
      const { StdioClientTransport } = await import('@modelcontextprotocol/client/stdio')
      const transport = new StdioClientTransport({
        command: 'node',
        args: ['-e', 'console.error("stdio works")'],
      })

      const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} })

      try {
        await expect(client.connect(transport)).rejects.toThrow()
      } finally {
        await client.close()
      }
    })
  })
})
