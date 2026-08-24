# Content Surface

English | [中文](content-surface.zh.md)

The per-session stream of typed content entries behind the service-line shell's content column. `ctx.contentSurface` is an extractor table: each host row that wants the column registers what it recognizes in the session log, and the service folds every registered extractor into one `contentSurface` [session projection](session-projection.md). The [content-surface Agent Note](../../.agents/notes/implemented/feature/2026-08-24-content-surface-router.md) owns the routing decision; the [package README](../../packages/experimental/content-surface/README.md) owns composition and limits; this page records the literal contract and the fold's rules.

The surface appends no session event. Every entry is derived from a fact another package already logs, so the whole column replays from the log the agent wrote, and adding a kind adds no durable format.

## What a kind contributes

```ts type-equiv
/**
 * One kind's contribution to the content surface.
 *
 * Both functions MUST be synchronous and pure: `read` runs inside the session
 * projection's fold, and `resolve` runs inside its view, where an async result
 * would tear the carriers' consistency cut.
 */
interface ContentSurfaceExtractor<D> {
  /** The kind this extractor produces; also the `content.surface.kind` key its renderer claims. */
  readonly kind: string
  /**
   * Invalidation anchor for `data`: bump it whenever the stored shape or the
   * reading rules change, so persisted checkpoints written by the previous
   * version are discarded instead of handed to the new `resolve`.
   */
  readonly dataVersion: number
  /**
   * Read the entry one committed event records.
   * @param event - the committed session event.
   * @returns the draft, or `undefined` when the event records nothing for this kind.
   */
  read(event: SessionEvent): ContentSurfaceDraft<D> | undefined
  /**
   * Resolve one stored record against what this kind's host row knows now.
   * @param data - the `data` a previous `read` stored.
   * @returns the entry's title and the payload its renderer receives.
   */
  resolve(data: D): ContentSurfaceResolved
}
```

`read` names the entry an event records and the opaque JSON to store for it; `resolve` turns that stored value into the switcher's `title` and the renderer's `payload`. The split is what keeps history stable: only the log-derived half is folded and checkpointed, so a deployment that renames a page or retires a chart changes what the column shows without rewriting what the session recorded.

Events reach the extractors in registration order and the first draft wins, so two kinds must not claim one event.

## What the fold stores, what the column receives

```ts type-equiv
/**
 * One entry as the fold stores it: the log-derived half, kept minimal so the
 * persisted checkpoint replays. One record per live entry survives the fold —
 * a later record naming the same kind and id replaces it — and `data` is
 * resolved into {@link ContentSurfaceEntry}'s `title` and `payload` at view
 * time, against whatever the kind's host row knows now.
 */
interface ContentSurfaceRecord {
  /** The extractor that produced it; also the `content.surface.kind` key its renderer claims. */
  readonly kind: string
  /** Identity within the kind: a later record with the same pair replaces this one. */
  readonly entryId: string
  /** Log sequence number of the recording event, which is also the entry's position in the stream. */
  readonly seq: number
  /** Kind-owned plain JSON, opaque to this package. */
  readonly data: unknown
}
```

```ts type-equiv
/** One resolved entry, as the browser column receives it. */
interface ContentSurfaceEntry {
  /** The extractor that produced it; the `content.surface.kind` key whose renderer draws it. */
  readonly kind: string
  /** Identity within the kind; stable across the calls that replace one another. */
  readonly entryId: string
  /** Log sequence number of the record that currently owns the entry. */
  readonly seq: number
  /** One line naming the entry in the switcher strip. */
  readonly title: string
  /** Kind-owned plain JSON its renderer consumes; opaque to the column. */
  readonly payload: unknown
}
```

Replacement happens in the fold, not the view: a session that redraws one chart a hundred times carries one record. `(kind, entryId)` is the identity, kind-qualified so two kinds never collide on an id. The published view sorts by owning `seq` descending, so `entries[0]` is what the column shows until a viewer picks another. A record whose kind has left the table resolves to nothing rather than to a half-entry no renderer could draw.

## Registration timing and the fold version

The projection registry fixes a unit's `apply`, `view`, and `stateVersion` at registration, caches one folded cell per session, and never revisits a built cell. A table read live inside one long-lived unit would therefore leave every session whose cell predates a late extractor permanently missing that kind's history.

`ctx.contentSurface` registers a **new unit for every table change** instead. Dropping the old registration drops its cells with it, and each session's next touch refolds `init` over its whole in-memory log through the new table. `stateVersion` is the durable side of the same problem: it is the sorted `kind@dataVersion` list hashed into 31 bits, so a composition change discards persisted checkpoint rows rather than forward-applying them. The residual cost is push latency, not correctness — the registry publishes a changed value only while driving an event, so a browser already connected when a kind row is hot-loaded reads the previous stream until that session's next event.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxcontentsurface--contentsurfaceregistry"></a>

### `ctx.contentSurface` — `ContentSurfaceRegistry`

`ctx.contentSurface`: the extractor table behind the content column's entry stream, and the owner of the `contentSurface` projection unit.

**Registration timing is free.** The projection registry fixes a unit's fold and its `stateVersion` at registration and caches one folded cell per session, so a table read live inside one long-lived unit would leave every cell built before a late extractor arrived permanently missing that kind's history. This registry therefore registers a NEW unit for every table change: the registry drops the old unit's cells with it, and each session's next touch refolds `init` over its whole in-memory log through the new table. `stateVersion` is derived from the table for the same reason, so a persisted checkpoint written under a different set of kinds is discarded rather than forward-applied.

The one cost is push latency: the registry publishes a changed value only while driving an event, so a browser already connected when a kind row is hot-loaded reads the previous stream until that session's next event.

```ts cordis-catalog
/**
 * Register one kind's extractor. The registration is an effect on the
 * calling context's fiber: disposing the fiber (or calling the returned
 * disposer) removes the kind, and every session's stream refolds without it.
 * @param extractor - the kind, its data version, and its two pure functions.
 * @returns the exact disposer that unregisters this extractor.
 */
register<D>(extractor: ContentSurfaceExtractor<D>): () => void
```

Source: [`packages/experimental/content-surface/src/index.ts`](../../packages/experimental/content-surface/src/index.ts)
<!-- END GENERATED cordis-surface -->
