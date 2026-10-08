/** The temporary sibling of `roots.json` is created exclusively, so a symbolic link planted at its name is not written through. */
import type * as Crypto from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { openRootRegistry } from '../src/registry.ts'
import { capturedLogger, principal, useTempHome } from './support.ts'

const { SUFFIX } = vi.hoisted(() => ({ SUFFIX: 'a1b2c3d4e5f6' }))

// The temporary sibling's random suffix is fixed so that the test can plant a link at its name.
vi.mock('node:crypto', async (importOriginal) => {
  const original = await importOriginal<typeof Crypto>()
  return { ...original, randomBytes: () => Buffer.from(SUFFIX, 'hex') }
})

const temp = useTempHome()

describe('replacing roots.json', () => {
  it('refuses a symbolic link standing at the temporary sibling\'s name instead of writing through it', () => {
    const file = join(temp.home, 'console-members', 'roots.json')
    const target = join(temp.base, 'planted.json')
    mkdirSync(join(temp.home, 'console-members'), { recursive: true })
    mkdirSync(temp.base, { recursive: true })
    symlinkSync(target, `${file}.${SUFFIX}.tmp`)
    const registry = openRootRegistry({
      file, membersRoot: join(temp.base, 'members'), seeds: [], platform: process.platform, logger: capturedLogger().logger,
    })

    expect(() => registry.ensureMember(principal('login-uid-alice-5501'))).toThrow(/EEXIST/)
    expect(existsSync(target)).toBe(false)
    expect(() => lstatSync(file)).toThrow(/ENOENT/)
  })
})
