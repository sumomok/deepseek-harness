/**
 * The embedded server's startup contract and its boot-failure quarantine
 * retry: a real (short-lived, scripted) child process stands in for `dsh web`,
 * so these run without the harness itself.
 * @module
 */

import { writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type QuarantineLoadFailure, ServerExitedBeforeUrl, startServer, startServerWithQuarantine, type ServerHandle,
} from '../src/server.ts'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-server-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** The verbatim field stderr this whole quarantine mechanism exists for. */
const FIELD_LOADER_ERROR = 'failed to apply loader entry include (cordis:include): failed to import loader entry '
  + 'bridge-browser (@yuxianglin/dsh-bridge-browser): Cannot find module '
  + '\'C:\\Users\\field\\.dsh\\profiles\\desktop\\node_modules\\@yuxianglin\\dsh-bridge-browser\\lib\\index.js\' '
  + 'imported from C:\\Users\\field\\.dsh\\profiles\\desktop\\'

/**
 * Write a scripted stand-in for the `dsh` CLI entry: on each invocation it
 * appends one line to `attemptsFile` and then behaves as the next entry in
 * `behaviors` says — `'success'` prints the URL line and idles, `'loader'`
 * writes {@link FIELD_LOADER_ERROR} to stderr and exits 1 after enough filler
 * output that the error line falls outside the last-15-lines tail, and
 * `'plain'` exits 1 with an unrelated stderr line. The last entry repeats for
 * any attempt past the array's length.
 * @param behaviors - one behavior per attempt, in order.
 * @returns the script's path and the attempts file it writes to.
 */
function scriptedEntry(behaviors: readonly ('success' | 'loader' | 'plain')[]): { entry: string; attemptsFile: string } {
  const entry = join(root, 'entry.cjs')
  const attemptsFile = join(root, 'attempts.log')
  writeFileSync(entry, `
    const fs = require('node:fs')
    const attemptsFile = ${JSON.stringify(attemptsFile)}
    const behaviors = ${JSON.stringify(behaviors)}
    let attempt = 0
    try { attempt = fs.readFileSync(attemptsFile, 'utf8').split('\\n').filter(Boolean).length } catch {}
    fs.appendFileSync(attemptsFile, 'x\\n')
    const behavior = behaviors[Math.min(attempt, behaviors.length - 1)]
    if (behavior === 'success') {
      process.stdout.write('dsh web: http://127.0.0.1:54321\\n')
      setInterval(() => {}, 1000)
    } else if (behavior === 'loader') {
      process.stderr.write(${JSON.stringify(FIELD_LOADER_ERROR)} + '\\n')
      for (let i = 0; i < 20; i++) process.stdout.write('filler line ' + i + '\\n')
      process.exitCode = 1
    } else {
      process.stderr.write('some unrelated crash\\n')
      process.exitCode = 1
    }
  `)
  return { entry, attemptsFile }
}

/** The lines `attemptsFile` holds, one per invocation. */
async function attemptCount(attemptsFile: string): Promise<number> {
  const { readFile } = await import('node:fs/promises')
  try {
    return (await readFile(attemptsFile, 'utf8')).split('\n').filter(Boolean).length
  } catch {
    return 0
  }
}

describe('startServer', () => {
  it('resolves with the URL line and a working stop', async () => {
    const { entry } = scriptedEntry(['success'])
    const handle = await startServer({ nodeBin: process.execPath, entry, cwd: root, env: {} }, () => {})
    expect(handle.url).toBe('http://127.0.0.1:54321')
    await handle.stop()
  })

  it('rejects with ServerExitedBeforeUrl carrying the whole output, beyond the message\'s own tail', async () => {
    const { entry } = scriptedEntry(['loader'])
    let caught: unknown
    try {
      await startServer({ nodeBin: process.execPath, entry, cwd: root, env: {} }, () => {})
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ServerExitedBeforeUrl)
    const exited = caught as ServerExitedBeforeUrl
    expect(exited.output).toContain('@yuxianglin/dsh-bridge-browser')
    // The message's tail is the last 15 lines; 20 filler lines follow the
    // loader error, so the message alone would not carry it.
    expect(exited.message).not.toContain('@yuxianglin/dsh-bridge-browser')
  })
})

describe('startServerWithQuarantine', () => {
  const alwaysQuarantines: QuarantineLoadFailure = (_home, output) =>
    output.includes('@yuxianglin/dsh-bridge-browser') ? { name: '@yuxianglin/dsh-bridge-browser', detail: 'stub detail' } : undefined

  const neverQuarantines: QuarantineLoadFailure = () => undefined

  it('retries once when quarantine finds a name to blame, and succeeds', async () => {
    const { entry, attemptsFile } = scriptedEntry(['loader', 'success'])
    const lines: string[] = []
    const handle: ServerHandle = await startServerWithQuarantine(
      { nodeBin: process.execPath, entry, cwd: root, env: {} }, (chunk) => { lines.push(chunk) }, alwaysQuarantines, root,
    )
    expect(handle.url).toBe('http://127.0.0.1:54321')
    expect(lines.join('')).toContain('disabled migrated @yuxianglin/dsh-bridge-browser after it failed to load; retrying startup')
    expect(await attemptCount(attemptsFile)).toBe(2)
    await handle.stop()
  })

  it('does not retry, and rejects with the original error, when quarantine finds nothing to blame', async () => {
    const { entry, attemptsFile } = scriptedEntry(['loader', 'success'])
    await expect(
      startServerWithQuarantine({ nodeBin: process.execPath, entry, cwd: root, env: {} }, () => {}, neverQuarantines, root),
    ).rejects.toBeInstanceOf(ServerExitedBeforeUrl)
    expect(await attemptCount(attemptsFile)).toBe(1)
  })

  it('does not retry a failure that is not an exit-before-URL at all', async () => {
    // A nonexistent Node binary fails at spawn itself, before the script ever
    // runs — the one rejection `startServer` produces that is not a
    // `ServerExitedBeforeUrl`, and quarantine has nothing to read from it.
    const { entry, attemptsFile } = scriptedEntry(['plain'])
    const bogusNodeBin = join(root, 'no-such-node-binary')
    await expect(
      startServerWithQuarantine({ nodeBin: bogusNodeBin, entry, cwd: root, env: {} }, () => {}, alwaysQuarantines, root),
    ).rejects.toThrow(/failed to spawn/)
    expect(await attemptCount(attemptsFile)).toBe(0)
  })

  it('propagates the retry\'s own failure when it fails again', async () => {
    const { entry, attemptsFile } = scriptedEntry(['loader', 'loader'])
    await expect(
      startServerWithQuarantine({ nodeBin: process.execPath, entry, cwd: root, env: {} }, () => {}, alwaysQuarantines, root),
    ).rejects.toBeInstanceOf(ServerExitedBeforeUrl)
    expect(await attemptCount(attemptsFile)).toBe(2)
  })
})
