/**
 * Pure types of this package's vendor-view half: the ONE home of the two
 * session-event declarations this package writes and of the shape a deployment
 * writes a view in, free of the host-side value imports (zod, dsh-tools, node)
 * the rest of the package carries.
 *
 * A view is the same three values a `show_component` call carries — an entry
 * id, a title, and a spec — written by a person in `cordis.yml` instead of by
 * the model in a tool call. That is what lets one entry kind, one extractor and
 * one seat serve both: what differs is who wrote the spec, not what it is.
 * @module @deepseek-ai/dsh-experimental-component-surface/types
 */

import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { ComponentSpec } from './component-call.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * The user picked one of the deployment's configured views, and it is now
     * an entry in the content column. Written by the `show-content-view`
     * command — the sidebar's navigation click — and by nothing else.
     *
     * Log-only, and never a model-visible input: what the model is told about
     * the column is what the tool it called said, and a view the user opened
     * beside the conversation is the user's own doing. The entry it produces is
     * folded straight out of this event by the same extractor that folds a
     * call, so the column replays from the log alone.
     *
     * The whole spec is recorded rather than the view id alone, for the reason
     * a call's arguments are: an entry is self-contained. A view the deployment
     * later edits or drops still replays as what the user actually saw, and no
     * reader has to resolve a log against a configuration file it does not
     * have.
     *
     * Required on read, like the events the console's other content rows write:
     * the envelope's `ignorable` marker is not something an appending plugin
     * can set, so a runtime whose session vocabulary does not carry this type
     * refuses the whole log rather than skipping the event. Every build of this
     * repository knows the type; a separately built runtime that excluded this
     * package would not.
     */
    'content-component/shown': {
      /**
       * The content-column entry this now owns, which is the configured view's
       * own id as `views` declares it: a view owns exactly one entry, so a
       * second click on the same view replaces what that entry shows. Named for
       * the entry rather than the view because the column keys its records on
       * this field and folds this event without knowing that a view id is one.
       */
      entryId: string
      /** The line the user reads on the entry's tab, as `views` declares it. */
      title: string
      /** The blocks to draw, exactly as load-time validation accepted them. */
      spec: ComponentSpec
      /** Always `'user'`: a view reaches the column by a person's click, never by anything the agent does. */
      by: 'user'
    }
    /**
     * A `show_component` call asked the user before drawing, and this is the
     * whole entry the answer allowed: a call that read rows out of the
     * deployment's own data backend, with the rows in it, or a call that opens
     * the deployment's own data page, which the host reads nothing for and
     * records with an empty `fetched`. Written by the tool itself, once the
     * user allowed the call and — for a read — every table answered, and by
     * nothing else.
     *
     * Log-only, and never a model-visible input. What the model receives is the
     * arguments it wrote plus a result line counting rows and naming attributes;
     * the rows themselves reach the browser seat and this record and go nowhere
     * near a model request.
     *
     * The whole filled spec is recorded rather than the rows alone, because the
     * column's reader is per-event, synchronous and pure: it cannot join a base
     * spec in one record to rows in another, and the later record for an entry
     * id replaces the earlier one outright. It is recorded rather than replayed
     * for the further reason that replaying would mean reading the backend
     * again — a second read of a person's data, at a moment nobody asked for it,
     * possibly answering differently.
     *
     * There is no `by` field, unlike `content-component/shown`: a view can be
     * opened by a person and a call cannot, so there is only one writer to name.
     *
     * Required on read, like this package's other event and for the same reason:
     * the envelope's `ignorable` marker is not something an appending plugin can
     * set, so a runtime whose session vocabulary does not carry this type
     * refuses the whole log rather than skipping the event.
     */
    'content-component/resolved': {
      /** The tool call the rows were read for, which pairs this with that call's own `tool/call`. */
      callId: ToolCallId
      /** The content-column entry this now owns, which is the call's `id`. */
      entryId: string
      /** The line the user reads on the entry's tab, as the call wrote it. */
      title: string
      /** The blocks to draw with the rows already in them, exactly as validation accepted them. */
      spec: ComponentSpec
      /**
       * What each read returned: never a cell, only the counts and the
       * attribute names the model was told, so this record carries no row
       * content that the spec above does not already carry. Empty for a call
       * that opened a data page, which read nothing on the host.
       */
      fetched: {
        /** The block the rows went into. */
        nodeId: string
        /** The table they were read from, by its name in the backend. */
        meta: string
        /** How many rows arrived. */
        rows: number
        /** How many rows match across every page, where the backend reported it. */
        total?: number
        /** The attributes this read asked for, which are the only ones the rows above carry. */
        columns: string[]
      }[]
    }
  }
}

/** One view a deployment configures, as `cordis.yml` writes it and before anything has judged it. */
export interface ContentView {
  /**
   * Stable id of the view, and of the content-column entry it owns. Read
   * exactly as a `show_component` entry id is — the same alphabet and the same
   * ceiling — because it becomes one.
   */
  readonly id: string
  /** Short phrase naming the entry for the user, on the same ceiling a call's title is read against. */
  readonly title: string
  /**
   * What to draw, in the structure `show_component`'s own `spec` parameter
   * takes. Judged at load by the same pass that judges a call, so a deployment
   * learns about a broken view when the row loads rather than when a user first
   * clicks it.
   */
  readonly spec: unknown
}
