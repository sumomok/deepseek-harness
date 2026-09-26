/**
 * The launch step that settles the Harness home: what it exports, when it asks
 * the person and what each answer does, and when it touches the terminal's
 * `DSH_HOME` and `~/.dsh`. The host is a recording stand-in for the boot
 * window; every directory is under a temporary root.
 * @module
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  exportPointerHome, promptView, settleDataLocation,
  type DataLocationHost, type LocationAnswer, type PromptView,
} from '../src/data-location-boot.ts'
import {
  DATA_ID_FILENAME, POINTER_VERSION, readDataId, readPointer, writePointer,
  type DataId, type DataLocationPointer,
} from '../src/data-location.ts'
import { DATA_LOCATION_TEXT, dataLocationText } from '../src/data-location-text.ts'
import {
  POINTER_HOME_ENV, readLoginShellDshHome, shellQuote, updateShellProfile, type ExplicitRead, type TerminalWrite,
} from '../src/terminal-env.ts'

let root: string
let osHome: string
let userData: string
let defaultHome: string

const ID = '11111111-2222-4333-8444-555555555555' as DataId
const OTHER = '99999999-8888-4777-8666-555555555555'
const posixOnly = process.platform === 'win32' ? it.skip : it
const withZsh = existsSync('/bin/zsh') ? it : it.skip

beforeEach(async () => {
  root = realpathSync(await mkdtemp(join(tmpdir(), 'dsh-data-location-boot-')))
  // HOME, ~/.dsh, and userData below are all inside this directory; none is the user's own.
  expect(root.startsWith(realpathSync(tmpdir()))).toBe(true)
  osHome = join(root, 'home')
  userData = join(root, 'userData')
  defaultHome = join(osHome, '.dsh')
  mkdirSync(osHome)
  mkdirSync(userData)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function dataDir(name: string, id?: string): string {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  if (id !== undefined) writeFileSync(join(dir, DATA_ID_FILENAME), `${id}\n`)
  return dir
}

function pointerAt(path: string, extra: Partial<DataLocationPointer> = {}): DataLocationPointer {
  return { version: POINTER_VERSION, path, dataId: ID, ...extra }
}

interface Recorded {
  host: DataLocationHost
  env: NodeJS.ProcessEnv
  asked: PromptView[]
  told: string[]
  terminalWrites: string[]
  persistentReads: number
  log: string[]
}

/**
 * A host answering prompts and folder picks from queues. The persistent
 * source reports `persistent` until a terminal write goes through, and then
 * what `afterWrite` says, by default the value written.
 */
function recordingHost(options: {
  answers?: LocationAnswer[]
  folders?: Array<string | undefined>
  persistent?: ExplicitRead
  afterWrite?: (value: string) => ExplicitRead
  terminal?: (value: string) => TerminalWrite | Error
  onAsk?: (view: PromptView) => void
  env?: NodeJS.ProcessEnv
} = {}): Recorded {
  const answers = [...options.answers ?? []]
  const folders = [...options.folders ?? []]
  const log: string[] = []
  const asked: PromptView[] = []
  const told: string[] = []
  const terminalWrites: string[] = []
  const env = options.env ?? {}
  const counters = { persistentReads: 0 }
  let persistent: ExplicitRead = options.persistent ?? { kind: 'unset' }
  const host: DataLocationHost = {
    userData, defaultHome, osHome, platform: process.platform, env, text: DATA_LOCATION_TEXT.zh,
    log: (line) => { log.push(line) },
    readPersistentEnv: async () => {
      counters.persistentReads += 1
      return persistent
    },
    writeTerminalEnv: async (value) => {
      terminalWrites.push(value)
      const result = options.terminal?.(value) ?? { kind: 'user-environment' }
      if (result instanceof Error) throw result
      if (result.kind === 'user-environment' || (result.kind === 'profile' && (result.update.kind === 'written' || result.update.kind === 'unchanged'))) {
        persistent = options.afterWrite?.(value) ?? { kind: 'set', value, source: 'user-environment' }
      }
      return result
    },
    ask: async (view) => {
      asked.push(view)
      options.onAsk?.(view)
      const answer = answers.shift()
      if (answer === undefined) throw new Error(`unexpected prompt: ${view.message}`)
      return answer
    },
    chooseFolder: async () => folders.shift(),
    tell: async (message) => { told.push(message) },
  }
  return {
    host, env, asked, told, terminalWrites, log,
    get persistentReads() { return counters.persistentReads },
  }
}

describe('exportPointerHome', () => {
  it('exports the pointer\'s directory and returns the launch value captured first', () => {
    writePointer(userData, pointerAt('/Volumes/Ext/DSH-Data'))
    const env: NodeJS.ProcessEnv = { DSH_HOME: '/from/terminal' }
    expect(exportPointerHome(userData, env)).toBe('/from/terminal')
    expect(env).toEqual({ DSH_HOME: '/Volumes/Ext/DSH-Data', [POINTER_HOME_ENV]: '/Volumes/Ext/DSH-Data' })
  })

  it('leaves the environment alone without a pointer', () => {
    const env: NodeJS.ProcessEnv = {}
    expect(exportPointerHome(userData, env)).toBeUndefined()
    expect(env).toEqual({})
  })

  it('does not report its own export from a relaunch as the person\'s value', () => {
    writePointer(userData, pointerAt('/data'))
    expect(exportPointerHome(userData, { DSH_HOME: '/data', [POINTER_HOME_ENV]: '/data' })).toBeUndefined()
  })
})

describe('promptView', () => {
  it('makes Esc quit on the unavailable prompt and keep on the changed-location prompt', () => {
    const unavailable = promptView({ kind: 'unavailable', reason: 'missing', path: 'E:\\DSH-Data' }, DATA_LOCATION_TEXT.zh)
    expect(unavailable.buttons.map(button => button.label)).toEqual(['重试', '选择数据所在的文件夹…', '退出'])
    expect(unavailable.buttons[unavailable.cancelIndex]?.answer).toBe('quit')
    expect(unavailable.detail).toContain('E:\\DSH-Data')
    const env = promptView({ kind: 'confirm-env', reason: 'missing', envPath: '/typo', current: '/data' }, DATA_LOCATION_TEXT.en)
    expect(env.buttons[env.cancelIndex]?.answer).toBe('keep')
    // A macOS sheet dismissed by raising its parent answers with the first
    // button, so the first button must change nothing.
    expect(unavailable.buttons[0]?.answer).toBe('retry')
    expect(env.buttons[0]?.answer).toBe('keep')
    expect(env.detail).toContain('/typo')
    expect(env.detail).toContain('/data')
  })

  it('picks the language by locale', () => {
    expect(dataLocationText('zh-CN')).toBe(DATA_LOCATION_TEXT.zh)
    expect(dataLocationText('en-US')).toBe(DATA_LOCATION_TEXT.en)
  })

  it('names each reason in words, without the variable\'s name', () => {
    for (const text of [DATA_LOCATION_TEXT.zh, DATA_LOCATION_TEXT.en]) {
      for (const reason of ['missing', 'id-mismatch', 'pointer-unreadable'] as const) {
        expect(text.unavailable(reason, '/p')).not.toMatch(/DSH_HOME|pointer|指针/)
      }
      expect(text.env('missing', '/a', '/b')).not.toContain('DSH_HOME')
    }
  })
})

describe('settleDataLocation without a pointer', () => {
  it('behaves as before: default home, no shell probe, no link, no export', async () => {
    mkdirSync(defaultHome)
    const recorded = recordingHost()
    const settled = await settleDataLocation(recorded.host, undefined)
    expect(settled).toEqual({ home: defaultHome, via: 'default', explicit: { kind: 'unset' } })
    expect(recorded.persistentReads).toBe(0)
    expect(recorded.env).toEqual({})
    expect(readPointer(userData)).toEqual({ kind: 'absent' })
    expect(readDataId(defaultHome).kind).toBe('ok')
  })

  it('uses the launch DSH_HOME as before', async () => {
    const recorded = recordingHost({ env: { DSH_HOME: '/t' } })
    expect(await settleDataLocation(recorded.host, '/t')).toMatchObject({ home: '/t', via: 'env' })
    expect(recorded.env).toEqual({ DSH_HOME: '/t' })
  })
})

describe('settleDataLocation with a pointer', () => {
  posixOnly('exports the data directory and links ~/.dsh to it', async () => {
    const data = dataDir('Ext/DSH-Data', ID)
    writePointer(userData, pointerAt(data))
    const recorded = recordingHost()
    const settled = await settleDataLocation(recorded.host, undefined)
    expect(settled).toMatchObject({ home: data, via: 'pointer', link: { kind: 'created' } })
    expect(recorded.persistentReads).toBe(1)
    expect(recorded.env).toEqual({ DSH_HOME: data, [POINTER_HOME_ENV]: data })
    expect(readlinkSync(defaultHome)).toBe(data)
  })

  it('leaves a real ~/.dsh and says so in the log', async () => {
    const data = dataDir('Ext/DSH-Data', ID)
    writePointer(userData, pointerAt(data))
    mkdirSync(defaultHome)
    const recorded = recordingHost()
    const settled = await settleDataLocation(recorded.host, undefined)
    expect(settled?.link).toEqual({ kind: 'kept-directory', reason: 'foreign' })
    expect(lstatSync(defaultHome).isDirectory()).toBe(true)
    expect(recorded.log.join('')).toContain('a real directory this app did not make')
  })

  it('asks when the directory is missing, and retry re-checks it', async () => {
    const data = join(root, 'Ext', 'DSH-Data')
    writePointer(userData, pointerAt(data))
    const recorded = recordingHost({
      answers: ['retry'],
      onAsk: () => { dataDir('Ext/DSH-Data', ID) },
    })
    const settled = await settleDataLocation(recorded.host, undefined)
    expect(recorded.asked).toHaveLength(1)
    expect(recorded.asked[0]?.detail).toContain(data)
    expect(settled?.home).toBe(data)
    expect(existsSync(join(defaultHome, 'sessions'))).toBe(false)
  })

  it('quits when the person quits, exporting nothing new and creating nothing', async () => {
    writePointer(userData, pointerAt(join(root, 'Ext', 'DSH-Data')))
    const recorded = recordingHost({ answers: ['quit'] })
    expect(await settleDataLocation(recorded.host, undefined)).toBeUndefined()
    expect(existsSync(defaultHome)).toBe(false)
    expect(existsSync(join(root, 'Ext'))).toBe(false)
  })

  it('refuses a folder without the data\'s marker and accepts the right one, updating the terminal', async () => {
    writePointer(userData, pointerAt(join(root, 'Ext', 'DSH-Data')))
    const wrong = dataDir('wrong', OTHER)
    const empty = dataDir('empty')
    const right = dataDir('moved/DSH-Data', ID)
    const recorded = recordingHost({ answers: ['choose', 'choose', 'choose', 'choose'], folders: [undefined, empty, wrong, right] })
    const settled = await settleDataLocation(recorded.host, undefined)
    expect(recorded.told).toEqual([DATA_LOCATION_TEXT.zh.refusedNoData(empty), DATA_LOCATION_TEXT.zh.refusedOtherData(wrong)])
    expect(settled?.home).toBe(right)
    expect(recorded.terminalWrites).toEqual([right])
    const read = readPointer(userData)
    expect(read.kind === 'ok' && read.pointer).toMatchObject({ path: right, dataId: ID, lastSeenEnv: right })
  })

  it('records the observed value as seen when the terminal could not be updated', async () => {
    writePointer(userData, pointerAt(join(root, 'Ext', 'DSH-Data'), { lastSeenEnv: '/old' }))
    const right = dataDir('moved', ID)
    const recorded = recordingHost({
      answers: ['choose'], folders: [right], persistent: { kind: 'set', value: '/old', source: 'login-shell' },
      terminal: () => ({ kind: 'profile', update: { kind: 'foreign-assignment', file: '/h/.zshrc', places: [{ file: '/h/.zshrc', line: 4 }] } }),
    })
    expect((await settleDataLocation(recorded.host, undefined))?.home).toBe(right)
    const read = readPointer(userData)
    expect(read.kind === 'ok' && read.pointer.lastSeenEnv).toBe('/old')
    expect(recorded.log.join('')).toContain('/h/.zshrc:4')
    expect(recorded.persistentReads).toBe(1)
  })

  it('does not reopen the question with the value it just answered', async () => {
    const seen = dataDir('seen', OTHER)
    writePointer(userData, pointerAt(join(root, 'Ext', 'DSH-Data'), { lastSeenEnv: seen }))
    const right = dataDir('moved', ID)
    const recorded = recordingHost({
      answers: ['choose'], folders: [right], persistent: { kind: 'set', value: seen, source: 'login-shell' },
    })
    expect((await settleDataLocation(recorded.host, undefined))?.home).toBe(right)
    expect(recorded.asked).toHaveLength(1)
    const read = readPointer(userData)
    expect(read.kind === 'ok' && read.pointer.lastSeenEnv).toBe(right)
  })

  it('records what the terminal reports after the write, and claims no sync it did not see', async () => {
    const cases: Array<{ afterWrite: ExplicitRead; sync: string; lastSeenEnv: string | undefined }> = [
      { afterWrite: { kind: 'set', value: '/still/old', source: 'login-shell' }, sync: 'overridden', lastSeenEnv: '/still/old' },
      { afterWrite: { kind: 'unset' }, sync: 'overridden', lastSeenEnv: undefined },
      { afterWrite: { kind: 'unknown', detail: 'timed out' }, sync: 'unconfirmed', lastSeenEnv: '/before' },
    ]
    for (const [index, { afterWrite, sync, lastSeenEnv }] of cases.entries()) {
      writePointer(userData, pointerAt(join(root, 'Ext', 'DSH-Data'), { lastSeenEnv: '/before' }))
      const right = dataDir(`moved-${String(index)}`, ID)
      const recorded = recordingHost({ answers: ['choose'], folders: [right], afterWrite: () => afterWrite })
      const settled = await settleDataLocation(recorded.host, undefined)
      expect(settled?.terminal?.kind).toBe(sync)
      const read = readPointer(userData)
      expect(read.kind === 'ok' && read.pointer.path).toBe(right)
      expect(read.kind === 'ok' && read.pointer.lastSeenEnv).toBe(lastSeenEnv)
      expect(recorded.log.join('')).toMatch(sync === 'overridden' ? /not synced/ : /not confirmed/)
    }
  })

  it('keeps the pointer when the terminal write throws', async () => {
    writePointer(userData, pointerAt(join(root, 'Ext', 'DSH-Data')))
    const right = dataDir('moved', ID)
    const recorded = recordingHost({ answers: ['choose'], folders: [right], terminal: () => new Error('denied') })
    expect((await settleDataLocation(recorded.host, undefined))?.home).toBe(right)
    const read = readPointer(userData)
    expect(read.kind === 'ok' && read.pointer.lastSeenEnv).toBeUndefined()
  })

  it('follows a changed DSH_HOME that holds this kind of data, without asking', async () => {
    const data = dataDir('DSH-Data', ID)
    const moved = dataDir('Elsewhere', OTHER)
    writePointer(userData, pointerAt(data))
    const recorded = recordingHost({ persistent: { kind: 'set', value: moved, source: 'user-environment' } })
    const settled = await settleDataLocation(recorded.host, undefined)
    expect(settled).toMatchObject({ home: moved, via: 'followed-env' })
    expect(recorded.asked).toEqual([])
    expect(recorded.env['DSH_HOME']).toBe(moved)
    const read = readPointer(userData)
    expect(read.kind === 'ok' && read.pointer).toMatchObject({ path: moved, dataId: OTHER, lastSeenEnv: moved })
  })

  it('prefers the launch value over the persistent source', async () => {
    const data = dataDir('DSH-Data', ID)
    writePointer(userData, pointerAt(data, { lastSeenEnv: data }))
    const recorded = recordingHost({ persistent: { kind: 'set', value: '/ignored', source: 'login-shell' } })
    expect(await settleDataLocation(recorded.host, data)).toMatchObject({ home: data, via: 'pointer' })
    expect(recorded.persistentReads).toBe(0)
  })

  it('keeps the pointer over a changed DSH_HOME without data, points the terminal back at it, and does not ask again', async () => {
    const data = dataDir('DSH-Data', ID)
    writePointer(userData, pointerAt(data))
    const typo = join(root, 'DSH-Dta')
    const recorded = recordingHost({ answers: ['keep'], persistent: { kind: 'set', value: typo, source: 'login-shell' } })
    const settled = await settleDataLocation(recorded.host, undefined)
    expect(settled?.home).toBe(data)
    expect(settled?.terminal).toMatchObject({ kind: 'synced', value: data })
    expect(recorded.asked).toHaveLength(1)
    expect(recorded.terminalWrites).toEqual([data])
    expect(existsSync(typo)).toBe(false)
    const read = readPointer(userData)
    expect(read.kind === 'ok' && read.pointer).toMatchObject({ path: data, lastSeenEnv: data })
    const again = recordingHost({ persistent: { kind: 'set', value: data, source: 'login-shell' } })
    expect((await settleDataLocation(again.host, undefined))?.home).toBe(data)
    expect(again.asked).toEqual([])
  })

  it('remembers the declined value when the person\'s own line keeps it in the terminal', async () => {
    const data = dataDir('DSH-Data', ID)
    writePointer(userData, pointerAt(data))
    const typo = join(root, 'DSH-Dta')
    const persistent: ExplicitRead = { kind: 'set', value: typo, source: 'login-shell' }
    const foreign = (): TerminalWrite => ({ kind: 'profile', update: { kind: 'foreign-assignment', file: '/h/.zshrc', places: [{ file: '/h/.zshrc', line: 2 }] } })
    const recorded = recordingHost({ answers: ['keep'], persistent, terminal: foreign })
    expect((await settleDataLocation(recorded.host, undefined))?.terminal).toMatchObject({ kind: 'not-written' })
    const read = readPointer(userData)
    expect(read.kind === 'ok' && read.pointer.lastSeenEnv).toBe(typo)
    const again = recordingHost({ persistent, terminal: foreign })
    expect((await settleDataLocation(again.host, undefined))?.home).toBe(data)
    expect(again.asked).toEqual([])
  })

  it('starts a new location the person chose, leaving the old data where it is', async () => {
    const data = dataDir('DSH-Data', ID)
    writePointer(userData, pointerAt(data))
    const fresh = join(root, 'Fresh')
    const recorded = recordingHost({ answers: ['use-new'], persistent: { kind: 'set', value: fresh, source: 'login-shell' } })
    const settled = await settleDataLocation(recorded.host, undefined)
    expect(settled?.home).toBe(fresh)
    const id = readDataId(fresh)
    expect(id.kind === 'ok' && id.id).not.toBe(ID)
    expect(readDataId(data)).toEqual({ kind: 'ok', id: ID })
  })

  it('asks for a folder when the pointer is unreadable, accepting any marked folder', async () => {
    writeFileSync(join(userData, 'data-location.json'), '{')
    const picked = dataDir('picked', OTHER)
    const recorded = recordingHost({ answers: ['choose'], folders: [picked] })
    expect((await settleDataLocation(recorded.host, undefined))?.home).toBe(picked)
    expect(recorded.asked[0]?.detail).toBe(DATA_LOCATION_TEXT.zh.unavailable('pointer-unreadable', undefined))
  })
})

describe('settleDataLocation against a real zsh', () => {
  /** A host whose terminal is zsh in the temporary home, as an app opened from Finder sees it. */
  function zshHost(answers: LocationAnswer[], folders: string[]): Recorded {
    const recorded = recordingHost({ answers, folders })
    recorded.host.readPersistentEnv = async () => await readLoginShellDshHome({
      shell: '/bin/zsh', env: { HOME: osHome, PATH: '/usr/bin:/bin' }, timeoutMs: 20_000,
    })
    recorded.host.writeTerminalEnv = async value => ({
      kind: 'profile', update: updateShellProfile({ home: osHome, shell: '/bin/zsh', zdotdir: undefined }, value),
    })
    return recorded
  }

  withZsh.each([
    ['a ZDOTDIR set in ~/.zshenv', (old: string) => {
      mkdirSync(join(osHome, 'zd'))
      writeFileSync(join(osHome, '.zshenv'), 'export ZDOTDIR="$HOME/zd"\n')
      writeFileSync(join(osHome, 'zd', '.zshrc'), `export DSH_HOME=${shellQuote(old)}\n`)
    }],
    ['an assignment in ~/.zlogin', (old: string) => {
      writeFileSync(join(osHome, '.zlogin'), `export DSH_HOME=${shellQuote(old)}\n`)
    }],
  ])('does not follow the old value back when %s outlives the written block', async (_name, arrange) => {
    const old = dataDir('Old/DSH-Data', OTHER)
    arrange(old)
    writePointer(userData, pointerAt(join(root, 'Ext', 'DSH-Data'), { lastSeenEnv: old }))
    const right = dataDir('moved', ID)
    const first = zshHost(['choose'], [right])
    const settled = await settleDataLocation(first.host, undefined)
    expect(settled?.home).toBe(right)
    expect(settled?.terminal).toMatchObject({ kind: 'overridden', value: right, reported: old })
    expect(readFileSync(join(osHome, '.zshrc'), 'utf8')).toContain(shellQuote(right))
    const again = zshHost([], [])
    expect(await settleDataLocation(again.host, undefined)).toMatchObject({ home: right, via: 'pointer' })
    expect(again.asked).toEqual([])
  }, 60_000)
})
