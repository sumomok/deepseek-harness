/**
 * The install handoff's teardown in `main.ts`: an installer may only start
 * after the server's whole process tree is confirmed gone, and a teardown that
 * cannot confirm it must refuse the handoff instead of returning as if it had
 * succeeded.
 *
 * `main.ts` composes Electron at import time. Its teardown and restart functions
 * execute here in a private VM with process and listener effects replaced; the
 * environment replacement and failed-install resume use their production modules.
 * @module
 */

import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { restoreOfficeEnvironment } from '../src/install-recovery.ts'
import { ENGINE_MODULES_ENV } from '../src/office-engine.ts'
import { ENDPOINT_ENV, TOKEN_ENV } from '../src/office-engine-service.ts'
import type { TreeCheck } from '../src/process-tree.ts'
import { resumeAfterFailedInstall } from '../src/server-lifecycle.ts'

const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')

/**
 * The source from one marker to the next.
 * @param start - the text the section starts at.
 * @param end - the text the section stops before.
 * @returns the source between the two markers.
 */
function section(start: string, end: string): string {
  const opening = source.indexOf(start)
  expect(opening).toBeGreaterThan(-1)
  const closing = source.indexOf(end, opening + start.length)
  expect(closing).toBeGreaterThan(opening)
  return source.slice(opening, closing)
}

/** The host member the installer handoff awaits before it starts the installer. */
const prepareQuit = section('prepareQuit: async () => {', 'resumeAfterFailedInstall:')

describe('the teardown before an install', () => {
  it('marks the quit and stops the whole server tree, not the bounded stop', () => {
    expect(prepareQuit).toContain('quitting = true')
    expect(prepareQuit).toContain('const check = await stopServerCompletely()')
    expect(prepareQuit).not.toContain('stopServerBounded')
    // The quitting flag is raised before the teardown starts: the tray's close
    // handler must let windows go from that moment, and a stop that fails is
    // undone by the updater's resume path.
    expect(prepareQuit.indexOf('quitting = true')).toBeLessThan(prepareQuit.indexOf('stopServerCompletely()'))
  })

  it('refuses the handoff when the tree is still running or the stop is unconfirmed', () => {
    expect(prepareQuit).toContain("if (check.kind === 'running') {")
    expect(prepareQuit).toContain('throw new UpdateStopIncomplete(')
    expect(prepareQuit).toContain("if (check.kind === 'unconfirmed') throw new UpdateStopIncomplete(check.detail)")
    // Both non-`gone` results throw, and neither returns early, so no caller
    // can read a teardown that confirmed nothing as a completed one.
    expect(prepareQuit.indexOf("check.kind === 'running'")).toBeLessThan(prepareQuit.indexOf("check.kind === 'unconfirmed'"))
    expect(prepareQuit.indexOf('throw new UpdateStopIncomplete')).toBeGreaterThan(prepareQuit.indexOf('stopServerCompletely()'))
  })

  it('names the refusal with a stable code, so the failure is observable', () => {
    expect(source).toMatch(/class UpdateStopIncomplete extends Error \{/u)
    expect(source).toContain("readonly code = 'UPDATE_STOP_INCOMPLETE'")
    expect(source).toContain("this.name = 'UpdateStopIncomplete'")
  })
})

/** Execute the production teardown/start functions with owned effects replaced. */
function lifecycle(stopResult: TreeCheck, retryResult: TreeCheck = { kind: 'gone' }) {
  const syntax = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true)
  const names = new Set(['stopServerCompletely', 'startEmbeddedServer', 'UpdateStopIncomplete'])
  const declarations = syntax.statements.filter(statement =>
    (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement))
    && statement.name !== undefined && names.has(statement.name.text))
  expect(declarations).toHaveLength(3)
  const closed = vi.fn(async () => {})
  const upgraded = vi.fn()
  const opened = vi.fn(async () => {
    const env = { [ENDPOINT_ENV]: 'http://127.0.0.1:2', [TOKEN_ENV]: 'fresh-token', [ENGINE_MODULES_ENV]: '/new-engine', NODE_PATH: '/new-engine' }
    context.officeEngineService = { close: closed, env }
    context.officeEngine = { runUpgrade: upgraded }
    return env
  })
  const launched = vi.fn(async (_spec: { env: Record<string, string> }) => ({ url: 'http://127.0.0.1:3' }))
  const spec = {
    env: { OTHER_SERVICE: 'retained', [ENDPOINT_ENV]: 'http://127.0.0.1:1', [TOKEN_ENV]: 'closed-token', [ENGINE_MODULES_ENV]: '/old-engine', NODE_PATH: '/old-engine' },
  }
  const context = createContext({
    server: { pid: 123 }, officeEngineService: { close: closed }, officeEngine: undefined,
    serverStopCheck: { kind: 'gone' }, quitting: false,
    process: { pid: 42, platform: 'darwin' }, app: { getPath: () => '/logs' },
    resolveSpec: () => ({ nodeBin: '/node' }), logLine: vi.fn(),
    stopServerTree: async (input: { closeShellWriters: () => Promise<void> }) => {
      await input.closeShellWriters()
      return stopResult
    },
    stopServerBounded: vi.fn(), sweepOrphanedServers: vi.fn(), nodeProcessProbes: vi.fn(),
    ensureTreeGone: vi.fn(async () => retryResult),
    restoreOfficeEnvironment, startOfficeEngineForServer: opened,
    startServerWithQuarantine: launched, quarantineLoadFailureFromOutput: vi.fn(), resolveHarnessHome: () => '/home',
    moveCleanup: { idle: async () => {} },
    spec,
  })
  const program = `${declarations.map(node => node.getText(syntax)).join('\n')}\nconst host = { ${prepareQuit} };`
  runInContext(ts.transpileModule(program, { compilerOptions: { target: ts.ScriptTarget.ES2024 } }).outputText, context)
  return { context, spec, closed, opened, launched, upgraded }
}

describe('resource recovery after install failure', () => {
  it.each(['installer failure', 'stop refusal'] as const)('reopens Office before the server after %s', async (failure) => {
    const fixture = lifecycle(failure === 'stop refusal' ? { kind: 'running', survivors: [] } : { kind: 'gone' })
    if (failure === 'stop refusal') {
      await expect(runInContext('host.prepareQuit()', fixture.context)).rejects.toMatchObject({ code: 'UPDATE_STOP_INCOMPLETE' })
    } else {
      await runInContext('host.prepareQuit()', fixture.context)
    }
    expect(fixture.closed).toHaveBeenCalledTimes(1)
    await resumeAfterFailedInstall({
      blocking: false,
      clearQuitting: () => { fixture.context.quitting = false },
      restartServer: async () => { await runInContext('startEmbeddedServer(spec)', fixture.context) },
      reveal: vi.fn(),
    })
    expect(fixture.opened).toHaveBeenCalledTimes(1)
    expect(fixture.launched).toHaveBeenCalledTimes(1)
    expect(fixture.spec.env).toEqual({
      OTHER_SERVICE: 'retained', [ENDPOINT_ENV]: 'http://127.0.0.1:2', [TOKEN_ENV]: 'fresh-token', [ENGINE_MODULES_ENV]: '/new-engine', NODE_PATH: '/new-engine',
    })
    expect(fixture.opened.mock.invocationCallOrder[0]).toBeLessThan(fixture.launched.mock.invocationCallOrder[0]!)
    expect(fixture.context.quitting).toBe(false)
  })

  it('keeps live Office credentials and starts its pending upgrade after a failed launch retries', async () => {
    const fixture = lifecycle({ kind: 'gone' })
    fixture.launched.mockRejectedValueOnce(new Error('server startup failed'))
    await runInContext('host.prepareQuit()', fixture.context)
    await expect(runInContext('startEmbeddedServer({ ...spec })', fixture.context)).rejects.toThrow('server startup failed')
    expect(fixture.spec.env[TOKEN_ENV]).toBe('closed-token')
    expect(fixture.upgraded).not.toHaveBeenCalled()
    await runInContext('startEmbeddedServer({ ...spec })', fixture.context)
    expect(fixture.opened).toHaveBeenCalledTimes(1)
    expect(fixture.upgraded).toHaveBeenCalledTimes(1)
    expect(fixture.launched.mock.calls.map(([spec]) => spec.env[TOKEN_ENV])).toEqual(['fresh-token', 'fresh-token'])
    expect(fixture.launched.mock.calls.map(([spec]) => spec.env[ENDPOINT_ENV])).toEqual(['http://127.0.0.1:2', 'http://127.0.0.1:2'])
  })

  it('resumes the Office manager belonging to the successful launch after cleanup', async () => {
    const fixture = lifecycle({ kind: 'gone' })
    const cleanup = Promise.withResolvers<undefined>()
    fixture.context.moveCleanup = { idle: () => cleanup.promise }
    await runInContext('host.prepareQuit()', fixture.context)
    await runInContext('startEmbeddedServer({ ...spec })', fixture.context)
    expect(fixture.upgraded).not.toHaveBeenCalled()
    const replacement = vi.fn()
    fixture.context.officeEngine = { runUpgrade: replacement }
    cleanup.resolve(undefined)
    await cleanup.promise
    expect(fixture.upgraded).toHaveBeenCalledTimes(1)
    expect(replacement).not.toHaveBeenCalled()
  })

  it('does not start another writer when the stopped process tree remains unknown', async () => {
    const fixture = lifecycle({ kind: 'unconfirmed', detail: 'process list unavailable' })
    await expect(runInContext('host.prepareQuit()', fixture.context)).rejects.toMatchObject({ code: 'UPDATE_STOP_INCOMPLETE' })
    await expect(runInContext('startEmbeddedServer(spec)', fixture.context)).rejects.toMatchObject({ code: 'UPDATE_STOP_INCOMPLETE' })
    await expect(runInContext('host.prepareQuit()', fixture.context)).rejects.toMatchObject({ code: 'UPDATE_STOP_INCOMPLETE' })
    expect(fixture.closed).toHaveBeenCalledTimes(1)
    expect(fixture.opened).not.toHaveBeenCalled()
    expect(fixture.launched).not.toHaveBeenCalled()
  })

  it('drops old credentials and module paths if the Office listener cannot reopen', async () => {
    expect(await restoreOfficeEnvironment({ OTHER: 'keep', [ENDPOINT_ENV]: 'closed', [TOKEN_ENV]: 'old', [ENGINE_MODULES_ENV]: '/old', NODE_PATH: '/old' }, async () => ({})))
      .toEqual({ OTHER: 'keep' })
  })
})

describe('the process-tree stop it relies on', () => {
  const stop = section('async function stopServerCompletely(): Promise<TreeCheck> {', '\n}\n')

  it('records the tree while the server runs and checks it after the stop', () => {
    expect(stop).toContain('await stopServerTree({')
    expect(stop).toContain('stop: stopServerBounded,')
    expect(stop).toContain('sweep: () => sweepOrphanedServers(nodeBin, logLine)')
    expect(stop).toContain('if (check.kind === \'running\')')
  })

  it('limits the sweep and the search for a server without a handle to this installation', () => {
    // Not a machine-wide search by process name: the executable comes from
    // this installation's spec and is compared against the shell's own child.
    expect(stop).toContain("const { nodeBin } = resolveSpec(app.getPath('logs'))")
    expect(stop).toContain('unhandled: { shell: process.pid, executable: nodeBin },')
  })
})

describe('the recovery the updater runs after a refused or failed install', () => {
  it('is still wired to clear the quitting flag and start the server again', () => {
    expect(source).toMatch(new RegExp([
      'resumeAfterFailedInstall: \\(blocking: boolean\\) => resumeAfterFailedInstall\\(\\{',
      '\\s+blocking,',
      '\\s+clearQuitting: \\(\\) => \\{ quitting = false \\},',
      "\\s+restartServer: \\(\\) => restartAfterStop\\('the failed install'\\),",
      '\\s+reveal,',
    ].join(''), 'u'))
  })
})
