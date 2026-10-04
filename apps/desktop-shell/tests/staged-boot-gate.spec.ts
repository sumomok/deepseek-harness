/**
 * What the packaging pipeline accepts from a staged server's boot, from its
 * composed profile, and from its listen on a held socket.
 * @module
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  findPackageCopies, findWithheldDirectories, loadFailureLines, missingProductionDependencies, placeholderBundleProblems,
  placeholderManifest, placeholderProblems, RETIRED_GUARD_WARNING, SINGLE_COPY_PACKAGES, singleCopyProblems,
  stagedBootEnv, stagedServerEnv, verifyDesktopLayer, verifyHeldSocketBoot, WITHHELD_PACKAGES, writePlaceholders,
} from '../scripts/staged-boot-gate.ts'
import { PLACEHOLDER_BUNDLES } from '../src/profile-seed.ts'
import { SERVER_LOG_ENV } from '../src/server.ts'

describe('loadFailureLines', () => {
  it('accepts a boot whose stderr carries no load report', () => {
    expect(loadFailureLines('')).toEqual([])
    expect(loadFailureLines('dsh web: http://127.0.0.1:50852/?token=abc\nsome plugin log line\n')).toEqual([])
  })

  it('reports a bundle the Loader skipped', () => {
    const line = 'dsh: skipping profile bundle "@deepseek-ai/dsh-desktop-app": Error: Cannot find package'
    expect(loadFailureLines(`first\n${line}\ndsh web: http://127.0.0.1:1/\n`)).toEqual([line])
  })

  it('reports a plugin row the compatibility check disabled', () => {
    const line = 'dsh: disabling profile plugin row "vision-switch": peer @deepseek-ai/dsh 0.2.0 is outside >=0.1.7-rc.1 <0.2.0-0'
    expect(loadFailureLines(line)).toEqual([line])
  })

  it('reports entries that did not activate, with the entries the warning names after it', () => {
    const stderr = [
      'dsh: warning: 2 entries did not activate',
      'account-controller (@deepseek-ai/dsh-api-account-controller): failed to import',
      'typert-loader (@deepseek-ai/dsh-typert-loader): activation failed',
      'unrelated (@x/y): a later line',
    ].join('\r\n')
    expect(loadFailureLines(stderr)).toEqual([
      'dsh: warning: 2 entries did not activate',
      'account-controller (@deepseek-ai/dsh-api-account-controller): failed to import',
      'typert-loader (@deepseek-ai/dsh-typert-loader): activation failed',
    ])
  })

  it('stops at the first line after the warning that names no entry', () => {
    expect(loadFailureLines('dsh: warning: 1 entry did not activate\ntypert-loader: …')).toEqual([
      'dsh: warning: 1 entry did not activate',
    ])
  })
})

/** A dump in the dialect `--dump-config` prints, with the desktop layer's row composed. */
const COMPOSED = `# == @deepseek-ai/dsh-base
- id: plugin-manager
  name: '@deepseek-ai/dsh-plugin-manager'
  disabled: !!js '!ctx.get(''profileContext'')'
# == @deepseek-ai/dsh-base, patched by @deepseek-ai/dsh-desktop-app
- id: session-query-sqlite
  name: '@deepseek-ai/dsh-session-query-sqlite'
  config:
    path: !!js dshHomePath('session-search/desktop.db')
    openAt: first-search
`

describe('verifyDesktopLayer', () => {
  it('accepts the search row the desktop layer opens at the first search', () => {
    expect(() => { verifyDesktopLayer(COMPOSED) }).not.toThrow()
  })

  it('finds the row inside a group', () => {
    const grouped = `- id: outer
  group: true
  config:
    - id: session-query-sqlite
      config:
        openAt: first-search
`
    expect(() => { verifyDesktopLayer(grouped) }).not.toThrow()
  })

  it('refuses the row the layers below the desktop one leave off', () => {
    expect(() => { verifyDesktopLayer(COMPOSED.replace('openAt: first-search', 'openAt: never')) })
      .toThrow(/openAt "never".*dsh-desktop-app did not reach the profile/)
  })

  it('refuses a disabled row', () => {
    expect(() => { verifyDesktopLayer(`${COMPOSED}  disabled: true\n`) }).toThrow(/disabled true/)
  })

  it('refuses a composition without the row', () => {
    expect(() => { verifyDesktopLayer('- id: timer\n') }).toThrow('has no session-query-sqlite row')
  })

  it('refuses output that is not an entry list', () => {
    expect(() => { verifyDesktopLayer('') }).toThrow('printed no entry list')
  })
})

describe('findWithheldDirectories', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  /**
   * A staged tree holding the given directories and files.
   * @param dirs - directories to create, relative to the root.
   * @param files - files to create, relative to the root.
   * @returns the tree's root.
   */
  function tree(dirs: readonly string[], files: readonly string[] = []): string {
    const root = mkdtempSync(join(tmpdir(), 'staged-boot-gate-'))
    roots.push(root)
    for (const dir of dirs) mkdirSync(join(root, dir), { recursive: true })
    for (const file of files) writeFileSync(join(root, file), '')
    return root
  }

  it('withholds upstream\'s auto-review and inspector bundles and the two plugins only the inspector bundle depends on', () => {
    expect(WITHHELD_PACKAGES).toEqual([
      '@deepseek-ai/dsh-experimental-auto-review', '@deepseek-ai/dsh-experimental-inspector-profile',
      '@deepseek-ai/dsh-experimental-inspector', '@deepseek-ai/dsh-experimental-session-inspector',
    ])
    expect(PLACEHOLDER_BUNDLES).toEqual(['@deepseek-ai/dsh-experimental-auto-review', '@deepseek-ai/dsh-experimental-inspector-profile'])
  })

  const PLACEHELD = 'node_modules/@deepseek-ai/dsh-experimental-auto-review'

  it('passes over the exact top-level placeholder of a placeholder bundle', async () => {
    const root = tree(['node_modules/@deepseek-ai/dsh-base'])
    await writePlaceholders(root, PLACEHOLDER_BUNDLES)
    expect(await findWithheldDirectories(root, WITHHELD_PACKAGES, PLACEHOLDER_BUNDLES)).toEqual([])
  })

  it('finds the placeholder when no placeholders are named', async () => {
    const root = tree([])
    await writePlaceholders(root, PLACEHOLDER_BUNDLES)
    expect(await findWithheldDirectories(root, WITHHELD_PACKAGES)).toEqual([
      PLACEHELD, 'node_modules/@deepseek-ai/dsh-experimental-inspector-profile',
    ])
  })

  it('finds a placeholder-identical copy nested under another package', async () => {
    const nested = `node_modules/@deepseek-ai/dsh/${PLACEHELD}`
    const root = tree([nested])
    writeFileSync(join(root, nested, 'package.json'), placeholderManifest('@deepseek-ai/dsh-experimental-auto-review'))
    await writePlaceholders(root, PLACEHOLDER_BUNDLES)
    expect(await findWithheldDirectories(root, WITHHELD_PACKAGES, PLACEHOLDER_BUNDLES)).toEqual([nested])
  })

  it('finds a top-level placeholder that holds another file beside its manifest', async () => {
    const root = tree([])
    await writePlaceholders(root, PLACEHOLDER_BUNDLES)
    writeFileSync(join(root, PLACEHELD, 'index.js'), '')
    expect(await findWithheldDirectories(root, WITHHELD_PACKAGES, PLACEHOLDER_BUNDLES)).toEqual([PLACEHELD])
  })

  it('finds a top-level placeholder whose manifest differs by one byte, or that holds the real package', async () => {
    const root = tree([`${PLACEHELD}/lib`])
    writeFileSync(join(root, 'node_modules/@deepseek-ai/dsh-experimental-auto-review/package.json'), placeholderManifest('@deepseek-ai/dsh-experimental-auto-review'))
    expect(await findWithheldDirectories(root, WITHHELD_PACKAGES, PLACEHOLDER_BUNDLES)).toEqual([PLACEHELD])
    rmSync(join(root, PLACEHELD, 'lib'), { recursive: true })
    writeFileSync(join(root, PLACEHELD, 'package.json'), `${placeholderManifest('@deepseek-ai/dsh-experimental-auto-review')} `)
    expect(await findWithheldDirectories(root, WITHHELD_PACKAGES, PLACEHOLDER_BUNDLES)).toEqual([PLACEHELD])
  })

  it('finds the plugins withheld without a placeholder at the top level too', async () => {
    const root = tree(['node_modules/@deepseek-ai/dsh-experimental-inspector', 'node_modules/@deepseek-ai/dsh-experimental-session-inspector'])
    writeFileSync(join(root, 'node_modules/@deepseek-ai/dsh-experimental-inspector/package.json'), placeholderManifest('@deepseek-ai/dsh-experimental-inspector'))
    expect(await findWithheldDirectories(root, WITHHELD_PACKAGES, PLACEHOLDER_BUNDLES)).toEqual([
      'node_modules/@deepseek-ai/dsh-experimental-inspector', 'node_modules/@deepseek-ai/dsh-experimental-session-inspector',
    ])
  })

  it('finds nothing in a tree without the package', async () => {
    const root = tree(['node_modules/@deepseek-ai/dsh-base'])
    expect(await findWithheldDirectories(root, WITHHELD_PACKAGES)).toEqual([])
  })

  it('finds the package where the hoisted deploy puts it', async () => {
    const root = tree(['node_modules/@deepseek-ai/dsh-experimental-auto-review/lib'])
    expect(await findWithheldDirectories(root, WITHHELD_PACKAGES))
      .toEqual(['node_modules/@deepseek-ai/dsh-experimental-auto-review'])
  })

  it('finds a copy nested under another package', async () => {
    const root = tree([
      'node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-experimental-auto-review',
      'node_modules/@deepseek-ai/dsh-base',
    ])
    expect(await findWithheldDirectories(root, WITHHELD_PACKAGES))
      .toEqual(['node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-experimental-auto-review'])
  })

  it('ignores a file of that name', async () => {
    const root = tree(['node_modules/@deepseek-ai'], ['node_modules/@deepseek-ai/dsh-experimental-auto-review'])
    expect(await findWithheldDirectories(root, WITHHELD_PACKAGES)).toEqual([])
  })
})

describe('placeholderManifest', () => {
  it('names the package and a version and declares nothing else', () => {
    const text = placeholderManifest('@deepseek-ai/dsh-experimental-auto-review')
    expect(JSON.parse(text)).toEqual({ name: '@deepseek-ai/dsh-experimental-auto-review', version: '0.0.0-withheld' })
    expect(text.endsWith('}\n')).toBe(true)
  })
})

describe('placeholderProblems', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  /** An empty staged tree. */
  function root(): string {
    const dir = mkdtempSync(join(tmpdir(), 'staged-placeholder-'))
    roots.push(dir)
    return dir
  }

  it('accepts the placeholders writePlaceholders wrote', async () => {
    const dir = root()
    await writePlaceholders(dir, PLACEHOLDER_BUNDLES)
    expect(await placeholderProblems(dir, PLACEHOLDER_BUNDLES)).toEqual([])
  })

  it('names a missing placeholder', async () => {
    const dir = root()
    await writePlaceholders(dir, PLACEHOLDER_BUNDLES.slice(1))
    expect(await placeholderProblems(dir, PLACEHOLDER_BUNDLES)).toEqual([
      '@deepseek-ai/dsh-experimental-auto-review: no placeholder at node_modules/@deepseek-ai/dsh-experimental-auto-review',
    ])
  })

  it('names a placeholder with other bytes or another file beside it', async () => {
    const dir = root()
    await writePlaceholders(dir, PLACEHOLDER_BUNDLES)
    writeFileSync(join(dir, 'node_modules/@deepseek-ai/dsh-experimental-auto-review/package.json'), '{"name":"@deepseek-ai/dsh-experimental-auto-review","version":"0.2.1-alpha.1"}\n')
    writeFileSync(join(dir, 'node_modules/@deepseek-ai/dsh-experimental-inspector-profile/cordis.patch.yml'), '')
    expect(await placeholderProblems(dir, PLACEHOLDER_BUNDLES)).toEqual([
      '@deepseek-ai/dsh-experimental-auto-review: node_modules/@deepseek-ai/dsh-experimental-auto-review is not the placeholder this build writes',
      '@deepseek-ai/dsh-experimental-inspector-profile: node_modules/@deepseek-ai/dsh-experimental-inspector-profile is not the placeholder this build writes',
    ])
  })
})

describe('placeholderBundleProblems', () => {
  const refused = { stage: 'enable', target: 'x', enabled: true, changed: false, application: 'failed', error: { code: 'not-bundle' } }
  const enabled = PLACEHOLDER_BUNDLES.map(name => ({ name, result: { ...refused, target: name } }))

  it('accepts a list without the withheld packages and a not-bundle refusal for each placeholder', () => {
    expect(placeholderBundleProblems([{ name: '@deepseek-ai/dsh-base' }, { name: '@haoran/dsh-btw' }], enabled)).toEqual([])
  })

  it('names a listed withheld package', () => {
    expect(placeholderBundleProblems([{ name: '@deepseek-ai/dsh-base' }, { name: '@deepseek-ai/dsh-experimental-inspector-profile' }], enabled))
      .toEqual(['listBundles lists the withheld @deepseek-ai/dsh-experimental-inspector-profile'])
  })

  it('refuses an empty or malformed list, which would prove nothing', () => {
    expect(placeholderBundleProblems([], enabled)).toEqual(['listBundles returned no bundles: []'])
    expect(placeholderBundleProblems(undefined, enabled)).toEqual(['listBundles returned no bundles: undefined'])
  })

  it('names an enable that was not refused as not-bundle, or that changed a file', () => {
    const resolveFailure = { ...refused, error: { code: 'operation-error', diagnostic: 'dsh: cannot resolve profile bundle' } }
    const changed = { ...refused, changed: true }
    const [autoReview, inspector] = PLACEHOLDER_BUNDLES as [string, string]
    expect(placeholderBundleProblems([{ name: '@deepseek-ai/dsh-base' }], [
      { name: autoReview, result: resolveFailure }, { name: inspector, result: changed },
    ])).toEqual([
      `setBundleEnabled(${autoReview}, true) was not refused as not-bundle without a change: ${JSON.stringify(resolveFailure)}`,
      `setBundleEnabled(${inspector}, true) was not refused as not-bundle without a change: ${JSON.stringify(changed)}`,
    ])
  })
})

describe('RETIRED_GUARD_WARNING', () => {
  it('is the warning the loader prints for an auto-review row no layer inserts', () => {
    expect(RETIRED_GUARD_WARNING).toBe('patch: entry "auto-review" not found')
  })
})

describe('singleCopyProblems', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  /**
   * A staged tree holding a `package.json` with the given name in each directory.
   * @param packages - directory relative to the root, mapped to the package name its manifest declares.
   * @returns the tree's root.
   */
  function tree(packages: Readonly<Record<string, string>>): string {
    const root = mkdtempSync(join(tmpdir(), 'staged-single-copy-'))
    roots.push(root)
    for (const [dir, name] of Object.entries(packages)) {
      mkdirSync(join(root, dir), { recursive: true })
      writeFileSync(join(root, dir, 'package.json'), JSON.stringify({ name, version: '4.0.5-alpha.1' }))
    }
    return root
  }

  const HOISTED = 'node_modules/@deepseek-ai/cordis'

  it('requires one copy of cordis', () => {
    expect(SINGLE_COPY_PACKAGES).toContain('@deepseek-ai/cordis')
  })

  it('accepts the one copy the hoisted deploy places at the top level', async () => {
    const root = tree({ [HOISTED]: '@deepseek-ai/cordis', 'node_modules/@deepseek-ai/schemastery': '@deepseek-ai/schemastery' })
    expect(await singleCopyProblems(root, SINGLE_COPY_PACKAGES)).toEqual([])
  })

  it('refuses a second copy nested under a plugin', async () => {
    const nested = 'node_modules/@haoran/dsh-screenshot/node_modules/@deepseek-ai/cordis'
    const root = tree({ [HOISTED]: '@deepseek-ai/cordis', [nested]: '@deepseek-ai/cordis' })
    expect(await singleCopyProblems(root, SINGLE_COPY_PACKAGES)).toEqual([`@deepseek-ai/cordis: 2 copies: ${HOISTED}, ${nested}`])
  })

  it('refuses a second copy in a pnpm store entry', async () => {
    const store = 'node_modules/.pnpm/@deepseek-ai+cordis@4.0.3/node_modules/@deepseek-ai/cordis'
    const root = tree({ [HOISTED]: '@deepseek-ai/cordis', [store]: '@deepseek-ai/cordis' })
    expect(await singleCopyProblems(root, SINGLE_COPY_PACKAGES)).toEqual([`@deepseek-ai/cordis: 2 copies: ${store}, ${HOISTED}`])
  })

  it('refuses a tree without cordis', async () => {
    const root = tree({ 'node_modules/@deepseek-ai/dsh': '@deepseek-ai/dsh' })
    expect(await singleCopyProblems(root, SINGLE_COPY_PACKAGES)).toEqual(['@deepseek-ai/cordis: no copy'])
  })

  it('counts a copy by its manifest name, not its directory name', async () => {
    const sameDirName = 'node_modules/@haoran/dsh-btw/node_modules/@deepseek-ai/cordis'
    const root = tree({ [HOISTED]: '@deepseek-ai/cordis', 'node_modules/vendored-framework': '@deepseek-ai/cordis', [sameDirName]: '@deepseek-ai/cordis-plugin-timer' })
    expect(await findPackageCopies(root, '@deepseek-ai/cordis')).toEqual([HOISTED, 'node_modules/vendored-framework'])
  })

  it('does not count a symbolic link to the copy', async () => {
    const root = tree({ [HOISTED]: '@deepseek-ai/cordis' })
    mkdirSync(join(root, 'node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'), { recursive: true })
    symlinkSync(join(root, HOISTED), join(root, 'node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/cordis'), 'dir')
    expect(await singleCopyProblems(root, SINGLE_COPY_PACKAGES)).toEqual([])
  })

  it('names a manifest that mentions the package and is not JSON', async () => {
    const root = tree({ [HOISTED]: '@deepseek-ai/cordis' })
    mkdirSync(join(root, 'node_modules/broken'), { recursive: true })
    writeFileSync(join(root, 'node_modules/broken/package.json'), '{"name": "@deepseek-ai/cordis",')
    await expect(findPackageCopies(root, '@deepseek-ai/cordis')).rejects.toThrow(/node_modules\/broken\/package\.json is not valid JSON/)
  })
})

describe('verifyStaging in package.ts', () => {
  const source = readFileSync(new URL('../scripts/package.ts', import.meta.url), 'utf8')
  const start = source.indexOf('async function verifyStaging(): Promise<void> {')
  const body = source.slice(start, source.indexOf('\n}\n', start))

  it('runs on every package run, --skip-deploy included', () => {
    expect(source).toContain('\n  await stagePnpmLaunchers(PNPM_LAUNCHER_STAGING)\n  await verifyStaging()\n')
  })

  it('throws when the staged server carries a withheld package directory', () => {
    expect(start).toBeGreaterThan(-1)
    expect(body).toContain([
      'const withheld = await findWithheldDirectories(SERVER_STAGING, WITHHELD_PACKAGES, PLACEHOLDER_BUNDLES)',
      '  if (withheld.length > 0) {',
      '    throw new Error(',
    ].join('\n'))
  })

  it('throws when the staged server does not carry the exact placeholder of each placeholder bundle', () => {
    expect(start).toBeGreaterThan(-1)
    expect(body).toContain([
      'const placeholders = await placeholderProblems(SERVER_STAGING, PLACEHOLDER_BUNDLES)',
      '  if (placeholders.length > 0) {',
      '    throw new Error(',
    ].join('\n'))
  })

  it('throws when the staged server does not carry exactly one copy of each single-copy package', () => {
    expect(start).toBeGreaterThan(-1)
    expect(body).toContain([
      'const duplicated = await singleCopyProblems(SERVER_STAGING, SINGLE_COPY_PACKAGES)',
      '  if (duplicated.length > 0) {',
      '    throw new Error(',
    ].join('\n'))
  })
})

describe('verifyStagedBoot in package.ts', () => {
  const source = readFileSync(new URL('../scripts/package.ts', import.meta.url), 'utf8')
  const start = source.indexOf('async function verifyStagedBoot(')
  const body = source.slice(start, source.indexOf('\n}\n', start))

  it('asks the booted server\'s plugin manager about the withheld bundles before stopping it', () => {
    expect(start).toBeGreaterThan(-1)
    expect(body).toContain('    await verifyPlaceholderBundles(base, cookie)\n')
    expect(body.indexOf('await verifyPlaceholderBundles(base, cookie)')).toBeLessThan(body.indexOf("child.kill('SIGTERM')"))
  })

  it('throws when the boot output or the dump\'s stderr reports the retired auto-review row', () => {
    expect(body).toContain([
      "const guardWarnings = [...collected.split('\\n'), ...dump.stderr.split('\\n')].filter(line => line.includes(RETIRED_GUARD_WARNING))",
      '  if (guardWarnings.length > 0) {',
      '    throw new Error(',
    ].join('\n'))
  })
})

describe('stagedServerEnv', () => {
  // Named, the desktop layer's server-log row mounts in the staged boot and
  // its module has to resolve from the payload, as it does under the shell.
  it('names the log file the server-log row mounts on, over the package-manager-free environment', () => {
    expect(stagedServerEnv({ NODE_PATH: '/repo/node_modules', PATH: '/usr/bin' }, '/tmp/build/dsh-server.log'))
      .toEqual({ PATH: '/usr/bin', [SERVER_LOG_ENV]: '/tmp/build/dsh-server.log' })
  })
})

describe('stagedBootEnv', () => {
  it('drops what pnpm and npm injected, NODE_PATH first', () => {
    expect(stagedBootEnv({
      NODE_PATH: '/repo/node_modules/.pnpm/node_modules',
      npm_config_user_agent: 'pnpm/11.7.0',
      npm_lifecycle_event: 'package',
      PNPM_SCRIPT_SRC_DIR: '/repo/apps/desktop-shell',
      pnpm_config_verify_deps_before_run: 'install',
      PATH: '/usr/bin',
      DSH_HOME: '/tmp/dsh-desktop-build-x',
      NODE_OPTIONS: '--max-old-space-size=4096',
    })).toEqual({ PATH: '/usr/bin', DSH_HOME: '/tmp/dsh-desktop-build-x', NODE_OPTIONS: '--max-old-space-size=4096' })
  })

  it('keeps names that only contain the prefixes', () => {
    expect(stagedBootEnv({ MY_NODE_PATH: 'x', XNPM_TOKEN: 'y' })).toEqual({ MY_NODE_PATH: 'x', XNPM_TOKEN: 'y' })
  })
})

describe('missingProductionDependencies', () => {
  const trees: string[] = []
  afterEach(() => {
    for (const tree of trees.splice(0)) rmSync(tree, { recursive: true, force: true })
  })

  /** What one fixture package declares. */
  interface Declared { dependencies?: string[]; optional?: string[]; peers?: string[]; optionalPeers?: string[] }

  /**
   * A tree of packages, each with its own production dependencies.
   * @param packages - `node_modules`-relative directory against the dependencies its manifest declares.
   * @returns the tree root.
   */
  function tree(packages: Record<string, Declared>): string {
    const root = mkdtempSync(join(tmpdir(), 'staged-closure-'))
    trees.push(root)
    for (const [dir, { dependencies = [], optional = [], peers = [], optionalPeers = [] }] of Object.entries(packages)) {
      mkdirSync(join(root, 'node_modules', dir), { recursive: true })
      writeFileSync(join(root, 'node_modules', dir, 'package.json'), JSON.stringify({
        name: dir.split('/node_modules/').at(-1),
        dependencies: Object.fromEntries(dependencies.map(name => [name, '*'])),
        optionalDependencies: Object.fromEntries(optional.map(name => [name, '*'])),
        peerDependencies: Object.fromEntries([...peers, ...optionalPeers].map(name => [name, '*'])),
        peerDependenciesMeta: Object.fromEntries(optionalPeers.map(name => [name, { optional: true }])),
      }))
    }
    return root
  }

  const whole = {
    '@deepseek-ai/dsh': { dependencies: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-experimental-auto-review', 'yaml'], optional: ['some-darwin-arm64'] },
    '@deepseek-ai/dsh-base': { dependencies: ['@deepseek-ai/dsh-settings'] },
    '@deepseek-ai/dsh-settings': { dependencies: ['yaml', 'nested-only'], peers: ['@deepseek-ai/dsh-protocol'], optionalPeers: ['@deepseek-ai/dsh-maybe'] },
    '@deepseek-ai/dsh-protocol': { peers: ['@deepseek-ai/cordis'] },
    '@deepseek-ai/cordis': {},
    '@deepseek-ai/dsh-settings/node_modules/nested-only': {},
    'yaml': {},
  }

  it('accepts a tree holding the whole closure, nested and withheld packages included', async () => {
    expect(await missingProductionDependencies(tree(whole), WITHHELD_PACKAGES)).toEqual([])
  })

  it('names a missing dependency found only through another dependency', async () => {
    const { '@deepseek-ai/dsh-base': _base, ...withoutBase } = whole
    expect(await missingProductionDependencies(tree(withoutBase), WITHHELD_PACKAGES)).toEqual(['@deepseek-ai/dsh -> @deepseek-ai/dsh-base'])
    const { '@deepseek-ai/dsh-settings/node_modules/nested-only': _nested, ...withoutNested } = whole
    expect(await missingProductionDependencies(tree(withoutNested), WITHHELD_PACKAGES))
      .toEqual(['@deepseek-ai/dsh-settings -> nested-only'])
  })

  it('names a missing required peer, and follows a present one', async () => {
    const { '@deepseek-ai/dsh-protocol': _protocol, ...withoutPeer } = whole
    expect(await missingProductionDependencies(tree(withoutPeer), WITHHELD_PACKAGES))
      .toEqual(['@deepseek-ai/dsh-settings -> @deepseek-ai/dsh-protocol (peer)'])
    const { '@deepseek-ai/cordis': _cordis, ...withoutPeersPeer } = whole
    expect(await missingProductionDependencies(tree(withoutPeersPeer), WITHHELD_PACKAGES))
      .toEqual(['@deepseek-ai/dsh-protocol -> @deepseek-ai/cordis (peer)'])
  })

  it('follows only the names it is given', async () => {
    const { yaml: _yaml, ...withoutYaml } = whole
    expect(await missingProductionDependencies(tree(withoutYaml), WITHHELD_PACKAGES, name => name.startsWith('@deepseek-ai/'))).toEqual([])
    expect(await missingProductionDependencies(tree(withoutYaml), WITHHELD_PACKAGES)).toEqual([
      '@deepseek-ai/dsh -> yaml', '@deepseek-ai/dsh-settings -> yaml',
    ])
  })

  it('reports a tree without the installation package', async () => {
    expect(await missingProductionDependencies(tree({ yaml: {} }), WITHHELD_PACKAGES)).toEqual(['(tree) -> @deepseek-ai/dsh'])
  })
})

describe('verifyHeldSocketBoot', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  /**
   * A stand-in server entry in a fresh directory, booted with the real preload.
   * Each boot appends one line to `boots.log` in that directory and answers
   * every request with the status `statuses` gives for its boot, 401 past the
   * end of the list.
   * @param listen - the source of its listen call, with `port` and `server` in scope.
   * @param statuses - the answer's status for each boot, in order.
   * @returns the launch, and the file its boots are counted in.
   */
  function bootOf(listen: string, statuses: readonly number[] = []): { boot: Parameters<typeof verifyHeldSocketBoot>[0]; boots: string } {
    const root = mkdtempSync(join(tmpdir(), 'dsh-held-boot-'))
    roots.push(root)
    const entry = join(root, 'entry.mjs')
    const boots = join(root, 'boots.log')
    writeFileSync(entry, `
      import { appendFileSync, readFileSync } from 'node:fs'
      import http from 'node:http'
      appendFileSync(${JSON.stringify(boots)}, 'boot\\n')
      const boot = readFileSync(${JSON.stringify(boots)}, 'utf8').split('\\n').filter(Boolean).length
      const status = ${JSON.stringify(statuses)}[boot - 1] ?? 401
      const port = Number(process.argv[process.argv.indexOf('--port') + 1])
      const server = http.createServer((req, res) => { res.writeHead(status); res.end() })
      const announce = () => { console.log('dsh web: http://127.0.0.1:' + server.address().port + '/?token=t') }
      ${listen}
    `)
    return {
      boot: {
        nodeBin: process.execPath, entry, cwd: root, reportDirectory: root, env: {},
        preload: fileURLToPath(new URL('../src/listen-handoff.mts', import.meta.url)),
      },
      boots,
    }
  }

  it('accepts a server that listens the way the web server does, twice on one socket', async () => {
    const { boot, boots } = bootOf('server.listen(port, \'127.0.0.1\', announce)')
    expect(await verifyHeldSocketBoot(boot)).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u)
    expect(readFileSync(boots, 'utf8')).toBe('boot\nboot\n')
  })

  it('fails the build when the second server on the socket answers with an error status', async () => {
    const { boot } = bootOf('server.listen(port, \'127.0.0.1\', announce)', [200, 500])
    await expect(verifyHeldSocketBoot(boot)).rejects.toThrow('the second staged server answered 500 on the held socket')
  })

  it('fails the build when the server listens some other way, with the handoff\'s reason', async () => {
    await expect(verifyHeldSocketBoot(bootOf('server.listen(0, \'127.0.0.1\', announce)').boot))
      .rejects.toThrow('the first staged server did not listen on the held socket: listen handoff failed: the server printed its URL line without listening on the held socket')
  })
})
