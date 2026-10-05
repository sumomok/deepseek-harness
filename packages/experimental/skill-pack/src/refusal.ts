/**
 * What a delivery is refused for, and the error that carries the refusal.
 *
 * One error type for every read a delivery can arrive through — a source
 * directory, the packs themselves, or an archive file — so a caller decides
 * what to do from the tag rather than from a message. The union is closed, so
 * a consumer switches on it and ends in `assertNever`.
 * @module @deepseek-ai/dsh-experimental-skill-pack/src/refusal
 */

/** What a {@link PackInstallError} refused. */
export type PackInstallRefusal =
  /** The file's extension is not one a pack may carry. */
  | 'code-file'
  /** The path leaves the pack directory, or names no pack directory at all. */
  | 'path-escape'
  /** The entry is a symbolic link, which would carry the root's contents outside it. */
  | 'symlink'
  /** The delivered set holds an entry that is not a pack directory. */
  | 'not-a-pack'
  /** The delivery names one pack twice, or one path twice inside a pack. */
  | 'duplicate-entry'
  /** The archive's bytes are not an archive this installer can read. */
  | 'archive-unreadable'
  /** The archive states a manifest format version this build does not know. */
  | 'archive-format'
  /** The archive carries no manifest, or one that is not a manifest. */
  | 'archive-manifest'
  /** The archive carries an entry its manifest does not declare, or lacks one it does. */
  | 'archive-entry'
  /** A file's bytes are not the ones the manifest's digest states. */
  | 'archive-digest'
  /** The archive, one of its files, or its file count is over the limit it was read under. */
  | 'archive-oversize'
  /** A delivered pack's `metadata` object is not a manifest. */
  | 'pack-manifest'
  /** A delivered pack states an anchor-file format this build does not read. */
  | 'pack-anchor-format'
  /** A delivered pack declares views in a view-file format this build does not read, or states none. */
  | 'pack-view-format'
  /** A view file a delivered pack declares is absent, leaves its pack, or is not a view. */
  | 'pack-view'
  /** The component surface this deployment composes will not draw a view a delivered pack declares. */
  | 'pack-view-refused'

/** A delivery this package refused, naming the entry and what was wrong with it. */
export class PackInstallError extends Error {
  /** Which rule refused the entry. */
  readonly refusal: PackInstallRefusal
  /** The entry, as the delivery named it. */
  readonly entry: string

  /**
   * @param refusal - which rule refused the entry.
   * @param entry - the entry, as the delivery named it.
   * @param detail - the sentence stating what the rule requires.
   */
  constructor(refusal: PackInstallRefusal, entry: string, detail: string) {
    super(`skill-pack: refused ${entry} — ${detail}`)
    this.name = 'PackInstallError'
    this.refusal = refusal
    this.entry = entry
  }
}
