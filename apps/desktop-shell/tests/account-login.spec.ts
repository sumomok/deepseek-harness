import { once } from 'node:events'
import { WebSocketServer, type WebSocket } from 'ws'
import { expect, it, onTestFinished, vi, type Mock } from 'vitest'
import { watchAccountLogin } from '../src/account-login.ts'

/** One real loopback Host stream, allocated and closed per test. */
async function accountFixture(): Promise<{
  open: Mock<(url: string) => Promise<void>>
  closed: Promise<void>
  send: (value: unknown) => void
}> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(server, 'listening')
  const opened = Promise.withResolvers<undefined>()
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
  const stop = watchAccountLogin(`http://127.0.0.1:${address.port}`, {
    cookies: async () => 'dsh-auth=test', open, log: () => undefined,
  })
  onTestFinished(async () => {
    stop()
    for (const socket of server.clients) socket.terminate()
    await new Promise<void>((resolve, reject) => {
      server.close((error) => { if (error) reject(error); else resolve() })
    })
  })
  await opened.promise
  return {
    open,
    closed: closed.promise,
    send: (value) => {
      if (client === undefined || streamId === undefined) throw new Error('account stream did not open')
      client.send(JSON.stringify({ type: 'item', streamId, value }))
    },
  }
}

it('opens each waiting account attempt once without exposing private attempt fields', async () => {
  const fixture = await accountFixture()
  const attempt = {
    id: 'attempt-one', phase: 'waiting-browser',
    authorizeUrl: 'https://platform.deepseek.com/dsh/authorize?from=desktop', codeVerifier: 'private',
  }
  fixture.send({ status: 'signed-out', attempt })
  await vi.waitFor(() => {
    expect(fixture.open).toHaveBeenCalledExactlyOnceWith('https://platform.deepseek.com/dsh/authorize?from=desktop')
  })
  fixture.send({ status: 'signed-out', attempt })
  fixture.send({ status: 'credential-stored', attempt: { id: 'attempt-one', phase: 'succeeded' } })
  fixture.send({ status: 'signed-out', attempt: null })
  // WebSocket ordering makes this later valid attempt a barrier: every earlier
  // duplicate and terminal frame has been handled before it opens.
  fixture.send({
    status: 'signed-out',
    attempt: { id: 'attempt-two', phase: 'waiting-browser', authorizeUrl: 'http://127.0.0.1:8080/oauth/authorize' },
  })
  await vi.waitFor(() => { expect(fixture.open).toHaveBeenCalledTimes(2) })
  expect(fixture.open.mock.calls).toEqual([
    ['https://platform.deepseek.com/dsh/authorize?from=desktop'],
    ['http://127.0.0.1:8080/oauth/authorize'],
  ])
})

it('fails closed on a non-browser authorization URL', async () => {
  const fixture = await accountFixture()
  fixture.send({
    status: 'signed-out',
    attempt: { id: 'unsafe', phase: 'waiting-browser', authorizeUrl: 'javascript:alert(1)' },
  })
  await fixture.closed
  expect(fixture.open).not.toHaveBeenCalled()
})
