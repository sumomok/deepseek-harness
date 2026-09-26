/**
 * The embedded server's startup contract and its boot-failure quarantine
 * retry: a real (short-lived, scripted) child process stands in for `dsh web`,
 * so these run without the harness itself.
 * @module
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseDshArgs } from '../../cli/src/args.ts'
import {
  DESKTOP_PROFILE, MIGRATION_MARKER_FILENAME, quarantineLoadFailureFromOutput, readMigrationMarker, WEB_PROFILE, writeMigrationMarker,
} from '../src/profile-seed.ts'
import {
  diagnosticReportFlags, type QuarantineLoadFailure, ServerExitedBeforeUrl, type ServerExitInfo, startServer,
  startServerWithQuarantine, type ServerHandle, type ServerSpec,
} from '../src/server.ts'

/**
 * A launch of `entry` on this process's own Node, in the case's root, with its
 * diagnostic reports in the root as well.
 * @param entry - the scripted entry to run.
 * @param overrides - fields a case sets for itself.
 * @returns the spec.
 */
function specFor(entry: string, overrides: Partial<ServerSpec> = {}): ServerSpec {
  return { nodeBin: process.execPath, entry, cwd: root, reportDirectory: root, env: {}, ...overrides }
}

/** Wait for `handle`'s `onExit` to fire, however it fires. */
function waitForExit(handle: ServerHandle): Promise<ServerExitInfo> {
  return new Promise((resolve) => { handle.onExit(resolve) })
}

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-server-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** The startup audit block the server writes to stderr for a migrated plugin that failed to import. */
const FIELD_LOADER_ERROR = 'dsh: warning: 1 entry did not activate\nbridge-browser (@yuxianglin/dsh-bridge-browser): failed to import'

/**
 * Write a scripted stand-in for the `dsh` CLI entry: on each invocation it
 * appends one line to `attemptsFile` and then behaves as the next entry in
 * `behaviors` says — `'success'` prints the URL line and idles, `'loader'`
 * writes {@link FIELD_LOADER_ERROR} to stderr and exits 1 after enough filler
 * output that the error line falls outside the last-15-lines tail, `'plain'`
 * exits 1 with an unrelated stderr line, and `'crash-after-start'` prints the
 * URL line, then twenty numbered lines, then exits 7 shortly after — a server
 * that dies on its own after startup already succeeded. The last entry
 * repeats for any attempt past the array's length.
 * @param behaviors - one behavior per attempt, in order.
 * @returns the script's path and the attempts file it writes to.
 */
function scriptedEntry(
  behaviors: readonly ('success' | 'loader' | 'plain' | 'crash-after-start')[],
): { entry: string; attemptsFile: string } {
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
    } else if (behavior === 'crash-after-start') {
      process.stdout.write('dsh web: http://127.0.0.1:54321\\n')
      for (let i = 0; i < 20; i++) process.stdout.write('line ' + i + '\\n')
      setTimeout(() => { process.exit(7) }, 30)
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

/**
 * A scripted entry that reports one environment variable's value to a file,
 * then prints the URL line and idles, exactly like `scriptedEntry`'s
 * `'success'` behavior.
 * @param varName - the environment variable to report.
 * @returns the script's path and the file it wrote the value to (the literal
 * string `'<unset>'` when the process saw no such variable).
 */
function envReportingEntry(varName: string): { entry: string; envFile: string } {
  const entry = join(root, 'env-entry.cjs')
  const envFile = join(root, 'env.log')
  writeFileSync(entry, `
    const fs = require('node:fs')
    fs.writeFileSync(${JSON.stringify(envFile)}, process.env[${JSON.stringify(varName)}] ?? '<unset>')
    process.stdout.write('dsh web: http://127.0.0.1:54321\\n')
    setInterval(() => {}, 1000)
  `)
  return { entry, envFile }
}

/**
 * A scripted entry that reports its own arguments to a file, then prints the
 * URL line and idles, exactly like `scriptedEntry`'s `'success'` behavior.
 * @returns the script's path and the file it wrote the JSON argument array to.
 */
function argvReportingEntry(): { entry: string; argvFile: string } {
  const entry = join(root, 'argv-entry.cjs')
  const argvFile = join(root, 'argv.log')
  writeFileSync(entry, `
    const fs = require('node:fs')
    fs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)))
    process.stdout.write('dsh web: http://127.0.0.1:54321\\n')
    setInterval(() => {}, 1000)
  `)
  return { entry, argvFile }
}

describe('startServer', () => {
  it('resolves with the URL line and a working stop', async () => {
    const { entry } = scriptedEntry(['success'])
    const handle = await startServer(specFor(entry), () => {})
    expect(handle.url).toBe('http://127.0.0.1:54321')
    await handle.stop()
  })

  it('rejects with ServerExitedBeforeUrl carrying the whole output, beyond the message\'s own tail', async () => {
    const { entry } = scriptedEntry(['loader'])
    let caught: unknown
    try {
      await startServer(specFor(entry), () => {})
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

  it('spawns a profile the launcher accepts', async () => {
    const { entry, argvFile } = argvReportingEntry()
    const handle = await startServer(specFor(entry), () => {})
    const { readFile } = await import('node:fs/promises')
    const argv = JSON.parse(await readFile(argvFile, 'utf8')) as string[]
    expect(argv).toEqual(['--profile', DESKTOP_PROFILE, '--port', '0', '--no-open'])
    // The launcher reserves `desktop` for upstream's own Electron application
    // and exits on `--profile desktop` from anything else, which is a boot this
    // shell cannot recover from: it spawns the server and waits for a URL line
    // that never comes. Parsing the very arguments the spawn used is what
    // proves the profile this shell asks for is one the launcher will boot.
    expect(parseDshArgs(argv, '0.0.0')).toEqual({
      mode: 'profile', profile: DESKTOP_PROFILE, patches: [], args: ['--port', '0', '--no-open'],
    })
    await handle.stop()
  })

  it('always sets DSH_TELEMETRY_DISABLED on the spawned server, unconditionally', async () => {
    const { entry, envFile } = envReportingEntry('DSH_TELEMETRY_DISABLED')
    const handle = await startServer(specFor(entry), () => {})
    const { readFile } = await import('node:fs/promises')
    expect(await readFile(envFile, 'utf8')).toBe('1')
    await handle.stop()
  })

  it('lets a caller-supplied env override the telemetry disable, for a test that wants it on', async () => {
    const { entry, envFile } = envReportingEntry('DSH_TELEMETRY_DISABLED')
    const handle = await startServer(
      specFor(entry, { env: { DSH_TELEMETRY_DISABLED: '' } }), () => {},
    )
    const { readFile } = await import('node:fs/promises')
    expect(await readFile(envFile, 'utf8')).toBe('')
    await handle.stop()
  })
})

/**
 * Write a scripted entry from its body and return its path.
 * @param name - the file name inside the case's root.
 * @param body - the CommonJS source.
 * @returns the entry path.
 */
function entryScript(name: string, body: string): string {
  const entry = join(root, name)
  writeFileSync(entry, body)
  return entry
}

/**
 * CommonJS source that leaves the last line to a process sharing the server's
 * output pipes: it writes that line 300 ms after it starts, so the line
 * arrives after the server itself has exited and before the pipes close —
 * the same order as a server whose final output is still in the pipe when
 * the process is gone, made certain rather than left to a race.
 */
const LATE_LAST_LINE = `
  const late = "setTimeout(() => process.stderr.write('the last line says why\\\\n'), 300)"
  require('node:child_process').spawn(process.execPath, ['-e', late], { stdio: 'inherit' })
`

describe('diagnostic reports', () => {
  it('puts the report flags before the entry script, where Node reads them as its own', async () => {
    const execArgvFile = join(root, 'execargv.json')
    const entry = entryScript('execargv-entry.cjs', `
      require('node:fs').writeFileSync(${JSON.stringify(execArgvFile)}, JSON.stringify(process.execArgv))
      process.stdout.write('dsh web: http://127.0.0.1:54321\\n')
      setInterval(() => {}, 1000)
    `)
    const reports = join(root, 'reports')
    const handle = await startServer(specFor(entry, { reportDirectory: reports }), () => {})
    expect(JSON.parse(readFileSync(execArgvFile, 'utf8'))).toEqual(diagnosticReportFlags(reports))
    await handle.stop()
  })

  it('writes a report without the environment into the report directory when the server dies of an uncaught exception', async () => {
    const entry = entryScript('throwing-entry.cjs', 'throw new Error(\'boot blew up\')\n')
    const reports = join(root, 'reports')
    mkdirSync(reports)
    await expect(startServer(
      specFor(entry, { reportDirectory: reports, env: { DSH_REPORT_SENTINEL: 'sk-sentinel-value' } }),
      () => {},
    )).rejects.toBeInstanceOf(ServerExitedBeforeUrl)
    const written = readdirSync(reports).filter(name => name.startsWith('report.') && name.endsWith('.json'))
    expect(written).toHaveLength(1)
    const text = readFileSync(join(reports, written[0] as string), 'utf8')
    const report = JSON.parse(text) as { header: { trigger: string }; environmentVariables?: unknown; javascriptStack: { message: string } }
    expect(report.header.trigger).toBe('Exception')
    expect(report.javascriptStack.message).toContain('boot blew up')
    expect(report.environmentVariables).toBeUndefined()
    expect(text).not.toContain('sk-sentinel-value')
  })
})

describe('ServerHandle.onExit', () => {
  it('carries the last line the server wrote before it exited, however much came before it', async () => {
    const entry = entryScript('draining-entry.cjs', `
      process.stdout.write('dsh web: http://127.0.0.1:54321\\n')
      setTimeout(() => {
        ${LATE_LAST_LINE}
        process.exit(9)
      }, 20)
    `)
    const handle = await startServer(specFor(entry), () => {})
    const info = await waitForExit(handle)
    expect(info.code).toBe(9)
    expect(info.tail).toContain('the last line says why')
  })

  it('does not wait past its bound for a pipe that a process the server started still holds open', async () => {
    const pidFile = join(root, 'grandchild.pid')
    const entry = entryScript('orphaning-entry.cjs', `
      const { spawn } = require('node:child_process')
      const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'inherit', detached: true })
      require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(grandchild.pid))
      grandchild.unref()
      process.stdout.write('dsh web: http://127.0.0.1:54321\\n')
      setTimeout(() => { process.exitCode = 3 }, 20)
    `)
    const handle = await startServer(specFor(entry), () => {})
    try {
      const startedWaiting = Date.now()
      const info = await waitForExit(handle)
      expect(info.code).toBe(3)
      expect(Date.now() - startedWaiting).toBeLessThan(6_000)
    } finally {
      try {
        process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL')
      } catch {
        // ESRCH: the grandchild already exited, which is what this cleanup wants.
      }
    }
  }, 10_000)

  it('marks a stop() teardown as expected', async () => {
    const { entry } = scriptedEntry(['success'])
    const handle = await startServer(specFor(entry), () => {})
    const exit = waitForExit(handle)
    await handle.stop()
    expect(await exit).toMatchObject({ expected: true })
  })

  it('marks the server dying on its own, after startup succeeded, as unexpected, and carries a bounded output tail', async () => {
    const { entry } = scriptedEntry(['crash-after-start'])
    const lines: string[] = []
    const handle = await startServer(specFor(entry), (chunk) => { lines.push(chunk) })
    const info = await waitForExit(handle)
    expect(info.expected).toBe(false)
    expect(info.code).toBe(7)
    expect(info.signal).toBeNull()
    // Twenty lines were written; only the last fifteen survive in the tail,
    // even though logSink (and so the real log file) received every one.
    expect(info.tail).toContain('line 19')
    expect(info.tail).not.toContain('line 0\n')
    expect(lines.join('')).toContain('line 0')
  })

  it('delivers the exit synchronously to a listener registered after the child already exited', async () => {
    const { entry } = scriptedEntry(['crash-after-start'])
    const handle = await startServer(specFor(entry), () => {})
    await waitForExit(handle)
    const late = await waitForExit(handle)
    expect(late.expected).toBe(false)
  })
})

describe('an exit before the URL line', () => {
  it('rejects with the whole output, including what the server wrote last', async () => {
    const entry = entryScript('draining-boot-entry.cjs', `
      ${LATE_LAST_LINE}
      process.exit(1)
    `)
    const failure = await startServer(specFor(entry), () => {})
      .then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(ServerExitedBeforeUrl)
    expect((failure as ServerExitedBeforeUrl).output).toContain('the last line says why')
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
      specFor(entry), (chunk) => { lines.push(chunk) }, alwaysQuarantines, root,
    )
    expect(handle.url).toBe('http://127.0.0.1:54321')
    expect(lines.join('')).toContain('disabled migrated @yuxianglin/dsh-bridge-browser after it failed to load; retrying startup')
    expect(await attemptCount(attemptsFile)).toBe(2)
    await handle.stop()
  })

  it('does not retry, and rejects with the original error, when quarantine finds nothing to blame', async () => {
    const { entry, attemptsFile } = scriptedEntry(['loader', 'success'])
    await expect(
      startServerWithQuarantine(specFor(entry), () => {}, neverQuarantines, root),
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
      startServerWithQuarantine(specFor(entry, { nodeBin: bogusNodeBin }), () => {}, alwaysQuarantines, root),
    ).rejects.toThrow(/failed to spawn/)
    expect(await attemptCount(attemptsFile)).toBe(0)
  })

  it('records a migrated plugin the audit block names after the URL line, without restarting the server', async () => {
    const plugin = '@yuxianglin/dsh-bridge-browser'
    const profileDir = join(root, 'profiles', DESKTOP_PROFILE)
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'p', dsh: { profile: { bundles: [plugin] } } }))
    const markerPath = join(profileDir, MIGRATION_MARKER_FILENAME)
    writeMigrationMarker(markerPath, { from: WEB_PROFILE, migrated: [plugin], defective: [], removed: [] })
    const entry = join(root, 'late-audit.cjs')
    const attemptsFile = join(root, 'attempts.log')
    // The URL line first, then the audit block on the other stream a moment
    // later: the order the server's two independent continuations can take.
    writeFileSync(entry, `
      require('node:fs').appendFileSync(${JSON.stringify(attemptsFile)}, 'x\\n')
      process.stdout.write('dsh web: http://127.0.0.1:54321\\n')
      setTimeout(() => { process.stderr.write(${JSON.stringify(`${FIELD_LOADER_ERROR}\n`)}) }, 50)
      setInterval(() => {}, 1000)
    `)
    const lines: string[] = []
    const handle = await startServerWithQuarantine(
      specFor(entry), (chunk) => { lines.push(chunk) }, quarantineLoadFailureFromOutput, root,
    )
    await vi.waitFor(() => { expect(readMigrationMarker(markerPath)?.defective.map(item => item.name)).toEqual([plugin]) })
    expect(lines.join('')).toContain(`disabled migrated ${plugin} after it failed to load (failed to import); it stays off from the next launch`)
    const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as { dsh: { profile: { bundles: string[] } } }
    expect(manifest.dsh.profile.bundles).toEqual([])
    expect(await attemptCount(attemptsFile)).toBe(1)
    await handle.stop()
  })

  it('propagates the retry\'s own failure when it fails again', async () => {
    const { entry, attemptsFile } = scriptedEntry(['loader', 'loader'])
    await expect(
      startServerWithQuarantine(specFor(entry), () => {}, alwaysQuarantines, root),
    ).rejects.toBeInstanceOf(ServerExitedBeforeUrl)
    expect(await attemptCount(attemptsFile)).toBe(2)
  })
})
