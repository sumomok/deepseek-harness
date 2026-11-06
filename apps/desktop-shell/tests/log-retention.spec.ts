/**
 * What one launch keeps of the desktop log directory: the log file rolled
 * over past its size, and the newest diagnostic reports.
 * @module
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KEPT_REPORTS, LOG_ROTATE_BYTES, pruneReports, rotateLog } from '../src/log-retention.ts'

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
