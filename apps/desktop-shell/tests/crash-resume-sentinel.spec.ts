/**
 * The intentional-stop sentinel the shell writes for the crash-resume plugin:
 * its text, where it lands, that a write leaves no temporary file behind, that
 * it replaces a sentinel the server already wrote, and that a failed write is
 * logged instead of thrown. Every case writes under its own temporary home.
 * @module
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  formatIntentionalStop, SENTINEL_DIRECTORY, SENTINEL_FILE, writeIntentionalStop,
} from '../src/crash-resume-sentinel.ts'

let home: string | undefined

afterEach(() => {
  if (home !== undefined) rmSync(home, { recursive: true, force: true })
  home = undefined
})

/**
 * A fresh Harness home under the system temporary directory.
 * @returns its path.
 */
function freshHome(): string {
  const created = mkdtempSync(join(tmpdir(), 'dsh-sentinel-'))
  expect(created.startsWith(tmpdir())).toBe(true)
  home = created
  return created
}

/**
 * Write the sentinel and collect what was logged.
 * @param target - the Harness home.
 * @param reason - why the server is being stopped.
 * @returns the logged lines.
 */
function write(target: string, reason: 'quit' | 'update'): string[] {
  const lines: string[] = []
  writeIntentionalStop(target, reason, (line) => { lines.push(line) })
  return lines
}

describe('formatIntentionalStop', () => {
  it('writes the fields in the order the plugin writes them, as one line', () => {
    expect(formatIntentionalStop('quit', 123)).toBe('{"version":1,"at":123,"by":"shell","reason":"quit"}\n')
  })
})

describe('writeIntentionalStop', () => {
  it('creates the plugin\'s state directory and writes the sentinel there', () => {
    const target = freshHome()
    const before = Date.now()
    expect(write(target, 'quit')).toEqual([])
    const text = readFileSync(join(target, SENTINEL_DIRECTORY, SENTINEL_FILE), 'utf8')
    expect(text.endsWith('\n')).toBe(true)
    const parsed = JSON.parse(text) as { at: number }
    expect(parsed).toEqual({ version: 1, at: parsed.at, by: 'shell', reason: 'quit' })
    expect(parsed.at).toBeGreaterThanOrEqual(before)
    expect(parsed.at).toBeLessThanOrEqual(Date.now())
  })

  it('leaves only the sentinel in the directory', () => {
    const target = freshHome()
    write(target, 'update')
    expect(readdirSync(join(target, SENTINEL_DIRECTORY))).toEqual([SENTINEL_FILE])
  })

  it('replaces a sentinel the server already wrote with a complete one of its own', () => {
    const target = freshHome()
    mkdirSync(join(target, SENTINEL_DIRECTORY))
    writeFileSync(join(target, SENTINEL_DIRECTORY, SENTINEL_FILE), '{"version":1,"at":1,"by":"server","reason":"SIGTERM"}\n')
    write(target, 'quit')
    const parsed = JSON.parse(readFileSync(join(target, SENTINEL_DIRECTORY, SENTINEL_FILE), 'utf8')) as Record<string, unknown>
    expect(parsed['by']).toBe('shell')
    expect(parsed['version']).toBe(1)
  })

  it('logs and returns when the directory cannot be created', () => {
    const target = freshHome()
    // A file where the state directory would go.
    writeFileSync(join(target, SENTINEL_DIRECTORY), '')
    const lines = write(target, 'quit')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^\[desktop\] crash-resume sentinel: .+\n$/u)
  })

  it('removes its temporary file when the rename fails', () => {
    const target = freshHome()
    // A non-empty directory where the sentinel would go refuses the rename.
    mkdirSync(join(target, SENTINEL_DIRECTORY, SENTINEL_FILE, 'occupied'), { recursive: true })
    const lines = write(target, 'quit')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^\[desktop\] crash-resume sentinel: /u)
    expect(readdirSync(join(target, SENTINEL_DIRECTORY))).toEqual([SENTINEL_FILE])
  })
})
