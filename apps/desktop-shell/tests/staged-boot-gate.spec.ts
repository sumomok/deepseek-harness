/**
 * What the packaging pipeline accepts from a staged server's boot, from its
 * composed profile, and from its listen on a held socket.
 * @module
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  findWithheldDirectories, loadFailureLines, missingProductionDependencies, stagedBootEnv, stagedServerEnv, verifyDesktopLayer,
  verifyHeldSocketBoot, WITHHELD_PACKAGES,
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
   * @param listen - the source of its listen call, with `port` and `server` in scope.
   * @returns the launch.
   */
  function bootOf(listen: string): Parameters<typeof verifyHeldSocketBoot>[0] {
    const root = mkdtempSync(join(tmpdir(), 'dsh-held-boot-'))
    roots.push(root)
    const entry = join(root, 'entry.mjs')
    writeFileSync(entry, `
      import http from 'node:http'
      const port = Number(process.argv[process.argv.indexOf('--port') + 1])
      const server = http.createServer((req, res) => { res.writeHead(401); res.end() })
      const announce = () => { console.log('dsh web: http://127.0.0.1:' + server.address().port + '/?token=t') }
      ${listen}
    `)
    return {
      nodeBin: process.execPath, entry, cwd: root, reportDirectory: root, env: {},
      preload: fileURLToPath(new URL('../src/listen-handoff.mts', import.meta.url)),
    }
  }

  it('accepts a server that listens the way the web server does, twice on one socket', async () => {
    expect(await verifyHeldSocketBoot(bootOf('server.listen(port, \'127.0.0.1\', announce)'))).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u)
  })

  it('fails the build when the server listens some other way, with the handoff\'s reason', async () => {
    await expect(verifyHeldSocketBoot(bootOf('server.listen(0, \'127.0.0.1\', announce)')))
      .rejects.toThrow('the first staged server did not listen on the held socket: listen handoff failed: the server printed its URL line without listening on the held socket')
  })
})
