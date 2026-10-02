/**
 * The packaging check that the staged server's LibreOffice kit declares, for
 * each desktop target, the engine version this package ships, and that
 * `ENGINE_DOWNLOADS` registers it.
 *
 * The staged kit is the one the packaged app reads, and the legacy hoisted
 * deploy that stages it does not take the workspace lockfile's pin: it
 * resolves the kit's range by publish age, to the newest release at least
 * pnpm's `minimumReleaseAge` old when the deploy runs. So it can be newer than
 * the kit the workspace installs and `tests/office-engine.spec.ts` reads, and
 * newer than the kit the previous package carried. A package whose kit
 * declares an unregistered version offers no Office preview download, and one
 * whose kit declares another registered version makes every person who
 * downloaded the engine download it again. The check lives apart from
 * `package.ts` because `package.ts` runs the build when it is imported.
 * @module
 */

import { realpathSync } from 'node:fs'
import { isAbsolute, relative, sep } from 'node:path'
import { kitManifestPath, OFFICE_KIT, readEngineRequirement, type DeclaredEngine } from '../src/office-engine.ts'

/** One host a desktop package offers the engine on, and the engine version its package ships. */
export interface DesktopEngineHost {
  /** `process.platform` of the host. */
  readonly platform: NodeJS.Platform
  /** `process.arch` of the host. */
  readonly arch: string
  /** The exact engine version the staged kit must declare for this host. */
  readonly engineVersion: string
}

/**
 * The hosts a desktop package offers the engine on — the macOS arm64 build and
 * the Windows x64 build — each with the engine version its package ships.
 *
 * A package run stops when the staged kit declares another version, so a kit
 * release never reaches the desktop through the time a deploy happens to run.
 * Raise a version here only to ship that engine: register its tarball in
 * `ENGINE_DOWNLOADS` (published size, `dist.integrity`, and a conversion
 * checked with that version), then run a fresh deploy once that kit is a day
 * old. Every person who downloaded the engine then downloads the new version
 * once, without being asked, on the first launch of that build. To keep the
 * current version while a newer kit is published, package with
 * `--skip-deploy` over a staging this check accepts.
 */
export const DESKTOP_ENGINE_HOSTS: readonly DesktopEngineHost[] = [
  { platform: 'darwin', arch: 'arm64', engineVersion: '0.1.5' },
  { platform: 'win32', arch: 'x64', engineVersion: '0.1.5' },
]

/**
 * Require the staged kit to declare, for every desktop host, the engine
 * version that host's package ships, registered, read the way the packaged
 * app reads it.
 *
 * The kit has to resolve from inside the staged tree: pnpm's `.bin` shims
 * export a `NODE_PATH` naming the workspace's packages, and a chain that
 * resolved through it would check the workspace kit instead.
 * @param serverModules - `node_modules` of the staged server closure.
 * @param hosts - the hosts and the engine version each ships; {@link DESKTOP_ENGINE_HOSTS} for a package run.
 * @returns the registered `<package>@<version>` of each host's engine, in `hosts` order.
 * @throws when the kit resolves from outside `serverModules`, or when, for any
 * host, the kit cannot be read, declares no exact engine version, declares
 * one other than the host's `engineVersion`, or declares one `ENGINE_DOWNLOADS`
 * lacks; the message names each declared and expected version and each
 * missing `<package>@<version>` entry.
 */
export function verifyStagedOfficeEngines(serverModules: string, hosts: readonly DesktopEngineHost[] = DESKTOP_ENGINE_HOSTS): string[] {
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
  for (const { platform, arch, engineVersion } of hosts) {
    const target = `${platform}-${arch}`
    const result = readEngineRequirement(serverModules, platform, arch)
    let declared: DeclaredEngine
    if (result.ok) {
      declared = result.requirement
    } else if (result.declared === undefined) {
      problems.push(`${target}: ${result.reason}`)
      continue
    } else {
      declared = result.declared
    }
    if (declared.version !== engineVersion) {
      problems.push(`${target}: the kit declares ${declared.version}, and this package ships ${engineVersion} (DESKTOP_ENGINE_HOSTS in scripts/office-engine-gate.ts)`)
    }
    if (result.ok) {
      registered.push(`${declared.name}@${declared.version}`)
    } else {
      problems.push(`${target}: the kit declares ${declared.version}, and ENGINE_DOWNLOADS has no ${declared.name}@${declared.version}`)
    }
  }
  if (problems.length > 0) {
    throw new Error(`package: the staged server's LibreOffice kit does not declare the Office engines this package ships:\n  ${problems.join('\n  ')}`)
  }
  return registered
}
