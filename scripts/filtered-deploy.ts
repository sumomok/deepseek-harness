/**
 * The `pnpm deploy` command line the packaging pipelines stage a closure with,
 * and the patched packages a staged closure must still carry.
 *
 * Two pipelines deploy one workspace package's production closure into a
 * staging directory — `apps/desktop/scripts/package.ts` for the desktop
 * client's embedded server, `scripts/build-exe-for-python-sdk.ts` for the
 * Python runtime's executable — and both need the same flags and the same
 * check afterwards, so both are decided here.
 * @module
 */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * The arguments `pnpm` is run with to deploy one workspace package's
 * production closure.
 *
 * `--config.allow-unused-patches=true` is what lets a **filtered** deploy run
 * at all. pnpm applies the root `patchedDependencies` to a deploy as it does
 * to an install, and refuses one whose resolution leaves a patch matching
 * nothing (`ERR_PNPM_UNUSED_PATCH`). No closure deployed here contains every
 * patched package — `electron-updater` is a dependency of the Electron shell
 * and enters neither the desktop server closure nor the Python runtime
 * closure — so without the flag both pipelines fail on their first step.
 *
 * The flag is one boolean for the whole deploy rather than a per-patch
 * exemption: it masks every patch this deploy leaves unused, including one
 * that stopped matching for a reason worth knowing about. The root install is
 * where that reporting still happens — `pnpm-workspace.yaml` keeps
 * `allowUnusedPatches` unset on purpose — and a patch whose package IS in the
 * closure is still applied, still fails the deploy when it cannot be, and is
 * checked in the staged tree by {@link verifyStagedPatches}.
 * @param rootPackage - the workspace package whose closure is deployed.
 * @param destination - the staging directory the closure is deployed into.
 * @returns the argument list, destination last, as `pnpm` takes it.
 */
export function filteredDeployArgs(rootPackage: string, destination: string): string[] {
  return [
    '--filter', rootPackage, 'deploy', '--legacy', '--prod',
    '--config.node-linker=hoisted',
    '--config.auto-install-peers=false',
    '--config.link-workspace-packages=true',
    '--config.allow-unused-patches=true',
    destination,
  ]
}

/** A root patch whose package enters a deployed closure. */
export interface StagedPatch {
  /** Directory under the closure's `node_modules`. */
  package: string
  /** The file the patch edits, relative to that directory. */
  file: string
  /** Text the patch adds, which the published package does not contain. */
  marker: string
}

/**
 * The patched packages every deployed closure carries, and what proves each
 * patch reached the staged copy.
 *
 * `electron-updater` is deliberately absent: it is patched at the root and
 * belongs to the Electron shell, which is packaged from `apps/desktop`'s own
 * `node_modules` rather than from a deployed closure.
 */
export const STAGED_PATCHES: readonly StagedPatch[] = [
  {
    package: 'node-pty',
    file: 'lib/unixTerminal.js',
    // `patches/node-pty@1.2.0-beta.15.patch` reads this environment variable to
    // find the spawn helper an embedded runtime places outside the package.
    marker: 'DSH_NODE_PTY_SPAWN_HELPER',
  },
]

/**
 * Check that every one of {@link STAGED_PATCHES} reached a staged closure.
 *
 * The deploy runs with unused patches allowed, so pnpm reports nothing either
 * when a patched package leaves a closure or when its patch stops reaching the
 * copy that is staged. A pipeline checks its own staged tree instead, and the
 * two are distinct failures: an absent file means the package is no longer in
 * this closure, which is a {@link STAGED_PATCHES} entry to remove when that is
 * intended; a file without its marker means the staged copy is the published
 * package standing in the patch's place.
 * @param closure - the staged closure whose `node_modules` is read.
 * @param label - the calling script's own reporting prefix.
 * @throws when a patch's file is absent from the closure or does not carry its marker.
 */
export async function verifyStagedPatches(closure: string, label: string): Promise<void> {
  const problems: string[] = []
  for (const patch of STAGED_PATCHES) {
    const path = join(closure, 'node_modules', patch.package, patch.file)
    if (!existsSync(path)) {
      problems.push(`${patch.package} never reached the closure (no ${patch.file}) — remove it from STAGED_PATCHES if this closure is no longer meant to carry it`)
      continue
    }
    if (!(await readFile(path, 'utf8')).includes(patch.marker)) {
      problems.push(`the staged ${patch.package} is unpatched (${patch.file} carries no ${patch.marker})`)
    }
  }
  if (problems.length > 0) {
    throw new Error(`${label}: ${problems.join('; ')}; the deploy allows unused patches, so pnpm reports nothing.`)
  }
  console.log(`${label}: staged patched packages: ${STAGED_PATCHES.map(patch => patch.package).join(', ')}`)
}
