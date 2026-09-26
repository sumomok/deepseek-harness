/**
 * The desktop package's repository build: which public client values it hands
 * every build step, and which artifacts it accepts before staging.
 * @module
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DESKTOP_APP_PACKAGE,
  DESKTOP_CLIENT_TITLE,
  REPOSITORY_BUILD_SCRIPTS,
  desktopClientBuildEnvironment,
  desktopVersion,
  runDesktopRepositoryBuild,
  verifyDesktopClientBuild,
  type BuildStep,
} from '../scripts/client-build.ts'

const REPOSITORY_ROOT = resolve(import.meta.dirname, '..', '..', '..')
const SHELL_DIR = resolve(import.meta.dirname, '..')
const VERSION = '0.1.0-rc.34'
const COMMIT = 'abcdef0123456'
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A repository root outside Git with a root manifest whose version is upstream's. */
function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-client-build-'))
  roots.push(root)
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '0.1.7-rc.2' }))
  return root
}

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), content)
}

/** A build step that emits the artifacts a real build would, from the values it was given. */
function emittingStep(
  root: string,
  calls: { args: string[]; environment: NodeJS.ProcessEnv }[],
  pageTitle?: string,
): BuildStep {
  return (_label, _command, args, environment) => {
    calls.push({ args, environment })
    const version = JSON.stringify(environment.DSH_CLIENT_VERSION)
    if (args.join(' ') === 'run build:web') {
      write(root, 'apps/web/dist/index.html', `<title>${pageTitle ?? String(environment.DSH_CLIENT_TITLE)}</title>`)
    }
    if (args.join(' ') === 'run build:lib') {
      write(root, 'packages/client/ui-settings-general/lib/client.js', `t(${version})`)
    }
    if (args.includes(DESKTOP_APP_PACKAGE)) write(root, 'apps/desktop-app/lib/client.js', `v(${version})`)
    return Promise.resolve()
  }
}

describe('desktop client build environment', () => {
  it('puts the desktop title and version over the repository values and inherited ones', () => {
    const environment = desktopClientBuildEnvironment(fixtureRoot(), {
      DSH_CLIENT_COMMIT_HASH: COMMIT,
      DSH_CLIENT_TITLE: 'Inherited',
      DSH_CLIENT_VERSION: '9.9.9',
    }, VERSION)
    expect(environment).toEqual({
      DSH_CLIENT_COMMIT_HASH: COMMIT.slice(0, 7),
      DSH_CLIENT_TITLE: DESKTOP_CLIENT_TITLE,
      DSH_CLIENT_VERSION: VERSION,
    })
  })

  it('reads the release version from the shell manifest', () => {
    const manifest = JSON.parse(readFileSync(join(SHELL_DIR, 'package.json'), 'utf8')) as { version: string }
    expect(desktopVersion(SHELL_DIR)).toBe(manifest.version)
  })

  it('runs the same pnpm scripts as scripts/build.ts, in its order', () => {
    const source = readFileSync(join(REPOSITORY_ROOT, 'scripts', 'build.ts'), 'utf8')
    const scripts = [...source.matchAll(/runScript\('([^']+)'/g)].map(match => match[1])
    expect(scripts).toEqual([...REPOSITORY_BUILD_SCRIPTS])
  })
})

describe('desktop repository build', () => {
  it('hands every step, the desktop-app bundle included, the desktop title and version', async () => {
    const root = fixtureRoot()
    const calls: { args: string[]; environment: NodeJS.ProcessEnv }[] = []
    await runDesktopRepositoryBuild(root, {
      PATH: '/bin', DSH_BUILD_CLIENT_PROFILE: 'official', DSH_CLIENT_COMMIT_HASH: COMMIT,
    }, VERSION, emittingStep(root, calls))
    expect(calls.map(call => call.args)).toEqual([
      ...REPOSITORY_BUILD_SCRIPTS.map(script => ['run', script]),
      ['--filter', DESKTOP_APP_PACKAGE, 'run', 'bundle'],
    ])
    for (const { environment } of calls) {
      expect(environment.DSH_CLIENT_TITLE).toBe(DESKTOP_CLIENT_TITLE)
      expect(environment.DSH_CLIENT_VERSION).toBe(VERSION)
      expect(environment.DSH_BUILD_CLIENT_PROFILE).toBeUndefined()
      expect(environment.PATH).toBe('/bin')
    }
    expect(() => { verifyDesktopClientBuild(root, VERSION) }).not.toThrow()
  })

  it('refuses artifacts from a build that embedded another version', async () => {
    const root = fixtureRoot()
    await runDesktopRepositoryBuild(root, { DSH_CLIENT_COMMIT_HASH: COMMIT }, VERSION, emittingStep(root, []))
    expect(() => { verifyDesktopClientBuild(root, '0.1.0-rc.35') }).toThrow(/embeds title "北冥" and version "0.1.0-rc.34"/)
  })

  it('refuses a page whose title is not the desktop title', async () => {
    const root = fixtureRoot()
    await runDesktopRepositoryBuild(root, { DSH_CLIENT_COMMIT_HASH: COMMIT }, VERSION, emittingStep(root, [], 'DSH Local Build'))
    expect(() => { verifyDesktopClientBuild(root, VERSION) }).toThrow(/index.html carries no <title>北冥<\/title>/)
  })

  it('refuses artifacts changed after the build record', async () => {
    const root = fixtureRoot()
    await runDesktopRepositoryBuild(root, { DSH_CLIENT_COMMIT_HASH: COMMIT }, VERSION, emittingStep(root, []))
    writeFileSync(join(root, 'apps/web/dist/index.html'), '<title>DSH Local Build</title>')
    expect(() => { verifyDesktopClientBuild(root, VERSION) }).toThrow(/client artifacts differ/)
  })

  it('refuses a desktop-app bundle that does not embed the version', async () => {
    const root = fixtureRoot()
    await runDesktopRepositoryBuild(root, { DSH_CLIENT_COMMIT_HASH: COMMIT }, VERSION, emittingStep(root, []))
    rmSync(join(root, 'apps/desktop-app/lib/client.js'))
    expect(() => { verifyDesktopClientBuild(root, VERSION) }).toThrow(/apps\/desktop-app\/lib\/client.js does not embed/)
  })
})
