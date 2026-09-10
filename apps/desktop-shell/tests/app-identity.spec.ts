/**
 * The directories an installed build keeps after this package was renamed:
 * where the pinned name puts them, and what the pin does to an `app` that
 * reports the renamed one.
 * @module
 */

import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PINNED_APP_NAME, pinAppIdentity, pinnedUserDataPath, type AppIdentityHost } from '../src/app-identity.ts'

let appData: string

beforeEach(async () => {
  appData = await mkdtemp(join(tmpdir(), 'dsh-identity-'))
})

afterEach(async () => {
  await rm(appData, { recursive: true, force: true })
})

/** What the pin did to a stand-in `app`, in call order. */
interface Recorded {
  name?: string
  paths: [string, string][]
}

/** An `app` that reports this package's own name and records what the pin sets. */
function recordingApp(root: string): { app: AppIdentityHost; recorded: Recorded } {
  const recorded: Recorded = { paths: [] }
  return {
    recorded,
    app: {
      setName: (name) => { recorded.name = name },
      getPath: () => root,
      setPath: (name, path) => { recorded.paths.push([name, path]) },
    },
  }
}

describe('pinnedUserDataPath', () => {
  it('lays the scoped name out as directories under the application-data root', () => {
    expect(pinnedUserDataPath('/root')).toBe(join('/root', '@deepseek-ai', 'dsh-desktop'))
  })

  it('is named after the pinned name, not after this package', () => {
    expect(PINNED_APP_NAME).toBe('@deepseek-ai/dsh-desktop')
    expect(pinnedUserDataPath('/root').endsWith('-shell')).toBe(false)
  })
})

describe('pinAppIdentity', () => {
  it('sets the name and both directories Electron derives from it', () => {
    const { app, recorded } = recordingApp(appData)
    pinAppIdentity(app)
    const userData = join(appData, '@deepseek-ai', 'dsh-desktop')
    expect(recorded.name).toBe(PINNED_APP_NAME)
    expect(recorded.paths).toEqual([['userData', userData], ['sessionData', userData]])
  })

  it('creates the user-data directory a fresh installation does not have yet', () => {
    const { app } = recordingApp(appData)
    expect(existsSync(join(appData, '@deepseek-ai', 'dsh-desktop'))).toBe(false)
    pinAppIdentity(app)
    expect(existsSync(join(appData, '@deepseek-ai', 'dsh-desktop'))).toBe(true)
  })

  it('leaves an existing user-data directory in place', () => {
    const { app } = recordingApp(appData)
    pinAppIdentity(app)
    expect(() => { pinAppIdentity(app) }).not.toThrow()
  })
})
