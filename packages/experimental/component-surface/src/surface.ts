/**
 * This package's contribution to the content column's entry stream: the
 * `component` kind.
 *
 * One entry per id, so a correction and the call it corrects are one row in the
 * column's switcher and the later one owns it — and a configured view the user
 * opens twice is that same one row, because a view owns one entry too
 * (`projection.ts` reads all four log shapes into the same three values). The
 * entry carries the validated spec itself — the record is self-contained,
 * everything the seat draws is in it — so nothing is resolved against live
 * state at view time and the column can draw a block without reaching into the
 * conversation it sits in.
 *
 * A call the tool refused is still in the log, and this extractor runs the same
 * judgement over it: an unreadable or refused call records no entry at all,
 * rather than an entry whose seat would have nothing to draw. A view's event
 * takes the identical pass — its spec was judged once at load, and judging the
 * record rather than trusting it is what keeps one reading of the log. It is
 * also what makes a call that reads its rows from the data backend produce
 * exactly one entry: that call's own `tool/call` names blocks with no rows in
 * them, fails this pass, and records nothing, while the
 * `content-component/resolved` written after the rows arrived carries the whole
 * filled spec and records the entry. A call that opens the deployment's own
 * data page passes this pass and is left out by `recordsEntry` instead: its
 * entry is the `content-component/resolved` the tool appends once the user has
 * agreed, and nothing before that answer.
 *
 * `dataVersion` is 2. The stored record is the same two fields it always was;
 * what changed is which log shapes are read into one, so a checkpoint written
 * by a build that did not read the fourth shape is discarded and refolded
 * rather than replayed as a column missing every read.
 *
 * `resolve` deliberately consults no catalog. The catalog is a build-time table
 * that grows and changes; a persisted checkpoint written before a component was
 * renamed must still resolve, and it is the seat — which knows which renderers
 * it actually has — that reports a block it cannot draw. What `resolve` does
 * check is that the record has the two fields it reads, because a persisted
 * checkpoint is plain JSON whose declared type is a claim, and one throw here
 * takes the whole `contentSurface` view down — every kind's entries, not just
 * this one's.
 * @module @deepseek-ai/dsh-experimental-component-surface/src/surface
 */

import type { ContentSurfaceExtractor } from '@deepseek-ai/dsh-experimental-content-surface'
import { COMPONENT_KIND, type ComponentSpec, type ComponentSurfacePayload } from './component-call.ts'
import { readComponentEvent, recordsEntry } from './projection.ts'
import { validateComponentCall } from './validate.ts'

/** What a `component` entry stores, which is also what its renderer receives. */
export interface ComponentSurfaceData {
  /** The user-facing line naming the entry in the switcher strip. */
  readonly title: string
  /** The blocks to draw, exactly as validation accepted them. */
  readonly spec: ComponentSpec
}

/** One stored record's fields as a checkpoint carries them, before anything has judged them. */
interface StoredRecord {
  /** The `title` a previous `read` stored, however malformed. */
  readonly title?: unknown
  /** The `spec` a previous `read` stored, however malformed. */
  readonly spec?: unknown
}

/**
 * Switcher line for a record this build cannot read.
 *
 * Chinese for the same reason the catalog's labels are: it is the line an end
 * user reads on a tab, not model-facing text. The kind carries no dictionary on
 * the host, and a title is data rather than copy the seat could translate.
 */
const UNREADABLE_TITLE = '无法显示的内容'

/**
 * Read the two fields a stored record is used for: the switcher line `resolve`
 * serves, and the spec the action command resolves a reported action against.
 * @param data - the stored record, as a live fold or a persisted checkpoint carries it.
 * @returns the record's fields, or `undefined` when it is not a record this build can read.
 */
export function readComponentSurfaceData(data: unknown): ComponentSurfaceData | undefined {
  if (data === null || typeof data !== 'object') return undefined
  const { title, spec } = data as StoredRecord
  if (typeof title !== 'string') return undefined
  if (spec === null || typeof spec !== 'object') return undefined
  // The nodes inside are not checked here, and deliberately: the seat re-judges
  // the whole spec against the catalog it actually has. What this asserts is
  // only the payload's declared type.
  return { title, spec: spec as ComponentSpec }
}

/**
 * Build the `component` extractor.
 * @returns the extractor to hand to `ctx.contentSurface.register`.
 */
export function componentExtractor(): ContentSurfaceExtractor<ComponentSurfaceData> {
  return {
    kind: COMPONENT_KIND,
    dataVersion: 2,
    read: (event) => {
      const args = readComponentEvent(event)
      if (args === undefined) return undefined
      const result = validateComponentCall(args)
      if (!result.ok) return undefined
      if (!recordsEntry(event, result.call.spec)) return undefined
      return { entryId: result.call.id, data: { title: result.call.title, spec: result.call.spec } }
    },
    resolve: (data) => {
      const record = readComponentSurfaceData(data)
      // A record with no spec still becomes an entry rather than nothing: the
      // extractor contract has no "skip" answer, and a payload the seat refuses
      // is already one sentence in the column.
      if (record === undefined) return { title: UNREADABLE_TITLE, payload: undefined }
      return { title: record.title, payload: { spec: record.spec } satisfies ComponentSurfacePayload }
    },
  }
}
