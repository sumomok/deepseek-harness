/** Validate the assembled application, including native Office conversion outside ASAR. */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import {
  DESKTOP_ELECTRON_MAJOR, DESKTOP_ELECTRON_MINIMUM,
  assertRuntimeProbe, formatRuntimeProbe, probeRuntimeExecutable,
} from '../../../scripts/runtime-version-gate.mjs'
import { desktopArtifactOutput, resolveDesktopBuildTarget, resolveDesktopTargetBuildPaths } from './desktop-build-paths.mjs'
import { readDesktopRuntime, verifyDesktopRuntime } from '../src/runtime-tree.ts'
import { verifyWindowsCode } from './windows-runtime-signature.mjs'
import { smokePreparedRuntime } from './smoke-prepared-runtime.ts'
import { resolveDesktopPackageTarget } from './package-target.ts'

const paths = resolveDesktopTargetBuildPaths()
const { values } = parseArgs({ options: { unsigned: { type: 'boolean', default: false }, 'skip-notarization': { type: 'boolean', default: false } }, allowPositionals: false })
const target = resolveDesktopBuildTarget()
const windows = target === 'win-x64'
const artifacts = desktopArtifactOutput(paths, { unsigned: values.unsigned, skipNotarization: values['skip-notarization'] }).directory
const application = windows ? join(artifacts, 'win-unpacked')
  : join(artifacts, target === 'mac-arm64' ? 'mac-arm64' : 'mac', 'DeepSeek Harness.app', 'Contents')
const resources = join(application, windows ? 'resources' : 'Resources')
const executable = windows ? join(application, 'DeepSeek Harness.exe') : join(application, 'MacOS', 'DeepSeek Harness')
const descriptor = await verifyDesktopRuntime(paths.dsh, readDesktopRuntime(paths.dsh).release.version,
  resolveDesktopPackageTarget(target))
const platform = windows ? 'win32' : 'darwin'
const electronProbe = probeRuntimeExecutable(executable, { electron: true })
assertRuntimeProbe(electronProbe, {
  platform, electron: { minimum: DESKTOP_ELECTRON_MINIMUM, major: DESKTOP_ELECTRON_MAJOR },
})
console.log(`desktop packaged Electron runtime: ${formatRuntimeProbe(electronProbe)}`)
const node = join(resources, 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', windows ? 'node.exe' : 'node')
if (!existsSync(node)) throw new Error(`desktop packaged runtime is missing ${node}`)
const nodeProbe = probeRuntimeExecutable(node)
assertRuntimeProbe(nodeProbe, { platform })
console.log(`desktop packaged Node runtime: ${formatRuntimeProbe(nodeProbe)}`)
if (windows && !values.unsigned) await verifyWindowsCode(application)
await smokePreparedRuntime(join(resources, 'app.asar', 'dsh'), executable, join(resources, 'runtime'), descriptor)
