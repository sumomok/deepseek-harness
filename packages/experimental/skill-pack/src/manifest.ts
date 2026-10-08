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
import type { PackDocumentField, PackManifest, PackManifestResult, PackMissing } from './types.ts'

/** The `metadata` key under which a pack manifest is read, and the prefix every refused field carries. */
const MANIFEST_FIELD = 'metadata'

/**
 * The view-file format versions this build reads.
 *
 * A pack states one of them in `metadata.pack.viewFormat`, once for the whole
 * pack, and it states one exactly when it declares views. The version governs
 * what a view file may say, so a build that meets a version it does not know
 * withholds the pack by name rather than reading the file under rules that
 * were written for something else.
 */
export const PACK_VIEW_FORMATS: readonly number[] = [1]

/**
 * The anchor-file format versions this build reads.
 *
 * A pack exported with element anchors states one of them in
 * `metadata.pack.anchorFormat`; a pack that states none carries no anchors and
 * is read whatever this list holds. `ANCHOR_FORMATS_READ` of the point-anchor
 * package, which writes those anchor lines, is the authority this list copies;
 * until that package is vendored into the console composition nothing but
 * this comment ties the two, and its vendoring brings an equivalence test. A
 * number is only ever added: dropping one is a breaking change for every pack
 * that states it.
 */
export const PACK_ANCHOR_FORMATS: readonly number[] = [1]

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
    viewFormat: z.int().optional(),
    anchorFormat: z.int().optional(),
  }),
  requires: z.strictObject({
    components: z.record(z.string().min(1), versionRange).optional(),
    parts: z.array(z.string().min(1)).optional(),
  }).optional(),
  views: z.array(z.string().min(1)).optional(),
})

/**
 * List the leaf keys of one object of the manifest schema.
 * @param shape - the object's keys and their schemas.
 * @param prefix - the dotted path of the object, with its trailing dot; empty at the top.
 * @param required - whether the object itself must be present.
 * @returns one field per leaf key, in declaration order; a key inside an optional object is optional.
 */
function manifestFields(shape: z.core.$ZodShape, prefix: string, required: boolean): PackDocumentField[] {
  return Object.entries(shape).flatMap(([key, field]) => {
    const optional = field instanceof z.ZodOptional
    const inner = field instanceof z.ZodOptional ? field.unwrap() : field
    const path = `${prefix}${key}`
    return inner instanceof z.ZodObject
      ? manifestFields(inner.shape, `${path}.`, required && !optional)
      : [{ path, required: required && !optional }]
  })
}

/**
 * Every key a manifest may carry inside `metadata`, read off the schema a
 * manifest is parsed with. A key outside this list refuses the manifest, and
 * so does a manifest leaving out a required one.
 */
export const PACK_MANIFEST_FIELDS: readonly PackDocumentField[] = manifestFields(manifestSchema.shape, '', true)

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
        ...pack.viewFormat !== undefined ? { viewFormat: pack.viewFormat } : {},
        ...pack.anchorFormat !== undefined ? { anchorFormat: pack.anchorFormat } : {},
      },
      requires: {
        components: requires?.components ?? {},
        parts: requires?.parts ?? [],
      },
      views: views ?? [],
    },
  }
}

/**
 * Whether this build reads the view files one manifest declares.
 *
 * A pack that declares no views states no format and is read whatever it
 * states, because there is no file the version would govern.
 * @param manifest - the parsed manifest.
 * @returns `true` when the pack declares no views, or states a format in {@link PACK_VIEW_FORMATS}.
 */
export function readsDeclaredViews(manifest: PackManifest): boolean {
  if (manifest.views.length === 0) return true
  const stated = manifest.pack.viewFormat
  return stated !== undefined && PACK_VIEW_FORMATS.includes(stated)
}

/**
 * The unmet requirement a manifest earns when this build cannot read the view
 * files it declares.
 *
 * One home for the member and for the sentence `describeMissing` states it in,
 * so the status route and an install refusal name the same two versions.
 * @param manifest - the parsed manifest, which {@link readsDeclaredViews} has refused.
 * @returns the `view-format` member, carrying the version the pack stated where it stated one.
 */
export function viewFormatMissing(manifest: PackManifest): PackMissing {
  const stated = manifest.pack.viewFormat
  return {
    kind: 'view-format',
    ...stated !== undefined ? { stated } : {},
    reads: PACK_VIEW_FORMATS,
  }
}

/**
 * The unmet requirement a manifest earns when this build cannot read the
 * anchor format it states.
 *
 * One home for the member and for the sentence `describeMissing` states it in,
 * so the status route and an install refusal name the same two numbers.
 * Nothing that arrives later changes the answer: which anchor formats can be
 * read is fixed by this build, so a pack refused here stays refused until it is
 * exported again.
 * @param manifest - the parsed manifest.
 * @returns the `anchor-format` member carrying the stated format and the ones this build reads, or
 *   `undefined` when the pack states no anchor format or states one in {@link PACK_ANCHOR_FORMATS}.
 */
export function anchorFormatMissing(manifest: PackManifest): PackMissing | undefined {
  const stated = manifest.pack.anchorFormat
  if (stated === undefined || PACK_ANCHOR_FORMATS.includes(stated)) return undefined
  return { kind: 'anchor-format', stated, reads: PACK_ANCHOR_FORMATS }
}
