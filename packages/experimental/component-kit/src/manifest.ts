/**
 * This package's own name and version, read from its own `package.json`.
 *
 * The catalog registry records which package contributed each component, and it
 * has to be the manifest that says so rather than two strings written here: a
 * version written beside the registration is a version that is right until the
 * next release and wrong afterwards, with nothing anywhere failing.
 *
 * Read relative to this module rather than resolved by name, so the answer is
 * this package's manifest whether the row runs from `src` under the source
 * launcher or from the bundled `lib`, and never a copy some other resolution
 * order found first.
 * @module @deepseek-ai/dsh-experimental-component-kit/src/manifest
 */

import { readFileSync } from 'node:fs'
import type { ComponentSource } from '@deepseek-ai/dsh-experimental-component-surface'

/**
 * Read one parsed manifest's name and version.
 *
 * Separate from the file read because a manifest is a file boundary: what comes
 * back is JSON whose declared type is a claim, and this is where the claim is
 * checked.
 * @param manifest - the parsed `package.json`.
 * @returns the contributing package, as the catalog registry records it.
 * @throws {Error} when it carries no name or no version, which would leave every
 * component of this row attributed to nothing.
 */
export function readComponentKitSource(manifest: unknown): ComponentSource {
  const { name, version } = (manifest ?? {}) as { name?: unknown; version?: unknown }
  if (typeof name !== 'string' || typeof version !== 'string') {
    throw new Error('component-kit: own package.json carries no name and version to register its components under')
  }
  return { package: name, version }
}

/**
 * Read this package's own name and version.
 * @returns the contributing package, as the catalog registry records it.
 */
export function componentKitSource(): ComponentSource {
  return readComponentKitSource(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')))
}
