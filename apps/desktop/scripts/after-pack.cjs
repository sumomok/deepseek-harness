/**
 * electron-builder afterPack hook: copy the staged server closure into the
 * packed app's resources. extraResources cannot carry it — the builder's
 * copier hard-excludes node_modules trees — and this hook runs before the
 * dmg/zip/NSIS targets seal the app directory. `cp -R` preserves the
 * executable bits node-pty's macOS spawn-helper needs (the hook host is
 * always the macOS build machine, for Windows targets too).
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
const { existsSync, readdirSync, rmSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

/** The scope that stays loose: its packages are what a release changes. */
const OURS = '@deepseek-ai'

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

module.exports = async function afterPack(context) {
  // Each platform ships the pruned payload scripts/package.ts derives and
  // verifies (the host's own by a full boot).
  const source = join(__dirname, '..', 'staging',
    context.electronPlatformName === 'win32' ? 'server-win' : 'server-mac')
  const resources = context.electronPlatformName === 'darwin'
    ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : join(context.appOutDir, 'resources')
  const server = join(resources, 'server')
  execFileSync('cp', ['-R', source, server])
  console.log(`after-pack: copied ${source} into ${server}`)

  if (context.electronPlatformName !== 'win32') return

  // 7z rather than zip because the installer unpacks it with the Nsis7z plugin
  // it already carries for the app package itself. `-mx=1` keeps the build
  // cheap: this archive rides inside an outer 7z that compresses it again.
  const { path7za } = require('7zip-bin')
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
