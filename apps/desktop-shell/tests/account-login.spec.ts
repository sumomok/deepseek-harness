import { once } from 'node:events'
import { WebSocketServer, type WebSocket } from 'ws'
import { expect, it, onTestFinished, vi, type Mock } from 'vitest'
import { watchAccountLogin } from '../src/account-login.ts'

/** One real loopback Host stream, allocated and closed per test. */
async function accountFixture(): Promise<{
  open: Mock<(url: string) => Promise<void>>
  log: Mock<(line: string) => void>
  closed: Promise<void>
  reconnect: () => Promise<void>
  send: (value: unknown) => void
}> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  const watcher: { stop?: () => void } = {}
  onTestFinished(async () => {
    watcher.stop?.()
    for (const socket of server.clients) socket.terminate()
    await new Promise<void>((resolve, reject) => {
      server.close((error) => { if (error) reject(error); else resolve() })
    })
  })
  await once(server, 'listening')
  let opened = Promise.withResolvers<undefined>()
  const closed = Promise.withResolvers<undefined>()
  let streamId: string | undefined
  let client: WebSocket | undefined
  server.on('connection', (socket, request) => {
    client = socket
    socket.on('close', () => { closed.resolve(undefined) })
    expect(request.headers.cookie).toBe('dsh-auth=test')
    socket.on('message', (data) => {
      const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data)
      const frame = JSON.parse(bytes.toString('utf8')) as { endpoint?: string; streamId?: string }
      if (frame.endpoint !== 'account/watch' || typeof frame.streamId !== 'string') return
      streamId = frame.streamId
      opened.resolve(undefined)
    })
  })
  const open = vi.fn<(url: string) => Promise<void>>().mockResolvedValue(undefined)
  const address = server.address()
  if (typeof address === 'string' || address === null) throw new Error('missing account fixture address')
  const log = vi.fn<(line: string) => void>()
  watcher.stop = watchAccountLogin(`http://127.0.0.1:${address.port}`, {
    cookies: async () => 'dsh-auth=test', open, log,
  })
  await opened.promise
  return {
    open,
    log,
    closed: closed.promise,
    reconnect: async () => {
      if (client === undefined) throw new Error('account stream did not open')
      opened = Promise.withResolvers<undefined>()
      client.close()
      await opened.promise
    },
    send: (value) => {
      if (client === undefined || streamId === undefined) throw new Error('account stream did not open')
      client.send(JSON.stringify({ type: 'item', streamId, value }))
    },
  }
}

it.each(['snapshot', 'credentials-changed'])('opens the waiting attempt from an account %s wire update', async (type) => {
  const fixture = await accountFixture()
  fixture.send({
    type,
    state: {
      status: 'signed-out',
      links: { usageUrl: 'https://platform.deepseek.com/usage', topUpUrl: 'https://platform.deepseek.com/top_up' },
      attempt: {
        id: 'wire-attempt', phase: 'waiting-browser',
        authorizeUrl: 'https://platform.deepseek.com/dsh/authorize?from=desktop',
      },
    },
  })
  await vi.waitFor(() => {
    expect(fixture.open).toHaveBeenCalledExactlyOnceWith('https://platform.deepseek.com/dsh/authorize?from=desktop')
  })
})

it('opens each waiting account attempt once without exposing private attempt fields', async () => {
  const fixture = await accountFixture()
  const attempt = {
    id: 'attempt-one', phase: 'waiting-browser',
    authorizeUrl: 'https://platform.deepseek.com/dsh/authorize?from=desktop', codeVerifier: 'private',
  }
  const state = {
    status: 'signed-out',
    links: { usageUrl: 'https://platform.deepseek.com/usage', topUpUrl: 'https://platform.deepseek.com/top_up' },
    attempt,
  }
  fixture.send({ type: 'snapshot', state })
  await vi.waitFor(() => {
    expect(fixture.open).toHaveBeenCalledExactlyOnceWith('https://platform.deepseek.com/dsh/authorize?from=desktop')
  })
  fixture.send({ type: 'snapshot', state })
  fixture.send({ type: 'credentials-changed', state })
  await fixture.reconnect()
  fixture.send({ type: 'snapshot', state })
  fixture.send({
    type: 'credentials-changed',
    state: { ...state, status: 'credential-stored', attempt: { id: 'attempt-one', phase: 'succeeded' } },
  })
  fixture.send({ type: 'snapshot', state: { ...state, attempt: null } })
  for (const phase of ['initializing', 'exchanging', 'committing', 'cancelled', 'expired', 'failed']) {
    fixture.send({ type: 'snapshot', state: { ...state, attempt: { id: 'inactive', phase } } })
  }
  // WebSocket ordering makes this later valid attempt a barrier: every earlier
  // duplicate and terminal frame has been handled before it opens.
  fixture.send({
    type: 'snapshot',
    state: {
      ...state,
      attempt: { id: 'attempt-two', phase: 'waiting-browser', authorizeUrl: 'http://127.0.0.1:8080/oauth/authorize' },
    },
  })
  await vi.waitFor(() => { expect(fixture.open).toHaveBeenCalledTimes(2) })
  expect(fixture.open.mock.calls).toEqual([
    ['https://platform.deepseek.com/dsh/authorize?from=desktop'],
    ['http://127.0.0.1:8080/oauth/authorize'],
  ])
})

it.each([
  'javascript:alert(1)',
  'http://platform.deepseek.com/dsh/authorize',
  'https://user:private@platform.deepseek.com/dsh/authorize',
])('fails closed on an unsafe authorization URL: %s', async (authorizeUrl) => {
  const fixture = await accountFixture()
  fixture.send({
    type: 'snapshot',
    state: {
      status: 'signed-out',
      links: { usageUrl: 'https://platform.deepseek.com/usage', topUpUrl: 'https://platform.deepseek.com/top_up' },
      attempt: { id: 'unsafe', phase: 'waiting-browser', authorizeUrl },
    },
  })
  await fixture.closed
  expect(fixture.open).not.toHaveBeenCalled()
  expect(fixture.log).toHaveBeenCalledExactlyOnceWith('[desktop] invalid DeepSeek account stream update; closing and retrying\n')
})

it.each([
  ['missing update', undefined],
  ['null update', null],
  ['array update', []],
  ['flat state', { attempt: { id: 'legacy', phase: 'waiting-browser', authorizeUrl: 'https://example.com/private' } }],
  ['missing type', { state: { attempt: null } }],
  ['unknown type', { type: 'other', state: { attempt: { id: 'unknown', phase: 'waiting-browser', authorizeUrl: 'https://example.com/private' } } }],
  ['missing state', { type: 'snapshot' }],
  ['null state', { type: 'snapshot', state: null }],
  ['array state', { type: 'snapshot', state: [] }],
  ['missing attempt', { type: 'snapshot', state: {} }],
  ['invalid attempt', { type: 'snapshot', state: { attempt: 'waiting-browser' } }],
  ['invalid id', { type: 'snapshot', state: { attempt: { id: 1, phase: 'waiting-browser', authorizeUrl: 'https://example.com/private' } } }],
  ['invalid phase', { type: 'snapshot', state: { attempt: { id: 'invalid', phase: null } } }],
  ['missing URL', { type: 'snapshot', state: { attempt: { id: 'invalid', phase: 'waiting-browser' } } }],
  ['invalid URL field', { type: 'snapshot', state: { attempt: { id: 'invalid', phase: 'waiting-browser', authorizeUrl: 1 } } }],
])('closes the account stream without opening a browser for %s', async (_name, value) => {
  const fixture = await accountFixture()
  fixture.send(value)
  await fixture.closed
  expect(fixture.open).not.toHaveBeenCalled()
  expect(fixture.log).toHaveBeenCalledExactlyOnceWith('[desktop] invalid DeepSeek account stream update; closing and retrying\n')
})
