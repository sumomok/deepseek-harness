/**
 * The plugin-admin service's four migration-repair routes: `/recheck`,
 * `/repair`, `/forget`, `/enable`. pnpm and the native dialog are both
 * injected, exactly as the rest of this service's suite injects them.
 * @module
 */

import { lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  DESKTOP_PROFILE, ensureLink, MIGRATION_MARKER_FILENAME, profileDirectory, readMigrationMarker,
  WEB_PROFILE, writeMigrationMarker, type MigrationMarker,
} from '../src/profile-seed.ts'
import {
  ENABLE_PATH, FORGET_PATH, PLUGIN_ADMIN_LIMITS, RECHECK_PATH, REPAIR_PATH, startPluginAdminService,
  type ConfirmRequest, type PluginAdminHandle, type PnpmResult, type PnpmRun,
} from '../src/plugin-admin-service.ts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/** A finished run that printed nothing and succeeded. */
const QUIET: PnpmResult = { code: 0, signal: null, stdout: '', stderr: '' }

/** The migrated plugin every case that is not about staging names. */
const NAME = '@yuxianglin/dsh-bridge-browser'

let root: string
let home: string
let service: PluginAdminHandle | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-repair-'))
  home = join(root, 'home')
})

afterEach(async () => {
  await service?.close()
  service = undefined
  await rm(root, { recursive: true, force: true })
})

/** The desktop and web profile directories under this case's home. */
function dirs(): { desktopDir: string; webDir: string } {
  return { desktopDir: profileDirectory(home, DESKTOP_PROFILE), webDir: profileDirectory(home, WEB_PROFILE) }
}

/** Write a profile manifest with the fields these routes read. */
function writeManifest(dir: string, bundles: readonly string[], dependencies: Record<string, string> = {}): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile', private: true, dependencies, dsh: { profile: { bundles: [...bundles] } },
  }, undefined, 2)}\n`)
}

/** Put a package under a profile's own `node_modules`. */
function writePackage(
  profileDir: string, name: string,
  options: { bundle?: boolean; entry?: boolean; buildScript?: boolean; version?: string } = {},
): string {
  const dir = join(profileDir, 'node_modules', name)
  mkdirSync(dir, { recursive: true })
  const manifest: Record<string, unknown> = { name, version: options.version ?? '1.0.0' }
  if (options.bundle !== false) manifest['dsh'] = { bundle: { patch: './cordis.patch.yml' } }
  if (options.buildScript === true) manifest['scripts'] = { build: 'tsc' }
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
  if (options.entry !== false) writeFileSync(join(dir, 'index.js'), '')
  return dir
}

/** Stage a desktop and web profile, and a marker naming `NAME` as defective. */
function stageDefective(options: { specifier?: string; buildScript?: boolean } = {}): void {
  const { desktopDir, webDir } = dirs()
  writeManifest(desktopDir, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
  writeManifest(webDir, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', NAME], { [NAME]: options.specifier ?? '^1.0.0' })
  writePackage(webDir, NAME, { entry: false, ...options.buildScript === undefined ? {} : { buildScript: options.buildScript } })
  ensureLink(join(desktopDir, 'node_modules', NAME), join(webDir, 'node_modules', NAME))
  writeMigrationMarker(join(desktopDir, MIGRATION_MARKER_FILENAME), {
    from: WEB_PROFILE, migrated: [],
    defective: [{ name: NAME, kind: 'entry-missing', detail: 'no built entry file', at: 1 }],
    removed: [],
  })
}

/** The marker file this suite reads back, or undefined when there is none. */
function markerNow(): MigrationMarker | undefined {
  return readMigrationMarker(join(dirs().desktopDir, MIGRATION_MARKER_FILENAME))
}

/** What one started service recorded about the calls it made. */
interface Recorded {
  runs: PnpmRun[]
  asked: ConfirmRequest[]
}

/** Start one service, with pnpm and the confirm dialog injected and recorded. */
async function start(
  options: { run?: (run: PnpmRun) => PnpmResult; confirm?: boolean } = {},
): Promise<{ handle: PluginAdminHandle; recorded: Recorded }> {
  const recorded: Recorded = { runs: [], asked: [] }
  service = await startPluginAdminService({
    home,
    run: async (run) => {
      recorded.runs.push(run)
      return options.run?.(run) ?? QUIET
    },
    confirm: async (request) => {
      recorded.asked.push(request)
      return options.confirm ?? true
    },
    relaunch: () => {},
    limits: PLUGIN_ADMIN_LIMITS,
  })
  return { handle: service, recorded }
}

/** POST a `{name}` body to one of the four repair routes. */
async function call(handle: PluginAdminHandle, path: string, name: unknown): Promise<Response> {
  return fetch(`${handle.endpoint}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${handle.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  })
}

/** The parsed JSON body of one answer. */
async function jsonOf(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>
}

describe('/recheck', () => {
  it('refuses a name that is not in the defective list', async () => {
    stageDefective()
    const { handle, recorded } = await start()
    const response = await call(handle, RECHECK_PATH, 'never-heard-of-it')
    expect(response.status).toBe(422)
    expect(recorded.runs).toEqual([])
  })

  it('promotes a defective name back to migrated once its package resolves cleanly', async () => {
    stageDefective()
    // The field is repaired by hand, outside this service, between two checks.
    writeFileSync(join(dirs().webDir, 'node_modules', NAME, 'index.js'), '')
    const { handle } = await start()
    const body = await jsonOf(await call(handle, RECHECK_PATH, NAME))
    expect(body).toEqual({ ok: true, restartRequired: true })
    const marker = markerNow()
    expect(marker?.migrated).toEqual([NAME])
    expect(marker?.defective).toEqual([])
    const manifest = JSON.parse(readFileSync(join(dirs().desktopDir, 'package.json'), 'utf8')) as {
      dsh: { profile: { bundles: string[] } }
      dependencies: Record<string, string>
    }
    expect(manifest.dsh.profile.bundles).toContain(NAME)
    expect(manifest.dependencies[NAME]).toBe('^1.0.0')
  })

  it('persists an updated reason and leaves the name defective when it still does not resolve', async () => {
    stageDefective()
    const { handle } = await start()
    const body = await jsonOf(await call(handle, RECHECK_PATH, NAME))
    expect(body.ok).toBe(false)
    expect(typeof body.reason).toBe('string')
    const marker = markerNow()
    expect(marker?.defective).toHaveLength(1)
    expect(marker?.defective[0]?.name).toBe(NAME)
    expect(marker?.migrated).toEqual([])
  })

  it('runs no pnpm and asks nobody: this is a filesystem check, not an install', async () => {
    stageDefective()
    const { handle, recorded } = await start()
    await call(handle, RECHECK_PATH, NAME)
    expect(recorded.runs).toEqual([])
    expect(recorded.asked).toEqual([])
  })
})

describe('/forget', () => {
  it('refuses a name in neither defective nor removed', async () => {
    stageDefective()
    const { handle } = await start()
    expect((await call(handle, FORGET_PATH, 'never-heard-of-it')).status).toBe(422)
  })

  it('deletes a defective name\'s record and its link', async () => {
    stageDefective()
    const { handle } = await start()
    const body = await jsonOf(await call(handle, FORGET_PATH, NAME))
    expect(body).toEqual({ ok: true })
    expect(markerNow()?.defective).toEqual([])
    expect(lstatSync(join(dirs().desktopDir, 'node_modules', NAME), { throwIfNoEntry: false })).toBeUndefined()
  })

  it('deletes a removed name\'s record too', async () => {
    const { desktopDir, webDir } = dirs()
    writeManifest(desktopDir, [])
    writeManifest(webDir, [NAME])
    writePackage(webDir, NAME)
    writeMigrationMarker(join(desktopDir, MIGRATION_MARKER_FILENAME), {
      from: WEB_PROFILE, migrated: [], defective: [], removed: [NAME],
    })
    const { handle } = await start()
    const body = await jsonOf(await call(handle, FORGET_PATH, NAME))
    expect(body).toEqual({ ok: true })
    expect(markerNow()?.removed).toEqual([])
  })
})

describe('/enable', () => {
  function stageRemoved(): void {
    const { desktopDir, webDir } = dirs()
    writeManifest(desktopDir, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
    writeManifest(webDir, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', NAME], { [NAME]: '^1.0.0' })
    writePackage(webDir, NAME)
    writeMigrationMarker(join(desktopDir, MIGRATION_MARKER_FILENAME), {
      from: WEB_PROFILE, migrated: [], defective: [], removed: [NAME],
    })
  }

  it('refuses a name that is not in the removed list', async () => {
    stageDefective()
    const { handle } = await start()
    expect((await call(handle, ENABLE_PATH, NAME)).status).toBe(422)
  })

  it('re-links and re-migrates a removed name whose web copy is healthy', async () => {
    stageRemoved()
    const { handle } = await start()
    const body = await jsonOf(await call(handle, ENABLE_PATH, NAME))
    expect(body).toEqual({ ok: true, restartRequired: true })
    expect(markerNow()).toMatchObject({ migrated: [NAME], removed: [] })
    expect(readlinkSync(join(dirs().desktopDir, 'node_modules', NAME))).toBe(join(dirs().webDir, 'node_modules', NAME))
    const manifest = JSON.parse(readFileSync(join(dirs().desktopDir, 'package.json'), 'utf8')) as {
      dsh: { profile: { bundles: string[] } }
    }
    expect(manifest.dsh.profile.bundles).toContain(NAME)
  })

  it('re-links but records defective when the web copy is no longer healthy', async () => {
    stageRemoved()
    rmSync(join(dirs().webDir, 'node_modules', NAME, 'index.js'))
    const { handle } = await start()
    const body = await jsonOf(await call(handle, ENABLE_PATH, NAME))
    expect(body.ok).toBe(false)
    const marker = markerNow()
    expect(marker?.removed).toEqual([])
    expect(marker?.defective).toHaveLength(1)
    expect(marker?.defective[0]).toMatchObject({ name: NAME, kind: 'entry-missing' })
  })

  it('refuses a removed name whose web copy is gone entirely', async () => {
    stageRemoved()
    rmSync(join(dirs().webDir, 'node_modules', NAME), { recursive: true, force: true })
    const { handle } = await start()
    expect((await call(handle, ENABLE_PATH, NAME)).status).toBe(422)
    expect(markerNow()?.removed).toEqual([NAME])
  })
})

describe('/repair', () => {
  it('refuses a name that is not in the defective list', async () => {
    stageDefective()
    const { handle } = await start()
    expect((await call(handle, REPAIR_PATH, 'never-heard-of-it')).status).toBe(422)
  })

  it('asks before touching anything, with the plain-language confirmation the owner specified', async () => {
    stageDefective()
    const { handle, recorded } = await start({ confirm: false })
    const body = await jsonOf(await call(handle, REPAIR_PATH, NAME))
    expect(body).toEqual({ ok: false, reason: 'cancelled' })
    expect(recorded.asked).toHaveLength(1)
    expect(recorded.asked[0]?.message).toBe(`尝试修复 ${NAME}？`)
    expect(recorded.asked[0]?.detail).toBe('将重新下载并执行该插件自带的构建脚本。')
    expect(recorded.asked[0]?.confirmLabel).toBe('修复')
    expect(recorded.runs).toEqual([])
  })

  it('reinstalls at the web profile\'s own declared specifier', async () => {
    stageDefective({ specifier: '^2.3.0' })
    const { handle, recorded } = await start()
    await call(handle, REPAIR_PATH, NAME)
    expect(recorded.runs[0]).toMatchObject({ args: ['add', `${NAME}@^2.3.0`], cwd: dirs().webDir })
  })

  it('reinstalls a git specifier as the bare add target, not name@spec', async () => {
    stageDefective({ specifier: 'git+https://example.test/x/y.git#abc123' })
    const { handle, recorded } = await start()
    await call(handle, REPAIR_PATH, NAME)
    expect(recorded.runs[0]?.args).toEqual(['add', 'git+https://example.test/x/y.git#abc123'])
  })

  it('promotes to migrated when the reinstall alone fixed it', async () => {
    stageDefective()
    const { handle } = await start({
      run: (run) => {
        if (run.args[0] === 'add') writeFileSync(join(dirs().webDir, 'node_modules', NAME, 'index.js'), '')
        return QUIET
      },
    })
    const body = await jsonOf(await call(handle, REPAIR_PATH, NAME))
    expect(body).toEqual({ ok: true, restartRequired: true })
    expect(markerNow()?.migrated).toEqual([NAME])
  })

  it('runs the package\'s own build script through the real directory a link points at, then cleans up after it', async () => {
    // The web copy is a symlink into a separate store, the way pnpm's own
    // content-addressable layout works: the build must run where the files
    // actually are, not at the profile-side link.
    // NAME is scoped, so its own parent scope directory has to exist too.
    const store = join(root, 'store', NAME)
    writePackage(join(root, 'store-profile'), NAME, { entry: false, buildScript: true })
    mkdirSync(dirname(store), { recursive: true })
    symlinkSync(join(root, 'store-profile', 'node_modules', NAME), store, 'junction')
    const { webDir, desktopDir } = dirs()
    mkdirSync(dirname(join(webDir, 'node_modules', NAME)), { recursive: true })
    symlinkSync(store, join(webDir, 'node_modules', NAME), 'junction')
    writeManifest(desktopDir, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
    writeManifest(webDir, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', NAME], { [NAME]: '^1.0.0' })
    ensureLink(join(desktopDir, 'node_modules', NAME), join(webDir, 'node_modules', NAME))
    writeMigrationMarker(join(desktopDir, MIGRATION_MARKER_FILENAME), {
      from: WEB_PROFILE, migrated: [],
      defective: [{ name: NAME, kind: 'entry-missing', detail: 'no built entry file', at: 1 }],
      removed: [],
    })

    // realpathSync, not the plain join: macOS's own temp directory is itself a
    // symlink (/var/folders/... -> /private/var/folders/...), so the runner's
    // own realpath resolution would otherwise disagree with a literal join.
    const realDir = realpathSync(join(root, 'store-profile', 'node_modules', NAME))
    const { handle, recorded } = await start({
      run: (run) => {
        if (run.args[0] === 'run' && run.args[1] === 'build') {
          mkdirSync(join(realDir, 'node_modules'), { recursive: true })
          writeFileSync(join(realDir, 'pnpm-lock.yaml'), '')
          writeFileSync(join(realDir, 'index.js'), '')
        }
        return QUIET
      },
    })
    const body = await jsonOf(await call(handle, REPAIR_PATH, NAME))
    expect(body).toEqual({ ok: true, restartRequired: true })
    expect(recorded.runs.map(run => run.cwd)).toContain(realDir)
    expect(recorded.runs.some(run => run.args[0] === 'install' && run.cwd === realDir)).toBe(true)
    expect(recorded.runs.some(run => run.args[0] === 'run' && run.args[1] === 'build' && run.cwd === realDir)).toBe(true)
    // The build's own node_modules and lockfile are removed after the build,
    // so the profile's hoisted tree stays the one runtime dependencies resolve
    // from.
    expect(lstatSync(join(realDir, 'node_modules'), { throwIfNoEntry: false })).toBeUndefined()
    expect(lstatSync(join(realDir, 'pnpm-lock.yaml'), { throwIfNoEntry: false })).toBeUndefined()
  })

  it('reports a failure and persists the reason when the package declares no build script', async () => {
    stageDefective({ buildScript: false })
    const { handle } = await start()
    const body = await jsonOf(await call(handle, REPAIR_PATH, NAME))
    expect(body.ok).toBe(false)
    expect(body.reason).toContain('no build script')
    const marker = markerNow()
    expect(marker?.defective).toHaveLength(1)
    // The build-ladder's own reason is what gets persisted, replacing the
    // detail the entry was staged with.
    expect(marker?.defective[0]?.detail).toBe(body.reason)
    expect(marker?.defective[0]?.kind).toBe('entry-missing')
  })

  it('reports the specific reason when the web profile declares no version to reinstall', async () => {
    const { desktopDir, webDir } = dirs()
    writeManifest(desktopDir, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
    writeManifest(webDir, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', NAME]) // no dependencies entry
    writePackage(webDir, NAME, { entry: false })
    ensureLink(join(desktopDir, 'node_modules', NAME), join(webDir, 'node_modules', NAME))
    writeMigrationMarker(join(desktopDir, MIGRATION_MARKER_FILENAME), {
      from: WEB_PROFILE, migrated: [],
      defective: [{ name: NAME, kind: 'entry-missing', detail: 'no built entry file', at: 1 }],
      removed: [],
    })
    const { handle, recorded } = await start()
    const body = await jsonOf(await call(handle, REPAIR_PATH, NAME))
    expect(body.ok).toBe(false)
    expect(body.reason).toContain('declares no version')
    expect(recorded.runs).toEqual([])
  })
})
