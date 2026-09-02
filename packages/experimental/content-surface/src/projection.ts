/**
 * The `contentSurface` projection unit: one session's content entries, folded
 * from whatever the registered extractors recognize in its log.
 *
 * The split mirrors every other unit in the repository. The fold keeps only
 * what the log said — kind, entry id, seq, and the extractor's opaque `data` —
 * and `view` resolves each surviving record against what the kind's host row
 * knows now, so a deployment that renames a page or retires a chart does not
 * rewrite history. One record per `(kind, entryId)` pair survives the fold: a
 * later record naming the same pair replaces the earlier one in place, which is
 * what makes a redrawn chart one entry rather than two.
 *
 * A `content-surface/dismissed` event removes its named `(kind, entryId)`
 * record outright rather than replacing it — the one case `apply` handles
 * without consulting the extractor table at all, since dismissal names the
 * pair to remove directly. A later record naming the same pair (the agent
 * redraws the chart, the user re-navigates to the page) is an ordinary fresh
 * insert once the old one is gone, so a dismissed-then-redrawn entry
 * resurrects exactly like one that was never dismissed.
 *
 * A `content-surface/selected` event is the other case `apply` handles without
 * the extractor table, and the only one that leaves the records untouched: it
 * replaces the stored selection with the pair it names and this event's own
 * seq. Which entry that puts in front is decided in `view`, because the answer
 * depends on records the selection knows nothing about — see {@link frontOf}.
 * @module @deepseek-ai/dsh-experimental-content-surface/src/projection
 */

import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
// Type-only: pulls this package's own `contentSurface` projection declarations.
import type {
  ContentSurfaceEntry, ContentSurfaceFold, ContentSurfaceRecord, ContentSurfaceSelection, ContentSurfaceView,
} from './types.ts'
import { foldVersion, type ErasedExtractor } from './extractor.ts'

/** The `contentSurface` unit as the registry's client-visible overload takes it: `wire` is required, not optional. */
type ContentSurfaceProjectionDefinition =
  & Omit<ProjectionDefinition<'contentSurface', ContentSurfaceFold>, 'wire'>
  & { wire: NonNullable<ProjectionDefinition<'contentSurface', ContentSurfaceFold>['wire']> }

/** One folded record, as the persisted checkpoint carries it. */
const recordSchema = zod.object({
  kind: zod.string(),
  entryId: zod.string(),
  seq: zod.number(),
  // Kind-owned and opaque here; `dataVersion` is each kind's own anchor for it.
  data: zod.json(),
})

/**
 * Fold state: one record per live entry, plus the last selection the log
 * recorded.
 *
 * The transform is what makes an absent optional absent rather than present
 * and undefined: zod types an `.optional()` key as `T | undefined`, while the
 * domain says `selected?: T`, and the two serialize identically on the JSON a
 * checkpoint carries. The same normalization runs on {@link viewSchema}.
 */
const stateSchema: ZodType<ContentSurfaceFold> = zod.object({
  records: zod.array(recordSchema),
  selected: zod.object({ kind: zod.string(), entryId: zod.string(), seq: zod.number() }).optional(),
}).transform(({ records, selected }) => ({
  records,
  ...selected === undefined ? {} : { selected },
}))

/** Wire payload schema of the `contentSurface` projection. */
const viewSchema: ZodType<ContentSurfaceView> = zod.object({
  entries: zod.array(zod.object({
    kind: zod.string(),
    entryId: zod.string(),
    seq: zod.number(),
    title: zod.string(),
    payload: zod.json(),
  })),
  front: zod.object({ kind: zod.string(), entryId: zod.string() }).optional(),
}).transform(({ entries, front }) => ({
  entries,
  ...front === undefined ? {} : { front },
}))

/** Registry cell of one record's identity; kind-qualified so two kinds never collide on an id. */
function cellOf(record: { kind: string; entryId: string }): string {
  return `${record.kind}\x00${record.entryId}`
}

/**
 * Read the record one committed event contributes, through the first extractor
 * that recognizes it.
 * @param event - the committed session event.
 * @param extractors - the registered table.
 * @returns the record, or `undefined` when no extractor recognized the event.
 */
function recordOf(event: SessionEvent, extractors: readonly ErasedExtractor[]): ContentSurfaceRecord | undefined {
  for (const extractor of extractors) {
    const draft = extractor.read(event)
    if (draft !== undefined) return { kind: extractor.kind, entryId: draft.entryId, seq: event.seq, data: draft.data }
  }
  return undefined
}

/**
 * Remove the record a `content-surface/dismissed` event names, if one is
 * still live.
 * @param state - the folded records before this event.
 * @param dismissed - the event's own `{ kind, entryId }`.
 * @returns `state` with the named record absent; `state` itself (same
 * reference) when no record named that pair.
 */
function withoutDismissed(
  state: ContentSurfaceRecord[],
  dismissed: { kind: string; entryId: string },
): ContentSurfaceRecord[] {
  const cell = cellOf(dismissed)
  const next = state.filter(stored => cellOf(stored) !== cell)
  return next.length === state.length ? state : next
}

/**
 * The same fold with different records, carrying the selection over.
 * @param state - the fold before this event.
 * @param records - the records after it.
 * @returns a new fold; the caller has already established that something changed.
 */
function withRecords(state: ContentSurfaceFold, records: ContentSurfaceRecord[]): ContentSurfaceFold {
  return { records, ...state.selected === undefined ? {} : { selected: state.selected } }
}

/**
 * The same fold with a different selection, carrying the records over.
 *
 * Selecting the pair that is already selected still produces a new fold: the
 * seq moved, and the seq is what {@link frontOf} compares.
 * @param state - the fold before this event.
 * @param selected - the pair the event named, with its own seq.
 * @returns a new fold.
 */
function withSelection(state: ContentSurfaceFold, selected: ContentSurfaceSelection): ContentSurfaceFold {
  return { records: state.records, selected }
}

/**
 * The entry the stream says is in front.
 *
 * A selection outranks the newest entry only while it is later than that
 * entry's own record. That single comparison carries both halves of the rule:
 * an entry the agent produced after the click takes the front (the user's
 * earlier choice gives way to what just arrived), and an entry that was
 * already there when the user clicked does not (the click is what the user
 * last said). A selection naming an entry that is no longer live — replaced,
 * dismissed, or produced by a kind that has left the table — resolves to the
 * newest entry, which is the same answer as no selection at all.
 * @param entries - the live entries, newest first.
 * @param selected - the last selection the log recorded, when there is one.
 * @returns the front entry's pair, or `undefined` when there are no entries.
 */
function frontOf(
  entries: readonly ContentSurfaceEntry[],
  selected: ContentSurfaceSelection | undefined,
): ContentSurfaceView['front'] {
  const newest = entries[0]
  if (newest === undefined) return undefined
  if (selected !== undefined && selected.seq > newest.seq) {
    const chosen = entries.find(entry => entry.kind === selected.kind && entry.entryId === selected.entryId)
    if (chosen !== undefined) return { kind: chosen.kind, entryId: chosen.entryId }
  }
  return { kind: newest.kind, entryId: newest.entryId }
}

/**
 * Resolve the whole current value from the folded state.
 *
 * A record whose kind has since left the table resolves to nothing rather than
 * to a half-entry the column could not draw: the composition that produced it
 * is gone, and the entry with it.
 * @param state - the folded records and the recorded selection.
 * @param extractors - the registered table.
 * @returns the live entries, newest first, and the entry in front.
 */
function resolveView(state: ContentSurfaceFold, extractors: readonly ErasedExtractor[]): ContentSurfaceView {
  const byKind = new Map(extractors.map(extractor => [extractor.kind, extractor]))
  const entries: ContentSurfaceEntry[] = state.records
    .flatMap((record) => {
      const extractor = byKind.get(record.kind)
      if (extractor === undefined) return []
      const resolved = extractor.resolve(record.data)
      return [{ kind: record.kind, entryId: record.entryId, seq: record.seq, title: resolved.title, payload: resolved.payload }]
    })
    // Newest first: the column shows entries[0] until the user picks another.
    .sort((left, right) => right.seq - left.seq)
  const front = frontOf(entries, state.selected)
  return { entries, ...front === undefined ? {} : { front } }
}

/**
 * Build the `contentSurface` unit for one extractor table.
 *
 * The table is captured here rather than read live, because `stateVersion` has
 * to describe the fold the unit actually performs; the registry owner registers
 * a fresh unit whenever the table changes.
 * @param extractors - the registered table, captured for this unit's lifetime.
 * @returns the definition to hand to `ctx.sessionProjections.register`.
 */
export function contentSurfaceProjection(extractors: readonly ErasedExtractor[]): ContentSurfaceProjectionDefinition {
  const table = [...extractors]
  return {
    key: 'contentSurface',
    stateSchema,
    init: () => ({ records: [] }),
    apply: (state: ContentSurfaceFold, event: SessionEvent) => {
      // The two cases that do not run the extractor table: both name their
      // subject directly, and no extractor would recognize either event type
      // anyway.
      if (event.type === 'content-surface/selected') {
        return withSelection(state, { kind: event.data.kind, entryId: event.data.entryId, seq: event.seq })
      }
      if (event.type === 'content-surface/dismissed') {
        const records = withoutDismissed(state.records, event.data)
        return records === state.records ? state : withRecords(state, records)
      }
      const record = recordOf(event, table)
      if (record === undefined) return state
      // Replacement happens in the fold rather than the view, so a session that
      // redraws one chart a hundred times carries one record, not a hundred —
      // a kind may store a whole document, and this state is checkpointed.
      const cell = cellOf(record)
      const at = state.records.findIndex(stored => cellOf(stored) === cell)
      return withRecords(state, at === -1
        ? [...state.records, record]
        : state.records.map((stored, index) => (index === at ? record : stored)))
    },
    wire: { viewSchema, view: state => resolveView(state, table) },
    stateVersion: foldVersion(table),
  }
}
