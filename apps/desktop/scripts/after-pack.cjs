/**
 * electron-builder afterPack hook: finish the packed app directory. Two steps
 * run here, in this order, and both have to be after the builder has laid the
 * bundle out and before the dmg/zip/NSIS targets seal it:
 *
 * 1. Copy the staged server closure into the app's resources. extraResources
 *    cannot carry it — the builder's copier hard-excludes node_modules trees.
 *    `cp -R` preserves the executable bits node-pty's macOS spawn-helper needs
 *    (the hook host is always the macOS build machine, for Windows targets too).
 * 2. Sign the macOS app (scripts/sign-mac.cjs), which must see the finished
 *    bundle: the signature seals every resource, so anything copied afterwards
 *    would break it.
 *
 * afterPack, not afterSign: `mac.identity: null` makes the builder's own
 * signing pass a no-op, and `doSignAfterPack` emits `afterSign` only when that
 * pass actually signed something. Nothing modifies the bundle between this hook
 * and the targets — `doAddElectronFuses` returns immediately without an
 * `electronFuses` config, and there is none.
 */

'use strict'

const { execFileSync } = require('node:child_process')
const { join } = require('node:path')
const { signMacApp } = require('./sign-mac.cjs')

module.exports = async function afterPack(context) {
  // Each platform ships the pruned payload scripts/package.ts derives and
  // verifies (the macOS one by a full boot).
  const isMac = context.electronPlatformName === 'darwin'
  const source = join(__dirname, '..', 'staging',
    context.electronPlatformName === 'win32' ? 'server-win' : 'server-mac')
  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  const resources = isMac ? join(appPath, 'Contents', 'Resources') : join(context.appOutDir, 'resources')
  execFileSync('cp', ['-R', source, join(resources, 'server')])
  console.log(`after-pack: copied ${source} into ${join(resources, 'server')}`)
  if (!isMac) return
  signMacApp({ appPath, log: line => { console.log(line) } })
}
