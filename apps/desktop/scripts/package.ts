/**
 * Desktop packaging pipeline. Stages the embedded server by `pnpm deploy` of
 * the apps/desktop-server manifest (the python/sdk-runtime staging recipe:
 * legacy hoisted deploy, restore hoists the legacy deployer leaves behind,
 * materialize every symlink), stages a real Node runtime per platform, then
 * runs electron-builder for the requested targets.
 *
 * Products land in apps/desktop/dist-app/. macOS builds run and are testable
 * on this machine; Windows builds are cross-packaged (NSIS needs no wine) and
 * carry the win32-x64 N-API prebuilds — they are structurally verified here
 * but must be smoke-tested on a real Windows machine.
 *
 * Usage: pnpm --filter @deepseek-ai/dsh-desktop run package [--mac] [--win]
 *        [--skip-repo-build] [--skip-deploy]
 */

import { spawn } from 'node:child_process'
import { createWriteStream, existsSync } from 'node:fs'
import { chmod, copyFile, cp, lstat, mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = resolve(APP_DIR, '..', '..')
const STAGING = join(APP_DIR, 'staging')
const SERVER_STAGING = join(STAGING, 'server')
const DEPLOY_ROOT_PACKAGE = '@deepseek-ai/dsh-desktop-server'
const DEPLOY_SOURCE_NODE_MODULES = join(ROOT, 'apps', 'desktop-server', 'node_modules')
const SERVER_ENTRY = join('node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const FRONTEND_DIST_INDEX = join('node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'index.html')
/** Bundled runtime: pinned to the repo's tested Node major (engines ^22.19 || >=24). */
const NODE_VERSION = 'v24.15.0'
const NODE_WIN_X64_URL = `https://nodejs.org/dist/${NODE_VERSION}/win-x64/node.exe`
const CACHE_DIR = join(APP_DIR, '.cache')

interface Cli {
  mac: boolean
  win: boolean
  skipRepoBuild: boolean
  skipDeploy: boolean
}

function parseCli(argv: string[]): Cli {
  const { values } = parseArgs({
    args: argv,
    options: {
      'mac': { type: 'boolean', default: false },
      'win': { type: 'boolean', default: false },
      'skip-repo-build': { type: 'boolean', default: false },
      'skip-deploy': { type: 'boolean', default: false },
    },
  })
  const mac = values.mac || (!values.mac && !values.win && process.platform === 'darwin')
  return { mac, win: values.win, skipRepoBuild: values['skip-repo-build'], skipDeploy: values['skip-deploy'] }
}

/**
 * Snapshot and restore the workspace's pnpm state markers around the deploy:
 * `pnpm deploy --config.node-linker=hoisted --prod` records ITS settings into
 * `node_modules/.pnpm-workspace-state*.json`, after which every later
 * `pnpm exec`/`run` sees a settings mismatch and tries a purging reinstall of
 * the whole workspace. The tree itself is untouched — only the markers lie —
 * so writing the pre-deploy bytes back keeps the checks truthful.
 * @param action - the deploy step to wrap.
 */
async function withWorkspaceStateGuard(action: () => Promise<void>): Promise<void> {
  const nodeModules = join(ROOT, 'node_modules')
  const markers = (await readdir(nodeModules)).filter(name =>
    name === '.modules.yaml' || name.startsWith('.pnpm-workspace-state'))
  const saved = new Map<string, Buffer>()
  for (const name of markers) saved.set(name, await readFile(join(nodeModules, name)))
  try {
    await action()
  } finally {
    for (const [name, content] of saved) await writeFile(join(nodeModules, name), content)
  }
}

/** Run one subprocess with inherited stdio from the repo root; non-zero exit throws. */
async function run(label: string, command: string, args: string[], cwd: string = ROOT): Promise<void> {
  console.log(`package: ${label}: ${[command, ...args].join(' ')}`)
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', env: { ...process.env, CI: 'true' } })
    child.once('error', (error) => { reject(new Error(`package: ${label} failed to spawn: ${error.message}`)) })
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`package: ${label} failed (${code === null ? `signal ${signal ?? 'unknown'}` : `exit ${String(code)}`})`))
    })
  })
}

/**
 * Restore direct dependencies pnpm's legacy deployer hoists beside the deploy
 * source instead of into the target (the build-exe-for-python-sdk recipe).
 */
async function restoreLegacyHoists(): Promise<void> {
  const manifest = JSON.parse(await readFile(join(SERVER_STAGING, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
  }
  for (const dependency of Object.keys(manifest.dependencies ?? {}).sort()) {
    const destination = join(SERVER_STAGING, 'node_modules', dependency)
    if (existsSync(destination)) continue
    const source = join(DEPLOY_SOURCE_NODE_MODULES, dependency)
    if (!existsSync(source)) {
      throw new Error(`package: deployed dependency ${dependency} is absent from both ${destination} and ${source}.`)
    }
    await mkdir(dirname(destination), { recursive: true })
    const nested = join(source, 'node_modules')
    await cp(source, destination, {
      recursive: true,
      dereference: true,
      filter: path => path !== nested && !path.startsWith(nested + sep),
    })
    console.log(`package: restored legacy deploy hoist: ${dependency}`)
  }
}

/** First symlink under a directory, if any. */
async function findSymlink(directory: string): Promise<string | undefined> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) return path
    if (metadata.isDirectory()) {
      const nested = await findSymlink(path)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

/** Replace deploy-time package links with real files (`.bin` links are dropped). */
async function materializeStagedLinks(): Promise<void> {
  const nodeModules = join(SERVER_STAGING, 'node_modules')
  let remaining = await findSymlink(nodeModules)
  while (remaining !== undefined) {
    const segments = remaining.slice(nodeModules.length + 1).split(sep)
    const binIndex = segments.lastIndexOf('.bin')
    if (binIndex >= 0) {
      await rm(join(nodeModules, ...segments.slice(0, binIndex + 1)), { recursive: true, force: true })
      remaining = await findSymlink(nodeModules)
      continue
    }
    const destination = remaining
    const source = await realpath(destination)
    const nested = join(source, 'node_modules')
    await rm(destination, { recursive: true, force: true })
    await cp(source, destination, {
      recursive: true,
      dereference: true,
      filter: path => path !== nested && !path.startsWith(nested + sep),
    })
    remaining = await findSymlink(nodeModules)
  }
}

/**
 * The staged tree must load native modules from their multi-platform N-API
 * prebuilds, never from a build/ tree compiled for this machine.
 */
async function prunePlatformBuilds(): Promise<void> {
  const ptyDir = join(SERVER_STAGING, 'node_modules', 'node-pty')
  await rm(join(ptyDir, 'build'), { recursive: true, force: true })
  for (const platform of ['darwin-arm64', 'darwin-x64']) {
    const helper = join(ptyDir, 'prebuilds', platform, 'spawn-helper')
    if (existsSync(helper)) await chmod(helper, 0o755)
  }
}

/**
 * Report every staged native artifact and fetch the win32-x64 members of
 * platform-split optional-dependency families the macOS install skipped
 * (`node-addon-require-builtin-*` style). Nothing is silently dropped: every
 * fetch and every remaining platform-specific artifact is printed.
 */
async function stageWindowsVariants(): Promise<void> {
  const nodeModules = join(SERVER_STAGING, 'node_modules')
  const packageDirs: string[] = []
  for (const entry of await readdir(nodeModules, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('@')) {
      for (const scoped of await readdir(join(nodeModules, entry.name), { withFileTypes: true })) {
        if (scoped.isDirectory()) packageDirs.push(join(nodeModules, entry.name, scoped.name))
      }
    } else {
      packageDirs.push(join(nodeModules, entry.name))
    }
  }
  const wanted = new Map<string, string>()
  for (const dir of packageDirs) {
    const manifestPath = join(dir, 'package.json')
    if (!existsSync(manifestPath)) continue
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      optionalDependencies?: Record<string, string>
    }
    for (const [dependency, version] of Object.entries(manifest.optionalDependencies ?? {})) {
      const isWin = dependency.includes('win32-x64')
      if (!isWin) continue
      if (existsSync(join(nodeModules, dependency))) continue
      wanted.set(dependency, version)
    }
  }
  for (const [dependency, version] of [...wanted.entries()].sort()) {
    const spec = `${dependency}@${version}`
    console.log(`package: staging Windows variant ${spec}`)
    const packDir = join(CACHE_DIR, 'npm-pack')
    await mkdir(packDir, { recursive: true })
    await run(`npm pack ${spec}`, 'npm', ['pack', spec, '--pack-destination', packDir], APP_DIR)
    const tarball = (await readdir(packDir)).find(name =>
      name === `${dependency.replaceAll('/', '-').replace(/^@/, '')}-${version}.tgz`)
    if (tarball === undefined) throw new Error(`package: npm pack produced no tarball for ${spec}`)
    const destination = join(nodeModules, dependency)
    await rm(destination, { recursive: true, force: true })
    await mkdir(destination, { recursive: true })
    await run(`extract ${tarball}`, 'tar', ['-xzf', join(packDir, tarball), '-C', destination, '--strip-components', '1'], APP_DIR)
  }
  // Full native inventory, so a platform gap is visible in the build log.
  const natives: string[] = []
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.name.endsWith('.node')) natives.push(path.slice(SERVER_STAGING.length + 1))
    }
  }
  await walk(nodeModules)
  console.log(`package: staged native artifacts:\n  ${natives.join('\n  ')}`)
}

/** Stage the bundled Node runtime for one platform. */
async function stageRuntime(platform: 'darwin' | 'win'): Promise<void> {
  const dir = join(STAGING, 'runtime', platform)
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  if (platform === 'darwin') {
    // The build machine's own Node is the tested engines match.
    if (!process.version.startsWith('v24.')) {
      throw new Error(`package: build Node is ${process.version}; the bundled runtime must be the tested v24 line.`)
    }
    await copyFile(process.execPath, join(dir, 'node'))
    await chmod(join(dir, 'node'), 0o755)
    return
  }
  const cached = join(CACHE_DIR, `node-${NODE_VERSION}-win-x64.exe`)
  if (!existsSync(cached)) {
    console.log(`package: downloading ${NODE_WIN_X64_URL}`)
    await mkdir(CACHE_DIR, { recursive: true })
    const response = await fetch(NODE_WIN_X64_URL)
    if (!response.ok || response.body === null) {
      throw new Error(`package: Node runtime download failed: ${String(response.status)} ${response.statusText}`)
    }
    await pipeline(Readable.fromWeb(response.body), createWriteStream(`${cached}.part`))
    await copyFile(`${cached}.part`, cached)
    await rm(`${cached}.part`)
  }
  await copyFile(cached, join(dir, 'node.exe'))
}

/** Verify the staged server answers the packaged layout's launch contract. */
async function verifyStaging(): Promise<void> {
  for (const required of [SERVER_ENTRY, FRONTEND_DIST_INDEX]) {
    const path = join(SERVER_STAGING, required)
    if (!existsSync(path)) {
      throw new Error(`package: staged server is missing ${required} — run without --skip-repo-build/--skip-deploy.`)
    }
  }
  const pty = join(SERVER_STAGING, 'node_modules', 'node-pty', 'prebuilds')
  if (!existsSync(pty)) throw new Error('package: staged node-pty has no prebuilds directory.')
  console.log(`package: staged prebuild platforms: ${(await readdir(pty)).sort().join(', ')}`)
  // Resolution smoke on the staged tree: `--version` imports the launcher
  // graph, so a package the deployer dropped (a link: override the manifest
  // forgot to list directly) fails the build here instead of on first launch.
  await run('staged launcher smoke', process.execPath, [join(SERVER_STAGING, SERVER_ENTRY), '--version'], SERVER_STAGING)
  // Full boot of the staged server: plugins load through the Loader at boot,
  // not at launcher import, so only a real `web --port 0` round-trip proves
  // the deployed closure is complete. The JS tree is shared across target
  // platforms; only the native prebuild selection differs.
  await verifyStagedBoot()
}

/** Boot the staged server once, wait for its URL line, fetch the index, tear it down. */
async function verifyStagedBoot(): Promise<void> {
  const child = spawn(process.execPath, [join(SERVER_STAGING, SERVER_ENTRY), 'web', '--port', '0'], {
    cwd: SERVER_STAGING,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let collected = ''
  try {
    const url = await new Promise<string>((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`package: staged boot printed no URL line in 90s.\n${collected.split('\n').slice(-20).join('\n')}`))
      }, 90_000)
      const onChunk = (chunk: Buffer): void => {
        collected += chunk.toString()
        const match = /dsh web: (http:\/\/127\.0\.0\.1:\d+)/.exec(collected)
        if (match?.[1] !== undefined) {
          clearTimeout(timer)
          resolvePromise(match[1])
        }
      }
      child.stdout.on('data', onChunk)
      child.stderr.on('data', onChunk)
      child.once('exit', (code) => {
        clearTimeout(timer)
        reject(new Error(`package: staged boot exited (${String(code)}) before its URL line.\n${collected.split('\n').slice(-20).join('\n')}`))
      })
    })
    const response = await fetch(url)
    if (!response.ok || !(await response.text()).includes('__DSH_BOOT__')) {
      throw new Error(`package: staged boot served an unexpected index from ${url}.`)
    }
    console.log(`package: staged boot verified at ${url}`)
  } finally {
    child.kill('SIGTERM')
    await new Promise<void>((resolvePromise) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolvePromise() }, 8_000)
      child.once('exit', () => { clearTimeout(timer); resolvePromise() })
    })
  }
}

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2))
  if (!cli.mac && !cli.win) throw new Error('package: nothing to build — pass --mac and/or --win.')
  if (!cli.skipRepoBuild) await run('repo build', 'pnpm', ['run', 'build'])
  await run('desktop tsc', 'pnpm', ['--filter', '@deepseek-ai/dsh-desktop', 'run', 'build:ts'])
  await run('icons', 'node', [join(APP_DIR, 'scripts', 'gen-desktop-icons.mjs')], APP_DIR)

  if (!cli.skipDeploy) {
    if (SERVER_STAGING === ROOT || ROOT.startsWith(SERVER_STAGING + sep)) {
      throw new Error(`package: refusing to clear staging dir ${SERVER_STAGING}.`)
    }
    await rm(SERVER_STAGING, { recursive: true, force: true })
    await withWorkspaceStateGuard(() => run('deploy server closure', 'pnpm', [
      '--filter', DEPLOY_ROOT_PACKAGE, 'deploy', '--legacy', '--prod',
      '--config.node-linker=hoisted',
      '--config.auto-install-peers=false',
      '--config.link-workspace-packages=true',
      SERVER_STAGING,
    ]))
    await restoreLegacyHoists()
    await materializeStagedLinks()
    await prunePlatformBuilds()
    await stageWindowsVariants()
    await Promise.all(['README.md', 'README.zh.md', 'README.i18n.yaml'].map(name =>
      rm(join(SERVER_STAGING, name), { force: true })))
  }
  await verifyStaging()

  const builder = ['--filter', '@deepseek-ai/dsh-desktop', 'exec', 'electron-builder', '--config', 'electron-builder.yml']
  if (cli.mac) {
    await stageRuntime('darwin')
    await run('electron-builder (mac)', 'pnpm', [...builder, '--mac'])
  }
  if (cli.win) {
    await stageRuntime('win')
    await run('electron-builder (win)', 'pnpm', [...builder, '--win'])
  }
  const products = (await readdir(join(APP_DIR, 'dist-app'))).filter(name =>
    name.endsWith('.dmg') || name.endsWith('.zip') || name.endsWith('.exe'))
  console.log(`package: products in apps/desktop/dist-app:\n  ${products.sort().join('\n  ')}`)
}

await main()
