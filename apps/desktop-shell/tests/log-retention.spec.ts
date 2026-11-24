/**
 * What one launch keeps of the desktop log directory: the log file rolled
 * over past its size, and the newest diagnostic reports.
 * @module
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KEPT_CRASH_DUMPS, KEPT_REPORTS, LOG_ROTATE_BYTES, pruneCrashDumps, pruneReports, rotateLog } from '../src/log-retention.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-log-retention-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('rotateLog', () => {
  it('rolls a log past the size over to .1, replacing the older one', () => {
    const file = join(dir, 'dsh-server.log')
    writeFileSync(file, 'x'.repeat(101))
    writeFileSync(`${file}.1`, 'the generation before')

    expect(rotateLog(file, 100)).toBe(`[desktop] rolled the previous log over to ${file}.1 (101 bytes)\n`)
    expect(readdirSync(dir)).toEqual(['dsh-server.log.1'])
    expect(readFileSync(`${file}.1`, 'utf8')).toBe('x'.repeat(101))
  })

  it('leaves a log at or under the size, and a missing one, alone', () => {
    const file = join(dir, 'dsh-server.log')
    expect(rotateLog(file, 100)).toBeUndefined()
    writeFileSync(file, 'x'.repeat(100))
    expect(rotateLog(file, 100)).toBeUndefined()
    expect(readdirSync(dir)).toEqual(['dsh-server.log'])
  })

  it('rolls over at 10 MiB', () => {
    expect(LOG_ROTATE_BYTES).toBe(10 * 1024 * 1024)
  })
})

describe('pruneReports', () => {
  /**
   * Write one report dated `secondsAgo` in the past.
   * @param name - the report's file name.
   * @param secondsAgo - how old its modification time is.
   */
  function report(name: string, secondsAgo: number): void {
    const path = join(dir, name)
    writeFileSync(path, '{}')
    const at = Date.now() / 1000 - secondsAgo
    utimesSync(path, at, at)
  }

  it('keeps the newest reports by modification time and leaves every other file', () => {
    for (let index = 0; index < 7; index++) report(`report.20260927.10000${String(index)}.${String(900 - index)}.0.001.json`, 100 - index)
    writeFileSync(join(dir, 'dsh-server.log'), 'log')
    writeFileSync(join(dir, 'report-notes.json'), 'not a report')

    expect(pruneReports(dir, 5)).toBe('[desktop] removed 2 old diagnostic report(s), keeping the newest 5\n')
    expect(readdirSync(dir).sort()).toEqual([
      'dsh-server.log',
      'report-notes.json',
      'report.20260927.100002.898.0.001.json',
      'report.20260927.100003.897.0.001.json',
      'report.20260927.100004.896.0.001.json',
      'report.20260927.100005.895.0.001.json',
      'report.20260927.100006.894.0.001.json',
    ])
  })

  it('removes nothing, and says nothing, at or under the count or without the directory', () => {
    for (let index = 0; index < 5; index++) report(`report.20260927.10000${String(index)}.1.0.001.json`, 10 - index)
    expect(pruneReports(dir, 5)).toBeUndefined()
    expect(readdirSync(dir)).toHaveLength(5)
    expect(pruneReports(join(dir, 'missing'), 5)).toBeUndefined()
  })

  it('keeps five', () => {
    expect(KEPT_REPORTS).toBe(5)
  })
})

describe('pruneCrashDumps', () => {
  /**
   * Write one crash dump dated `secondsAgo` in the past.
   * @param relPath - relative path inside `dir`.
   * @param secondsAgo - how old its modification time is.
   */
  function dump(relPath: string, secondsAgo: number): void {
    const full = join(dir, relPath)
    const parent = join(full, '..')
    mkdirSync(parent, { recursive: true })
    writeFileSync(full, 'MDMP')
    const at = Date.now() / 1000 - secondsAgo
    utimesSync(full, at, at)
  }

  it('keeps the newest crash dumps globally across immediate subdirs and preserves metadata and deeper trees', () => {
    dump('completed/a.dmp', 120)
    dump('pending/b.dmp', 110)
    dump('root-old.dmp', 100)
    dump('completed/c.dmp', 90)
    dump('pending/d.DMP', 80)
    dump('new/e.dmp', 70)
    dump('completed/f.dmp', 60)
    dump('root-newest.dmp', 50)
    // Crashpad metadata and deeper attachment directories must never be touched.
    writeFileSync(join(dir, 'settings.dat'), 'settings')
    writeFileSync(join(dir, 'metadata'), 'meta')
    mkdirSync(join(dir, 'attachments', 'uuid-1'), { recursive: true })
    writeFileSync(join(dir, 'attachments', 'uuid-1', 'nested.dmp'), 'attachment')

    expect(pruneCrashDumps(dir, 5)).toBe('[desktop] removed 3 old crash dump(s), keeping the newest 5\n')
    expect(existsSync(join(dir, 'completed/a.dmp'))).toBe(false)
    expect(existsSync(join(dir, 'pending/b.dmp'))).toBe(false)
    expect(existsSync(join(dir, 'root-old.dmp'))).toBe(false)
    expect(existsSync(join(dir, 'completed/c.dmp'))).toBe(true)
    expect(existsSync(join(dir, 'pending/d.DMP'))).toBe(true)
    expect(existsSync(join(dir, 'new/e.dmp'))).toBe(true)
    expect(existsSync(join(dir, 'completed/f.dmp'))).toBe(true)
    expect(existsSync(join(dir, 'root-newest.dmp'))).toBe(true)
    expect(existsSync(join(dir, 'settings.dat'))).toBe(true)
    expect(existsSync(join(dir, 'metadata'))).toBe(true)
    expect(existsSync(join(dir, 'attachments', 'uuid-1', 'nested.dmp'))).toBe(true)
  })

  it('breaks mtime ties by relative path descending', () => {
    dump('completed/a.dmp', 50)
    dump('completed/b.dmp', 50)
    dump('pending/a.dmp', 50)

    expect(pruneCrashDumps(dir, 2)).toBe('[desktop] removed 1 old crash dump(s), keeping the newest 2\n')
    expect(existsSync(join(dir, 'completed/a.dmp'))).toBe(false)
    expect(existsSync(join(dir, 'completed/b.dmp'))).toBe(true)
    expect(existsSync(join(dir, 'pending/a.dmp'))).toBe(true)
  })

  it('never follows or deletes symlinked dumps or symlinked subdirectories', () => {
    const external = mkdtempSync(join(tmpdir(), 'dsh-crash-ext-'))
    try {
      const externalDump = join(external, 'outside.dmp')
      writeFileSync(externalDump, 'MDMP')
      const oldAt = Date.now() / 1000 - 500
      utimesSync(externalDump, oldAt, oldAt)

      dump('completed/real-1.dmp', 40)
      dump('completed/real-2.dmp', 30)
      symlinkSync(externalDump, join(dir, 'link.dmp'))
      symlinkSync(external, join(dir, 'linked-dir'))

      expect(pruneCrashDumps(dir, 1)).toBe('[desktop] removed 1 old crash dump(s), keeping the newest 1\n')
      expect(existsSync(join(dir, 'completed/real-1.dmp'))).toBe(false)
      expect(existsSync(join(dir, 'completed/real-2.dmp'))).toBe(true)
      expect(existsSync(join(dir, 'link.dmp'))).toBe(true)
      expect(existsSync(externalDump)).toBe(true)
    } finally {
      rmSync(external, { recursive: true, force: true })
    }
  })

  it('removes nothing and says nothing at or under the limit or when the directory is missing', () => {
    for (let index = 0; index < 5; index++) dump(`completed/d${String(index)}.dmp`, 10 - index)
    expect(pruneCrashDumps(dir, 5)).toBeUndefined()
    expect(readdirSync(join(dir, 'completed'))).toHaveLength(5)
    expect(pruneCrashDumps(join(dir, 'missing'), 5)).toBeUndefined()
  })

  it('keeps five', () => {
    expect(KEPT_CRASH_DUMPS).toBe(5)
  })
})
