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
  findPackageCopies, findWithheldDirectories, loadFailureLines, missingProductionDependencies, SINGLE_COPY_PACKAGES, singleCopyProblems,
  stagedBootEnv, stagedServerEnv, verifyDesktopLayer, verifyHeldSocketBoot, WITHHELD_PACKAGES,
} from '../scripts/staged-boot-gate.ts'
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

  it('withholds the upstream auto-review bundle', () => {
    expect(WITHHELD_PACKAGES).toContain('@deepseek-ai/dsh-experimental-auto-review')
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
    const root = tree({ [HOISTED]: '@deepseek-ai/cordis', 'node_modules/vendored-framework': '@deepseek-ai/cordis', 'node_modules/cordis': 'cordis' })
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
