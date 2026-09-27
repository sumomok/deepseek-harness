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

const fixture = vi.hoisted(() => ({ userData: '', locale: 'zh-CN' }))

vi.mock('electron', () => ({
  app: {
    getPath: (): string => fixture.userData,
    getVersion: (): string => '0.1.0-rc.35',
    getLocale: (): string => fixture.locale,
  },
}))

const { readState, setCloseAction, setServerPort } = await import('../src/desktop-state.ts')
const { menuText, shellLanguage } = await import('../src/menu-text.ts')

beforeEach(() => {
  fixture.userData = mkdtempSync(join(tmpdir(), 'dsh-desktop-state-'))
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
  it('replace the file through a temporary file and leave none behind', () => {
    setServerPort(49_321)
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
