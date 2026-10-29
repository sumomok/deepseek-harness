import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { SessionFormatUnsupportedMigrationError } from '@deepseek-ai/dsh-session-format-catalog'
import { expectedUnsupported, unversionedProtocolFixtures } from './session-format-corpus-inventory.ts'
import { parseSessionLog } from '../src/index.ts'

const repoRoot = resolve(import.meta.dirname, '../../../..')
const excludedDirectories = new Set(['dist', 'lib', 'node_modules'])

function committedSessionFixtures(directory: string): string[] {
  // Derived/redacted measurement fixtures keep original source ranges rather
  // than replayable dense sequences; measurements.spec.ts owns their coverage.
  if (relative(repoRoot, directory) === 'packages/test-support/session-snapshot/tests/context-lifecycle/fixtures') return []
  const files: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (!excludedDirectories.has(entry.name)) files.push(...committedSessionFixtures(path))
    } else if (entry.name.startsWith('session') && entry.name.endsWith('.jsonl')) {
      if (!/^session(?:\.[1-9]\d*)?(?:\.v[1-9]\d*)?\.jsonl$/.test(entry.name)) {
        throw new Error(`invalid committed Session filename: ${path}`)
      }
      files.push(path)
    }
  }
  return files
}

function declaresFormat(text: string): boolean {
  const firstLine = text.split(/\r?\n/).find(line => line.trim().length > 0)
  if (firstLine === undefined) return false
  const header: unknown = JSON.parse(firstLine)
  if (header === null || typeof header !== 'object' || Array.isArray(header)) return false
  if (Object.hasOwn(header, 'version')) return true
  const data = (header as { readonly data?: unknown }).data
  return data !== null && typeof data === 'object' && !Array.isArray(data) && Object.hasOwn(data, 'version')
}

/** Read the generation from either a historical flat header or the current session envelope. */
function headerVersion(text: string): number {
  const header = JSON.parse(text.split(/\r?\n/u).find(line => line.trim().length > 0) ?? '{}') as {
    version?: number
    data?: { version?: number }
  }
  return header.version ?? header.data?.version ?? Number.NaN
}

function filenameFormatVersion(path: string): number {
  const match = /^session(?:\.[1-9]\d*)?(?:\.v([1-9]\d*))?\.jsonl$/.exec(path.split(/[/\\]/u).at(-1) ?? '')
  if (match === null) throw new Error(`invalid committed Session filename: ${path}`)
  return match[1] === undefined ? 0 : Number(match[1])
}

type Unsupported = { sourceVersion: number; reason: string }

function assertRestoration(
  key: string,
  sourceVersion: number,
  restore: () => unknown,
  unsupported: Unsupported | undefined,
): void {
  if (unsupported === undefined) {
    expect(restore, key + ': current-format restoration').not.toThrow()
    return
  }
  expect(sourceVersion, key + ': current-generation fixtures cannot be unsupported').toBeLessThan(SESSION_FORMAT_VERSION)
  expect(sourceVersion, key + ': inventoried source generation').toBe(unsupported.sourceVersion)
  let refusal: unknown
  try {
    restore()
  } catch (error) {
    refusal = error
  }
  expect(refusal, key + ': expected unsupported migration').toBeInstanceOf(SessionFormatUnsupportedMigrationError)
  expect((refusal as Error).message, key + ': exact refusal reason').toBe(unsupported.reason)
}

const fixtures = ['snapshots', 'packages', 'scripts/snapshots/python-sdk-single-exe']
  .flatMap(root => committedSessionFixtures(join(repoRoot, root)))
  .map(file => ({ file, key: relative(repoRoot, file).split('\\').join('/') }))
  .sort((a, b) => a.key.localeCompare(b.key))

describe('committed Session format corpus', () => {
  it('keeps every exception tied to an existing fixture', () => {
    const keys = new Set(fixtures.map(({ key }) => key))
    for (const key of [...Object.keys(expectedUnsupported), ...unversionedProtocolFixtures]) {
      expect(keys.has(key), key).toBe(true)
    }
  })

  it.each(fixtures)('$key', ({ file, key }) => {
    const bytes = readFileSync(file)
    const source = bytes.toString('utf8')
    try {
      if (unversionedProtocolFixtures.has(key)) {
        expect(declaresFormat(source), key + ': protocol fixture must remain unversioned').toBe(false)
        expect(filenameFormatVersion(file), key + ': protocol fixture filename').toBe(0)
        expect(expectedUnsupported[key], key + ': protocol fixture is not an unsupported migration').toBeUndefined()
        return
      }
      expect(declaresFormat(source), key + ': Session header must declare its format').toBe(true)
      const version = headerVersion(source)
      const filenameVersion = filenameFormatVersion(file)
      const expectedVersion = filenameVersion === 0 && version === SESSION_FORMAT_VERSION ? version : filenameVersion
      expect(version, key + ': filename/header Session generation').toBe(expectedVersion)
      assertRestoration(key, version, () => parseSessionLog(source), expectedUnsupported[key])
    } finally {
      expect(readFileSync(file), key + ': source bytes remain unchanged').toEqual(bytes)
    }
  })
})

describe('corpus unsupported policy', () => {
  const refusal = { sourceVersion: 2, reason: 'deliberate historical refusal' }
  const refused = (): never => { throw new SessionFormatUnsupportedMigrationError(refusal.reason) }

  it('rejects an unlisted migration refusal', () => {
    expect(() => { assertRestoration('unlisted', 2, refused, undefined) }).toThrow('current-format restoration')
  })

  it('rejects an exception that starts restoring successfully', () => {
    expect(() => { assertRestoration('supported', 2, () => [], refusal) }).toThrow('expected unsupported migration')
  })

  it('rejects a changed refusal reason', () => {
    expect(() => { assertRestoration('changed', 2, refused, { ...refusal, reason: 'different' }) }).toThrow('exact refusal reason')
  })

  it('rejects corruption masquerading as an unsupported migration', () => {
    expect(() => { assertRestoration('corrupt', 2, () => { throw new Error(refusal.reason) }, refusal) })
      .toThrow('expected unsupported migration')
  })

  it('rejects a mismatched source generation', () => {
    expect(() => { assertRestoration('wrong-version', 1, refused, refusal) }).toThrow('inventoried source generation')
  })

  it('never exempts a current-generation fixture', () => {
    expect(() => {
      assertRestoration('current', SESSION_FORMAT_VERSION, refused, {
        ...refusal, sourceVersion: SESSION_FORMAT_VERSION,
      })
    }).toThrow('current-generation fixtures cannot be unsupported')
  })

  it('accepts only the exact typed historical refusal', () => {
    expect(() => { assertRestoration('historical', 2, refused, refusal) }).not.toThrow()
  })
})
