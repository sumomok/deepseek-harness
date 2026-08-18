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
  // Each platform ships the pruned payload scripts/package.ts derives and
  // verifies (the macOS one by a full boot).
  const source = join(__dirname, '..', 'staging',
    context.electronPlatformName === 'win32' ? 'server-win' : 'server-mac')
  const resources = context.electronPlatformName === 'darwin'
    ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : join(context.appOutDir, 'resources')
  execFileSync('cp', ['-R', source, join(resources, 'server')])
  console.log(`after-pack: copied ${source} into ${join(resources, 'server')}`)
}
