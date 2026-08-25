/**
 * The loopback plugin-admin protocol: what it refuses, in what order it
 * decides, and what it does with the requests it accepts. pnpm and the native
 * dialog are both injected, so everything here runs without either.
 * @module
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ADMIN_PROFILES, ENDPOINT_ENV, OUTDATED_PATH, PEERS_PATH, PLUGIN_ADMIN_LIMITS, RELAUNCH_PATH,
  resolvePnpmLauncher, startPluginAdminService, TOKEN_ENV, UPDATE_PATH,
  type ConfirmRequest, type PluginAdminHandle, type PluginAdminLimits, type PnpmResult, type PnpmRun,
} from '../src/plugin-admin-service.ts'

/** A finished run that printed nothing and succeeded. */
const QUIET: PnpmResult = { code: 0, signal: null, stdout: '', stderr: '' }

/** What `pnpm outdated --json` answers for a profile with one updatable plugin. */
const OUTDATED = {
  'dsh-better-sidebar': {
    current: '0.14.0',
    latest: '0.15.2',
    wanted: '0.14.0',
    isDeprecated: false,
    dependencyType: 'dependencies',
  },
}

/** The plugin every case that is not about the fence names. */
const PLUGIN = 'dsh-better-sidebar'

/** A built-in: seeded into `dsh.profile.bundles` and never a dependency. */
const BUILTIN = '@haoran/dsh-screenshot'

let service: PluginAdminHandle | undefined
const homes: string[] = []

afterEach(async () => {
  await service?.close()
  service = undefined
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

/** One staged profile's manifest fields. */
interface StagedProfile {
  /** Packages the profile installed for itself. */
  dependencies?: Record<string, string>
  /** Bundle layers the profile lists, installed or seeded. */
  bundles?: string[]
  /** Packages present under the profile's own `node_modules`, and whether each declares `dsh.bundle`. */
  installed?: Record<string, boolean>
  /** The version each staged package carries; {@link STAGED_VERSION} where this names none. */
  versions?: Record<string, string>
}

/** The version a staged package carries unless a case names another. */
const STAGED_VERSION = '0.15.2'

/**
 * Stage a Harness home with the profiles a case needs.
 * @param profiles - what each profile's manifest and `node_modules` hold.
 * @returns the home directory, removed by the shared teardown.
 */
function stageHome(profiles: Partial<Record<string, StagedProfile>>): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-plugin-admin-'))
  homes.push(home)
  for (const [profile, staged] of Object.entries(profiles)) {
    if (staged === undefined) continue
    const dir = join(home, 'profiles', profile)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
      name: `dsh-profile-${profile}`,
      private: true,
      dependencies: staged.dependencies ?? {},
      dsh: { profile: { bundles: staged.bundles ?? [] } },
    }, undefined, 2)}\n`)
    for (const [name, isBundle] of Object.entries(staged.installed ?? {})) {
      const packageDir = join(dir, 'node_modules', name)
      mkdirSync(packageDir, { recursive: true })
      writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
        name,
        version: staged.versions?.[name] ?? STAGED_VERSION,
        ...isBundle ? { dsh: { bundle: { patch: './cordis.patch.yml' } } } : {},
      }))
    }
  }
  return home
}

/** The home every case that is not about staging uses: one updatable plugin, one seeded built-in. */
function stageOrdinaryHome(): string {
  return stageHome({
    desktop: {
      dependencies: { [PLUGIN]: '0.14.0' },
      bundles: [BUILTIN, PLUGIN],
      installed: { [PLUGIN]: true },
    },
    web: { dependencies: { [PLUGIN]: '0.14.0' }, bundles: [PLUGIN], installed: { [PLUGIN]: true } },
  })
}

/** What one started service recorded about the calls it made. */
interface Recorded {
  /** Every pnpm invocation, in order. */
  runs: PnpmRun[]
  /** Every confirmation the service asked for, in order. */
  asked: ConfirmRequest[]
  /** How many times the shell was asked to restart. */
  relaunches: number
}

/** How one case wants its injected halves to behave. */
interface Halves {
  /** What pnpm answers; the default succeeds silently. */
  run?: (run: PnpmRun) => PnpmResult
  /** What the user answers; the default confirms. */
  confirm?: boolean
  /** The bounds to change for this case. */
  limits?: Partial<PluginAdminLimits>
}

/**
 * Start one service for this test over a staged home.
 * @param home - the staged Harness home.
 * @param halves - what pnpm and the user do.
 * @returns the handle and the record of what it asked for.
 */
async function start(home: string, halves: Halves = {}): Promise<{ handle: PluginAdminHandle; recorded: Recorded }> {
  const recorded: Recorded = { runs: [], asked: [], relaunches: 0 }
  service = await startPluginAdminService({
    home,
    run: async (run) => {
      recorded.runs.push(run)
      return halves.run?.(run) ?? QUIET
    },
    confirm: async (request) => {
      recorded.asked.push(request)
      return halves.confirm ?? true
    },
    relaunch: () => { recorded.relaunches++ },
    limits: { ...PLUGIN_ADMIN_LIMITS, ...halves.limits },
  })
  return { handle: service, recorded }
}

/** POST a body to one of this service's routes with its own token and content type. */
async function call(handle: PluginAdminHandle, path: string, body: unknown, token = handle.token): Promise<Response> {
  return fetch(`${handle.endpoint}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** The parsed JSON body of one answer. */
async function jsonOf(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>
}

describe('the listener', () => {
  it('binds the loopback address on an ephemeral port', async () => {
    const { handle } = await start(stageOrdinaryHome())
    expect(handle.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  })

  it('mints a fresh 32-byte token per launch, and puts it in no environment', async () => {
    const first = await start(stageOrdinaryHome())
    expect(first.handle.token).toMatch(/^[0-9a-f]{64}$/)
    // The endpoint and the token reach the server child's environment and
    // nothing else; a pnpm this service spawns inherits neither.
    expect(process.env[ENDPOINT_ENV]).toBeUndefined()
    expect(process.env[TOKEN_ENV]).toBeUndefined()
    expect(Object.values(process.env)).not.toContain(first.handle.token)
    await first.handle.close()
    service = undefined
    const second = await start(stageOrdinaryHome())
    expect(second.handle.token).not.toBe(first.handle.token)
  })
})

describe('admission', () => {
  it('answers an unknown path 404 before it looks at the token, so it tells an unauthenticated caller nothing', async () => {
    const { handle } = await start(stageOrdinaryHome())
    const response = await fetch(`${handle.endpoint}/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(response.status).toBe(404)
    expect(await response.text()).toContain('no route for POST /install')
  })

  it('answers a known path under the wrong method 404', async () => {
    const { handle } = await start(stageOrdinaryHome())
    const response = await fetch(`${handle.endpoint}${UPDATE_PATH}`, { method: 'GET' })
    expect(response.status).toBe(404)
  })

  it('refuses a request carrying no authorization at all', async () => {
    const { handle, recorded } = await start(stageOrdinaryHome())
    const response = await fetch(`${handle.endpoint}${OUTDATED_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile: 'desktop' }),
    })
    expect(response.status).toBe(401)
    expect(recorded.runs).toEqual([])
  })

  it('refuses another token of the same length, which is what a constant-time compare is for', async () => {
    const { handle, recorded } = await start(stageOrdinaryHome())
    const wrong = `${handle.token.slice(0, -1)}${handle.token.endsWith('a') ? 'b' : 'a'}`
    expect(wrong).toHaveLength(handle.token.length)
    const response = await call(handle, OUTDATED_PATH, { profile: 'desktop' }, wrong)
    expect(response.status).toBe(401)
    expect(recorded.runs).toEqual([])
  })

  it('refuses a prefix of its own token', async () => {
    const { handle } = await start(stageOrdinaryHome())
    expect((await call(handle, OUTDATED_PATH, { profile: 'desktop' }, handle.token.slice(0, 32))).status).toBe(401)
  })

  it('refuses a body that is not JSON, and one that is not an object', async () => {
    const { handle } = await start(stageOrdinaryHome())
    const notJson = await fetch(`${handle.endpoint}${OUTDATED_PATH}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${handle.token}`, 'content-type': 'application/json' },
      body: 'not json',
    })
    expect(notJson.status).toBe(400)
    expect((await call(handle, OUTDATED_PATH, ['desktop'])).status).toBe(400)
  })

  it('refuses a body over the cap', async () => {
    const { handle } = await start(stageOrdinaryHome(), { limits: { maxBodyBytes: 64 } })
    const response = await call(handle, OUTDATED_PATH, { profile: 'desktop', pad: 'x'.repeat(256) })
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('at most 64 bytes')
  })

  it('requires the JSON content type', async () => {
    const { handle } = await start(stageOrdinaryHome())
    const response = await fetch(`${handle.endpoint}${OUTDATED_PATH}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${handle.token}`, 'content-type': 'text/plain' },
      body: JSON.stringify({ profile: 'desktop' }),
    })
    expect(response.status).toBe(400)
  })
})

describe('the profile fence', () => {
  it('acts in exactly the two profiles the shell owns', () => {
    expect([...ADMIN_PROFILES]).toEqual(['desktop', 'web'])
  })

  it.each([
    ['a profile that does not exist', 'agent'],
    ['a traversal', '../../../etc'],
    ['an absolute path', '/etc'],
    ['an empty name', ''],
  ])('refuses %s', async (_case, profile) => {
    const { handle, recorded } = await start(stageOrdinaryHome())
    const response = await call(handle, OUTDATED_PATH, { profile })
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('profile must be one of desktop, web')
    expect(recorded.runs).toEqual([])
  })

  it('refuses a profile that is not a string', async () => {
    const { handle } = await start(stageOrdinaryHome())
    expect((await call(handle, OUTDATED_PATH, { profile: { desktop: true } })).status).toBe(400)
  })

  it('runs in the directory the named profile occupies', async () => {
    const home = stageOrdinaryHome()
    const { handle, recorded } = await start(home)
    await call(handle, OUTDATED_PATH, { profile: 'web' })
    expect(recorded.runs).toHaveLength(1)
    expect(recorded.runs[0]?.cwd).toBe(join(home, 'profiles', 'web'))
  })
})

describe('the package fence', () => {
  it('refuses a package this profile never installed', async () => {
    const { handle, recorded } = await start(stageOrdinaryHome())
    const response = await call(handle, UPDATE_PATH, { profile: 'desktop', name: 'left-pad', version: '1.3.0' })
    expect(response.status).toBe(422)
    expect(await response.text()).toContain('left-pad is not a plugin this profile installed')
    expect(recorded.asked).toEqual([])
    expect(recorded.runs).toEqual([])
  })

  it('refuses a built-in, which is listed as a bundle and never as a dependency', async () => {
    const { handle, recorded } = await start(stageOrdinaryHome())
    const response = await call(handle, UPDATE_PATH, { profile: 'desktop', name: BUILTIN, version: '0.2.0' })
    expect(response.status).toBe(422)
    expect(recorded.runs).toEqual([])
  })

  it('refuses a package installed in the other profile', async () => {
    const home = stageHome({
      desktop: { dependencies: {}, bundles: [] },
      web: { dependencies: { [PLUGIN]: '0.14.0' } },
    })
    const { handle } = await start(home)
    expect((await call(handle, UPDATE_PATH, { profile: 'desktop', name: PLUGIN, version: '0.15.2' })).status).toBe(422)
    expect((await call(handle, UPDATE_PATH, { profile: 'web', name: PLUGIN, version: '0.15.2' })).status).toBe(200)
  })

  it.each([
    ['a flag', '--registry=https://evil.test'],
    ['a path', '../../../evil'],
    ['a file spec', 'file:/tmp/evil'],
    ['an uppercase name, which npm has not allowed since 2017', 'Left-Pad'],
    ['a name with a space', 'left pad'],
  ])('refuses %s as a package name', async (_case, name) => {
    const { handle, recorded } = await start(stageOrdinaryHome())
    const response = await call(handle, UPDATE_PATH, { profile: 'desktop', name, version: '1.0.0' })
    expect(response.status).toBe(400)
    expect(recorded.runs).toEqual([])
  })

  it('reads the fence off disk on every call, not once at startup', async () => {
    const home = stageHome({ desktop: { dependencies: {}, bundles: [] } })
    const { handle } = await start(home)
    expect((await call(handle, UPDATE_PATH, { profile: 'desktop', name: PLUGIN, version: '0.15.2' })).status).toBe(422)
    writeFileSync(join(home, 'profiles', 'desktop', 'package.json'), JSON.stringify({
      dependencies: { [PLUGIN]: '0.14.0' },
      dsh: { profile: { bundles: [] } },
    }))
    expect((await call(handle, UPDATE_PATH, { profile: 'desktop', name: PLUGIN, version: '0.15.2' })).status).toBe(200)
  })
})

describe('the version fence', () => {
  it.each([
    ['a caret range', '^0.15.0'],
    ['a tilde range', '~0.15.0'],
    ['a comparator', '>=0.15.0'],
    ['a wildcard', '0.15.x'],
    ['a star', '*'],
    ['the latest tag', 'latest'],
    ['a dist tag', 'next'],
    ['a tarball URL', 'https://evil.test/pkg.tgz'],
    ['a git spec', 'git+ssh://git@evil.test/pkg.git'],
    ['a github shorthand', 'github:evil/pkg'],
    ['a file spec', 'file:../evil'],
    ['a link spec', 'link:../evil'],
    ['an npm alias', 'npm:evil@1.0.0'],
    ['a workspace spec', 'workspace:*'],
    ['leading whitespace', ' 0.15.2'],
    ['trailing whitespace', '0.15.2 '],
    ['an embedded newline', '0.15.2\n--registry=https://evil.test'],
    ['a partial version', '0.15'],
    ['an empty version', ''],
    ['a v prefix', 'v0.15.2'],
  ])('refuses %s', async (_case, version) => {
    const { handle, recorded } = await start(stageOrdinaryHome())
    const response = await call(handle, UPDATE_PATH, { profile: 'desktop', name: PLUGIN, version })
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('one exact published version')
    expect(recorded.asked).toEqual([])
    expect(recorded.runs).toEqual([])
  })

  it.each(['0.15.2', '1.0.0', '0.1.0-rc.7', '2.3.4-beta.1', '1.2.3+build.5'])('accepts the exact version %s', async (version) => {
    const { handle, recorded } = await start(stageOrdinaryHome())
    expect((await call(handle, UPDATE_PATH, { profile: 'desktop', name: PLUGIN, version })).status).toBe(200)
    expect(recorded.runs[0]?.args).toEqual(['add', `${PLUGIN}@${version}`])
  })

  it('refuses a version that is not a string', async () => {
    const { handle } = await start(stageOrdinaryHome())
    expect((await call(handle, UPDATE_PATH, { profile: 'desktop', name: PLUGIN, version: 15 })).status).toBe(400)
  })
})

describe('reporting what is outdated', () => {
  it('hands pnpm\'s own JSON back, name for name, with how the run ended', async () => {
    const { handle, recorded } = await start(stageOrdinaryHome(), {
      run: () => ({ code: 1, signal: null, stdout: JSON.stringify(OUTDATED), stderr: '' }),
    })
    const body = await jsonOf(await call(handle, OUTDATED_PATH, { profile: 'desktop' }))
    expect(recorded.runs[0]?.args).toEqual(['outdated', '--json'])
    expect(body.packages).toEqual(OUTDATED)
    // pnpm exits 1 precisely when something is outdated, so a caller reading
    // the exit status as failure would report nothing exactly when there is
    // something to report.
    expect(body.exitCode).toBe(1)
  })

  it('answers an empty profile with no packages rather than a failure', async () => {
    const { handle } = await start(stageOrdinaryHome(), { run: () => QUIET })
    const body = await jsonOf(await call(handle, OUTDATED_PATH, { profile: 'desktop' }))
    expect(body.packages).toBeNull()
    expect(body.exitCode).toBe(0)
  })

  it('carries what pnpm printed instead of JSON, and why the run produced no status', async () => {
    const { handle } = await start(stageOrdinaryHome(), {
      run: () => ({ code: null, signal: null, stdout: 'ERR_PNPM_NO_LOCKFILE', stderr: 'registry unreachable', failure: 'pnpm did not finish within 1ms' }),
    })
    const body = await jsonOf(await call(handle, OUTDATED_PATH, { profile: 'desktop' }))
    expect(body.packages).toBeNull()
    expect(body.output).toBe('ERR_PNPM_NO_LOCKFILE')
    expect(body.stderr).toBe('registry unreachable')
    expect(body.failure).toBe('pnpm did not finish within 1ms')
  })

  it('needs no package name, so it works before anything is known about the profile', async () => {
    const { handle } = await start(stageOrdinaryHome())
    expect((await call(handle, OUTDATED_PATH, { profile: 'desktop' })).status).toBe(200)
  })
})

describe('reporting peers', () => {
  it('asks pnpm for one published version\'s peers and hands them back verbatim', async () => {
    const peers = { '@deepseek-ai/dsh-client-ui-slots': '^0.1.0-rc.7', react: '^18.2.0' }
    const { handle, recorded } = await start(stageOrdinaryHome(), {
      run: () => ({ ...QUIET, stdout: JSON.stringify(peers) }),
    })
    const body = await jsonOf(await call(handle, PEERS_PATH, { profile: 'desktop', name: PLUGIN, version: '0.15.2' }))
    expect(recorded.runs[0]?.args).toEqual(['view', `${PLUGIN}@0.15.2`, 'peerDependencies', '--json'])
    expect(body.peers).toEqual(peers)
  })

  it('answers a package that declares no peers with none, which pnpm prints as nothing', async () => {
    const { handle } = await start(stageOrdinaryHome(), { run: () => QUIET })
    const body = await jsonOf(await call(handle, PEERS_PATH, { profile: 'desktop', name: PLUGIN, version: '0.15.2' }))
    expect(body.peers).toBeNull()
    expect(body.exitCode).toBe(0)
  })

  it('applies the same package and version fences as an update', async () => {
    const { handle } = await start(stageOrdinaryHome())
    expect((await call(handle, PEERS_PATH, { profile: 'desktop', name: 'left-pad', version: '1.3.0' })).status).toBe(422)
    expect((await call(handle, PEERS_PATH, { profile: 'desktop', name: PLUGIN, version: 'latest' })).status).toBe(400)
  })

  it('asks nobody: reading a version is not a change', async () => {
    const { handle, recorded } = await start(stageOrdinaryHome())
    await call(handle, PEERS_PATH, { profile: 'desktop', name: PLUGIN, version: '0.15.2' })
    expect(recorded.asked).toEqual([])
  })
})

describe('the update', () => {
  it('asks the person at the keyboard before it installs anything', async () => {
    const { handle, recorded } = await start(stageOrdinaryHome())
    await call(handle, UPDATE_PATH, { profile: 'desktop', name: PLUGIN, version: '0.15.2' })
    expect(recorded.asked).toHaveLength(1)
    expect(recorded.asked[0]?.message).toBe(`将 ${PLUGIN} 更新到 0.15.2？`)
    expect(recorded.asked[0]?.confirmLabel).toBe('更新')
    expect(recorded.asked[0]?.cancelLabel).toBe('取消')
    expect(recorded.asked[0]?.detail).toBeUndefined()
  })

  it('installs nothing when the person declines', async () => {
    const { handle, recorded } = await start(stageOrdinaryHome(), { confirm: false })
    const body = await jsonOf(await call(handle, UPDATE_PATH, { profile: 'desktop', name: PLUGIN, version: '0.15.2' }))
    expect(body.confirmed).toBe(false)
    expect(recorded.runs).toEqual([])
  })

  it('shows the caller\'s warning under the question', async () => {
    const { handle, recorded } = await start(stageOrdinaryHome())
    await call(handle, UPDATE_PATH, {
      profile: 'desktop', name: PLUGIN, version: '0.15.2',
      warning: '这个版本要求的组件版本比当前应用新,更新后可能无法使用。',
    })
    expect(recorded.asked[0]?.detail).toBe('这个版本要求的组件版本比当前应用新,更新后可能无法使用。')
  })

  it('flattens a warning that tries to write its own dialog, and caps it', async () => {
    const { handle, recorded } = await start(stageOrdinaryHome(), { limits: { maxWarningChars: 20 } })
    await call(handle, UPDATE_PATH, {
      profile: 'desktop', name: PLUGIN, version: '0.15.2',
      warning: 'careful\n\nOK  to continue, definitely fine',
    })
    expect(recorded.asked[0]?.detail).toBe('careful OK to contin')
  })

  it('refuses a warning that is not a string, and treats a blank one as none', async () => {
    const { handle, recorded } = await start(stageOrdinaryHome())
    expect((await call(handle, UPDATE_PATH, { profile: 'desktop', name: PLUGIN, version: '0.15.2', warning: 7 })).status).toBe(400)
    await call(handle, UPDATE_PATH, { profile: 'desktop', name: PLUGIN, version: '0.15.2', warning: '   ' })
    expect(recorded.asked.at(-1)?.detail).toBeUndefined()
  })

  it('reports the install with how pnpm ended', async () => {
    const { handle } = await start(stageOrdinaryHome(), {
      run: () => ({ code: 0, signal: null, stdout: '+ dsh-better-sidebar 0.15.2', stderr: '' }),
    })
    const body = await jsonOf(await call(handle, UPDATE_PATH, { profile: 'desktop', name: PLUGIN, version: '0.15.2' }))
    expect(body).toMatchObject({ profile: 'desktop', name: PLUGIN, version: '0.15.2', confirmed: true, exitCode: 0 })
    expect(body.installedVersion).toBe('0.15.2')
    expect(body.output).toBe('+ dsh-better-sidebar 0.15.2')
  })

  it('runs one install at a time', async () => {
    const home = stageOrdinaryHome()
    let release = (): void => {}
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const recorded: PnpmRun[] = []
    service = await startPluginAdminService({
      home,
      run: async (run) => {
        recorded.push(run)
        await blocked
        return QUIET
      },
      confirm: async () => true,
      relaunch: () => {},
      limits: PLUGIN_ADMIN_LIMITS,
    })
    const first = call(service, UPDATE_PATH, { profile: 'desktop', name: PLUGIN, version: '0.15.2' })
    // The second call has to arrive while the first is still installing, which
    // is what the first run entering the injected half reports.
    while (recorded.length === 0) await new Promise(resolve => setTimeout(resolve, 5))
    const second = await call(service, UPDATE_PATH, { profile: 'desktop', name: PLUGIN, version: '0.15.2' })
    expect(second.status).toBe(503)
    release()
    expect((await first).status).toBe(200)
    expect(recorded).toHaveLength(1)
  })
})

describe('a package that stopped being a bundle', () => {
  it('takes the name out of the profile\'s bundle list, because leaving it would end the next boot', async () => {
    const home = stageHome({
      desktop: {
        dependencies: { [PLUGIN]: '0.14.0' },
        bundles: [BUILTIN, PLUGIN],
        installed: { [PLUGIN]: false },
      },
    })
    const { handle } = await start(home)
    const body = await jsonOf(await call(handle, UPDATE_PATH, { profile: 'desktop', name: PLUGIN, version: '0.15.2' }))
    expect(body.stillBundle).toBe(false)
    expect(body.droppedFromBundles).toEqual([PLUGIN])
    const manifest = JSON.parse(readFileSync(join(home, 'profiles', 'desktop', 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
      dsh: { profile: { bundles: string[] } }
    }
    expect(manifest.dsh.profile.bundles).toEqual([BUILTIN])
    // The dependency stays: the package is still installed, and taking the
    // entry out is about what the Loader mounts, not about what pnpm holds.
    expect(manifest.dependencies).toEqual({ [PLUGIN]: '0.14.0' })
  })

  it('leaves the list alone for a package that is still a bundle', async () => {
    const home = stageOrdinaryHome()
    const { handle } = await start(home)
    const body = await jsonOf(await call(handle, UPDATE_PATH, { profile: 'desktop', name: PLUGIN, version: '0.15.2' }))
    expect(body.stillBundle).toBe(true)
    expect(body.droppedFromBundles).toEqual([])
    const manifest = JSON.parse(readFileSync(join(home, 'profiles', 'desktop', 'package.json'), 'utf8')) as {
      dsh: { profile: { bundles: string[] } }
    }
    expect(manifest.dsh.profile.bundles).toEqual([BUILTIN, PLUGIN])
  })

  it('treats a run that exited 1 as installed when the version asked for is on disk', async () => {
    // `pnpm add` exits 1 with ERR_PNPM_IGNORED_BUILDS while installing
    // correctly, on every profile whose `pnpm-workspace.yaml` names no
    // `allowBuilds` — which is every profile this shell seeds. Reading the exit
    // status as the outcome reported a finished install as a failure.
    const home = stageHome({
      desktop: {
        dependencies: { [PLUGIN]: '0.14.0' },
        bundles: [PLUGIN],
        installed: { [PLUGIN]: true },
      },
    })
    const { handle } = await start(home, {
      run: () => ({ code: 1, signal: null, stdout: 'Packages: +1 -3', stderr: '[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: node-pty@1.1.0' }),
    })
    const body = await jsonOf(await call(handle, UPDATE_PATH, { profile: 'desktop', name: PLUGIN, version: '0.15.2' }))
    expect(body.installedVersion).toBe('0.15.2')
    expect(body.stillBundle).toBe(true)
    // The status is still reported, so a caller can say what pnpm complained about.
    expect(body.exitCode).toBe(1)
    expect(body.stderr).toContain('ERR_PNPM_IGNORED_BUILDS')
  })

  it('drops the bundle entry on that same exit-1 install when the package stopped being one', async () => {
    const home = stageHome({
      desktop: { dependencies: { [PLUGIN]: '0.14.0' }, bundles: [BUILTIN, PLUGIN], installed: { [PLUGIN]: false } },
    })
    const { handle } = await start(home, { run: () => ({ code: 1, signal: null, stdout: '', stderr: 'ERR_PNPM_IGNORED_BUILDS' }) })
    const body = await jsonOf(await call(handle, UPDATE_PATH, { profile: 'desktop', name: PLUGIN, version: '0.15.2' }))
    expect(body.droppedFromBundles).toEqual([PLUGIN])
    const manifest = JSON.parse(readFileSync(join(home, 'profiles', 'desktop', 'package.json'), 'utf8')) as {
      dsh: { profile: { bundles: string[] } }
    }
    expect(manifest.dsh.profile.bundles).toEqual([BUILTIN])
  })

  it('reports no installed version when nothing readable is on disk', async () => {
    const home = stageHome({ desktop: { dependencies: { [PLUGIN]: '0.14.0' }, bundles: [PLUGIN] } })
    const { handle } = await start(home)
    const body = await jsonOf(await call(handle, UPDATE_PATH, { profile: 'desktop', name: PLUGIN, version: '0.15.2' }))
    expect(body.installedVersion).toBeNull()
    expect(body.stillBundle).toBeNull()
    expect(body.droppedFromBundles).toEqual([])
  })

  it('checks nothing when the version asked for is not the one on disk', async () => {
    const home = stageHome({
      desktop: {
        dependencies: { [PLUGIN]: '0.14.0' },
        bundles: [PLUGIN],
        installed: { [PLUGIN]: false },
        versions: { [PLUGIN]: '0.14.0' },
      },
    })
    const { handle } = await start(home, { run: () => ({ code: 1, signal: null, stdout: '', stderr: 'ERR_PNPM_FETCH_404' }) })
    const body = await jsonOf(await call(handle, UPDATE_PATH, { profile: 'desktop', name: PLUGIN, version: '0.15.2' }))
    expect(body.installedVersion).toBe('0.14.0')
    expect(body.exitCode).toBe(1)
    expect(body.stillBundle).toBeNull()
    const manifest = JSON.parse(readFileSync(join(home, 'profiles', 'desktop', 'package.json'), 'utf8')) as {
      dsh: { profile: { bundles: string[] } }
    }
    expect(manifest.dsh.profile.bundles).toEqual([PLUGIN])
  })
})

describe('the relaunch', () => {
  it('asks before it restarts, and answers before it does', async () => {
    const { handle, recorded } = await start(stageOrdinaryHome())
    const body = await jsonOf(await call(handle, RELAUNCH_PATH, {}))
    expect(body.confirmed).toBe(true)
    expect(recorded.asked[0]?.message).toBe('重启应用以完成更新？')
    expect(recorded.asked[0]?.confirmLabel).toBe('重启')
    expect(recorded.relaunches).toBe(1)
  })

  it('restarts nothing when the person says later', async () => {
    const { handle, recorded } = await start(stageOrdinaryHome(), { confirm: false })
    expect((await jsonOf(await call(handle, RELAUNCH_PATH, {}))).confirmed).toBe(false)
    expect(recorded.relaunches).toBe(0)
  })

  it('still needs the token', async () => {
    const { handle, recorded } = await start(stageOrdinaryHome())
    const response = await fetch(`${handle.endpoint}${RELAUNCH_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(response.status).toBe(401)
    expect(recorded.relaunches).toBe(0)
  })
})

describe('where pnpm comes from', () => {
  it('runs the shipped copy under the bundled Node in a packaged application', () => {
    const launcher = resolvePnpmLauncher({ packaged: true, resourcesPath: '/Apps/DSH.app/Contents/Resources', nodeBin: '/Apps/DSH.app/Contents/Resources/runtime/node' })
    expect(launcher.command).toBe('/Apps/DSH.app/Contents/Resources/runtime/node')
    expect(launcher.prefixArgs).toEqual([join('/Apps/DSH.app/Contents/Resources', 'runtime', 'pnpm', 'bin', 'pnpm.mjs')])
  })

  it('falls back to the developer\'s own pnpm in a source launch, which ships no copy', () => {
    expect(resolvePnpmLauncher({ packaged: false, resourcesPath: '/unused', nodeBin: 'node' }))
      .toEqual({ command: 'pnpm', prefixArgs: [] })
  })
})
