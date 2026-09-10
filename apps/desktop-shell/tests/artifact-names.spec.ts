/**
 * What a packaging run owes `dist-app`, and what checking the directory
 * against that list reports. The expected names are electron-builder's
 * defaults for the targets `electron-builder.yml` declares, so this reads that
 * config and pins the names against it rather than against a memory of them.
 * @module
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { CORE_SCHEMA, load } from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { auditArtifacts, expectedArtifacts, type ArtifactFile } from '../scripts/artifact-names.ts'

/** The parts of electron-builder.yml the artifact names follow from. */
interface BuilderConfig {
  productName: string
  artifactName?: string
  mac: { artifactName?: string; target: { target: string; arch: string[] }[] }
  win: { artifactName?: string; target: { target: string; arch: string[] }[] }
  nsis: { artifactName?: string }
  dmg?: { artifactName?: string }
}

const config = load(
  readFileSync(fileURLToPath(new URL('../electron-builder.yml', import.meta.url)), 'utf8'),
  { schema: CORE_SCHEMA },
) as BuilderConfig

const VERSION = '0.1.0-rc.20'

describe('expectedArtifacts', () => {
  it('names the macOS zip and dmg, each with its blockmap', () => {
    expect(expectedArtifacts(VERSION, { mac: true, win: false })).toEqual([
      'DSH Desktop-0.1.0-rc.20-arm64-mac.zip',
      'DSH Desktop-0.1.0-rc.20-arm64-mac.zip.blockmap',
      'DSH Desktop-0.1.0-rc.20-arm64.dmg',
      'DSH Desktop-0.1.0-rc.20-arm64.dmg.blockmap',
    ])
  })

  it('names the Windows installer and its blockmap', () => {
    expect(expectedArtifacts(VERSION, { mac: false, win: true })).toEqual([
      'DSH Desktop Setup 0.1.0-rc.20.exe',
      'DSH Desktop Setup 0.1.0-rc.20.exe.blockmap',
    ])
  })

  it('owes both platforms\' files when both were built', () => {
    const both = expectedArtifacts(VERSION, { mac: true, win: true })
    expect(both).toEqual([
      ...expectedArtifacts(VERSION, { mac: true, win: false }),
      ...expectedArtifacts(VERSION, { mac: false, win: true }),
    ])
  })

  it('owes nothing when no platform was built', () => {
    expect(expectedArtifacts(VERSION, { mac: false, win: false })).toEqual([])
  })

  it('carries the productName electron-builder.yml declares', () => {
    for (const name of expectedArtifacts(VERSION, { mac: true, win: true })) {
      expect(name.startsWith(config.productName)).toBe(true)
    }
  })

  it('carries the single arch each platform target declares', () => {
    // The arch is in the mac names because it is not x64; NSIS's default name
    // carries none, which is why only the mac side is asserted here.
    expect(config.mac.target.map(target => target.arch)).toEqual([['arm64'], ['arm64']])
    expect(config.win.target.map(target => target.arch)).toEqual([['x64']])
    for (const name of expectedArtifacts(VERSION, { mac: true, win: false })) {
      expect(name).toContain('-arm64')
    }
  })

  it('holds only while no target overrides electron-builder\'s default naming', () => {
    // Every name here is a default template filled in. An artifactName anywhere
    // in the config would rename the files without renaming what is expected.
    expect(config.artifactName).toBeUndefined()
    expect(config.mac.artifactName).toBeUndefined()
    expect(config.win.artifactName).toBeUndefined()
    expect(config.nsis.artifactName).toBeUndefined()
    expect(config.dmg?.artifactName).toBeUndefined()
  })
})

describe('auditArtifacts', () => {
  const expected = expectedArtifacts(VERSION, { mac: true, win: true })
  const STARTED_AT = 1_000_000

  /**
   * A directory holding each named file, written after this run began.
   * @param names - the files present.
   * @param bytes - the size each one has.
   * @returns what the directory holds, for the audit.
   */
  function built(names: string[], bytes = 1024): Map<string, ArtifactFile> {
    return new Map(names.map(name => [name, { bytes, mtimeMs: STARTED_AT + 1 }]))
  }

  it('verifies every expected file when each was written by this run with content', () => {
    const audit = auditArtifacts(expected, built(expected), STARTED_AT)
    expect(audit.verified.map(entry => entry.name)).toEqual(expected)
    expect(audit.verified.every(entry => entry.bytes === 1024)).toBe(true)
    expect(audit.missing).toEqual([])
    expect(audit.empty).toEqual([])
    expect(audit.stale).toEqual([])
  })

  it('reports the platform whose build never ran, artifact and blockmap alike', () => {
    const win = expectedArtifacts(VERSION, { mac: false, win: true })
    const audit = auditArtifacts(expected, built(win), STARTED_AT)
    expect(audit.missing).toEqual(expectedArtifacts(VERSION, { mac: true, win: false }))
    expect(audit.verified.map(entry => entry.name)).toEqual(win)
  })

  it('reports a file that is there at zero bytes separately from a missing one', () => {
    const files = built(expected)
    files.set(expected[0] ?? '', { bytes: 0, mtimeMs: STARTED_AT + 1 })
    const audit = auditArtifacts(expected, files, STARTED_AT)
    expect(audit.empty).toEqual([expected[0]])
    expect(audit.missing).toEqual([])
    expect(audit.stale).toEqual([])
  })

  it('reports this version\'s own file from an earlier run as stale, not as a product', () => {
    // Repackaging one version after a fix: the previous run's artifacts carry
    // exactly the expected names, so only their age separates them.
    const files = built(expected)
    const leftover = expected[4] ?? ''
    files.set(leftover, { bytes: 138_000_000, mtimeMs: STARTED_AT - 1 })
    const audit = auditArtifacts(expected, files, STARTED_AT)
    expect(audit.stale).toEqual([leftover])
    expect(audit.verified.map(entry => entry.name)).not.toContain(leftover)
    expect(audit.missing).toEqual([])
  })

  it('reports a whole platform left over from an earlier run of the same version', () => {
    const mac = expectedArtifacts(VERSION, { mac: true, win: false })
    const win = expectedArtifacts(VERSION, { mac: false, win: true })
    const files = new Map([
      ...built(mac),
      ...new Map(win.map(name => [name, { bytes: 1024, mtimeMs: STARTED_AT - 60_000 }] as const)),
    ])
    const audit = auditArtifacts(expected, files, STARTED_AT)
    expect(audit.stale).toEqual(win)
    expect(audit.verified.map(entry => entry.name)).toEqual(mac)
  })

  it('accepts a file written exactly when the run started', () => {
    const audit = auditArtifacts(expected, new Map(expected.map(name => [name, { bytes: 1, mtimeMs: STARTED_AT }])), STARTED_AT)
    expect(audit.stale).toEqual([])
    expect(audit.verified.length).toBe(expected.length)
  })

  it('ignores whatever else the directory holds, including older versions', () => {
    const files = built(expected)
    files.set('DSH Desktop Setup 0.1.0-rc.19.exe', { bytes: 138_000_000, mtimeMs: STARTED_AT - 1 })
    const audit = auditArtifacts(expected, files, STARTED_AT)
    expect(audit.verified.map(entry => entry.name)).toEqual(expected)
    expect(audit.stale).toEqual([])
  })

  it('accounts for every expected name exactly once', () => {
    const files = new Map<string, ArtifactFile>([
      [expected[0] ?? '', { bytes: 0, mtimeMs: STARTED_AT + 1 }],
      [expected[1] ?? '', { bytes: 7, mtimeMs: STARTED_AT + 1 }],
      [expected[2] ?? '', { bytes: 7, mtimeMs: STARTED_AT - 1 }],
    ])
    const audit = auditArtifacts(expected, files, STARTED_AT)
    const accounted = [...audit.verified.map(entry => entry.name), ...audit.missing, ...audit.empty, ...audit.stale]
    expect([...accounted].sort()).toEqual([...expected].sort())
  })
})
