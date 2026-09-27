/**
 * The desktop package's repository build: the title it hands `pnpm run build`,
 * and which client artifacts it accepts before the desktop-app bundle.
 * @module
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  assertDesktopClientTitle,
  DESKTOP_APP_BUNDLE_ARGS,
  DESKTOP_BUILD_STEPS,
  DESKTOP_CLIENT_TITLE,
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

describe('desktop client title check', () => {
  const client = { DSH_CLIENT_COMMIT_HASH: 'abcdef0', DSH_CLIENT_TITLE: DESKTOP_CLIENT_TITLE, DSH_CLIENT_VERSION: UPSTREAM_VERSION }

  it('accepts recorded artifacts built with the desktop title', () => {
    const root = fixtureRoot()
    built(root, client)
    expect(() => { assertDesktopClientTitle(root) }).not.toThrow()
  })

  it('refuses artifacts built without the desktop title', () => {
    const root = fixtureRoot()
    built(root, { ...client, DSH_CLIENT_TITLE: 'DSH Local Build' })
    expect(() => { assertDesktopClientTitle(root) }).toThrow(/embeds title "DSH Local Build"/)
  })

  it('refuses a page whose title is not the desktop title', () => {
    const root = fixtureRoot()
    built(root, client, 'DSH Local Build')
    expect(() => { assertDesktopClientTitle(root) }).toThrow(/index.html carries no <title>北冥<\/title>/)
  })

  it('refuses artifacts changed after the build record', () => {
    const root = fixtureRoot()
    built(root, client)
    writeFileSync(join(root, 'apps/web/dist/index.html'), '<title>北冥</title><!-- changed -->')
    expect(() => { assertDesktopClientTitle(root) }).toThrow(/client artifacts differ/)
  })
})

describe('the builds after the repository build', () => {
  it('bundle the desktop-app package first, then build the shell', () => {
    expect(DESKTOP_BUILD_STEPS.map(step => step.name)).toEqual(['desktop-app bundle', 'desktop tsc'])
    expect(DESKTOP_BUILD_STEPS[0]?.args).toEqual(DESKTOP_APP_BUNDLE_ARGS)
    expect(DESKTOP_APP_BUNDLE_ARGS).toEqual(['--filter', '@deepseek-ai/dsh-desktop-app', 'run', 'bundle'])
  })

  it('all run in package.ts after the title check and before the server closure is deployed', () => {
    const source = readFileSync(new URL('../scripts/package.ts', import.meta.url), 'utf8')
    const steps = source.indexOf("for (const step of DESKTOP_BUILD_STEPS) await run(step.name, 'pnpm', [...step.args])")
    expect(steps).toBeGreaterThan(source.indexOf('assertDesktopClientTitle(ROOT)'))
    expect(steps).toBeLessThan(source.indexOf("run('deploy server closure'"))
  })
})
