/**
 * Reuse of the registry tarballs the packaging pipeline keeps under
 * `.cache/npm-pack`.
 *
 * `npm pack <name>@<version>` writes the registry's own tarball for that
 * version, and a published version's tarball never changes, so a cached file
 * whose bytes match the registry's `dist.integrity` for the version is the file
 * `npm pack` would write again. Reusing it saves one `npm pack` per tarball,
 * which took 19.9 s for the five Windows variants in the rc.37 run.
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

/** How [[packedTarball]] asks the registry about a version and fetches its tarball. */
export interface PackSource {
  /**
   * The registry's `dist.integrity` for one exact version.
   * @param spec - `<name>@<version>`.
   * @returns the Subresource Integrity string, or undefined when the registry gave none.
   */
  integrity(spec: string): Promise<string | undefined>
  /**
   * Write the registry tarball of `spec` into `directory`, as `npm pack --pack-destination` does.
   * @param spec - `<name>@<version>`.
   * @param directory - the directory the tarball is written to.
   */
  pack(spec: string, directory: string): Promise<void>
}

/** Hash algorithms [[tarballMatchesIntegrity]] checks, strongest first. */
const INTEGRITY_ALGORITHMS = ['sha512', 'sha384', 'sha256'] as const

/**
 * The file name `npm pack` gives a registry package's tarball: the scope's `@`
 * dropped and its `/` turned into `-`.
 * @param name - the package name.
 * @param version - the exact version.
 * @returns the tarball's file name.
 */
export function packedTarballName(name: string, version: string): string {
  return `${name.replaceAll('/', '-').replace(/^@/, '')}-${version}.tgz`
}

/**
 * Whether a file's bytes match a Subresource Integrity string, as npm compares
 * them: the strongest supported algorithm the string names decides, and any of
 * its digests matching is a match. A string naming no supported algorithm
 * matches nothing.
 * @param path - the file to hash.
 * @param integrity - the Subresource Integrity string, such as `sha512-<base64>`.
 * @returns true when the file matches.
 */
export async function tarballMatchesIntegrity(path: string, integrity: string): Promise<boolean> {
  const entries = integrity.trim().split(/\s+/).map(entry => /^(sha\d+)-([A-Za-z0-9+/=]+)(?:\?.*)?$/.exec(entry))
  for (const algorithm of INTEGRITY_ALGORITHMS) {
    const digests = entries.filter(entry => entry?.[1] === algorithm).map(entry => entry?.[2])
    if (digests.length === 0) continue
    const actual = createHash(algorithm).update(await readFile(path)).digest('base64')
    return digests.includes(actual)
  }
  return false
}

/**
 * The path of the registry tarball for `name@version` under `directory`,
 * reusing a cached file when its bytes match the registry's `dist.integrity`
 * for that version and packing it otherwise.
 *
 * A cached file costs one registry lookup ([[PackSource.integrity]]), never a
 * download. A missing file, a lookup that returns no integrity, and a file that
 * does not match all fall back to `pack`; a mismatched file is deleted first,
 * so a pack that writes nothing fails here instead of leaving the old bytes in
 * use.
 * @param directory - the tarball cache, created when absent.
 * @param name - the package name.
 * @param version - the exact version.
 * @param source - the registry lookup and the pack command.
 * @returns the tarball's path.
 * @throws when `pack` leaves no tarball under the expected name.
 */
export async function packedTarball(directory: string, name: string, version: string, source: PackSource): Promise<string> {
  const spec = `${name}@${version}`
  const path = join(directory, packedTarballName(name, version))
  if (existsSync(path)) {
    const integrity = await source.integrity(spec)
    if (integrity !== undefined && await tarballMatchesIntegrity(path, integrity)) {
      console.log(`package: reusing ${path}, which matches the registry's dist.integrity for ${spec}`)
      return path
    }
    console.log(integrity === undefined
      ? `package: the registry gave no dist.integrity for ${spec}; packing it again`
      : `package: ${path} does not match the registry's dist.integrity for ${spec}; packing it again`)
    await rm(path, { force: true })
  }
  await mkdir(directory, { recursive: true })
  await source.pack(spec, directory)
  if (!existsSync(path)) throw new Error(`package: npm pack produced no tarball for ${spec}`)
  return path
}
