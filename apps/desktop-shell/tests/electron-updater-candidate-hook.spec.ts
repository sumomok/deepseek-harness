/**
 * The vendored update library's candidate hook is the one place this product
 * replaces the library's version comparison, so it is guarded rather than
 * trusted: the patch file, the installed copy, and the lockfile's patch hash
 * must agree, and the hook must stay behind the library's own system and
 * rollout checks.
 *
 * This is a contract test, not a behavioral one. The behavior of the shipped
 * hook is exercised through `updater.ts`; what can silently regress here is the
 * patch itself disappearing on a dependency bump, which no other test would
 * notice.
 * @module
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const PATCH = 'patches/electron-updater@6.8.9.patch'
const LOCKFILE = 'pnpm-lock.yaml'

/**
 * Read a repository file relative to this spec.
 * @param name - repository-relative path.
 * @returns the file's contents.
 */
function read(name: string): string {
  return readFileSync(join(process.cwd(), name), 'utf8')
}

describe('electron-updater candidate hook', () => {
  it('is declared as an optional member so every other consumer keeps the library behavior', () => {
    const typings = read('apps/desktop-shell/node_modules/electron-updater/out/AppUpdater.d.ts')
    expect(typings).toContain('isUpdateCandidate?: (updateInfo: UpdateInfo) => boolean | Promise<boolean>;')
    expect(typings).toContain('Left undefined, the library compares SemVer')
  })

  it('keeps the system and rollout checks ahead of the hook', () => {
    const source = read('apps/desktop-shell/node_modules/electron-updater/out/AppUpdater.js')
    const method = source.slice(source.indexOf('async isUpdateAvailable(updateInfo) {'), source.indexOf('checkIfUpdateSupported(updateInfo) {'))
    expect(method.length).toBeGreaterThan(0)
    const system = method.indexOf('this.isUpdateSupported(updateInfo)')
    const rollout = method.indexOf('isUserWithinRollout')
    const hook = method.indexOf('return await candidateCheck(updateInfo)')
    expect(system).toBeGreaterThan(-1)
    expect(rollout).toBeGreaterThan(system)
    expect(hook).toBeGreaterThan(rollout)
    // The equal-version early return applies only when no product policy is installed.
    expect(method).toContain('candidateCheck == null && (0, semver_1.eq)')
  })

  it('ships the same hook in the patch pnpm applies, with the earlier multipart fix intact', () => {
    const patch = read(PATCH)
    expect(patch).toContain('isUpdateCandidate?: (updateInfo: UpdateInfo) => boolean | Promise<boolean>;')
    expect(patch).toContain('candidateCheck == null && (0, semver_1.eq)')
    expect(patch).toContain('response.on("error", reject);')
  })

  it('records the patch content\u2019s hash in the lockfile, which is what pnpm verifies', () => {
    const hash = createHash('sha256').update(read(PATCH), 'utf8').digest('hex')
    const lockfile = read(LOCKFILE)
    const declared = /electron-updater@6\.8\.9\(patch_hash=([0-9a-f]{64})\)/u.exec(lockfile)
    expect(declared?.[1]).toBe(hash)
  })
})
