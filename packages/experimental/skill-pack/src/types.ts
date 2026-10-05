/**
 * The values this package hands across its own edges: what a pack's manifest
 * says, what a component plugin has registered, what reconciliation answered,
 * what the status route publishes, and what a delivery is made of.
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
   * id is settled by the pack root instead, which withholds both of them.
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
  /** Another pack this root would otherwise offer declares one of this pack's view ids, so neither is offered. */
  | { readonly kind: 'view-id-conflict'; readonly id: string; readonly pack: string }

/** One pack's state and, when it is inactive, every reason it is. */
export interface PackStatus {
  /** The skill name the pack's frontmatter declares, which is how a user and the model address it. */
  readonly skill: string
  /** The pack's own version; absent when the manifest did not parse far enough to carry one. */
  readonly version?: string
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
  /** Every pack in the pack root, in skill-name order, active and inactive alike. */
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
