/**
 * Open DeepSeek account authorization in the system browser.
 *
 * The shared account UI starts the Host-owned PKCE flow. On Desktop it waits for
 * the native shell to observe `account/watch` and open the resulting URL. This
 * module is only that observer: tokens, callback handling, and credential
 * storage stay in the Host, and no account credential enters the renderer.
 * @module @deepseek-ai/dsh-desktop-shell/account-login
 */

import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { parseRemoteStreamServerMessage, REMOTE_STREAM_MUX_PATH } from '@deepseek-ai/dsh-api-gateway/stream-protocol'

/** Native operations the account watcher needs; no Host credential crosses this interface. */
export interface AccountLoginHost {
  /** Read the browser-session cookies for the running loopback Host. */
  cookies: () => Promise<string>
  /** Open one validated authorization URL in the system browser. */
  open: (url: string) => Promise<void>
  /** Write a diagnostic that never contains the authorization URL. */
  log: (line: string) => void
}

/** The only account projection the native opener acts on. */
interface WaitingAttempt {
  id: string
  authorizeUrl: string
}

/** Accept only an HTTPS destination, or HTTP on an explicit loopback callback. */
function authorizationUrl(value: string): string {
  const url = new URL(value)
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.username || url.password || !(url.protocol === 'https:' || (loopback && url.protocol === 'http:'))) {
    throw new Error('desktop account: invalid authorization destination')
  }
  return url.href
}

/**
 * Validate the account frame and return the waiting attempt it carries.
 * Other phases need no native action. Unknown or malformed values fail closed.
 */
function waitingAttempt(value: unknown): WaitingAttempt | undefined {
  if (typeof value !== 'object' || value === null || !('attempt' in value)) {
    throw new Error('desktop account: invalid state')
  }
  const attempt: unknown = value.attempt
  if (attempt === null) return undefined
  if (typeof attempt !== 'object' || !('id' in attempt) || typeof attempt.id !== 'string'
    || !('phase' in attempt) || typeof attempt.phase !== 'string') {
    throw new Error('desktop account: invalid attempt')
  }
  if (attempt.phase !== 'waiting-browser') return undefined
  if (!('authorizeUrl' in attempt) || typeof attempt.authorizeUrl !== 'string') {
    throw new Error('desktop account: waiting attempt omitted its authorization URL')
  }
  return { id: attempt.id, authorizeUrl: authorizationUrl(attempt.authorizeUrl) }
}

/**
 * Watch one running Host and open each waiting authorization attempt once.
 * Reconnects continue the same attempt without reopening its browser page.
 * @param origin - loopback Web origin of the running Host.
 * @param host - authenticated cookie reader, external opener, and safe logger.
 * @returns disposer ending the stream and every pending reconnect.
 */
export function watchAccountLogin(origin: string, host: AccountLoginHost): () => void {
  let closed = false
  let socket: WebSocket | undefined
  let retry: ReturnType<typeof setTimeout> | undefined
  let openedAttempt: string | undefined

  const reconnect = (): void => {
    if (closed) return
    retry = setTimeout(connect, 1000)
    retry.unref()
  }
  const connect = (): void => {
    if (closed) return
    const streamId = randomUUID()
    void host.cookies().then((cookie) => {
      if (closed) return
      const url = new URL(REMOTE_STREAM_MUX_PATH, origin)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      socket = new WebSocket(url, { headers: { cookie }, maxPayload: 65_536 })
      socket.on('open', () => {
        socket?.send(JSON.stringify({ type: 'open', streamId, endpoint: 'account/watch', payload: { args: {} } }))
      })
      socket.on('message', (data) => {
        try {
          const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data)
          const frame = parseRemoteStreamServerMessage(bytes.toString('utf8'))
          if (frame.streamId !== streamId) throw new Error('desktop account: unexpected stream')
          if (frame.type !== 'item') {
            socket?.close()
            return
          }
          const attempt = waitingAttempt(frame.value)
          if (attempt === undefined || openedAttempt === attempt.id) return
          openedAttempt = attempt.id
          void host.open(attempt.authorizeUrl).catch(() => {
            host.log('[desktop] could not open the DeepSeek authorization page\n')
          })
        } catch {
          socket?.close()
        }
      })
      socket.on('error', () => { socket?.close() })
      socket.on('close', reconnect)
    }).catch(() => {
      host.log('[desktop] could not authenticate the DeepSeek account stream; retrying\n')
      reconnect()
    })
  }

  connect()
  return () => {
    closed = true
    if (retry !== undefined) clearTimeout(retry)
    socket?.close()
  }
}
