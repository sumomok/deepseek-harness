/**
 * Desktop packaging pipeline. Stages the embedded server by `pnpm deploy` of
 * the apps/desktop-server manifest (the python/sdk-runtime staging recipe:
 * legacy hoisted deploy, restore hoists the legacy deployer leaves behind,
 * materialize every symlink), stages a real Node runtime per platform, then
 * runs electron-builder for the requested targets.
 *
 * Products land in apps/desktop/dist-app/. Each platform's build runs on its
 * own host and on any other: NSIS needs no wine, so Windows packages cross-build
 * from macOS, and they carry the win32-x64 N-API prebuilds either way. A
 * cross-built Windows package is structurally verified only and still has to be
 * smoke-tested on a real Windows machine; building on Windows is what lets that
 * smoke test happen against the package just built.
 *
 * Usage: pnpm --filter @deepseek-ai/dsh-desktop run package [--mac] [--win]
 *        [--skip-repo-build] [--skip-deploy]
 */

import { spawn } from 'node:child_process'
import { createWriteStream, existsSync } from 'node:fs'
import { chmod, copyFile, cp, lstat, mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { bundleClosure } from './bundle-closure.ts'
import { verifyNsisIntegrity } from './nsis-integrity.ts'

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

/**
 * Resolve a bare command name against PATH the way the shell would.
 *
 * Windows has no executable bit: what makes a file runnable is its extension
 * being in PATHEXT, and `pnpm`/`npm`/`npx` install as `.cmd` shims with no
 * extensionless twin. `spawn` without `shell: true` does no PATHEXT expansion,
 * so `spawn('pnpm', …)` is ENOENT on Windows however well pnpm is installed.
 * `shell: true` would fix that by handing the line to cmd.exe, which then owns
 * the quoting of every argument — staging paths here contain spaces. Resolving
 * the name to a concrete file instead keeps argument passing verbatim.
 *
 * PATHEXT candidates come before the bare name: pnpm ships both `pnpm.cmd` and
 * an extensionless POSIX shell script in the same directory, and only the
 * former is something CreateProcess can start.
 *
 * Returns the command unchanged off Windows, when it is already a path, and
 * when nothing on PATH matches — the last so the caller still gets spawn's own
 * ENOENT rather than a message invented here.
 */
function resolveCommand(command: string): string {
  if (process.platform !== 'win32') return command
  if (command.includes(sep) || command.includes('/')) return command
  const extensions = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  for (const directory of (process.env.PATH ?? '').split(';').filter(Boolean)) {
    for (const extension of [...extensions, '']) {
      const candidate = join(directory, `${command}${extension}`)
      if (existsSync(candidate)) return candidate
    }
  }
  return command
}

/**
 * Wrap a `.cmd`/`.bat` shim in the `cmd.exe` invocation that can start it.
 *
 * Node refuses to spawn a batch file directly since the CVE-2024-27980 fix and
 * fails with `EINVAL`: the file is a script only the command interpreter can
 * run, and passing argv to an interpreter is what the vulnerability was about.
 * `shell: true` is Node's own answer, but it joins argv with single spaces and
 * quotes nothing, so any argument with a space arrives split. Building the
 * command line here and setting `windowsVerbatimArguments` keeps that quoting
 * exact and stops Node from quoting the finished line a second time.
 *
 * `/d` skips AutoRun commands from the registry, which would otherwise run
 * inside every build step; `/s` makes cmd.exe strip exactly the outer quote
 * pair and take the rest verbatim, which is why the whole line is wrapped.
 */
function batchInvocation(file: string, args: string[]): { command: string; args: string[] } {
  const quote = (value: string): string =>
    /[\s&|<>^"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
  const line = [file, ...args].map(quote).join(' ')
  return { command: process.env.COMSPEC ?? 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`] }
}

/** Run one subprocess with inherited stdio from the repo root; non-zero exit throws. */
async function run(label: string, command: string, args: string[], cwd: string = ROOT): Promise<void> {
  console.log(`package: ${label}: ${[command, ...args].join(' ')}`)
  const resolved = resolveCommand(command)
  const isBatch = /\.(?:cmd|bat)$/i.test(resolved)
  const invocation = isBatch ? batchInvocation(resolved, args) : { command: resolved, args }
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd,
      stdio: 'inherit',
      env: { ...process.env, CI: 'true' },
      windowsVerbatimArguments: isBatch,
    })
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
}

/**
 * Boot one staged tree, wait for its URL line, fetch the index, tear it down.
 * Plugins load through the Loader at boot, not at launcher import, so only a
 * real `web --port 0` round-trip proves a payload is complete. Run against
 * the macOS pruned payload it doubles as the gate on the shared prune rules.
 * @param root - the staged server tree to boot.
 */
async function verifyStagedBoot(root: string): Promise<void> {
  const child = spawn(process.execPath, [join(root, SERVER_ENTRY), 'web', '--port', '0'], {
    cwd: root,
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

/** Per-target pruned payloads staged beside the full server tree. */
const SERVER_PAYLOADS = { darwin: join(STAGING, 'server-mac'), win: join(STAGING, 'server-win') } as const
type PayloadTarget = keyof typeof SERVER_PAYLOADS

/**
 * Non-runtime file suffixes pruned from every payload. Types, sources, source
 * maps, debug symbols, and docs are the bulk of the tree's file count and its
 * deepest paths (`lib/types/**`), and a node_modules forest inside an NSIS
 * installer pays for every file twice on Windows: per-file extraction under
 * antivirus scanning, and the 260-character MAX_PATH ceiling.
 */
const PRUNE_SUFFIXES = ['.map', '.pdb', '.ts', '.mts', '.cts', '.tsbuildinfo']

/**
 * Markdown is pruned only when the basename is a documentation name: shipped
 * config trees carry runtime markdown (agent-preset `SKILL.md` instruction
 * files), and deleting those is a behavior bug, not a size win.
 */
const DOC_MARKDOWN =
  /^(readme|changelog|history|security|contributing|code_of_conduct|governance|authors|maintainers|backers|sponsors)\b|\.zh\.md$/i

/**
 * The bilingual pairing record that sits beside every README in this
 * workspace. It is documentation metadata — git blob hashes for the doc-sync
 * gate — and 190 copies of it ride into the payload because `files` lists the
 * README and pnpm deploy takes the package as published. Nothing at runtime
 * reads one, and the install pays for each by file rather than by byte.
 */
const DOC_SIDECAR = /^readme(\.[a-z-]+)?\.i18n\.yaml$/i

/** Platform-split artifact directories, relative to node_modules: keep only the target's. */
const PLATFORM_DIR_RULES: Record<PayloadTarget, { parent: string; keep: (name: string) => boolean }[]> = {
  win: [
    { parent: join('node-pty', 'prebuilds'), keep: name => name === 'win32-x64' },
    { parent: '@img', keep: name => !name.includes('darwin') && !name.includes('linux') },
    { parent: '@koromix', keep: name => !name.startsWith('koffi-') || name === 'koffi-win32-x64' },
    { parent: join('@vscode', 'ripgrep'), keep: name => name !== 'bin' },
    { parent: '.', keep: name => !name.startsWith('node-addon-require-builtin-') || name === 'node-addon-require-builtin-win32-x64-msvc' },
  ],
  darwin: [
    { parent: join('node-pty', 'prebuilds'), keep: name => name === `darwin-${process.arch}` },
    { parent: '@img', keep: name => !name.includes('win32') && !name.includes('linux') },
    { parent: '@koromix', keep: name => !name.startsWith('koffi-') || name === `koffi-darwin-${process.arch}` },
    { parent: '.', keep: name => !name.startsWith('node-addon-require-builtin-') || name.startsWith(`node-addon-require-builtin-darwin-${process.arch}`) },
  ],
}

/**
 * Derive one target's pruned server payload from the verified full staging:
 * copy everything except the other platforms' artifact directories and
 * non-runtime file suffixes, then report counts and the longest relative path
 * (the install prefix adds ~50 characters ahead of Windows' 260 limit). The
 * macOS payload goes through a full boot afterwards, which is what proves the
 * shared suffix rules cut no runtime content.
 * @param target - which platform's payload to derive.
 */
async function deriveServerPayload(target: PayloadTarget): Promise<void> {
  const destination = SERVER_PAYLOADS[target]
  await rm(destination, { recursive: true, force: true })
  const nodeModulesPrefix = join(SERVER_STAGING, 'node_modules') + sep
  const skippedDirs: string[] = []
  let pruned = 0
  const filter = (source: string): boolean => {
    const name = source.slice(source.lastIndexOf(sep) + 1)
    if (source.startsWith(nodeModulesPrefix)) {
      const parentRel = dirname(source.slice(nodeModulesPrefix.length))
      for (const rule of PLATFORM_DIR_RULES[target]) {
        if (parentRel === rule.parent && !rule.keep(name)) {
          skippedDirs.push(join(parentRel, name))
          return false
        }
      }
    }
    const lower = name.toLowerCase()
    if (PRUNE_SUFFIXES.some(suffix => lower.endsWith(suffix))) {
      pruned += 1
      return false
    }
    if ((lower.endsWith('.md') || lower.endsWith('.markdown')) && DOC_MARKDOWN.test(lower)) {
      pruned += 1
      return false
    }
    if (DOC_SIDECAR.test(basename(lower))) {
      pruned += 1
      return false
    }
    return true
  }
  await cp(SERVER_STAGING, destination, { recursive: true, filter })
  // Collapsing the third-party trees happens here rather than in the package
  // build, so the workspace's publishable artifacts are untouched and only
  // this copy changes. It runs before the payload's own smoke test and before
  // the boot gate, which is what decides whether the result is usable.
  const collapsed = await bundleClosure(destination)
  console.log(`package: ${target} payload bundled: ${String(collapsed.bundled)} entry points, ${String(collapsed.removed)} third-party packages removed`)
  if (collapsed.unbundled.length > 0) {
    console.log(`package: ${target} payload kept unbundled: ${collapsed.unbundled.join(', ')}`)
  }
  const counted = await countFiles(destination)
  console.log(`package: ${target} payload derived: ${String(counted)} files, pruned ${String(pruned)}, dropped platform dirs:\n  ${skippedDirs.sort().join('\n  ')}`)
  let longest = ''
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (path.length > longest.length) longest = path
    }
  }
  await walk(destination)
  const relative = longest.slice(destination.length + 1)
  console.log(`package: ${target} payload longest relative path: ${String(relative.length)} chars`)
  // The binding budget is the installer's own extract staging, not the install
  // directory: the 7z-out directory under %TEMP% is ~48 characters and the
  // payload sits below the app's resources/server (17), so a relative path over
  // ~194 cannot be extracted at all. NSIS is not long-path aware and reports the
  // failure as a busy file, so the margin is worth watching well before it goes.
  if (relative.length > 180) {
    console.log(`package: WARNING — ${String(194 - relative.length)} chars from the installer's MAX_PATH budget:\n  ${relative}`)
  }
  // Resolution smoke on every payload; the host's own payload additionally boots.
  await run(`pruned ${target} payload smoke`, process.execPath, [join(destination, SERVER_ENTRY), '--version'], destination)
}

/** Count regular files under a directory. */
async function countFiles(dir: string): Promise<number> {
  let total = 0
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) total += await countFiles(path)
    else total += 1
  }
  return total
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

  const derived = new Set<PayloadTarget>()
  const derivePayloadOnce = async (target: PayloadTarget): Promise<void> => {
    if (derived.has(target)) return
    await deriveServerPayload(target)
    derived.add(target)
  }

  // One payload always derives and fully boots, and it is the one this host can
  // run: both payloads share the prune rules, so either proves pruning cut no
  // runtime content. It has to be the host's own — the whole point of pruning
  // is that a darwin payload carries no win32 koffi or node-pty prebuild, so
  // booting it on Windows fails on the missing native module rather than on
  // anything the gate exists to catch.
  const bootGate: PayloadTarget = process.platform === 'win32' ? 'win' : 'darwin'
  await derivePayloadOnce(bootGate)
  await verifyStagedBoot(SERVER_PAYLOADS[bootGate])

  // `--publish never`: the run() helper sets CI=true, and electron-builder
  // treats CI plus a `publish` block as a request to upload. Publishing is
  // scripts/publish-update.ts's job, and the feed's generic provider has no
  // uploader at all, so the build must only ever emit the manifests.
  const builder = ['--filter', '@deepseek-ai/dsh-desktop', 'exec', 'electron-builder', '--config', 'electron-builder.yml', '--publish', 'never']
  if (cli.mac) {
    await stageRuntime('darwin')
    await derivePayloadOnce('darwin')
    await run('electron-builder (mac)', 'pnpm', [...builder, '--mac'])
  }
  if (cli.win) {
    await stageRuntime('win')
    await derivePayloadOnce('win')
    await run('electron-builder (win)', 'pnpm', [...builder, '--win'])
    for (const name of (await readdir(join(APP_DIR, 'dist-app'))).filter(file => file.endsWith('.exe'))) {
      await verifyNsisIntegrity(join(APP_DIR, 'dist-app', name))
    }
  }
  const products = (await readdir(join(APP_DIR, 'dist-app'))).filter(name =>
    name.endsWith('.dmg') || name.endsWith('.zip') || name.endsWith('.exe'))
  console.log(`package: products in apps/desktop/dist-app:\n  ${products.sort().join('\n  ')}`)
}

await main()
