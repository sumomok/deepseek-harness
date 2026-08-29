/**
 * One branch `favorites-route.client.spec.ts`'s real composition cannot
 * reach: every throw the real `dsh-settings-file` provider can produce
 * (schemastery's `ValidationError`, this package's own `validateFavorites`)
 * is an `Error` instance, so the favorites route's `renderThrown` fallback
 * for a non-Error rejection never fires against the real provider. The
 * `settings` capability's Service Definition places no such constraint on a
 * provider, so a fake one exercising that fallback is a legitimate
 * configuration of the same seam, not a hostile input to a value the static
 * interface requires.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import * as ServerSidebar from '../src/index.ts'

/** A request whose body is one JSON chunk, with the headers a valid POST needs. */
function fakeRequest(body: string): IncomingMessage {
  async function* chunks() { yield body }
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    setEncoding: () => {},
    [Symbol.asyncIterator]: chunks,
  } as unknown as IncomingMessage
}

/** A response that captures what the handler answered. */
function fakeResponse(): { res: ServerResponse; status: () => number; body: () => unknown } {
  let status = 0
  let body = ''
  const res = {
    writeHead: (code: number) => { status = code },
    end: (chunk?: string) => { if (chunk !== undefined) body = chunk },
  } as unknown as ServerResponse
  return { res, status: () => status, body: () => JSON.parse(body) as unknown }
}

describe('server-sidebar favorites route: non-Error rejection fallback', () => {
  it('renders a thrown non-Error value through String() rather than crashing', async () => {
    let handler: ((req: IncomingMessage, res: ServerResponse) => void | Promise<void>) | undefined
    const ctx = new Context()
    ctx.provide('settings', {
      register: () => ({
        get: () => ({ favorites: [] }),
        // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the non-Error rejection is the scenario under test.
        replace: () => Promise.reject('not an Error instance'),
      }),
    } as never)
    ctx.provide('webServer', {
      register: (route: { handler: typeof handler }) => { handler = route.handler; return () => {} },
    } as never)
    await ctx.plugin(ServerSidebar).await()
    expect(handler).toBeDefined()

    const { res, status, body } = fakeResponse()
    await handler?.(fakeRequest(JSON.stringify({ favorites: [] })), res)
    expect(status()).toBe(400)
    expect(body()).toEqual({ error: 'server-sidebar: not an Error instance' })
  })
})
