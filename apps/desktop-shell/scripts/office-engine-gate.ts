/**
 * The packaging check that the staged server's LibreOffice kit declares, for
 * each desktop target, an engine version `ENGINE_DOWNLOADS` registers.
 *
 * The staged kit is the one the packaged app reads, and the legacy hoisted
 * deploy that stages it does not take the workspace lockfile's pin, so it can
 * be newer than the kit the workspace installs and `tests/office-engine.spec.ts`
 * reads. A package whose kit declares an unregistered version offers no Office
 * preview download. The check lives apart from `package.ts` because
 * `package.ts` runs the build when it is imported.
 * @module
 */

import { realpathSync } from 'node:fs'
import { isAbsolute, relative, sep } from 'node:path'
import { kitManifestPath, OFFICE_KIT, readEngineRequirement } from '../src/office-engine.ts'

/** The hosts a desktop package offers the engine on: the macOS arm64 build and the Windows x64 build. */
export const DESKTOP_ENGINE_HOSTS: readonly { readonly platform: NodeJS.Platform; readonly arch: string }[] = [
  { platform: 'darwin', arch: 'arm64' },
  { platform: 'win32', arch: 'x64' },
]

/**
 * Require the staged kit to declare a registered engine for every desktop
 * host, read the way the packaged app reads it.
 *
 * The kit has to resolve from inside the staged tree: pnpm's `.bin` shims
 * export a `NODE_PATH` naming the workspace's packages, and a chain that
 * resolved through it would check the workspace kit instead.
 * @param serverModules - `node_modules` of the staged server closure.
 * @returns the registered `<package>@<version>` of each desktop host's engine, in {@link DESKTOP_ENGINE_HOSTS} order.
 * @throws when the kit resolves from outside `serverModules`, or when, for any
 * desktop host, the kit cannot be read, declares no exact engine version, or
 * declares one `ENGINE_DOWNLOADS` lacks; the message names each declared
 * version and each missing `<package>@<version>` entry.
 */
export function verifyStagedOfficeEngines(serverModules: string): string[] {
  const problems: string[] = []
  let manifest: string | undefined
  try {
    manifest = kitManifestPath(serverModules)
  } catch {
    // An unresolvable kit is reported below, once per host, by
    // readEngineRequirement's own reason.
  }
  if (manifest !== undefined) {
    const inside = relative(realpathSync(serverModules), manifest)
    if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
      problems.push(`${OFFICE_KIT} resolves to ${manifest}, outside the staged ${serverModules}`)
    }
  }
  const registered: string[] = []
  for (const { platform, arch } of DESKTOP_ENGINE_HOSTS) {
    const result = readEngineRequirement(serverModules, platform, arch)
    if (result.ok) {
      registered.push(`${result.requirement.name}@${result.requirement.version}`)
    } else if (result.declaredVersion === undefined) {
      problems.push(`${platform}-${arch}: ${result.reason}`)
    } else {
      const entry = `${OFFICE_KIT}-${platform}-${arch}@${result.declaredVersion}`
      problems.push(`${platform}-${arch}: the kit declares ${result.declaredVersion}, and ENGINE_DOWNLOADS has no ${entry}`)
    }
  }
  if (problems.length > 0) {
    throw new Error(`package: the staged server's LibreOffice kit declares engines the desktop cannot offer:\n  ${problems.join('\n  ')}`)
  }
  return registered
}
