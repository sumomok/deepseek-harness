/**
 * The production dependencies pnpm's legacy deployer leaves inside a package
 * it hoisted beside the deploy source.
 *
 * The legacy deployer places some of the deploy root's direct dependencies in
 * the deploy source's own `node_modules` instead of the target, and
 * `restoreLegacyHoists` in `package.ts` copies each one back without its nested
 * `node_modules`, because that tree also holds the package's development
 * dependencies. A production dependency the deployer resolved only inside that
 * nested tree is then in neither place: `@deepseek-ai/dsh-base`, the bundle
 * every profile starts from, reached the staged tree this way only through the
 * build machine's `NODE_PATH`. This module follows each restored package's
 * `dependencies` and copies the ones the staging tree lacks.
 * @module
 */

import { existsSync } from 'node:fs'
import { cp, mkdir, readFile, realpath } from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'

/** A package `restoreLegacyHoists` copied back into the staging tree. */
export interface RestoredHoist {
  /** The package name. */
  name: string
  /** The directory the deployer left it in, beside the deploy source. */
  source: string
}

/**
 * The directory Node would load a dependency from, searching the dependent's
 * own `node_modules` and each ancestor's.
 * @param from - the dependent package's directory.
 * @param name - the dependency's package name.
 * @returns the dependency's directory, or undefined when no `package.json` is found for it.
 */
function resolveFrom(from: string, name: string): string | undefined {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
    if (dirname(dir) === dir) return undefined
  }
}

/**
 * Copy a package's files into the staging tree, dereferencing links and
 * leaving out its nested `node_modules`.
 * @param source - the package directory, possibly a link.
 * @param destination - where it goes under the staging `node_modules`.
 */
async function copyPackage(source: string, destination: string): Promise<void> {
  const real = await realpath(source)
  const nested = join(real, 'node_modules')
  await mkdir(dirname(destination), { recursive: true })
  await cp(real, destination, {
    recursive: true,
    dereference: true,
    filter: path => path !== nested && !path.startsWith(nested + sep),
  })
}

/**
 * Copy into the staging tree every production dependency of the restored
 * packages that it lacks, following each copied package's own.
 *
 * A dependency already in the staging `node_modules` is the deployer's and is
 * not followed; the payload closure check in `staged-boot-gate.ts` covers it.
 * A skipped name is neither copied nor followed.
 * @param stagingNodeModules - the staging tree's `node_modules`.
 * @param restored - the packages `restoreLegacyHoists` copied back.
 * @param skip - package names the payload leaves out on purpose.
 * @returns the names copied, in order, and the `<dependent> -> <dependency>` pairs no source provided.
 */
export async function restoreHoistedDependencies(
  stagingNodeModules: string, restored: readonly RestoredHoist[], skip: readonly string[],
): Promise<{ copied: string[]; unresolved: string[] }> {
  const copied: string[] = []
  const unresolved: string[] = []
  const queue = restored.map(({ name, source }) => ({ name, source }))
  const followed = new Set<string>()
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    if (followed.has(next.name)) continue
    followed.add(next.name)
    const manifest = JSON.parse(await readFile(join(next.source, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }
    for (const name of Object.keys(manifest.dependencies ?? {}).sort()) {
      if (skip.includes(name) || existsSync(join(stagingNodeModules, name, 'package.json'))) continue
      const source = resolveFrom(next.source, name)
      if (source === undefined) {
        unresolved.push(`${next.name} -> ${name}`)
        continue
      }
      await copyPackage(source, join(stagingNodeModules, name))
      copied.push(name)
      queue.push({ name, source: await realpath(source) })
    }
  }
  return { copied, unresolved }
}
