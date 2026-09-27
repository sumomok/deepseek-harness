/**
 * The intentional-stop sentinel across a real server child: a quit, a
 * mandatory-update stop, or a session end of a running server writes it; the
 * same after the server crashed writes nothing, because the shell keeps the
 * crashed server's handle. A scripted entry on this process's own Node stands
 * in for `dsh web`, started through `startServer` exactly as the shell starts
 * the real one.
 * @module
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SENTINEL_DIRECTORY, SENTINEL_FILE } from '../src/crash-resume-sentinel.ts'
import { markIntentionalStop, stopForMandatoryUpdate, stopServerForQuit } from '../src/server-lifecycle.ts'
import { startServer, type ServerExitInfo, type ServerHandle } from '../src/server.ts'

let root: string
let sentinel: string
const started: ServerHandle[] = []

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-intentional-stop-'))
  expect(root.startsWith(tmpdir())).toBe(true)
  sentinel = join(root, SENTINEL_DIRECTORY, SENTINEL_FILE)
})

afterEach(async () => {
  for (const handle of started.splice(0)) await handle.stop()
  rmSync(root, { recursive: true, force: true })
})

/**
 * Start a scripted server that prints its URL line and then idles, or exits
 * with code 7 on its own shortly after.
 * @param behavior - `idle` or `crash`.
 * @returns the running server.
 */
async function serve(behavior: 'idle' | 'crash'): Promise<ServerHandle> {
  const entry = join(root, `${behavior}.cjs`)
  writeFileSync(entry, `
    process.stdout.write('dsh web: http://127.0.0.1:54321\\n')
    ${behavior === 'idle' ? 'setInterval(() => {}, 1000)' : 'setTimeout(() => { process.exit(7) }, 30)'}
  `)
  const handle = await startServer({ nodeBin: process.execPath, entry, cwd: root, reportDirectory: root, env: {} }, () => {})
  started.push(handle)
  return handle
}

/**
 * Wait for the server's own exit, as the shell's supervision hears it.
 * @param handle - the server.
 * @returns the exit info.
 */
function crashed(handle: ServerHandle): Promise<ServerExitInfo> {
  return new Promise((resolve) => { handle.onExit(resolve) })
}

/** The home, the log, the cookie removal and the deadline a quit passes. */
function quitContext(): { home: string; log: () => void; clearCookies: () => Promise<void>; timeoutMs: number } {
  return { home: root, log: () => {}, clearCookies: async () => {}, timeoutMs: 5_000 }
}

describe('a running server', () => {
  it('is recorded as stopped on purpose by a quit', async () => {
    const handle = await serve('idle')
    expect(await stopServerForQuit(handle, quitContext())).toBe('stopped')
    expect(JSON.parse(readFileSync(sentinel, 'utf8'))).toMatchObject({ version: 1, by: 'shell', reason: 'quit' })
    expect(handle.exited()).toBe(true)
  })

  it('is recorded as stopped on purpose by a mandatory-update stop', async () => {
    const handle = await serve('idle')
    await stopForMandatoryUpdate(handle, { home: root, log: () => {} })
    expect(JSON.parse(readFileSync(sentinel, 'utf8'))).toMatchObject({ reason: 'update' })
  })

  it('is recorded as stopped on purpose by a session end', async () => {
    const handle = await serve('idle')
    expect(markIntentionalStop(handle, 'shutdown', { home: root, log: () => {} })).toBe(true)
    expect(JSON.parse(readFileSync(sentinel, 'utf8'))).toMatchObject({ reason: 'shutdown' })
  })
})

describe('a server that crashed', () => {
  it('leaves no sentinel when the app is quit afterwards', async () => {
    const handle = await serve('crash')
    expect((await crashed(handle)).expected).toBe(false)
    expect(await stopServerForQuit(handle, quitContext())).toBe('stopped')
    expect(existsSync(sentinel)).toBe(false)
  })

  it('leaves no sentinel when the session ends afterwards', async () => {
    const handle = await serve('crash')
    await crashed(handle)
    expect(markIntentionalStop(handle, 'shutdown', { home: root, log: () => {} })).toBe(false)
    expect(existsSync(sentinel)).toBe(false)
  })
})
