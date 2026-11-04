/**
 * electron-builder afterPack hook: finish the packed app directory. Everything
 * here runs after the builder has laid the bundle out and before the dmg/zip/
 * NSIS targets seal it.
 *
 * Both platforms start by copying the staged server closure and the staged
 * package manager into the app's resources. extraResources cannot carry either
 * — the builder's copier hard-excludes node_modules trees, and both trees have
 * one — and `cp -R` preserves the executable bits node-pty's macOS spawn-helper
 * needs (the hook host is always the macOS build machine, for Windows targets
 * too). The platform's pnpm launcher script follows them into `runtime/`.
 * What each platform does next is platform-specific and mutually exclusive.
 *
 * macOS then signs the app (scripts/sign-mac.cjs), which must see the finished
 * bundle: the signature seals every resource, so anything written afterwards
 * would break it. That is why signing is the last thing on this branch and why
 * the branch returns rather than falling through.
 *
 * afterPack, not afterSign: `mac.identity: null` makes the builder's own
 * signing pass a no-op, and `doSignAfterPack` emits `afterSign` only when that
 * pass actually signed something. Nothing modifies the bundle between this hook
 * and the targets — `doAddElectronFuses` returns immediately without an
 * `electronFuses` config, and there is none.
 *
 * On Windows the third-party half of the closure travels as one archive rather
 * than as loose files, and `customInit`'s sibling `customInstall` unpacks it
 * into place. An install's cost is its file count — 98% of the copy is
 * per-file overhead, measured — and the installer pays that count twice, once
 * decompressing into %TEMP% and once copying to the install directory. One
 * archive is one file in both of those passes, so the files are created once
 * instead of twice.
 *
 * Only the third-party half travels this way. This repo's own packages change
 * every release and stay loose, because the update feed's differential
 * download is computed over a 7z built with a 1 MB dictionary — a change
 * invalidates about a dictionary's worth of blocks, which is what keeps a
 * routine update at 1% of the payload. Sealing packages that change every
 * release inside one archive would shift every block after the change and
 * throw that away; sealing dependencies that change only when they are bumped
 * costs nothing on the releases in between.
 */

'use strict'

const { execFileSync } = require('node:child_process')
const { chmodSync, existsSync, readdirSync, rmSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { signMacApp } = require('./sign-mac.cjs')

/** The scope that stays loose: its packages are what a release changes. */
const OURS = '@deepseek-ai'

/**
 * Probe the Node and Electron binaries that actually landed in the bundle.
 *
 * The Node half is runnable on this host for a macOS package; a Windows package
 * cross-built on macOS carries an executable this host cannot start, so only
 * its official digest is checked and the native probe stays pending. The
 * packaged Electron binary runs here only when its target platform is this
 * host. Signing must follow this check so the probe never changes the sealed
 * mac bundle.
 * @param {object} context - electron-builder afterPack context.
 * @param {string} appPath - macOS `.app` path.
 * @param {string} resources - bundle resources directory.
 * @param {boolean} isMac - whether the target is macOS.
 */
async function verifyRuntimeProbe(context, appPath, resources, isMac) {
  const {
    SHELL_ELECTRON_VERSION, WINDOWS_HOST_NODE_SHA256, WINDOWS_HOST_NODE_VERSION,
    assertRuntimeProbe, formatRuntimeProbe, probeRuntimeExecutable, verifyFileSha256,
  } = await import('../../../scripts/runtime-version-gate.mjs')
  const node = join(resources, 'runtime', isMac ? 'node' : 'node.exe')
  if (isMac) {
    const probe = probeRuntimeExecutable(node)
    assertRuntimeProbe(probe, { platform: 'darwin' })
    console.log(`after-pack: bundled Node runtime ${formatRuntimeProbe(probe)}`)
  } else {
    verifyFileSha256(node, WINDOWS_HOST_NODE_SHA256)
    console.log(`after-pack: bundled Windows Node runtime matches the official Node ${WINDOWS_HOST_NODE_VERSION} SHA-256`)
    if (process.platform === 'win32') {
      const probe = probeRuntimeExecutable(node)
      assertRuntimeProbe(probe, { platform: 'win32', arch: 'x64', node: WINDOWS_HOST_NODE_VERSION })
      console.log(`after-pack: bundled Node runtime ${formatRuntimeProbe(probe)}`)
    } else {
      console.log(`after-pack: Windows Node probe deferred: ${context.electronPlatformName} artifact built on ${process.platform}`)
    }
  }

  const product = context.packager.appInfo.productFilename
  const executable = isMac ? join(appPath, 'Contents', 'MacOS', product) : join(context.appOutDir, `${product}.exe`)
  if (process.platform !== context.electronPlatformName) {
    console.log(`after-pack: packaged Electron probe deferred: ${context.electronPlatformName} artifact built on ${process.platform}`)
    return
  }
  const probe = probeRuntimeExecutable(executable, { electron: true })
  assertRuntimeProbe(probe, { platform: context.electronPlatformName, electron: SHELL_ELECTRON_VERSION })
  console.log(`after-pack: packaged Electron runtime ${formatRuntimeProbe(probe)}`)
}

/** Everything else in node_modules, as paths relative to it. */
function thirdPartyIn(nodeModules) {
  const out = []
  for (const entry of readdirSync(nodeModules, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === OURS || entry.name === '.bin') continue
    if (entry.name.startsWith('@')) {
      for (const scoped of readdirSync(join(nodeModules, entry.name), { withFileTypes: true })) {
        if (scoped.isDirectory()) out.push(`${entry.name}/${scoped.name}`)
      }
    } else out.push(entry.name)
  }
  return out
}

/**
 * Build the hook for one staging directory.
 * @param {string} stagingRoot - Directory holding the staged server, pnpm and launchers.
 * @returns {(context: object) => Promise<void>} electron-builder afterPack hook.
 */
function createAfterPack(stagingRoot) {
  return async function afterPack(context) {
    // Each platform ships the pruned payload scripts/package.ts derives and
    // verifies (the host's own by a full boot).
    const isMac = context.electronPlatformName === 'darwin'
    const source = join(stagingRoot,
      context.electronPlatformName === 'win32' ? 'server-win' : 'server-mac')
    const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
    const resources = isMac ? join(appPath, 'Contents', 'Resources') : join(context.appOutDir, 'resources')

    // electron-builder.yml's `asarUnpack` entry. Without the file the app still
    // starts, but every launch logs a failed handoff and changes origin on each
    // crash rebind, so its absence fails the build instead.
    const listenPreload = join(resources, 'app.asar.unpacked', 'lib', 'listen-handoff.mjs')
    if (!existsSync(listenPreload)) throw new Error(`after-pack: ${listenPreload} is missing; check asarUnpack in electron-builder.yml`)
    const server = join(resources, 'server')
    execFileSync('cp', ['-R', source, server])
    console.log(`after-pack: copied ${source} into ${server}`)

    // Beside the bundled Node that runs it: the launcher script copied below
    // runs `runtime/pnpm/bin/pnpm.mjs` under `runtime/node`, which is how
    // upstream's plugin manager installs on a machine with no package manager.
    // `runtime/` itself is already there, from the platform's extraResources
    // entry.
    const pnpmSource = join(stagingRoot, 'pnpm')
    if (!existsSync(pnpmSource)) throw new Error(`after-pack: no staged package manager at ${pnpmSource}`)
    const pnpm = join(resources, 'runtime', 'pnpm')
    rmSync(pnpm, { recursive: true, force: true })
    execFileSync('cp', ['-R', pnpmSource, pnpm])
    if (!existsSync(join(pnpm, 'bin', 'pnpm.mjs'))) throw new Error(`after-pack: ${pnpm} carries no bin/pnpm.mjs`)
    console.log(`after-pack: copied ${pnpmSource} into ${pnpm}`)

    // The platform's pnpm launcher, whose path the shell hands the server as
    // DSH_DESKTOP_PNPM. The file names restate PNPM_LAUNCHERS in
    // src/pnpm-launcher.ts, which this CommonJS hook cannot import;
    // scripts/package.ts stages both under these names.
    const launcherName = context.electronPlatformName === 'win32' ? 'dsh-pnpm.cmd' : 'dsh-pnpm'
    const launcherSource = join(stagingRoot, 'pnpm-launchers', launcherName)
    if (!existsSync(launcherSource)) throw new Error(`after-pack: no staged pnpm launcher at ${launcherSource}`)
    const launcher = join(resources, 'runtime', launcherName)
    execFileSync('cp', [launcherSource, launcher])
    if (isMac) chmodSync(launcher, 0o755)
    console.log(`after-pack: copied ${launcherSource} into ${launcher}`)

    // Before macOS signing: the probe executes files that the signature seals.
    await verifyRuntimeProbe(context, appPath, resources, isMac)

    if (isMac) {
      signMacApp({ appPath, log: line => { console.log(line) } })
      return
    }

    if (context.electronPlatformName !== 'win32') return

    // 7z rather than zip because the installer unpacks it with the Nsis7z plugin
    // it already carries for the app package itself. `-mx=1` keeps the build
    // cheap: this archive rides inside an outer 7z that compresses it again.
    const { path7za } = require('7zip-bin')
    // 7zip-bin ships no install script and the extracted tarball carries no
    // executable bit, so on a machine that installed the dependency for the
    // first time the spawn below fails with EACCES — every CI runner, and any
    // clean checkout. Setting the bit here is idempotent and costs nothing where
    // an older install already has it.
    chmodSync(path7za, 0o755)
    const nodeModules = join(server, 'node_modules')
    const archive = join(resources, 'server-deps.7z')
    const names = thirdPartyIn(nodeModules)
    if (names.length === 0) return
    // The names go in a list file rather than on the command line. 7-Zip reads a
    // leading `@` as "the list of files is in this file" and a scoped package is
    // spelled `@scope/name`, so passing 270 of them as arguments is a parse error
    // before it is anything else; inside a list file the `@` means nothing.
    const listFile = join(resources, 'server-deps.txt')
    writeFileSync(listFile, names.join('\n') + '\n', 'utf8')
    execFileSync(path7za, ['a', '-t7z', '-mx=1', archive, `@${listFile}`], { cwd: nodeModules, stdio: 'pipe' })
    rmSync(listFile, { force: true })
    for (const name of names) rmSync(join(nodeModules, name), { recursive: true, force: true })
    if (!existsSync(archive)) throw new Error('after-pack: server-deps.7z was not written')
    console.log(`after-pack: sealed ${names.length} third-party packages into ${archive}`)
  }
}

const afterPack = createAfterPack(join(__dirname, '..', 'staging'))
module.exports = afterPack
module.exports.createAfterPack = createAfterPack
