/**
 * Staging and checking the pnpm launcher scripts ([[PNPM_LAUNCHERS]]) the
 * payload carries beside the bundled Node. `scripts/package.ts` stages both on
 * every run and fails the build on anything {@link pnpmLauncherProblems}
 * reports; `scripts/after-pack.cjs` copies the target platform's script into
 * `resources/runtime/`.
 * @module
 */

import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PNPM_LAUNCHERS } from '../src/pnpm-launcher.ts'

/**
 * Write both platforms' launcher scripts into `dir`, replacing whatever was
 * there, the POSIX one executable.
 * @param dir - the staging directory, created when absent.
 */
export async function stagePnpmLaunchers(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  for (const launcher of Object.values(PNPM_LAUNCHERS)) {
    const path = join(dir, launcher.file)
    await writeFile(path, launcher.content)
    if (launcher.executable) await chmod(path, 0o755)
  }
}

/**
 * What is wrong with the launcher scripts staged in `dir`: a script that is
 * missing, whose text is not the one [[PNPM_LAUNCHERS]] holds, or that lacks
 * the executable bit it needs.
 * @param dir - the staging directory.
 * @returns one line per problem; empty when both scripts are staged as shipped.
 */
export async function pnpmLauncherProblems(dir: string): Promise<string[]> {
  const problems: string[] = []
  for (const launcher of Object.values(PNPM_LAUNCHERS)) {
    const path = join(dir, launcher.file)
    let mode: number
    try {
      mode = (await stat(path)).mode
    } catch {
      // Any stat failure means the script is not there to ship.
      problems.push(`${path} is not staged`)
      continue
    }
    if (await readFile(path, 'utf8') !== launcher.content) problems.push(`${path} is not the launcher src/pnpm-launcher.ts holds`)
    if (launcher.executable && (mode & 0o111) === 0) problems.push(`${path} is not executable`)
  }
  return problems
}
