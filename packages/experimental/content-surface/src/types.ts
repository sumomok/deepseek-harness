/**
 * Pure types of the content-surface domain: the ONE home of the
 * `contentSurface` projection key, the `content-surface/dismissed` and
 * `content-surface/selected` session events, and the entry vocabulary both
 * halves read, free of this package's host-side value imports (zod, cordis).
 * The package root re-exports it for host consumers; the browser column
 * imports this subpath directly, so neither side duplicates a declaration.
 *
 * @module @deepseek-ai/dsh-experimental-content-surface/types
 */

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * The user closed one entry's tab in the switcher strip. Fold-only: no
     * extractor recognizes it, and the `contentSurface` unit removes the
     * named `(kind, entryId)` record on sight — see `projection.ts`'s
     * `apply`. Re-recording the same pair later (the agent redraws the
     * chart, the user re-navigates to the page) is an ordinary fresh record
     * and resurrects it as a new entry, exactly as if it had never been
     * dismissed; this event only ever removes, never suppresses future
     * writes.
     */
    'content-surface/dismissed': {
      /** The dismissed entry's kind. */
      kind: string
      /** The dismissed entry's id within `kind`. */
      entryId: string
      /** Always `'user'` today: dismissal is a switcher-strip gesture, never something the agent does on its own. */
      by: 'user'
    }
    /**
     * The user brought one entry's tab to the front of the switcher strip.
     * Fold-only like dismissal — no extractor recognizes it — and the one
     * event that changes nothing about which entries exist: the
     * `contentSurface` unit stores the named `(kind, entryId)` together with
     * this event's own seq, and `view` compares that seq against the newest
     * entry's to decide the stream's `front`. A selection therefore holds the
     * front only until a later record arrives, which is what puts a page the
     * agent has just shown in front of a tab the user clicked earlier.
     * Naming a pair that is not live is harmless: `front` falls back to the
     * newest entry, exactly as if nothing had been selected.
     */
    'content-surface/selected': {
      /** The selected entry's kind. */
      kind: string
      /** The selected entry's id within `kind`. */
      entryId: string
      /** Always `'user'` today: selection is a switcher-strip gesture. */
      by: 'user'
    }
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    contentSurface: ContentSurfaceFold
  }
  interface SessionProjectionMap {
    /**
     * The content entries one session's log produced, newest first. The host
     * folds it because the log and every extractor's configuration are the
     * host's; the browser resolves nothing and only decides which entry it
     * shows.
     */
    contentSurface: ContentSurfaceView
  }
}

/**
 * One entry as the fold stores it: the log-derived half, kept minimal so the
 * persisted checkpoint replays. One record per live entry survives the fold —
 * a later record naming the same kind and id replaces it — and `data` is
 * resolved into {@link ContentSurfaceEntry}'s `title` and `payload` at view
 * time, against whatever the kind's host row knows now.
 */
export interface ContentSurfaceRecord {
  /** The extractor that produced it; also the `content.surface.kind` key its renderer claims. */
  readonly kind: string
  /** Identity within the kind: a later record with the same pair replaces this one. */
  readonly entryId: string
  /** Log sequence number of the recording event, which is also the entry's position in the stream. */
  readonly seq: number
  /** Kind-owned plain JSON, opaque to this package. */
  readonly data: unknown
}

/** The entry one `content-surface/selected` event named, and when it did. */
export interface ContentSurfaceSelection {
  /** The selected entry's kind. */
  readonly kind: string
  /** The selected entry's id within `kind`. */
  readonly entryId: string
  /** Log sequence number of the selecting event, compared against the newest entry's own seq. */
  readonly seq: number
}

/**
 * Fold state of the `contentSurface` unit: the live records, and the last
 * selection the log recorded. The selection is kept whole rather than resolved
 * because the entry it names may be gone, replaced, or newer than it — all
 * three are decided in `view`, against the records as they stand then.
 */
export interface ContentSurfaceFold {
  /** One record per live entry, in first-appearance order. */
  readonly records: ContentSurfaceRecord[]
  /** The last entry the user brought to the front; absent until one is selected. */
  readonly selected?: ContentSurfaceSelection
}

/** One resolved entry, as the browser column receives it. */
export interface ContentSurfaceEntry {
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

/** Whole current value of the `contentSurface` projection. */
export interface ContentSurfaceView {
  /**
   * Every live entry, highest owning seq first, so `entries[0]` is what the
   * column shows until the user picks another. Replaced entries are absent:
   * one entry id yields one entry, owned by the last record that named it.
   */
  readonly entries: readonly ContentSurfaceEntry[]
  /**
   * The entry the log says is in front, absent only when `entries` is empty.
   * It is the selected entry when the log recorded a selection, that entry is
   * still live, and the selection came after the newest entry's own record;
   * otherwise it is `entries[0]`. Nothing the agent produces waits behind a
   * click the user made earlier, and nothing the user clicked is displaced by
   * an entry that was already there.
   */
  readonly front?: {
    /** The front entry's kind. */
    readonly kind: string
    /** The front entry's id within `kind`. */
    readonly entryId: string
  }
}
