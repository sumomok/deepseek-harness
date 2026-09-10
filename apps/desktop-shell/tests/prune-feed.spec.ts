/**
 * What a publish leaves in an update-feed channel directory: which versions
 * keep their artifacts, which keep their blockmaps, and what is never a
 * deletion candidate at all.
 * @module
 */

import { describe, expect, it } from 'vitest'
import {
  KEPT_ARTIFACT_VERSIONS,
  KEPT_BLOCKMAP_VERSIONS,
  type PruneSelection,
  selectPrunable,
} from '../scripts/prune-feed.ts'

/**
 * The Windows installer name electron-builder produces for one version.
 * @param version - the version it carries.
 * @returns the artifact name.
 */
function win(version: string): string {
  return `DSH Desktop Setup ${version}.exe`
}

/**
 * The macOS zip name electron-builder produces for one version.
 * @param version - the version it carries.
 * @returns the artifact name.
 */
function mac(version: string): string {
  return `DSH Desktop-${version}-arm64-mac.zip`
}

/**
 * One channel directory holding each version's artifact and blockmap beside the manifest.
 * @param versions - the versions present, in whatever order the server listed them.
 * @param artifact - the naming function for this channel.
 * @param manifest - the manifest name the channel serves.
 * @returns every entry the directory holds.
 */
function directory(versions: string[], artifact: (version: string) => string, manifest: string): string[] {
  return [manifest, ...versions.flatMap(version => [artifact(version), `${artifact(version)}.blockmap`])]
}

/**
 * What a publish of one version uploads or rewrites in its channel.
 * @param version - the version being published.
 * @param artifact - the naming function for this channel.
 * @param manifest - the manifest name the channel serves.
 * @returns the names the publish owns.
 */
function published(version: string, artifact: (version: string) => string, manifest: string): string[] {
  return [artifact(version), `${artifact(version)}.blockmap`, manifest]
}

/**
 * Every name the selection accounted for, which must be the input exactly once over.
 * @param selection - the selection to flatten.
 * @returns all four groups concatenated.
 */
function accounted(selection: PruneSelection): string[] {
  return [...selection.keep, ...selection.unparsed, ...selection.deleteArtifacts, ...selection.deleteBlockmaps]
}

/** `0.1.0-rc.N` for each of the given release candidates. */
const rc = (...numbers: number[]): string[] => numbers.map(number => `0.1.0-rc.${String(number)}`)

describe('selectPrunable', () => {
  it('keeps the newest two versions of artifacts and leaves every blockmap in the window', () => {
    const versions = rc(9, 10, 15, 16, 17, 18)
    const selection = selectPrunable(
      directory(versions, win, 'latest.yml'),
      '0.1.0-rc.18',
      published('0.1.0-rc.18', win, 'latest.yml'),
    )
    expect(selection.deleteArtifacts).toEqual([win('0.1.0-rc.9'), win('0.1.0-rc.10'), win('0.1.0-rc.15'), win('0.1.0-rc.16')])
    expect(selection.deleteBlockmaps).toEqual([])
    expect(selection.keep).toContain(win('0.1.0-rc.17'))
    expect(selection.keep).toContain(win('0.1.0-rc.18'))
    expect(selection.unparsed).toEqual([])
  })

  it('keeps a blockmap whose artifact it deletes', () => {
    const selection = selectPrunable(
      directory(rc(9, 10, 15, 16, 17, 18), mac, 'latest-mac.yml'),
      '0.1.0-rc.18',
      published('0.1.0-rc.18', mac, 'latest-mac.yml'),
    )
    expect(selection.deleteArtifacts).toContain(mac('0.1.0-rc.9'))
    expect(selection.keep).toContain(`${mac('0.1.0-rc.9')}.blockmap`)
  })

  it('orders versions by semver precedence, so rc.9 goes before rc.10 does', () => {
    const selection = selectPrunable(
      directory(rc(9, 10, 11), win, 'latest.yml'),
      '0.1.0-rc.11',
      published('0.1.0-rc.11', win, 'latest.yml'),
    )
    // Lexicographically `0.1.0-rc.9` is the *newest* of the three, which would
    // keep the oldest build and delete the one clients are about to update from.
    expect(selection.deleteArtifacts).toEqual([win('0.1.0-rc.9')])
    expect(selection.keep).toContain(win('0.1.0-rc.10'))
  })

  it('orders the blockmap window by semver precedence too', () => {
    const versions = rc(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12)
    const selection = selectPrunable(
      directory(versions, win, 'latest.yml'),
      '0.1.0-rc.12',
      published('0.1.0-rc.12', win, 'latest.yml'),
    )
    // Lexicographic order would drop rc.10's blockmap and keep rc.9's.
    expect(selection.deleteBlockmaps).toEqual([`${win('0.1.0-rc.1')}.blockmap`, `${win('0.1.0-rc.2')}.blockmap`])
    expect(selection.keep).toContain(`${win('0.1.0-rc.10')}.blockmap`)
  })

  it('never selects a file this publish just wrote, whatever else the directory holds', () => {
    const selection = selectPrunable(
      directory(rc(18, 19, 20, 21), win, 'latest.yml'),
      '0.1.0-rc.18',
      published('0.1.0-rc.18', win, 'latest.yml'),
    )
    expect(selection.keep).toContain(win('0.1.0-rc.18'))
    expect(selection.keep).toContain(`${win('0.1.0-rc.18')}.blockmap`)
    expect(selection.deleteArtifacts).toEqual([win('0.1.0-rc.19')])
  })

  it('never selects a manifest', () => {
    const selection = selectPrunable(
      ['latest.yml', ...directory(rc(9, 10, 17, 18), mac, 'latest-mac.yml')],
      '0.1.0-rc.18',
      published('0.1.0-rc.18', mac, 'latest-mac.yml'),
    )
    expect(selection.keep).toContain('latest.yml')
    expect(selection.keep).toContain('latest-mac.yml')
    expect(accounted(selection).filter(name => name.endsWith('.yml')).every(name => selection.keep.includes(name))).toBe(true)
  })

  it('leaves a name that carries no version alone instead of guessing at it', () => {
    const strangers = ['DSH Desktop Setup nightly.exe', 'notes.txt', 'DSH Desktop-0.1.0-rc.17-arm64.dmg', 'win-unpacked']
    const selection = selectPrunable(
      [...strangers, ...directory(rc(9, 17, 18), win, 'latest.yml')],
      '0.1.0-rc.18',
      published('0.1.0-rc.18', win, 'latest.yml'),
    )
    expect(selection.unparsed).toEqual(strangers)
    for (const stranger of strangers) {
      expect(selection.deleteArtifacts).not.toContain(stranger)
      expect(selection.deleteBlockmaps).not.toContain(stranger)
    }
  })

  it('deletes nothing from a directory holding fewer versions than either window', () => {
    const versions = rc(17, 18)
    expect(versions.length).toBeLessThanOrEqual(KEPT_ARTIFACT_VERSIONS)
    expect(versions.length).toBeLessThanOrEqual(KEPT_BLOCKMAP_VERSIONS)
    const names = directory(versions, mac, 'latest-mac.yml')
    const selection = selectPrunable(names, '0.1.0-rc.18', published('0.1.0-rc.18', mac, 'latest-mac.yml'))
    expect(selection.deleteArtifacts).toEqual([])
    expect(selection.deleteBlockmaps).toEqual([])
    expect(selection.keep).toEqual(names)
  })

  it('accounts for every name in the directory exactly once', () => {
    const names = [
      'notes.txt',
      ...directory(rc(...Array.from({ length: 14 }, (_, index) => index + 5)), win, 'latest.yml'),
    ]
    const selection = selectPrunable(names, '0.1.0-rc.18', published('0.1.0-rc.18', win, 'latest.yml'))
    expect([...accounted(selection)].sort()).toEqual([...names].sort())
    expect(selection.deleteArtifacts.length).toBe(14 - KEPT_ARTIFACT_VERSIONS)
    expect(selection.deleteBlockmaps.length).toBe(14 - KEPT_BLOCKMAP_VERSIONS)
  })
})
