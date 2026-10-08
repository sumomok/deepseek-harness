/**
 * The values this package hands across its own edges: what a pack's manifest
 * says, what a component plugin has registered, what reconciliation answered,
 * what the status route publishes, what a delivery is made of, and what the
 * organization intake takes and answers.
 *
 * Runtime code lives in the modules that own each value — `manifest.ts` parses
 * a manifest, `views.ts` parses a view file, `reconcile.ts` judges a pack,
 * `delivery.ts` holds a delivered set to the pack rules, `archive.ts` writes
 * and reads the packed file, and `install.ts` replaces a pack root.
 * @module @deepseek-ai/dsh-experimental-skill-pack/src/types
 */

/**
 * One part a component plugin has registered into the component catalog, as
 * this package needs to read it: which part, which package registered it, and
 * at which version that package is installed.
 */
export interface ProvidedPart {
  /** The part id a pack names in `requires.parts`, such as `toy.data-page`. */
  readonly id: string
  /** The npm package name of the component plugin that registered the part. */
  readonly plugin: string
  /** That package's own version, matched against `requires.components`. */
  readonly version: string
}

/** One view file the component surface will not draw: where in it, and why. */
export interface PackViewRefusal {
  /** Parameter path of the offending value inside the view, such as `spec.nodes[0].component`. */
  readonly path: string
  /** What is wrong with that value, in the words the component surface refuses a call in. */
  readonly reason: string
}

/**
 * The component surface, as a pack's requirements read it: `ctx.skillPackParts`.
 *
 * Both questions come from one catalog and change together, so they are one
 * key: a deployment that could mount the part list without the judgement would
 * have a state where a pack's parts are known and its views are unjudged, and
 * the pack would be offered with a view nobody can draw — which is the state
 * this package exists to prevent.
 *
 * This package declares the key and consumes it; the row that implements it
 * over the real component catalog is separate wiring. Until a provider of the
 * key is mounted every pack sees an empty part list, so a pack that requires
 * any part stays inactive.
 */
export interface PartsSource {
  /**
   * The parts registered right now.
   * @returns every registered part, in no guaranteed order.
   */
  list(): readonly ProvidedPart[]
  /**
   * Observe registrations and withdrawals.
   * @param listener - called after the registered set changes; it reads {@link PartsSource.list} for the new set.
   * @returns the disposer that stops the notifications.
   */
  onChange(listener: () => void): () => void
  /**
   * Judge one view file against the surface that would draw it.
   *
   * The judgement is the component surface's own, so a view a pack ships and a
   * block the model places are accepted on identical terms. This package reads
   * neither the spec nor the params it hands over.
   *
   * A view id the deployment's own configuration already claims is refused
   * here, because the deployment's views own their ids. Two packs claiming one
   * id is settled by this package instead: two packs of the pack root are both
   * withheld, and an offered organization pack keeps the id against the pack
   * root.
   * @param view - the parsed view file.
   * @returns the refusal, or `undefined` when the view can be drawn here.
   */
  judgeView(view: PackView): PackViewRefusal | undefined
}

/** What a pack's `metadata.pack` block states about the pack itself. */
export interface PackIdentity {
  /** The pack's own version, an exact semantic version. */
  readonly version: string
  /** Semantic-version range the console platform must satisfy; absent means any platform. */
  readonly platform?: string
  /**
   * Which version of the view-file format the pack's view files are written
   * in, stated once for the whole pack. Required of a pack that declares
   * views, and meaningless on one that declares none.
   */
  readonly viewFormat?: number
  /**
   * Which version of the anchor-file format the pack's element anchors are
   * written in. Stated by a pack exported with anchors; a pack that states
   * none carries no anchors, and nothing here reads an anchor file itself.
   */
  readonly anchorFormat?: number
}

/** What a pack's `metadata.requires` block states it needs before it may be offered. */
export interface PackRequirements {
  /** Component plugin package name to the semantic-version range that package must satisfy. */
  readonly components: Readonly<Record<string, string>>
  /** Part ids that must exist in the component catalog. */
  readonly parts: readonly string[]
}

/** One pack's manifest: the `metadata` object of its SKILL.md frontmatter, parsed. */
export interface PackManifest {
  /** The pack's own version and the platform range it states. */
  readonly pack: PackIdentity
  /** What the pack needs from component plugins. */
  readonly requires: PackRequirements
  /** Pack-relative paths of the view files the pack declares. */
  readonly views: readonly string[]
}

/** A manifest that parsed, or the field that stopped it. */
export type PackManifestResult =
  | { readonly ok: true; readonly manifest: PackManifest }
  | { readonly ok: false; readonly field: string; readonly reason: string }

/** One view a pack declares: what to draw, and the values the pack fills it with. */
export interface PackView {
  /** Stable id of the view and of the content-column entry it owns. */
  readonly id: string
  /** Short phrase naming the entry for the user. */
  readonly title: string
  /**
   * What to draw. Carried verbatim: the component catalog judges a spec, and
   * this package neither reads nor rejects one.
   */
  readonly spec: unknown
  /** Values the view fills its blocks with, carried verbatim for the same reason. */
  readonly params: Readonly<Record<string, unknown>>
}

/** A view file that parsed, or the reason it did not. */
export type PackViewResult =
  | { readonly ok: true; readonly path: string; readonly view: PackView }
  | { readonly ok: false; readonly path: string; readonly reason: string }

/** One unmet requirement. Every member names the exact value that was refused. */
export type PackMissing =
  /** The `metadata` object is not a manifest; `field` is the path that failed. */
  | { readonly kind: 'manifest-invalid'; readonly field: string; readonly reason: string }
  /** The deployment's platform version falls outside the pack's declared range. */
  | { readonly kind: 'platform-version'; readonly range: string; readonly present: string }
  /** No registered part comes from this component plugin package. */
  | { readonly kind: 'plugin-absent'; readonly plugin: string; readonly range: string }
  /** The component plugin package is registered at a version outside the declared range. */
  | { readonly kind: 'plugin-version'; readonly plugin: string; readonly range: string; readonly present: string }
  /** No component plugin has registered this part id. */
  | { readonly kind: 'part-absent'; readonly part: string }
  /** The pack states an anchor-file format this build does not read. */
  | { readonly kind: 'anchor-format'; readonly stated: number; readonly reads: readonly number[] }
  /** The pack declares views in a view-file format this build does not read, or states none at all. */
  | { readonly kind: 'view-format'; readonly stated?: number; readonly reads: readonly number[] }
  /** A declared view file could not be read or parsed. */
  | { readonly kind: 'view-unreadable'; readonly view: string; readonly reason: string }
  /** A declared view parsed, and the component surface will not draw it. */
  | { readonly kind: 'view-refused'; readonly view: string; readonly path: string; readonly reason: string }
  /**
   * Another pack declares one of this pack's view ids. With `origin:
   * 'pack-root'` it is a pack this root would otherwise offer, and neither is
   * offered; with `origin: 'organization'` it is an offered organization pack,
   * which keeps the id.
   */
  | {
    readonly kind: 'view-id-conflict'
    readonly id: string
    /** The skill name of the other pack. */
    readonly pack: string
    /** Where the other pack is installed. */
    readonly origin: 'pack-root' | 'organization'
  }

/** One pack's state and, when it is inactive, every reason it is. */
export interface PackStatus {
  /** The skill name the pack's frontmatter declares, which is how a user and the model address it. */
  readonly skill: string
  /**
   * The pack's own `metadata.pack.version`, absent when the manifest did not
   * parse far enough to carry one. Shown and traced only: nothing here
   * compares it with {@link PackStatus.entryVersion}.
   */
  readonly version?: string
  /** Where the pack is installed: the pack root, or the organization root `ctx.skillPackIntake` writes. */
  readonly origin: 'pack-root' | 'organization'
  /**
   * The `version` of the organization manifest entry, which keys the entry
   * together with its skill name; present on organization entries only.
   */
  readonly entryVersion?: string
  /** The organization channel the entry was handed over under; present on organization entries only. */
  readonly channel?: 'stable' | 'trial'
  /** `active` exactly when `missing` is empty. */
  readonly state: 'active' | 'inactive'
  /**
   * Every unmet requirement, in a fixed order: manifest, platform, plugins,
   * parts, anchor format, view format, unreadable views, refused views. A pack withheld for a
   * contested view id carries that one reason and no other, because it had no
   * other.
   */
  readonly missing: readonly PackMissing[]
}

/** One active pack's view, as `activeViews()` hands it to a caller that will place it. */
export interface ActivePackView extends PackView {
  /** The skill name of the pack that declared the view. */
  readonly pack: string
}

/** What `GET /skill-pack/status` answers. */
export interface PackStatusDocument {
  /**
   * Every pack in the pack root in skill-name order, then every entry of the
   * offered organization set in `name@version` order, active and inactive alike.
   */
  readonly packs: readonly PackStatus[]
}

/** One file inside a delivered pack. */
export interface DeliveredFile {
  /** Pack-relative path, written with `/` separators. */
  readonly path: string
  /** The file's bytes; a string is written as UTF-8. */
  readonly content: string | Uint8Array
}

/** One pack in a delivered set. */
export interface DeliveredPack {
  /** The pack's directory name inside the pack root. */
  readonly name: string
  /** Every file the pack carries, in any order. */
  readonly files: readonly DeliveredFile[]
}

/** Which set a delivery archive carries, as its manifest states it. */
export interface PackSetIdentity {
  /** The set's own name, which the delivery side chooses and a deployment logs. */
  readonly id: string
  /** The set's own version. Nothing here compares two of them, so a downgrade is an ordinary delivery. */
  readonly version: string
}

/** The sizes and the count one archive is read under; a deployment sets them, and an archive over any of them is refused whole. */
export interface PackArchiveLimits {
  /** Largest archive that is read at all, in bytes. */
  readonly maxArchiveBytes: number
  /** Largest single file an archive may carry, in bytes. */
  readonly maxFileBytes: number
  /** Most entries an archive may carry, its manifest among them. */
  readonly maxFiles: number
}

/** A delivered set that is already unpacked, which is also what an archive is written from. */
export type PackSetSource =
  /** A directory whose immediate children are pack directories. */
  | { readonly kind: 'directory'; readonly path: string }
  /** The packs themselves, already in hand. */
  | { readonly kind: 'packs'; readonly packs: readonly DeliveredPack[] }

/** One archive file, verified against its own manifest before anything is staged. */
export interface PackArchiveDelivery {
  /** Discriminant of the archive delivery. */
  readonly kind: 'archive'
  /** The archive's own name, which a refusal about the archive as a whole is reported against. */
  readonly name: string
  /** The archive's bytes. */
  readonly bytes: Uint8Array
  /** The sizes and count this archive is read under. */
  readonly limits: PackArchiveLimits
}

/** Where the delivered set comes from. */
export type PackDelivery = PackSetSource | PackArchiveDelivery

/**
 * One skill pack an organization hands over, whose files the handing plugin
 * has already verified against the organization's signature and digests.
 */
export interface OrgPackInput {
  /** The skill name; the `name` of the entry's `SKILL.md` frontmatter must be this name. */
  readonly name: string
  /**
   * The `version` of the organization manifest entry, which keys the entry and
   * names its directory `<name>@<version>`; it must be one directory name on
   * Linux, macOS and Windows: no `/`, `\`, `:`, `*`, `?`, `"`, `<`, `>`, `|`
   * or control character U+0000 to U+001F, no `.` or space at its end, and
   * not a Windows device name (`CON`, `PRN`, `AUX`, `NUL`, `COM1` to `COM9`,
   * `LPT1` to `LPT9`) in any letter case, with or without an extension. It
   * holds no lone UTF-16 surrogate, and `<name>@<version>` is at most 255
   * bytes of UTF-8. It need not equal the pack's own `metadata.pack.version`,
   * and nothing here compares the two.
   */
  readonly version: string
  /** Shown on `GET /skill-pack/status` only; this package chooses no version by it. */
  readonly channel: 'stable' | 'trial'
  /**
   * Every file of the skill directory, its path relative to that directory
   * with `/` separators. Content is accepted as bytes or as a string, which is
   * written as UTF-8; either way the bytes judged are the bytes written, a
   * byte-order mark included.
   */
  readonly files: readonly DeliveredFile[]
}

/**
 * Why `replace` refused one entry.
 *
 * Members are added as the pack rules grow. A consumer compiled against an
 * earlier list shows one general sentence for a code it does not know rather
 * than switching exhaustively.
 */
export type IntakeRefusalCode =
  /**
   * A file, path, extension, frontmatter, manifest or view file breaks the
   * pack rules, two paths that fold to one name, as `duplicate` states for
   * versions, or a path used both as a file and as the directory of another
   * path, among them, and a path segment or `<name>@<version>` that holds
   * a lone UTF-16 surrogate or is over 255 bytes of UTF-8; or the frontmatter
   * `name` is not the entry's name, or the version is not one directory name.
   * A name the file system refuses for another reason, such as one holding a
   * code point APFS refuses, or a path longer than `PATH_MAX`, is not refused:
   * writing it fails, so the whole `replace` answers `failed`, and the
   * organization root and the offered set stay as they were.
   */
  | 'pack-invalid'
  /** `metadata.pack.anchorFormat` states an anchor format this build does not read. */
  | 'anchor-format'
  /** The entry declares views in a view format this build does not read, or states none. */
  | 'view-format'
  /** Every other requirement is met, and the component surface this deployment composes will not draw one of its views. */
  | 'view-refused'
  /** Another entry of the set declares one of its view ids with a file of different bytes. */
  | 'view-id-conflict'
  /**
   * The set names the same `name@version` more than once, two that are equal
   * after Unicode NFC, lower case, upper case, lower case again and NFC again
   * counting as one. Two that differ only in letter case name one directory on
   * macOS and Windows, and two that differ only in Unicode normalization name
   * one on macOS; both are refused on every platform, so that one rule holds
   * wherever the set is written. The fold is wider than any one file
   * system's, so a few pairs a file system keeps apart, such as `ı` and `I`,
   * are refused too. Every occurrence is refused, because nothing says which
   * of them is the one meant.
   */
  | 'duplicate'

/** One entry `replace` refused, and why. */
export interface IntakeRefusal {
  /** The entry's skill name. */
  readonly name: string
  /** The entry's organization manifest version. */
  readonly version: string
  /** Which rule refused it. */
  readonly code: IntakeRefusalCode
  /** One English sentence for an operator, naming the refused value. */
  readonly detail: string
}

/**
 * What one `replace` call did. The union is closed: `ok` and `failed` are its
 * only members.
 */
export type IntakeResult =
  /** Every entry not in `refused` is installed and offered; no refused entry was written. */
  | { readonly kind: 'ok'; readonly refused: readonly IntakeRefusal[] }
  /**
   * The new set is not offered. The set offered before the call stays
   * offered while the fiber holding it is active; a fiber that stops
   * withdraws the set it handed over, so where the calling fiber held that
   * set and stopped, before or while the new set was written, or where the
   * row stopped, no set is offered. The organization root is as it was,
   * except where the calling fiber or the row stopped while the set was being
   * written; then the root already holds the new set, and a later call
   * handing over the same files writes nothing.
   */
  | { readonly kind: 'failed'; readonly detail: string }

/**
 * `ctx.skillPackIntake`: installs the skill packs an organization hands over,
 * and answers which of them may be offered now. The skill-pack row provides it
 * only where `organizationRoot` is configured.
 *
 * The plugin handing the packs over is their only skill provider: this
 * package reports none of them to `ctx.skills`, and only installs them, judges
 * them, and hands their views to the component surface.
 */
export interface SkillPackIntake {
  /**
   * Replace the organization root with `packs`.
   *
   * Each entry is judged on its own: an entry breaking a rule is refused and
   * not written. The accepted entries are staged and swapped in together, so
   * the root holds all of them or is left as it was. An entry waiting for a
   * plugin, a part or a platform version installs and stays inactive until
   * that arrives, without a restart. `replace([])` withdraws the set and
   * empties the root.
   *
   * The calling fiber — the fiber of the context the caller read
   * `skillPackIntake` from, an `inject` callback's own fiber included — holds
   * the set it hands over: once written, the set is offered through
   * {@link SkillPackIntake.isActive}, `ctx.skillPacks.activeViews()` and the
   * status route for as long as that fiber is active, and withdrawn when it
   * stops, its files staying on disk. Nothing is offered after a process
   * starts until the first `replace`. A set already on disk byte for byte is
   * offered without being written again.
   *
   * When the promise resolves with `ok`, `isActive` already answers from the
   * new set, and every `onChange` listener has been called after it was
   * offered. Calls run one at a time in the order they arrive, and the last
   * one offered is the set offered. A call that reaches its turn after this
   * row has stopped, whose calling fiber is no longer active when its turn
   * comes or when its write finishes, whose row stops while its set is
   * written, or whose read or write of the organization root fails, answers
   * `failed` and offers nothing new.
   * @param packs - every entry to offer, keyed by name and version.
   * @param options - `signal` rejects the call with its `reason`, changing
   *   nothing, while the call waits for its turn or before it writes; once the
   *   write starts the call no longer reads it.
   * @returns which entries were refused and why, or why the new set is not offered.
   */
  replace(packs: readonly OrgPackInput[], options?: { readonly signal?: AbortSignal }): Promise<IntakeResult>
  /**
   * Whether one entry may be offered now, judged synchronously against the
   * offered set and the parts registered at the moment of the call.
   * @param name - the entry's skill name.
   * @param version - the entry's organization manifest version.
   * @returns `true` when the offered set holds the entry and its parts, plugins,
   *   platform range, anchor format and views are all met.
   */
  isActive(name: string, version: string): boolean
  /**
   * Watch for a change in what {@link SkillPackIntake.isActive} answers: a set
   * offered or withdrawn, or the registered parts changing. The listener is
   * called after the change, so the read it makes sees it. The watch lasts as
   * long as the calling fiber.
   * @param listener - called after each change; it reads `isActive` again.
   * @returns the disposer that stops the watch.
   */
  onChange(listener: () => void): () => void
}
