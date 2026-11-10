/**
 * The shell's state file as the port choice and the update handoff use it: the
 * remembered server port survives a write of any other field, a value that is
 * not a port is read back as nothing remembered, and the two update records
 * are projected field by field — a complete record is read, a damaged or older
 * one is not promoted or trusted as a whole. The file is real, under a
 * temporary userData directory; electron's `app` stands in.
 * @module
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InstallReceipt } from '../src/desktop-state.ts'
import type { ReleaseIdentity } from '../src/release-identity.ts'

const fixture = vi.hoisted(() => ({
  userData: '',
  locale: 'zh-CN',
  /** Error codes the next renames throw, one per call, before the real rename runs again. */
  renameFailures: [] as string[],
  renames: 0,
  /** File-system calls in order, as `fsync` and `rename`. */
  calls: [] as string[],
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    fsyncSync: (fd: number): void => {
      fixture.calls.push('fsync')
      actual.fsyncSync(fd)
    },
    renameSync: (from: string, to: string): void => {
      fixture.calls.push('rename')
      fixture.renames += 1
      const code = fixture.renameFailures.shift()
      if (code !== undefined) throw Object.assign(new Error(`${code}: rename`), { code })
      actual.renameSync(from, to)
    },
  }
})

vi.mock('electron', () => ({
  app: {
    getPath: (): string => fixture.userData,
    getVersion: (): string => '0.1.0-rc.35',
    getLocale: (): string => fixture.locale,
  },
}))

const {
  confirmedInstallOnLaunch, forgetServerPort, readState, recordBuildRun, RENAME_ATTEMPTS, reportStateWritesTo, setCloseAction,
  setInstalledUpdate, setInstalledUpdateV2, setServerPort,
} = await import('../src/desktop-state.ts')
const { menuText, shellLanguage } = await import('../src/menu-text.ts')

beforeEach(() => {
  fixture.userData = mkdtempSync(join(tmpdir(), 'dsh-desktop-state-'))
  fixture.renameFailures = []
  fixture.renames = 0
  fixture.calls = []
  reportStateWritesTo(() => {})
})

afterEach(() => {
  rmSync(fixture.userData, { recursive: true, force: true })
})

/**
 * Replace the state file with raw JSON.
 * @param value - what the file holds.
 */
function writeRaw(value: unknown): void {
  writeFileSync(join(fixture.userData, 'desktop-state.json'), JSON.stringify(value))
}

describe('serverPort', () => {
  it('is remembered without dropping other fields, and kept across a write of another field', () => {
    setCloseAction('quit')
    setServerPort(49_321)
    expect(readState()).toEqual({ serverPort: 49_321, closeAction: 'quit' })
    setCloseAction('tray')
    expect(readState()).toEqual({ serverPort: 49_321, closeAction: 'tray' })
    expect(JSON.parse(readFileSync(join(fixture.userData, 'desktop-state.json'), 'utf8'))).toEqual({ serverPort: 49_321, closeAction: 'tray' })
  })

  it('reads back as nothing remembered when the file holds something that is not a port', () => {
    for (const serverPort of [0, 70_000, 12.5, '49321', null]) {
      writeRaw({ serverPort, closeAction: 'quit' })
      expect(readState()).toEqual({ closeAction: 'quit' })
    }
  })
})

describe('writes', () => {
  it('replace the file through a flushed temporary file and leave none behind', () => {
    setServerPort(49_321)
    expect(fixture.calls).toEqual(['fsync', 'rename'])
    expect(existsSync(join(fixture.userData, 'desktop-state.json.tmp'))).toBe(false)
    expect(readState()).toEqual({ serverPort: 49_321 })
  })

  it('leave the previous file whole when the temporary file cannot be written', () => {
    writeRaw({ closeAction: 'quit', installedUpdate: { fromVersion: '0.1.0-rc.34', fileName: 'a.zip', sha512: 'x' } })
    const before = readFileSync(join(fixture.userData, 'desktop-state.json'), 'utf8')
    mkdirSync(join(fixture.userData, 'desktop-state.json.tmp'))
    setServerPort(49_321)
    expect(readFileSync(join(fixture.userData, 'desktop-state.json'), 'utf8')).toBe(before)
  })

  it('remove the temporary file when the rename fails', () => {
    mkdirSync(join(fixture.userData, 'desktop-state.json'))
    writeFileSync(join(fixture.userData, 'desktop-state.json', 'occupant'), '')
    setServerPort(49_321)
    expect(existsSync(join(fixture.userData, 'desktop-state.json.tmp'))).toBe(false)
  })
})

describe('forgetServerPort', () => {
  it('drops the remembered port and keeps every other field', () => {
    setCloseAction('tray')
    setServerPort(49_321)
    forgetServerPort()
    expect(readState()).toEqual({ closeAction: 'tray' })
  })
})

describe('a rename refused by another process', () => {
  it('is retried until it succeeds', () => {
    fixture.renameFailures = ['EPERM', 'EBUSY']
    setServerPort(49_321)
    expect(fixture.renames).toBe(3)
    expect(readState()).toEqual({ serverPort: 49_321 })
  })

  it('is given up after the last attempt, reported, and leaves the previous file and no temporary file', () => {
    setCloseAction('quit')
    const lines: string[] = []
    reportStateWritesTo((line) => { lines.push(line) })
    fixture.renames = 0
    fixture.renameFailures = Array.from({ length: RENAME_ATTEMPTS }, () => 'EACCES')
    setServerPort(49_321)
    expect(fixture.renames).toBe(RENAME_ATTEMPTS)
    expect(readState()).toEqual({ closeAction: 'quit' })
    expect(existsSync(join(fixture.userData, 'desktop-state.json.tmp'))).toBe(false)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('could not write')
  })

  it('is not retried for an error that is not a sharing error', () => {
    fixture.renameFailures = ['ENOSPC']
    setServerPort(49_321)
    expect(fixture.renames).toBe(1)
    expect(readState()).toEqual({})
  })
})

describe('shellLanguage', () => {
  it('follows the system locale, Chinese for zh* and English otherwise', () => {
    fixture.locale = 'zh-TW'
    expect(shellLanguage()).toBe('zh')
    expect(menuText().edit).toBe('编辑')
    fixture.locale = 'en-US'
    expect(shellLanguage()).toBe('en')
    expect(menuText().edit).toBe('Edit')
  })
})

/** The version every build in the state-file cases publishes under. */
const BUILD_VERSION = '0.1.0-rc.35'

/** A source commit identity for builds that differ only in sequence. */
const REVISION = '0123456789abcdef0123456789abcdef01234567'

/**
 * One build's complete identity.
 * @param sequence - build sequence.
 * @returns the identity of a standard build of [[BUILD_VERSION]].
 */
function build(sequence: number): ReleaseIdentity {
  return {
    version: BUILD_VERSION,
    dshRelease: { schemaVersion: 2, runtimeVersion: BUILD_VERSION, buildSequence: sequence, revision: REVISION, kind: 'standard' },
  }
}

/** The artifact a receipt names. */
const FILE_NAME = 'DSH Desktop-0.1.0-rc.35-arm64-mac.zip'

/** The manifest's base64 SHA-512 for that artifact. */
const SHA512 = `${'A'.repeat(86)}==`

/** A complete install receipt. */
const RECEIPT: InstallReceipt = { schemaVersion: 2, from: build(101), target: build(102), fileName: FILE_NAME, sha512: SHA512 }

describe('confirmed install on launch', () => {
  it('confirms the receipt target before recording the launch and suppresses repeat notices', () => {
    setInstalledUpdateV2(RECEIPT)
    recordBuildRun(RECEIPT.from)
    expect(confirmedInstallOnLaunch(RECEIPT.target)).toEqual(RECEIPT)
    expect(readState().installedUpdateV2).toEqual(RECEIPT)
    recordBuildRun(RECEIPT.target)
    expect(confirmedInstallOnLaunch(RECEIPT.target)).toBeUndefined()
  })

  it('does not report manual changes, downgrades, or an unconfirmed receipt as installed', () => {
    recordBuildRun(build(103))
    expect(confirmedInstallOnLaunch(build(104))).toBeUndefined()
    setInstalledUpdateV2({ ...RECEIPT, target: build(104) })
    expect(confirmedInstallOnLaunch(build(101))).toBeUndefined()
    expect(confirmedInstallOnLaunch(RECEIPT.from)).toBeUndefined()
    expect(confirmedInstallOnLaunch(undefined)).toBeUndefined()
  })

  it('requires the complete target identity, including revision', () => {
    setInstalledUpdateV2(RECEIPT)
    const other = { ...RECEIPT.target, dshRelease: { ...RECEIPT.target.dshRelease, revision: 'b'.repeat(40) } }
    expect(confirmedInstallOnLaunch(other)).toBeUndefined()
  })
})

describe('lastRunBuild', () => {
  it('records the complete identity and reports a different build that ran before it', () => {
    const first = build(101)
    expect(recordBuildRun(first)).toBeUndefined()
    expect(readState()).toEqual({ lastRunBuild: first })
    const second = build(102)
    expect(recordBuildRun(second)).toEqual(first)
    expect(readState()).toEqual({ lastRunBuild: second })
  })

  it('reports nothing when the same build runs again', () => {
    recordBuildRun(build(101))
    expect(recordBuildRun(build(101))).toBeUndefined()
  })

  it('records nothing for a launch that carries no identity, and keeps what was recorded', () => {
    const recorded = build(101)
    recordBuildRun(recorded)
    expect(recordBuildRun(undefined)).toBeUndefined()
    expect(readState()).toEqual({ lastRunBuild: recorded })
  })

  it('reads back only a complete identity; an older or damaged one is not remembered', () => {
    writeRaw({ lastRunBuild: build(101), closeAction: 'quit' })
    expect(readState()).toEqual({ lastRunBuild: build(101), closeAction: 'quit' })
    for (const lastRunBuild of [
      { version: BUILD_VERSION },
      { ...build(101), dshRelease: { ...build(101).dshRelease, schemaVersion: 1 } },
      { ...build(101), dshRelease: { ...build(101).dshRelease, buildSequence: 0 } },
      { ...build(101), version: 'not-a-version' },
      'a build',
    ]) {
      writeRaw({ lastRunBuild, closeAction: 'quit' })
      expect(readState()).toEqual({ closeAction: 'quit' })
    }
  })
})

describe('installedUpdateV2', () => {
  it('records both identities and the artifact, and reads them back field for field', () => {
    expect(setInstalledUpdateV2(RECEIPT)).toBe(true)
    expect(readState()).toEqual({ installedUpdateV2: RECEIPT })
    expect(setInstalledUpdateV2(undefined)).toBe(true)
    expect(readState()).toEqual({})
  })

  it('keeps every other field, the older record included', () => {
    const legacy = { fromVersion: '0.1.0-rc.34', fileName: 'DSH Desktop-0.1.0-rc.34-arm64-mac.zip', sha512: 'legacy' }
    setCloseAction('quit')
    setServerPort(49_321)
    setInstalledUpdate(legacy)
    expect(setInstalledUpdateV2(RECEIPT)).toBe(true)
    expect(readState()).toEqual({ closeAction: 'quit', serverPort: 49_321, installedUpdate: legacy, installedUpdateV2: RECEIPT })
    expect(setInstalledUpdateV2(undefined)).toBe(true)
    expect(readState()).toEqual({ closeAction: 'quit', serverPort: 49_321, installedUpdate: legacy })
  })

  it('reads a receipt only when every field is valid, and never trusts the record as a whole', () => {
    writeRaw({ installedUpdateV2: { ...RECEIPT, extra: 'ignored' }, closeAction: 'quit' })
    expect(readState()).toEqual({ installedUpdateV2: RECEIPT, closeAction: 'quit' })
    for (const installedUpdateV2 of [
      { ...RECEIPT, schemaVersion: 1 },
      { ...RECEIPT, schemaVersion: 3 },
      { ...RECEIPT, from: undefined },
      { ...RECEIPT, target: { version: BUILD_VERSION } },
      { ...RECEIPT, target: { ...build(102), dshRelease: { ...build(102).dshRelease, revision: 'HEAD' } } },
      { ...RECEIPT, fileName: undefined },
      { ...RECEIPT, fileName: 7 },
      { ...RECEIPT, sha512: '' },
      null,
    ]) {
      writeRaw({ installedUpdateV2, closeAction: 'quit' })
      expect(readState()).toEqual({ closeAction: 'quit' })
    }
  })

  it('reports a write it could not complete as false and leaves the earlier receipt readable', () => {
    expect(setInstalledUpdateV2(RECEIPT)).toBe(true)
    // A directory at the temporary file's name makes every write step fail.
    mkdirSync(join(fixture.userData, 'desktop-state.json.tmp'))
    const reported: string[] = []
    reportStateWritesTo((line) => { reported.push(line) })
    expect(setInstalledUpdateV2({ ...RECEIPT, target: build(103) })).toBe(false)
    expect(reported).toHaveLength(1)
    expect(reported[0]).toContain('could not write')
    expect(readState()).toEqual({ installedUpdateV2: RECEIPT })
  })
})

describe('the record an older build left', () => {
  const LEGACY = { fromVersion: '0.1.0-rc.34', fileName: 'DSH Desktop-0.1.0-rc.34-arm64-mac.zip', sha512: 'legacy' }

  it('is read for compatibility but never becomes a receipt', () => {
    writeRaw({ lastRunVersion: '0.1.0-rc.35', installedUpdate: LEGACY })
    expect(readState()).toEqual({ lastRunVersion: '0.1.0-rc.35', installedUpdate: LEGACY })
    expect(readState().installedUpdateV2).toBeUndefined()
  })

  it('cannot confirm an install after the fact, because it names no target', () => {
    writeRaw({ lastRunVersion: '0.1.0-rc.35', installedUpdate: LEGACY })
    // The new launch records its own build, and still has no receipt to confirm:
    // nothing infers a target from the old record or from the version change.
    expect(recordBuildRun(build(102))).toBeUndefined()
    expect(readState()).toEqual({ lastRunVersion: '0.1.0-rc.35', installedUpdate: LEGACY, lastRunBuild: build(102) })
    expect(readState().installedUpdateV2).toBeUndefined()
  })

  it('loses the newer fields safely when an older writer rewrites the file', () => {
    // An older build projects only the fields it knows, so its next write
    // drops `lastRunBuild` and `installedUpdateV2`. Losing them means the next
    // launch confirms nothing and sweeps nothing, which is the safe side.
    setInstalledUpdateV2(RECEIPT)
    recordBuildRun(build(102))
    writeRaw({ lastRunVersion: '0.1.0-rc.35', closeAction: 'quit' })
    expect(readState()).toEqual({ lastRunVersion: '0.1.0-rc.35', closeAction: 'quit' })
  })
})
