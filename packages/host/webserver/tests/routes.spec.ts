/** `routes()` lists the registrations in effect: named routes, upgrade routes, and the fallback seat. */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebServer, { type WebRoute } from '../src/index.ts'

const roots: Context[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function mount(): Promise<WebServer> {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  return ctx.webServer
}

const answer = (body: string): WebRoute['handler'] => (_req, res) => {
  res.writeHead(200)
  res.end(body)
}

describe('WebServer.routes()', () => {
  it('lists exact, prefix, and upgrade routes sorted by path within each kind, then the fallback seat', async () => {
    const server = await mount()
    expect(server.routes()).toEqual([])

    server.register({ kind: 'prefix', path: '/plugins', handler: answer('plugins') })
    server.register({ kind: 'exact', path: '/zeta', handler: answer('zeta') })
    server.registerFallback(answer('fallback'))
    server.registerUpgrade({ path: '/api/remote.mux', handler: (_req, socket) => { socket.destroy() } })
    server.register({ kind: 'exact', path: '/alpha', handler: answer('alpha') })
    server.register({ kind: 'prefix', path: '/api', handler: answer('api') })

    expect(server.routes()).toEqual([
      { kind: 'exact', path: '/alpha' },
      { kind: 'exact', path: '/zeta' },
      { kind: 'prefix', path: '/api' },
      { kind: 'prefix', path: '/plugins' },
      { kind: 'upgrade', path: '/api/remote.mux' },
      { kind: 'fallback' },
    ])
    const response = await fetch(`http://127.0.0.1:${String(server.port)}/zeta`)
    expect(await response.text()).toBe('zeta')
  })

  it('drops each registration once its disposer runs', async () => {
    const server = await mount()
    const removeExact = server.register({ kind: 'exact', path: '/one', handler: answer('one') })
    const removePrefix = server.register({ kind: 'prefix', path: '/two', handler: answer('two') })
    const removeUpgrade = server.registerUpgrade({ path: '/three', handler: (_req, socket) => { socket.destroy() } })
    const removeFallback = server.registerFallback(answer('fallback'))

    removeExact()
    expect(server.routes()).toEqual([
      { kind: 'prefix', path: '/two' },
      { kind: 'upgrade', path: '/three' },
      { kind: 'fallback' },
    ])
    removeFallback()
    expect(server.routes()).toEqual([{ kind: 'prefix', path: '/two' }, { kind: 'upgrade', path: '/three' }])
    removeUpgrade()
    removePrefix()
    expect(server.routes()).toEqual([])
  })

  it('keeps the first registration when a duplicate throws, and lists one path under several kinds', async () => {
    const server = await mount()
    server.register({ kind: 'exact', path: '/same', handler: answer('exact') })
    server.register({ kind: 'prefix', path: '/same', handler: answer('prefix') })
    server.registerUpgrade({ path: '/same', handler: (_req, socket) => { socket.destroy() } })
    server.registerFallback(answer('fallback'))

    expect(() => server.register({ kind: 'exact', path: '/same', handler: answer('second') }))
      .toThrow('webserver: duplicate exact route "/same"')
    expect(() => server.register({ kind: 'prefix', path: '/same', handler: answer('second') }))
      .toThrow('webserver: duplicate prefix route "/same"')
    expect(() => server.registerUpgrade({ path: '/same', handler: (_req, socket) => { socket.destroy() } }))
      .toThrow('webserver: duplicate upgrade route "/same"')
    expect(() => server.registerFallback(answer('second'))).toThrow('webserver: fallback already registered')

    expect(server.routes()).toEqual([
      { kind: 'exact', path: '/same' },
      { kind: 'prefix', path: '/same' },
      { kind: 'upgrade', path: '/same' },
      { kind: 'fallback' },
    ])
    const response = await fetch(`http://127.0.0.1:${String(server.port)}/same`)
    expect(await response.text()).toBe('exact')
  })

  it('returns fresh entries that do not reach the route tables', async () => {
    const server = await mount()
    server.register({ kind: 'exact', path: '/kept', handler: answer('kept') })
    const listed = server.routes() as Array<{ kind: string; path?: string }>
    listed[0]!.path = '/changed'
    listed.length = 0

    expect(server.routes()).toEqual([{ kind: 'exact', path: '/kept' }])
  })
})
