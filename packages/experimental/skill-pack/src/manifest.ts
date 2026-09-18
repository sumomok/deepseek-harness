/**
 * Reading a pack's manifest — the `metadata` object of its SKILL.md
 * frontmatter — into the typed values reconciliation judges.
 *
 * A pack is data installed at runtime, so a manifest this module refuses is a
 * pack this deployment reports inactive, never a failed boot: every refusal
 * comes back as a value naming the field, and nothing here throws.
 *
 * The object is read strictly. A key this schema does not know is a misspelled
 * requirement, and a misspelled requirement is one the pack would be offered
 * without.
 * @module @deepseek-ai/dsh-experimental-skill-pack/src/manifest
 */

import semver from 'semver'
import { z } from 'zod'
import type { PackManifestResult } from './types.ts'

/** The `metadata` key under which a pack manifest is read, and the prefix every refused field carries. */
const MANIFEST_FIELD = 'metadata'

const exactVersion = z.string().refine(value => semver.valid(value) !== null, {
  message: 'must be an exact semantic version',
})

const versionRange = z.string().refine(value => semver.validRange(value) !== null, {
  message: 'must be a semantic-version range',
})

const manifestSchema = z.strictObject({
  pack: z.strictObject({
    version: exactVersion,
    platform: versionRange.optional(),
  }),
  requires: z.strictObject({
    components: z.record(z.string().min(1), versionRange).optional(),
    parts: z.array(z.string().min(1)).optional(),
  }).optional(),
  views: z.array(z.string().min(1)).optional(),
})

/**
 * Name the refused field the way a person reading the status route finds it in
 * the file: the `metadata` key, then the path inside it.
 *
 * An unrecognized key is reported against the object that holds it rather than
 * against itself, so the key is appended — the field a reader has to go and
 * look at is the one they misspelled, not its parent.
 * @param issue - the first issue zod reported.
 * @returns the dotted field name, `metadata` itself when the whole object was refused.
 */
function fieldName(issue: z.core.$ZodIssue): string {
  const path = issue.path.map(String)
  if (issue.code === 'unrecognized_keys') path.push(...issue.keys.slice(0, 1))
  return [MANIFEST_FIELD, ...path].join('.')
}

/**
 * Parse one pack's `metadata` object into its manifest.
 * @param metadata - the frontmatter `metadata` value, however malformed, or absent.
 * @returns the manifest, or the first field that refused it and why.
 */
export function parsePackManifest(metadata: unknown): PackManifestResult {
  const read = manifestSchema.safeParse(metadata)
  if (!read.success) {
    const issue = read.error.issues.at(0)
    /* v8 ignore next 2 -- zod reports at least one issue for every failed parse; the fallback
       keeps a refusal from being reported with no field at all. */
    if (issue === undefined) return { ok: false, field: MANIFEST_FIELD, reason: 'is not a pack manifest' }
    return { ok: false, field: fieldName(issue), reason: issue.message }
  }
  const { pack, requires, views } = read.data
  return {
    ok: true,
    manifest: {
      pack: {
        version: pack.version,
        ...pack.platform !== undefined ? { platform: pack.platform } : {},
      },
      requires: {
        components: requires?.components ?? {},
        parts: requires?.parts ?? [],
      },
      views: views ?? [],
    },
  }
}
