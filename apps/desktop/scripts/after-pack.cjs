/**
 * electron-builder afterPack hook: copy the staged server closure into the
 * packed app's resources. extraResources cannot carry it — the builder's
 * copier hard-excludes node_modules trees — and this hook runs before the
 * dmg/zip/NSIS targets seal the app directory. `cp -R` preserves the
 * executable bits node-pty's macOS spawn-helper needs (the hook host is
 * always the macOS build machine, for Windows targets too).
 */

'use strict'

const { execFileSync } = require('node:child_process')
const { join } = require('node:path')

module.exports = async function afterPack(context) {
  const { existsSync } = require('node:fs')
  // Windows ships the pruned per-target payload scripts/package.ts derives;
  // macOS ships the full verified staging.
  const winSource = join(__dirname, '..', 'staging', 'server-win')
  const source = context.electronPlatformName === 'win32' && existsSync(winSource)
    ? winSource
    : join(__dirname, '..', 'staging', 'server')
  const resources = context.electronPlatformName === 'darwin'
    ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : join(context.appOutDir, 'resources')
  execFileSync('cp', ['-R', source, join(resources, 'server')])
  console.log(`after-pack: copied ${source} into ${join(resources, 'server')}`)
}
