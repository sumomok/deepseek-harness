/**
 * The launch step that settles the Harness home: what it exports, when it asks
 * the person and what each answer does, and when it touches the terminal's
 * `DSH_HOME` and `~/.dsh`. The host is a recording stand-in for the boot
 * window; every directory is under a temporary root.
 * @module
 */

import {
  chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  exportPointerHome, promptView, settleDataLocation,
  type DataLocationHost, type LocationAnswer, type PromptView,
} from '../src/data-location-boot.ts'
import {
  DATA_ID_FILENAME, MOVE_STATE_FILENAME, POINTER_VERSION, readDataId, readGeneration, readPointer, RETIRED_FILENAME, writeGeneration,
  writePointer,
  type DataId, type DataLocationPointer,
} from '../src/data-location.ts'
import {
  ABANDONED_FILENAME, abandonedCopiesAsideName, abandonedCopiesText, JournalError, moveDir, readAbandonedCopies, setAbandonedCopiesAside,
  type MoveId,
} from '../src/move/journal.ts'
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
  revealed: string[]
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
  onReveal?: (path: string) => void
  env?: NodeJS.ProcessEnv
} = {}): Recorded {
  const answers = [...options.answers ?? []]
  const folders = [...options.folders ?? []]
  const log: string[] = []
  const asked: PromptView[] = []
  const told: string[] = []
  const terminalWrites: string[] = []
  const revealed: string[] = []
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
      if (value === undefined) throw new Error('the launch step never removes the terminal setting')
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
    reveal: (path) => {
      revealed.push(path)
      options.onReveal?.(path)
    },
    tell: async (message) => { told.push(message) },
  }
  return {
    host, env, asked, told, terminalWrites, log, revealed,
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

  it('exports nothing when only the backup of the pointer is readable', () => {
    writePointer(userData, pointerAt('/old'))
    writePointer(userData, pointerAt('/new'))
    writeFileSync(join(userData, 'data-location.json'), '{')
    const env: NodeJS.ProcessEnv = {}
    expect(exportPointerHome(userData, env)).toBeUndefined()
    expect(env).toEqual({})
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
    expect(unavailable.buttons[0]?.answer).toBe('retry')
    expect(env.buttons[0]?.answer).toBe('keep')
    expect(env.detail).toContain('/typo')
    expect(env.detail).toContain('/data')
  })

  it('offers only keep and quit when the new location cannot be used', () => {
    for (const reason of ['not-a-folder', 'damaged-data', 'set-aside', 'cannot-create'] as const) {
      for (const text of [DATA_LOCATION_TEXT.zh, DATA_LOCATION_TEXT.en]) {
        const view = promptView({ kind: 'confirm-env', reason, envPath: '/set', current: '/data' }, text)
        expect(view.buttons.map(button => button.answer)).toEqual(['keep', 'quit'])
        expect(view.buttons[view.cancelIndex]?.answer).toBe('keep')
        expect(view.detail).toContain('/set')
        expect(view.detail).not.toContain(text.useNew)
      }
    }
    for (const reason of ['missing', 'not-harness-data'] as const) {
      const view = promptView({ kind: 'confirm-env', reason, envPath: '/set', current: '/data' }, DATA_LOCATION_TEXT.zh)
      expect(view.buttons.map(button => button.answer)).toEqual(['keep', 'use-new'])
    }
  })

  it('names the file browser of each platform on the damaged-record prompt', () => {
    const mac = promptView({ kind: 'abandoned-unreadable', path: '/u/abandoned-copies.json', platform: 'darwin' }, DATA_LOCATION_TEXT.zh)
    expect(mac.buttons.map(button => button.label)).toEqual(['在访达中显示', '移开这个文件并继续', '退出'])
    const win = promptView({ kind: 'abandoned-unreadable', path: 'C:\\u\\abandoned-copies.json', platform: 'win32' }, DATA_LOCATION_TEXT.zh)
    expect(win.buttons.map(button => button.label)).toEqual(['在资源管理器中显示', '移开这个文件并继续', '退出'])
    const en = promptView({ kind: 'abandoned-unreadable', path: 'C:\\u\\abandoned-copies.json', platform: 'win32' }, DATA_LOCATION_TEXT.en)
    expect(en.buttons.map(button => button.label)).toEqual(['Show in File Explorer', 'Move This File Aside and Continue', 'Quit'])
    expect(en.detail).toContain('C:\\u\\abandoned-copies.json')
  })

  it('picks the language by locale', () => {
    expect(dataLocationText('zh-CN')).toBe(DATA_LOCATION_TEXT.zh)
    expect(dataLocationText('en-US')).toBe(DATA_LOCATION_TEXT.en)
  })

  it('names each reason in words, without the variable\'s name', () => {
    for (const text of [DATA_LOCATION_TEXT.zh, DATA_LOCATION_TEXT.en]) {
      for (const reason of ['missing', 'id-mismatch', 'pointer-unreadable', 'set-aside'] as const) {
        expect(text.unavailable(reason, '/p')).not.toMatch(/DSH_HOME|pointer|指针/)
      }
      expect(text.unavailableSuggested('/p')).not.toMatch(/DSH_HOME|pointer|backup|指针|备份/)
      for (const reason of ['missing', 'not-harness-data', 'not-a-folder', 'damaged-data', 'set-aside', 'cannot-create'] as const) {
        expect(text.env(reason, '/a', '/b')).not.toMatch(/DSH_HOME|pointer|marker|指针|标记/)
      }
    }
  })
})

describe('settleDataLocation and folders a data move set aside', () => {
  it('asks instead of using a pointer\'s folder that a move set aside, and refuses picking one', async () => {
    const aside = dataDir('aside', ID)
    writeFileSync(join(aside, MOVE_STATE_FILENAME), 'm\n')
    const retired = dataDir('retired')
    writeFileSync(join(retired, RETIRED_FILENAME), '{}\n')
    const good = dataDir('good', ID)
    writePointer(userData, pointerAt(aside))
    const recorded = recordingHost({ answers: ['choose', 'choose'], folders: [retired, good] })
    const settled = await settleDataLocation(recorded.host, undefined)
    expect(settled).toMatchObject({ home: good, via: 'pointer' })
    expect(recorded.asked.map(view => view.detail)).toEqual([
      DATA_LOCATION_TEXT.zh.unavailable('set-aside', aside), DATA_LOCATION_TEXT.zh.unavailable('set-aside', aside),
    ])
    expect(recorded.told).toEqual([DATA_LOCATION_TEXT.zh.refusedSetAside(retired)])
  })

  it('refuses an abandoned copy recorded under user data, and names the default home it cannot use', async () => {
    mkdirSync(defaultHome)
    writeFileSync(join(defaultHome, DATA_ID_FILENAME), `${ID}\n`)
    mkdirSync(moveDir(userData))
    writeFileSync(join(moveDir(userData), ABANDONED_FILENAME), abandonedCopiesText([
      { path: realpathSync(defaultHome), dataId: ID, moveId: 'm' as MoveId, abandonedAt: '' },
    ]))
    const recorded = recordingHost({ answers: ['quit'] })
    expect(await settleDataLocation(recorded.host, undefined)).toBeUndefined()
    expect(recorded.asked[0]?.detail).toBe(DATA_LOCATION_TEXT.zh.unavailable('set-aside', defaultHome))
  })

  it('does not start while the record of abandoned copies is damaged: it names the file, shows it, and quits', async () => {
    mkdirSync(defaultHome)
    mkdirSync(moveDir(userData))
    const record = join(moveDir(userData), ABANDONED_FILENAME)
    writeFileSync(record, '{')
    const quitting = recordingHost({ answers: ['reveal', 'reveal', 'quit'] })
    expect(await settleDataLocation(quitting.host, undefined)).toBeUndefined()
    expect(quitting.revealed).toEqual([record, record])
    expect(quitting.asked).toHaveLength(3)
    const view = quitting.asked[0]
    expect(view?.message).toBe(DATA_LOCATION_TEXT.zh.abandonedUnreadableTitle)
    expect(view?.detail).toBe(DATA_LOCATION_TEXT.zh.abandonedUnreadable(record))
    expect(view?.buttons.map(button => button.answer)).toEqual(['reveal', 'move-aside', 'quit'])
    expect(view?.buttons[view.cancelIndex]?.answer).toBe('quit')
    // Nothing was decided or written while the record was unreadable.
    expect(readPointer(userData)).toEqual({ kind: 'absent' })
    expect(readDataId(defaultHome).kind).toBe('absent')
    // Once the person fixes the file, the launch goes on.
    const fixing = recordingHost({ answers: ['reveal'], onReveal: () => { writeFileSync(record, abandonedCopiesText([])) } })
    expect(await settleDataLocation(fixing.host, undefined)).toMatchObject({ home: defaultHome, via: 'default' })
  })
})

describe('setting an unreadable record of abandoned copies aside', () => {
  /** A default home and an unreadable record; returns the record's path. */
  function damagedRecord(): string {
    mkdirSync(defaultHome)
    mkdirSync(moveDir(userData))
    const record = join(moveDir(userData), ABANDONED_FILENAME)
    writeFileSync(record, '{')
    return record
  }

  /** The files in the move directory named like a set-aside record. */
  function asideFiles(): string[] {
    return readdirSync(moveDir(userData)).filter(name => /^abandoned-copies\.corrupt-[0-9T-]+Z(-\d+)?\.json$/.test(name))
  }

  it('asks first, and cancelling leaves the record where it is', async () => {
    const record = damagedRecord()
    const recorded = recordingHost({ answers: ['move-aside', 'cancel', 'quit'] })
    expect(await settleDataLocation(recorded.host, undefined)).toBeUndefined()
    const confirm = recorded.asked[1]
    expect(confirm?.message).toBe(DATA_LOCATION_TEXT.zh.confirmMoveAsideTitle)
    expect(confirm?.buttons.map(button => button.answer)).toEqual(['cancel', 'confirm'])
    expect(confirm?.buttons[confirm.cancelIndex]?.answer).toBe('cancel')
    const name = /改名为「([^」]+)」/.exec(confirm?.detail ?? '')?.[1]
    expect(confirm?.detail).toBe(DATA_LOCATION_TEXT.zh.confirmMoveAside(record, name ?? ''))
    expect(readFileSync(record, 'utf8')).toBe('{')
    expect(asideFiles()).toEqual([])
  })

  it('renames the record aside, keeps its bytes, and goes on', async () => {
    const record = damagedRecord()
    const recorded = recordingHost({ answers: ['move-aside', 'confirm'] })
    expect(await settleDataLocation(recorded.host, undefined)).toMatchObject({ home: defaultHome, via: 'default' })
    const aside = asideFiles()
    expect(aside).toHaveLength(1)
    expect(recorded.asked[1]?.detail).toContain(aside[0])
    expect(readFileSync(join(moveDir(userData), aside[0] ?? ''), 'utf8')).toBe('{')
    expect(existsSync(record)).toBe(false)
    expect(readAbandonedCopies(moveDir(userData))).toEqual([])
  })

  it('never overwrites an earlier set-aside record', async () => {
    damagedRecord()
    await settleDataLocation(recordingHost({ answers: ['move-aside', 'confirm'] }).host, undefined)
    const first = asideFiles()
    writeFileSync(join(moveDir(userData), ABANDONED_FILENAME), '[')
    // The same second on a fast machine gives the same time; the name must still differ.
    const recorded = recordingHost({ answers: ['move-aside', 'confirm'] })
    await settleDataLocation(recorded.host, undefined)
    expect(asideFiles()).toHaveLength(2)
    expect(asideFiles()).toEqual(expect.arrayContaining(first))
    expect(new Set(asideFiles().map(name => readFileSync(join(moveDir(userData), name), 'utf8')))).toEqual(new Set(['{', '[']))
  })

  it('leaves a record that was repaired while the confirmation was open', async () => {
    const record = damagedRecord()
    const repaired = abandonedCopiesText([])
    const recorded = recordingHost({
      answers: ['move-aside', 'confirm'],
      onAsk: (view) => { if (view.message === DATA_LOCATION_TEXT.zh.confirmMoveAsideTitle) writeFileSync(record, repaired) },
    })
    expect(await settleDataLocation(recorded.host, undefined)).toMatchObject({ home: defaultHome })
    expect(readFileSync(record, 'utf8')).toBe(repaired)
    expect(asideFiles()).toEqual([])
  })

  it('names the set-aside file by the time, with a number when that name is taken', () => {
    const record = damagedRecord()
    const dir = moveDir(userData)
    const at = new Date('2026-09-28T01:02:03.456Z')
    expect(abandonedCopiesAsideName(dir, at)).toBe('abandoned-copies.corrupt-2026-09-28T01-02-03-456Z.json')
    writeFileSync(join(dir, 'abandoned-copies.corrupt-2026-09-28T01-02-03-456Z.json'), 'earlier')
    expect(abandonedCopiesAsideName(dir, at)).toBe('abandoned-copies.corrupt-2026-09-28T01-02-03-456Z-2.json')
    expect(() => setAbandonedCopiesAside(dir, 'abandoned-copies.corrupt-2026-09-28T01-02-03-456Z.json')).toThrow(JournalError)
    expect(readFileSync(join(dir, 'abandoned-copies.corrupt-2026-09-28T01-02-03-456Z.json'), 'utf8')).toBe('earlier')
    expect(readFileSync(record, 'utf8')).toBe('{')
  })

  posixOnly('asks again when the rename fails, and does not start', async () => {
    const record = damagedRecord()
    chmodSync(moveDir(userData), 0o500)
    try {
      const recorded = recordingHost({ answers: ['move-aside', 'confirm', 'quit'] })
      expect(await settleDataLocation(recorded.host, undefined)).toBeUndefined()
      expect(recorded.asked.map(view => view.message)).toEqual([
        DATA_LOCATION_TEXT.zh.abandonedUnreadableTitle,
        DATA_LOCATION_TEXT.zh.confirmMoveAsideTitle,
        DATA_LOCATION_TEXT.zh.abandonedUnreadableTitle,
      ])
      expect(recorded.log.some(line => line.includes('could not set'))).toBe(true)
    } finally {
      chmodSync(moveDir(userData), 0o700)
    }
    expect(readFileSync(record, 'utf8')).toBe('{')
    expect(readPointer(userData)).toEqual({ kind: 'absent' })
  })
})

describe('making a set-aside folder the data again', () => {
  /** A folder with the identity, set aside by a lower number than the pointer's. */
  function olderFolder(): string {
    const folder = dataDir('mine', ID)
    writeGeneration(folder, 1)
    writePointer(userData, pointerAt(folder, { generation: 2 }))
    return folder
  }

  /** Record the folder as an abandoned copy. */
  function recordAbandoned(folder: string): void {
    mkdirSync(moveDir(userData), { recursive: true })
    writeFileSync(join(moveDir(userData), ABANDONED_FILENAME), abandonedCopiesText([
      { path: realpathSync(folder), dataId: ID, moveId: 'm' as MoveId, abandonedAt: '' },
    ]))
  }

  it('offers it only after a confirmation that other copies stop being used, then uses the folder', async () => {
    const folder = olderFolder()
    recordAbandoned(folder)
    const recorded = recordingHost({ answers: ['use-anyway', 'confirm'] })
    expect(await settleDataLocation(recorded.host, undefined)).toMatchObject({ home: folder, via: 'pointer' })
    const [page, confirm] = recorded.asked
    expect(page?.buttons.map(button => button.answer)).toEqual(['retry', 'choose', 'use-anyway', 'quit'])
    expect(page?.buttons.find(button => button.answer === 'use-anyway')?.label).toBe('这就是我要用的数据，改用它')
    expect(confirm?.message).toBe(DATA_LOCATION_TEXT.zh.confirmUseTitle(folder))
    expect(confirm?.detail).toBe(DATA_LOCATION_TEXT.zh.confirmUse)
    expect(confirm?.buttons[confirm.cancelIndex]?.answer).toBe('cancel')
    expect(readGeneration(folder)).toBe(3)
    expect(readPointer(userData)).toMatchObject({ kind: 'ok', pointer: { path: folder, generation: 3 } })
    expect(readAbandonedCopies(moveDir(userData))).toEqual([])
  })

  it('changes nothing when the person cancels', async () => {
    const folder = olderFolder()
    const recorded = recordingHost({ answers: ['use-anyway', 'cancel', 'quit'] })
    expect(await settleDataLocation(recorded.host, undefined)).toBeUndefined()
    expect(readGeneration(folder)).toBe(1)
    expect(readPointer(userData)).toMatchObject({ kind: 'ok', pointer: { generation: 2 } })
  })

  it('is not offered for a folder in the middle of a move or retired', async () => {
    const folder = dataDir('marked', ID)
    writeFileSync(join(folder, RETIRED_FILENAME), '{}\n')
    writePointer(userData, pointerAt(folder))
    const recorded = recordingHost({ answers: ['quit'] })
    await settleDataLocation(recorded.host, undefined)
    expect(recorded.asked[0]?.buttons.map(button => button.answer)).toEqual(['retry', 'choose', 'quit'])
  })

  posixOnly('ends with the folder in use after an interruption at any of its steps', async () => {
    const folder = olderFolder()
    recordAbandoned(folder)
    // The record cannot be rewritten: the folder's number is already raised, the rest is not done.
    chmodSync(moveDir(userData), 0o500)
    try {
      await expect(settleDataLocation(recordingHost({ answers: ['use-anyway', 'confirm'] }).host, undefined)).rejects.toThrow()
    } finally {
      chmodSync(moveDir(userData), 0o700)
    }
    expect(readGeneration(folder)).toBe(3)
    expect(readAbandonedCopies(moveDir(userData))).toHaveLength(1)
    expect(readPointer(userData)).toMatchObject({ kind: 'ok', pointer: { generation: 2 } })
    // Still refused by the record, so the person is asked again; now the pointer cannot be written.
    chmodSync(userData, 0o500)
    try {
      await expect(settleDataLocation(recordingHost({ answers: ['use-anyway', 'confirm'] }).host, undefined)).rejects.toThrow()
    } finally {
      chmodSync(userData, 0o700)
    }
    expect(readGeneration(folder)).toBe(4)
    expect(readAbandonedCopies(moveDir(userData))).toEqual([])
    // The pointer is one step behind its folder, which the reference allows for: the folder is used.
    const settled = await settleDataLocation(recordingHost().host, undefined)
    expect(settled).toMatchObject({ home: folder, via: 'pointer' })
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

  posixOnly('takes a DSH_HOME of ~/.dsh for the directory the link names, never the link', async () => {
    const data = dataDir('Ext/DSH-Data', ID)
    writePointer(userData, pointerAt(data))
    await settleDataLocation(recordingHost().host, undefined)
    expect(readlinkSync(defaultHome)).toBe(data)
    const recorded = recordingHost({ persistent: { kind: 'set', value: '~/.dsh', source: 'login-shell' } })
    const settled = await settleDataLocation(recorded.host, undefined)
    expect(settled).toMatchObject({ home: data, via: 'pointer', link: { kind: 'already-correct' } })
    expect(recorded.asked).toEqual([])
    const read = readPointer(userData)
    expect(read.kind === 'ok' && read.pointer).toMatchObject({ path: data, lastSeenEnv: data })
    expect(readlinkSync(defaultHome)).toBe(data)
  })

  posixOnly('reads a DSH_HOME of a dangling ~/.dsh as the unplugged directory it names', async () => {
    const data = join(root, 'Unplugged', 'DSH-Data')
    writePointer(userData, pointerAt(data))
    symlinkSync(data, defaultHome)
    const recorded = recordingHost({ answers: ['quit'], persistent: { kind: 'set', value: defaultHome, source: 'login-shell' } })
    expect(await settleDataLocation(recorded.host, undefined)).toBeUndefined()
    expect(recorded.asked[0]?.detail).toBe(DATA_LOCATION_TEXT.zh.unavailable('missing', data))
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

  it('logs a profile reached through a dangling link as not written', async () => {
    writePointer(userData, pointerAt(join(root, 'Ext', 'DSH-Data')))
    const right = dataDir('moved', ID)
    const recorded = recordingHost({
      answers: ['choose'], folders: [right],
      terminal: () => ({ kind: 'profile', update: { kind: 'dangling-profile', link: '/h/.bash_profile' } }),
    })
    expect((await settleDataLocation(recorded.host, undefined))?.terminal).toMatchObject({ kind: 'not-written' })
    expect(recorded.log.join('')).toContain('through /h/.bash_profile, a link whose target is missing')
    expect(recorded.asked).toHaveLength(1)
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

  it('quits from the changed-location prompt when the new location cannot be used', async () => {
    const data = dataDir('DSH-Data', ID)
    writePointer(userData, pointerAt(data))
    const file = join(root, 'a-file')
    writeFileSync(file, 'x')
    const recorded = recordingHost({ answers: ['quit'], persistent: { kind: 'set', value: file, source: 'login-shell' } })
    expect(await settleDataLocation(recorded.host, undefined)).toBeUndefined()
    expect(recorded.asked[0]?.buttons.map(button => button.answer)).toEqual(['keep', 'quit'])
    expect(recorded.terminalWrites).toEqual([])
    expect(readPointer(userData)).toEqual({ kind: 'ok', pointer: pointerAt(data) })
  })

  posixOnly('offers only keep and quit for a DSH_HOME that is a dangling link, and keeps the launch going', async () => {
    const data = dataDir('DSH-Data', ID)
    writePointer(userData, pointerAt(data))
    const dangling = join(root, 'dangling')
    symlinkSync(join(root, 'Unplugged', 'DSH-Data'), dangling)
    const recorded = recordingHost({ answers: ['keep'], persistent: { kind: 'set', value: dangling, source: 'login-shell' } })
    expect((await settleDataLocation(recorded.host, undefined))?.home).toBe(data)
    expect(recorded.asked[0]?.buttons.map(button => button.answer)).toEqual(['keep', 'quit'])
    expect(recorded.asked[0]?.detail).toBe(DATA_LOCATION_TEXT.zh.env('not-a-folder', dangling, data))
    expect(existsSync(join(root, 'Unplugged'))).toBe(false)
  })

  const writable = process.platform === 'win32' || process.getuid?.() === 0 ? it.skip : it

  writable('asks again with keep and quit when the new location cannot be created, and never shows the error', async () => {
    const data = dataDir('DSH-Data', ID)
    writePointer(userData, pointerAt(data))
    const locked = dataDir('locked')
    const fresh = join(locked, 'Fresh')
    chmodSync(locked, 0o555)
    try {
      for (const last of ['keep', 'quit'] as const) {
        const recorded = recordingHost({ answers: ['use-new', last], persistent: { kind: 'set', value: fresh, source: 'login-shell' } })
        const settled = await settleDataLocation(recorded.host, undefined)
        expect(recorded.asked.map(view => view.buttons.map(button => button.answer))).toEqual([['keep', 'use-new'], ['keep', 'quit']])
        expect(recorded.asked[1]?.detail).toBe(DATA_LOCATION_TEXT.zh.env('cannot-create', fresh, data))
        expect(recorded.asked[1]?.detail).not.toMatch(/EACCES|Error|permission denied/i)
        expect(recorded.log.join('')).toContain('EACCES')
        expect(settled?.home).toBe(last === 'keep' ? data : undefined)
        const read = readPointer(userData)
        expect(read.kind === 'ok' && read.pointer.path).toBe(data)
        expect(existsSync(fresh)).toBe(false)
      }
    } finally {
      chmodSync(locked, 0o755)
    }
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

  it('offers the backup\'s location for confirmation instead of using it', async () => {
    const old = dataDir('Old', ID)
    const current = dataDir('Current', ID)
    writePointer(userData, pointerAt(old))
    writePointer(userData, pointerAt(current))
    writeFileSync(join(userData, 'data-location.json'), '{"trunc')
    const recorded = recordingHost({ answers: ['choose'], folders: [current] })
    expect((await settleDataLocation(recorded.host, undefined))?.home).toBe(current)
    const view = recorded.asked[0]
    expect(view?.buttons.map(button => button.answer)).toEqual(['retry', 'use-suggested', 'choose', 'quit'])
    expect(view?.buttons[view.cancelIndex]?.answer).toBe('quit')
    expect(view?.detail).toBe(DATA_LOCATION_TEXT.zh.unavailableSuggested(old))
    const read = readPointer(userData)
    expect(read.kind === 'ok' && read.pointer.path).toBe(current)
  })

  it('uses the backup\'s location once the person confirms it, if it still carries the recorded identity', async () => {
    const old = dataDir('Old', ID)
    writeFileSync(join(userData, 'data-location.json.bak'), JSON.stringify(pointerAt(old)))
    writeFileSync(join(userData, 'data-location.json'), '{"trunc')
    const recorded = recordingHost({ answers: ['use-suggested'] })
    const settled = await settleDataLocation(recorded.host, undefined)
    expect(settled?.home).toBe(old)
    expect(recorded.terminalWrites).toEqual([old])
    const read = readPointer(userData)
    expect(read.kind === 'ok' && read.pointer).toMatchObject({ path: old, dataId: ID })
    const other = dataDir('Other', OTHER)
    writeFileSync(join(userData, 'data-location.json.bak'), JSON.stringify(pointerAt(other)))
    writeFileSync(join(userData, 'data-location.json'), '{"trunc')
    const refused = recordingHost({ answers: ['use-suggested', 'quit'] })
    expect(await settleDataLocation(refused.host, undefined)).toBeUndefined()
    expect(refused.told).toEqual([DATA_LOCATION_TEXT.zh.refusedOtherData(other)])
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

  withZsh('confirms the sync through a CRLF ~/.zshrc, the terminal reading the directory with no carriage return', async () => {
    writeFileSync(join(osHome, '.zshrc'), 'export A=1\r\nexport B=2\r\n')
    writePointer(userData, pointerAt(join(root, 'Ext', 'DSH-Data')))
    const right = dataDir('moved', ID)
    const settled = await settleDataLocation(zshHost(['choose'], [right]).host, undefined)
    expect(settled?.terminal).toEqual(expect.objectContaining({ kind: 'synced', value: right }))
    const read = await readLoginShellDshHome({ shell: '/bin/zsh', env: { HOME: osHome, PATH: '/usr/bin:/bin' }, timeoutMs: 20_000 })
    expect(read).toEqual({ kind: 'set', value: right, source: 'login-shell' })
  }, 60_000)

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
