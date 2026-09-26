/**
 * The desktop package's repository build: the title it hands `pnpm run build`,
 * which client artifacts it accepts, and the values the desktop-app bundle
 * runs with.
 * @module
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  repositoryClientBuildEnvironment,
  resolveClientBuildEnvironment,
  writeClientBuildRecord,
  type ClientBuildEnvironment,
} from '../../../scripts/client-build-environment.ts'
import {
  DESKTOP_CLIENT_TITLE,
  desktopAppBundleEnvironment,
  desktopRepositoryBuildEnvironment,
} from '../scripts/client-build.ts'

const COMMIT = 'abcdef0123456'
const UPSTREAM_VERSION = '0.1.7-rc.2'
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A repository root outside Git whose root manifest carries upstream's version. */
function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-client-build-'))
  roots.push(root)
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: UPSTREAM_VERSION }))
  return root
}

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), content)
}

/** Emit the artifacts a build with `client` would, then record them. */
function built(root: string, client: ClientBuildEnvironment, pageTitle = client.DSH_CLIENT_TITLE): void {
  write(root, 'apps/web/dist/index.html', `<title>${String(pageTitle)}</title>`)
  write(root, 'packages/client/ui-settings-general/lib/client.js', `t(${JSON.stringify(client.DSH_CLIENT_VERSION)})`)
  writeClientBuildRecord(root, client)
}

describe('desktop repository build environment', () => {
  it('adds the desktop title and keeps everything else the caller set', () => {
    expect(desktopRepositoryBuildEnvironment({ PATH: '/bin', DSH_CLIENT_TITLE: 'Inherited' }))
      .toEqual({ PATH: '/bin', DSH_CLIENT_TITLE: DESKTOP_CLIENT_TITLE })
  })

  it('reaches the client values scripts/build.ts embeds, beside the repository version', () => {
    const root = fixtureRoot()
    const parent = desktopRepositoryBuildEnvironment({ DSH_CLIENT_COMMIT_HASH: COMMIT })
    expect(resolveClientBuildEnvironment(repositoryClientBuildEnvironment(root, parent), undefined)).toEqual({
      DSH_CLIENT_COMMIT_HASH: COMMIT.slice(0, 7),
      DSH_CLIENT_TITLE: DESKTOP_CLIENT_TITLE,
      DSH_CLIENT_VERSION: UPSTREAM_VERSION,
    })
  })
})

describe('desktop-app bundle environment', () => {
  const client = { DSH_CLIENT_COMMIT_HASH: 'abcdef0', DSH_CLIENT_TITLE: DESKTOP_CLIENT_TITLE, DSH_CLIENT_VERSION: UPSTREAM_VERSION }

  it('hands the bundle exactly the recorded client values', () => {
    const root = fixtureRoot()
    built(root, client)
    expect(desktopAppBundleEnvironment(root, { PATH: '/bin', DSH_CLIENT_VERSION: '9.9.9', DSH_BUILD_CLIENT_PROFILE: 'official' }))
      .toEqual({ PATH: '/bin', ...client })
  })

  it('refuses artifacts built without the desktop title', () => {
    const root = fixtureRoot()
    built(root, { ...client, DSH_CLIENT_TITLE: 'DSH Local Build' })
    expect(() => desktopAppBundleEnvironment(root, {})).toThrow(/embeds title "DSH Local Build"/)
  })

  it('refuses a page whose title is not the desktop title', () => {
    const root = fixtureRoot()
    built(root, client, 'DSH Local Build')
    expect(() => desktopAppBundleEnvironment(root, {})).toThrow(/index.html carries no <title>北冥<\/title>/)
  })

  it('refuses artifacts changed after the build record', () => {
    const root = fixtureRoot()
    built(root, client)
    writeFileSync(join(root, 'apps/web/dist/index.html'), '<title>北冥</title><!-- changed -->')
    expect(() => desktopAppBundleEnvironment(root, {})).toThrow(/client artifacts differ/)
  })
})
