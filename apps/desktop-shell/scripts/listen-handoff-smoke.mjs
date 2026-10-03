/**
 * The listen-socket handoff run from a real Electron main process, as part of
 * `pnpm --filter @deepseek-ai/dsh-desktop-shell run render-smoke`.
 *
 * `tests/listen-handoff.spec.ts` runs both halves under Node. This case runs
 * the shell's half where the shell runs it: Electron's main process binds the
 * socket with Node's internal bind, which is not a public API, and sends it
 * over IPC from Electron's own event loop. A stand-in server on the Node in
 * `DSH_DESKTOP_NODE` (else `node` on PATH, as a development launch uses)
 * listens on it through the built preload, is killed, and a second one takes
 * the same socket.
 *
 * Requires `pnpm --filter @deepseek-ai/dsh-desktop-shell run build:ts` first:
 * it imports `lib/`.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import * as net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { holdLoopbackPort } from '../lib/listen-socket.js'
import { startServer } from '../lib/server.js'

/** The built preload, which a packaged app runs from `app.asar.unpacked`. */
const PRELOAD = fileURLToPath(new URL('../lib/listen-handoff.mjs', import.meta.url))

/**
 * A stand-in server: it listens the way the web server does, answers with its
 * name and whether its IPC channel was open when it started, and kills itself
 * on `/die`.
 */
const ENTRY = `
import http from 'node:http'
const port = Number(process.argv[process.argv.indexOf('--port') + 1])
const connected = process.connected
const server = http.createServer((req, res) => {
  if (req.url === '/die') { res.end('dying'); setTimeout(() => { process.kill(process.pid, 'SIGKILL') }, 20); return }
  res.end(process.env.ENTRY_NAME + ' connected=' + String(connected))
})
server.listen(port, '127.0.0.1', () => { console.log('dsh web: http://127.0.0.1:' + server.address().port + '/?token=t') })
`

/**
 * GET `path` from `127.0.0.1:<port>` on a fresh connection.
 * @param {number} port - the port.
 * @param {string} path - the request path.
 * @param {number} timeoutMs - how long to wait for the answer.
 * @returns {Promise<string>} `<status> <body>`, or the error code.
 */
function get(port, path, timeoutMs) {
  return new Promise((resolve) => {
    const call = request({ host: '127.0.0.1', port, path, agent: false }, (response) => {
      let body = ''
      response.on('data', (chunk) => { body += String(chunk) })
      response.on('end', () => { resolve(`${String(response.statusCode)} ${body}`) })
    })
    call.setTimeout(timeoutMs, () => { call.destroy(new Error('timeout')) })
    call.once('error', (error) => { resolve(error.code ?? error.message) })
    call.end()
  })
}

/**
 * Listen on `127.0.0.1:<port>` and close again, as another local program would try.
 * @param {number} port - the port.
 * @returns {Promise<string>} `listening`, or the error code.
 */
function squat(port) {
  return new Promise((resolve) => {
    const listener = net.createServer()
    listener.once('error', (error) => { resolve(error.code ?? error.message) })
    listener.listen(port, '127.0.0.1', () => { listener.close(() => { resolve('listening') }) })
  })
}

/**
 * Run the handoff from this Electron main process.
 * @param {(condition: boolean, what: string) => void} check - fails the smoke unless `condition` holds.
 * @param {string} nodeBin - the Node the stand-in server runs on.
 * @returns {Promise<void>} resolves when every check passed.
 */
export async function listenHandoffCase(check, nodeBin) {
  check(typeof net._createServerHandle === 'function', `Electron ${process.versions.electron ?? '?'} exposes net._createServerHandle in the main process`)
  const result = holdLoopbackPort(0)
  check(result.kind === 'held', `the main process holds a loopback port (${result.kind === 'held' ? String(result.socket.port) : result.reason})`)
  if (result.kind !== 'held') return
  const socket = result.socket
  const directory = await mkdtemp(join(tmpdir(), 'dsh-listen-handoff-smoke-'))
  const entry = join(directory, 'entry.mjs')
  await writeFile(entry, ENTRY)
  const spec = (name) => ({
    nodeBin, entry, cwd: directory, reportDirectory: directory, env: { ENTRY_NAME: name }, listen: { socket, preload: PRELOAD },
  })
  const origin = `http://127.0.0.1:${String(socket.port)}`
  const started = []
  try {
    const first = await startServer(spec('first'), () => {})
    started.push(first)
    check(first.url === origin, `the first server listens on the held port (${first.url})`)
    check(await get(socket.port, '/', 3_000) === '200 first connected=false', 'its IPC channel was closed before its own code ran')
    const exited = new Promise((resolve) => { first.onExit(resolve) })
    await get(socket.port, '/die', 3_000)
    await exited
    check(await squat(socket.port) === 'EADDRINUSE', 'with no server running, another listen on the held port gets EADDRINUSE')
    const pending = get(socket.port, '/', 10_000)
    const second = await startServer(spec('second'), () => {})
    started.push(second)
    check(second.url === origin, `a second server takes the same socket (${second.url})`)
    const answer = await pending
    if (process.platform === 'darwin') check(answer === '200 second connected=false', `a request made while no server ran is answered by the second (${answer})`)
    else console.log(`  info a request made while no server ran: ${answer}`)
  } finally {
    await Promise.all(started.map(server => server.stop()))
    socket.close()
    await rm(directory, { recursive: true, force: true })
  }
}
