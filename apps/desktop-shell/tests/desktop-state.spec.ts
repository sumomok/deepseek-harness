/**
 * The shell's state file as the port choice uses it: the remembered server
 * port survives a write of any other field, and a value that is not a port is
 * read back as nothing remembered. The file is real, under a temporary
 * userData directory; electron's `app` stands in.
 * @module
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
  forgetServerPort, readState, RENAME_ATTEMPTS, reportStateWritesTo, setCloseAction, setServerPort,
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
