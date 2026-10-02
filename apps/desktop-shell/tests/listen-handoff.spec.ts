/**
 * The listen-socket handoff between the shell's `startServer` and the
 * server-side preload, run with real processes: the preload source runs under
 * Node in a child that stands in for `dsh web` and listens the way its web
 * server does, on a socket this test holds the way the shell does. Ports are
 * picked by the system; every child is stopped and every socket closed after
 * its case.
 * @module
 */

import { spawn, type ChildProcess } from 'node:child_process'
import type { Readable } from 'node:stream'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import * as net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HANDOFF_READY_LINE, holdLoopbackPort, LISTEN_HANDOFF_ENV, type HeldListenSocket } from '../src/listen-socket.ts'
import { ListenHandoffFailed, startServer, type ServerExitInfo, type ServerHandle, type ServerSpec } from '../src/server.ts'

/** The preload under test, run from source as Node strips its types. */
const PRELOAD = fileURLToPath(new URL('../src/listen-handoff.mts', import.meta.url))

/** The preload as `--import` takes it: a Windows drive path is not a valid ESM specifier. */
const PRELOAD_URL = pathToFileURL(PRELOAD).href

/**
 * The stand-in server. It reads `--port` the way the CLI does, answers every
 * request with its name and what it saw at startup, and kills itself on
 * `/die`. `ENTRY_BEHAVIOR` picks how it listens: positionally (the default,
 * as the web server does), with an options object, after another server on a
 * port of its own, twice on the same port, or after a worker thread ran.
 */
const ENTRY = `
import http from 'node:http'
import { Worker } from 'node:worker_threads'
const port = Number(process.argv[process.argv.indexOf('--port') + 1])
const name = process.env.ENTRY_NAME ?? 'server'
const seen = { connected: process.connected, handoffVariable: process.env.${LISTEN_HANDOFF_ENV} ?? null }
if (typeof process.send === 'function') process.send('hello', (error) => { seen.sendError = error?.code ?? null })
const server = http.createServer((req, res) => {
  if (req.url === '/die') { res.end('dying'); setTimeout(() => { process.kill(process.pid, 'SIGKILL') }, 20); return }
  res.end(name + ' ' + JSON.stringify(seen))
})
const announce = () => { console.log('dsh web: http://127.0.0.1:' + server.address().port + '/?token=t') }
switch (process.env.ENTRY_BEHAVIOR) {
  case 'options':
    server.listen({ port, host: '127.0.0.1' }, announce)
    break
  case 'other-first': {
    const other = http.createServer((req, res) => { res.end('other') })
    other.listen(0, '127.0.0.1', () => { seen.other = other.address().port; server.listen(port, '127.0.0.1', announce) })
    break
  }
  case 'second-listen':
    server.listen(port, '127.0.0.1', () => {
      announce()
      setTimeout(() => { server.close(() => { server.listen(port, '127.0.0.1') }) }, 50)
    })
    break
  case 'worker': {
    const worker = new Worker(new URL('./worker.mjs', import.meta.url), { env: { ${LISTEN_HANDOFF_ENV}: String(port) } })
    worker.once('message', (message) => { seen.worker = message; server.listen(port, '127.0.0.1', announce) })
    break
  }
  default:
    server.listen(port, '127.0.0.1', announce)
}
`

/** A worker body that reports it ran; with the preload active in workers it would never get to. */
const WORKER = `
import { parentPort } from 'node:worker_threads'
parentPort.postMessage('worker ran')
`

/** A preload that shortens every timer of 5 s or more to 10 ms, so the socket wait ends at once. */
const FAST_TIMERS = `
const original = globalThis.setTimeout
globalThis.setTimeout = (callback, ms, ...rest) => original(callback, ms >= 5000 ? 10 : ms, ...rest)
`

let root: string
const sockets: HeldListenSocket[] = []
const handles: ServerHandle[] = []
const listeners: net.Server[] = []

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-listen-handoff-'))
  await writeFile(join(root, 'entry.mjs'), ENTRY)
  await writeFile(join(root, 'worker.mjs'), WORKER)
  await writeFile(join(root, 'fast-timers.mjs'), FAST_TIMERS)
})

afterEach(async () => {
  await Promise.all(handles.splice(0).map(handle => handle.stop()))
  for (const socket of sockets.splice(0)) socket.close()
  await Promise.all(listeners.splice(0).map(listener => new Promise((resolve) => { listener.close(resolve) })))
  await rm(root, { recursive: true, force: true })
})

/**
 * Hold a loopback port the system picks, closed after the case.
 * @returns the held socket.
 */
function hold(): HeldListenSocket {
  const result = holdLoopbackPort(0)
  if (result.kind !== 'held') throw new Error(`could not hold a port: ${result.reason}`)
  sockets.push(result.socket)
  return result.socket
}

/**
 * A launch of the stand-in on this process's Node, listening on `socket`.
 * @param socket - the socket to hand over.
 * @param env - `ENTRY_BEHAVIOR`, `ENTRY_NAME`.
 * @returns the spec.
 */
function specFor(socket: HeldListenSocket, env: Record<string, string> = {}): ServerSpec {
  return {
    nodeBin: process.execPath, entry: join(root, 'entry.mjs'), cwd: root, reportDirectory: root, env,
    listen: { socket, preload: PRELOAD },
  }
}

/**
 * Start the stand-in, stopped after the case.
 * @param spec - the launch.
 * @returns the running server.
 */
async function start(spec: ServerSpec): Promise<ServerHandle> {
  const handle = await startServer(spec, () => {})
  handles.push(handle)
  return handle
}

/**
 * GET `path` from `127.0.0.1:<port>` on a fresh connection.
 * @param port - the port.
 * @param path - the request path.
 * @param timeoutMs - how long to wait for the whole answer.
 * @returns `<status> <body>`, or the error code.
 */
async function get(port: number, path: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    const call = request({ host: '127.0.0.1', port, path, agent: false }, (response) => {
      let body = ''
      response.on('data', (chunk: Buffer) => { body += chunk.toString() })
      response.on('end', () => { resolve(`${String(response.statusCode)} ${body}`) })
    })
    call.setTimeout(timeoutMs, () => { call.destroy(new Error('timeout')) })
    call.once('error', (error: NodeJS.ErrnoException) => { resolve(error.code ?? error.message) })
    call.end()
  })
}

/**
 * Listen on `127.0.0.1:<port>` from this process, as another local program would.
 * @param port - the port.
 * @returns `listening`, or the error code.
 */
async function squat(port: number): Promise<string> {
  const listener = net.createServer()
  return new Promise((resolve) => {
    listener.once('error', (error: NodeJS.ErrnoException) => { resolve(error.code ?? error.message) })
    listener.listen(port, '127.0.0.1', () => {
      listeners.push(listener)
      resolve('listening')
    })
  })
}

/**
 * Take a port the system picks with a listener in this process, as another
 * local program would hold one.
 * @returns the port.
 */
async function takePort(): Promise<number> {
  const listener = net.createServer()
  listeners.push(listener)
  await new Promise<void>((resolve) => { listener.listen(0, '127.0.0.1', resolve) })
  const address = listener.address()
  if (address === null || typeof address === 'string') throw new Error('the listener has no port')
  return address.port
}

/**
 * What the stand-in saw at startup, from its answer to `/`.
 * @param answer - `200 <name> <json>`.
 * @returns the name and the parsed report.
 */
function report(answer: string): { name: string; seen: Record<string, unknown> } {
  const match = /^200 (\S+) (.*)$/s.exec(answer)
  if (match === null) throw new Error(`unexpected answer: ${answer}`)
  return { name: match[1] as string, seen: JSON.parse(match[2] as string) as Record<string, unknown> }
}

/**
 * The standard output of a child spawned with a piped stdout.
 * @param child - the child.
 * @returns its stdout stream.
 */
function stdoutOf(child: ChildProcess): Readable {
  if (child.stdout === null) throw new Error('the child was spawned without a stdout pipe')
  return child.stdout
}

/** Wait for `handle`'s exit. */
function exited(handle: ServerHandle): Promise<ServerExitInfo> {
  return new Promise((resolve) => { handle.onExit(resolve) })
}

describe('a server started on a held socket', () => {
  it('listens on it through a positional listen, with the channel and the variable gone before its code runs', async () => {
    const socket = hold()
    const handle = await start(specFor(socket))
    expect(handle.url).toBe(`http://127.0.0.1:${String(socket.port)}`)
    const { seen } = report(await get(socket.port, '/', 3_000))
    expect(seen).toMatchObject({ connected: false, handoffVariable: null })
    // The channel is closed, so nothing the server runs reaches the shell.
    expect(seen['sendError']).toBe('ERR_IPC_CHANNEL_CLOSED')
  })

  it('listens on it through an options-object listen', async () => {
    const socket = hold()
    const handle = await start(specFor(socket, { ENTRY_BEHAVIOR: 'options' }))
    expect(handle.url).toBe(`http://127.0.0.1:${String(socket.port)}`)
  })

  it('leaves a listen for another port to bind on its own', async () => {
    const socket = hold()
    await start(specFor(socket, { ENTRY_BEHAVIOR: 'other-first' }))
    const { seen } = report(await get(socket.port, '/', 3_000))
    expect(typeof seen['other']).toBe('number')
    expect(seen['other']).not.toBe(socket.port)
    expect(await get(seen['other'] as number, '/', 3_000)).toBe('200 other')
  })

  it('does not run in a worker thread, even one given the variable', async () => {
    const socket = hold()
    await start(specFor(socket, { ENTRY_BEHAVIOR: 'worker' }))
    expect(report(await get(socket.port, '/', 3_000)).seen['worker']).toBe('worker ran')
  })

  it('keeps the port from every other listener after the server is killed', async () => {
    const socket = hold()
    const handle = await start(specFor(socket))
    const exit = exited(handle)
    expect(await get(socket.port, '/die', 3_000)).toBe('200 dying')
    expect((await exit).expected).toBe(false)
    expect(await squat(socket.port)).toBe('EADDRINUSE')
  })

  // Whether the socket keeps listening without a child is checked on Windows
  // by the release's manual probe; where it does not, the request is refused,
  // as it would be with no socket held.
  it.skipIf(process.platform === 'win32')('has a request made while no server runs answered by the next one', async () => {
    const socket = hold()
    const first = await start(specFor(socket, { ENTRY_NAME: 'first' }))
    const exit = exited(first)
    await get(socket.port, '/die', 3_000)
    await exit
    const pending = get(socket.port, '/', 10_000)
    const second = await start(specFor(socket, { ENTRY_NAME: 'second' }))
    expect(second.url).toBe(`http://127.0.0.1:${String(socket.port)}`)
    expect(report(await pending).name).toBe('second')
  }, 15_000)

  it('ends the server on a second listen for the held port, and the port stays held', async () => {
    const socket = hold()
    const handle = await start(specFor(socket, { ENTRY_BEHAVIOR: 'second-listen' }))
    const info = await exited(handle)
    expect(info.code).toBe(1)
    expect(info.tail).toContain('dsh-desktop listen handoff failed: second listen on the held port')
    expect(await squat(socket.port)).toBe('EADDRINUSE')
  })
})

describe('a handoff that cannot hold', () => {
  it('ends the server rather than leave it listening on every interface when the socket was never bound', async () => {
    const taken = await takePort()
    const create = net._createServerHandle
    if (typeof create !== 'function') throw new Error('this Node has no net._createServerHandle')
    const unbound = create('127.0.0.1', taken, 4)
    // A platform that reports the failed bind at once leaves nothing to hand over.
    if (typeof unbound === 'number') return
    const socket: HeldListenSocket = { port: taken, handle: unbound, close: () => { unbound.close() } }
    sockets.push(socket)
    const failure = await startServer(specFor(socket), () => {}).then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(ListenHandoffFailed)
    expect((failure as ListenHandoffFailed).reason).toMatch(/not 127\.0\.0\.1:|listen on the held socket failed/)
  })

  it('writes the failure line and exits when no socket arrives', async () => {
    const socket = hold()
    const child = spawn(process.execPath, ['--import', pathToFileURL(join(root, 'fast-timers.mjs')).href, '--import', PRELOAD_URL, join(root, 'entry.mjs'), '--port', String(socket.port)], {
      env: { ...process.env, [LISTEN_HANDOFF_ENV]: String(socket.port) }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    let output = ''
    stdoutOf(child).on('data', (chunk: Buffer) => { output += chunk.toString() })
    const code = await new Promise<number | null>((resolve) => { child.once('exit', resolve) })
    expect(code).toBe(1)
    expect(output).toContain(`${HANDOFF_READY_LINE}\ndsh-desktop listen handoff failed: no socket arrived within 10s\n`)
    expect(output).not.toContain('dsh web:')
  })

  it('writes the failure line and exits when the shell closes the channel without sending', async () => {
    const child = spawn(process.execPath, ['--import', PRELOAD_URL, join(root, 'entry.mjs'), '--port', '1'], {
      env: { ...process.env, [LISTEN_HANDOFF_ENV]: '1' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    let output = ''
    stdoutOf(child).on('data', (chunk: Buffer) => {
      output += chunk.toString()
      if (output.includes(HANDOFF_READY_LINE) && child.connected) child.disconnect()
    })
    const code = await new Promise<number | null>((resolve) => { child.once('exit', resolve) })
    expect(code).toBe(1)
    expect(output).toContain('dsh-desktop listen handoff failed: the IPC channel closed before the socket arrived')
  })

  it('does nothing in a process started without the variable', async () => {
    const child = spawn(process.execPath, ['--import', PRELOAD_URL, join(root, 'entry.mjs'), '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] })
    const gone = new Promise((resolve) => { child.once('exit', resolve) })
    const output = await new Promise<string>((resolve) => {
      let text = ''
      child.stdout.on('data', (chunk: Buffer) => {
        text += chunk.toString()
        if (text.includes('dsh web:')) resolve(text)
      })
      void gone.then(() => { resolve(text) })
    })
    child.kill('SIGKILL')
    await gone
    expect(output).toContain('dsh web: http://127.0.0.1:')
    expect(output).not.toContain('dsh-desktop listen handoff')
  })
})
