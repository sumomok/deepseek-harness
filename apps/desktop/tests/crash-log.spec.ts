/**
 * What a main-process crash leaves behind: one log entry in the file the user
 * is asked to send, and the error box Electron would have shown on its own.
 *
 * Every registration goes into the shared `dispose`, which `afterEach` runs,
 * so a failing assertion cannot leave the runner holding a listener of this
 * suite's.
 * @module
 */

import { afterEach, describe, expect, it } from 'vitest'
import { reportUncaughtException, setupCrashLog, type CrashLogHost } from '../src/crash-log.ts'

/** Removes the handlers the running test registered. */
let dispose: (() => void) | undefined

afterEach(() => {
  dispose?.()
  dispose = undefined
})

/**
 * The `uncaughtException` handler as Node calls it. `@types/node` narrows the
 * first argument to `Error`; Node hands over whatever was thrown, which is the
 * case these tests exist for.
 */
type ThrownValueListener = (value: unknown, origin: NodeJS.UncaughtExceptionOrigin) => void

/** A log sink and error box that record what they were given. */
interface Recorder {
  /** Every entry written to the log sink, in order. */
  entries: string[]
  /** Every `[title, content]` pair the error box was opened with. */
  boxes: Array<[string, string]>
  /** The host to pass, writing into the two lists above. */
  host: CrashLogHost
}

/** What one registration recorded, and the handlers it installed. */
interface Registered extends Recorder {
  /** The `uncaughtException` handler this registration added. */
  onUncaughtException: ThrownValueListener
  /** The `unhandledRejection` handler this registration added. */
  onUnhandledRejection: NodeJS.UnhandledRejectionListener
}

/**
 * The single listener a registration added, as identified by the caller.
 * @param listeners - the listeners `process` gained.
 * @returns the one listener.
 */
function only<T>(listeners: readonly T[]): T {
  expect(listeners).toHaveLength(1)
  const [listener] = listeners
  if (listener === undefined) throw new Error('crash-log.spec: the registration installed no listener.')
  return listener
}

/**
 * A host that records instead of writing to the log file or opening a box.
 * @returns the host and the two lists it appends to.
 */
function recorder(): Recorder {
  const entries: string[] = []
  const boxes: Array<[string, string]> = []
  return {
    entries,
    boxes,
    host: {
      log: (entry) => { entries.push(entry) },
      showErrorBox: (title, content) => { boxes.push([title, content]) },
    },
  }
}

/**
 * Register crash logging against recording fakes and hand back the handlers it
 * installed, identified as the listeners `process` did not carry before.
 * @returns what the fakes record, plus the two installed handlers.
 */
function register(): Registered {
  const recording = recorder()
  const beforeExceptions = process.listeners('uncaughtException')
  const beforeRejections = process.listeners('unhandledRejection')
  dispose = setupCrashLog(recording.host)
  return {
    ...recording,
    onUncaughtException: only(process.listeners('uncaughtException').filter(listener => !beforeExceptions.includes(listener))) as ThrownValueListener,
    onUnhandledRejection: only(process.listeners('unhandledRejection').filter(listener => !beforeRejections.includes(listener))),
  }
}

describe('setupCrashLog', () => {
  it('logs an uncaught exception with its stack and shows Electron\'s own box', () => {
    const registered = register()
    const error = new Error('net::ERR_CONNECTION_RESET')
    error.stack = 'Error: net::ERR_CONNECTION_RESET\n    at doExecuteTasks'

    registered.onUncaughtException(error, 'uncaughtException')

    expect(registered.entries).toEqual([
      '[desktop] uncaught exception: Error: net::ERR_CONNECTION_RESET\n    at doExecuteTasks\n',
    ])
    expect(registered.boxes).toEqual([[
      'A JavaScript error occurred in the main process',
      'Uncaught Exception:\nError: net::ERR_CONNECTION_RESET\n    at doExecuteTasks',
    ]])
  })

  it('falls back to name and message when the error carries no stack', () => {
    const registered = register()
    const error = new TypeError('handler is not a function')
    delete error.stack

    registered.onUncaughtException(error, 'uncaughtException')

    expect(registered.entries).toEqual(['[desktop] uncaught exception: TypeError: handler is not a function\n'])
    expect(registered.boxes).toEqual([[
      'A JavaScript error occurred in the main process',
      'Uncaught Exception:\nTypeError: handler is not a function',
    ]])
  })

  it('reports a thrown string without touching Error properties', () => {
    const registered = register()

    expect(() => { registered.onUncaughtException('boom', 'uncaughtException') }).not.toThrow()

    expect(registered.entries).toEqual(['[desktop] uncaught exception: boom\n'])
    expect(registered.boxes).toEqual([[
      'A JavaScript error occurred in the main process',
      'Uncaught Exception:\nboom',
    ]])
  })

  it('reports a thrown undefined rather than throwing inside the handler', () => {
    const registered = register()

    // `throw undefined` is the case that ends the process with no record at
    // all when the handler reads `.message` off what it was handed.
    expect(() => { registered.onUncaughtException(undefined, 'uncaughtException') }).not.toThrow()

    expect(registered.entries).toEqual(['[desktop] uncaught exception: undefined\n'])
    expect(registered.boxes).toEqual([[
      'A JavaScript error occurred in the main process',
      'Uncaught Exception:\nundefined',
    ]])
  })

  it('logs an unhandled rejection without opening a box', () => {
    const registered = register()
    const reason = new Error('feed unreachable')
    reason.stack = 'Error: feed unreachable\n    at check'

    registered.onUnhandledRejection(reason, Promise.resolve())

    expect(registered.entries).toEqual(['[desktop] unhandled rejection: Error: feed unreachable\n    at check\n'])
    expect(registered.boxes).toEqual([])
  })

  it('describes a rejection reason that is not an error', () => {
    const registered = register()

    registered.onUnhandledRejection('gave up', Promise.resolve())

    expect(registered.entries).toEqual(['[desktop] unhandled rejection: gave up\n'])
  })

  it('removes both handlers when disposed', () => {
    const exceptions = process.listenerCount('uncaughtException')
    const rejections = process.listenerCount('unhandledRejection')
    dispose = setupCrashLog(recorder().host)

    expect(process.listenerCount('uncaughtException')).toBe(exceptions + 1)
    expect(process.listenerCount('unhandledRejection')).toBe(rejections + 1)

    dispose()
    dispose = undefined

    expect(process.listenerCount('uncaughtException')).toBe(exceptions)
    expect(process.listenerCount('unhandledRejection')).toBe(rejections)
  })
})

describe('reportUncaughtException', () => {
  it('logs and shows one report for the launch chain, which registers no handler', () => {
    const recording = recorder()

    reportUncaughtException(recording.host, new RangeError('boot window failed'))

    expect(recording.entries).toHaveLength(1)
    expect(recording.entries[0]).toMatch(/^\[desktop] uncaught exception: RangeError: boot window failed\n/)
    expect(recording.entries[0]?.endsWith('\n')).toBe(true)
    expect(recording.boxes[0]?.[0]).toBe('A JavaScript error occurred in the main process')
    expect(recording.boxes[0]?.[1]).toMatch(/^Uncaught Exception:\nRangeError: boot window failed\n/)
  })

  it('reports a rejection reason of any shape', () => {
    const recording = recorder()

    expect(() => { reportUncaughtException(recording.host, undefined) }).not.toThrow()

    expect(recording.entries).toEqual(['[desktop] uncaught exception: undefined\n'])
    expect(recording.boxes).toEqual([[
      'A JavaScript error occurred in the main process',
      'Uncaught Exception:\nundefined',
    ]])
  })
})
