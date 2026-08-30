/**
 * Server-menu domain: the durable shape, its schema, and the settings
 * namespace this package's node half registers.
 *
 * Persistence is per-account because it rides the settings capability: the
 * local file provider's document lives at `$DSH_HOME/settings.yaml`, and this
 * deployment shape is one process per signed-in user (see the package
 * README's workflows section). One document carries two independent facts:
 * the persistent 工作台 (workbench) conversation's id, and the user's own
 * named workflow shortcuts. A workflow's `homeSessionId` is a weak reference
 * to a session id — see {@link ServerMenuWorkflow} — because nothing here
 * owns session deletion and a stale pointer must not corrupt the document it
 * lives in.
 */

import z from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'

/** Settings namespace this package owns. */
export const SERVER_SIDEBAR_NAMESPACE: SettingsNamespace = settingsNamespace('server-sidebar')

/**
 * One workflow: a user-named shortcut back to the one conversation it binds
 * (v1 boundary: one workflow binds one conversation, decision ⑥). `id` is
 * the stable primary key that a rename or a degraded re-creation never
 * changes; `homeSessionId` is a weak reference to a session id — this
 * package never observes session deletion, so a workflow naming a session
 * the workspace domain no longer lists is expected, not corrupt. Opening a
 * workflow whose session is gone re-creates one and repoints
 * `homeSessionId` at it rather than dropping the workflow (decision ⑧; see
 * the package README).
 */
export interface ServerMenuWorkflow {
  /** Stable identity, generated once at save time; survives a degraded re-creation. */
  id: string
  /** The user's own name for the workflow. */
  name: string
  /** Display order among workflows, ascending; ties break on `id`. User-dragged (decision ⑤). */
  order: number
  /** The conversation this workflow currently binds; a weak reference (see above). */
  homeSessionId: string
  /**
   * The content-column page ids shown in the bound conversation at save
   * time, oldest first — replayed in this order into a re-created
   * conversation so the last one replayed ends up on display, matching what
   * was on display when the workflow was saved. Chart-kind entries are not
   * captured (v1 boundary; see the package README).
   */
  navSnapshot: string[]
  /** When this workflow was first saved (epoch ms); unchanged by a later re-creation. */
  savedAt: number
}

/** Durable section this package's namespace resolves to. */
export interface ServerMenuSettings {
  /** Every workflow, in no particular storage order — `order` is what the menu sorts by. */
  workflows: ServerMenuWorkflow[]
  /**
   * The persistent 工作台 (workbench) conversation's id; a weak reference,
   * absent until the workbench entry is clicked for the first time. Resolved
   * fresh at render time exactly like a workflow's `homeSessionId` — see the
   * package README.
   */
  workbenchSessionId?: string
}

/** Durable schema; also the wire shape the server-menu route validates a patch's merged result against. */
export const ServerMenuSettingsSchema: z<ServerMenuSettings> = z.object({
  workflows: z.array(z.object({
    id: z.string().required(),
    name: z.string().required(),
    order: z.number().required(),
    homeSessionId: z.string().required(),
    navSnapshot: z.array(z.string()).default([]),
    savedAt: z.number().required(),
  })).default([]),
  workbenchSessionId: z.string(),
})

/**
 * Reject a server-menu document with a duplicate workflow id — the one
 * constraint the schema alone cannot express (schemastery validates shape,
 * not cross-element uniqueness).
 * @param value - the resolved section, schema-valid by construction.
 * @throws {Error} when two workflows share an id.
 */
export function validateServerMenu(value: ServerMenuSettings): void {
  const seen = new Set<string>()
  for (const workflow of value.workflows) {
    if (seen.has(workflow.id)) {
      // Unprefixed: this message's one consumer (the server-menu route's error
      // response) adds the "server-sidebar:" prefix itself, alongside every
      // other write failure it wraps the same way.
      throw new Error(`duplicate workflow id "${workflow.id}"`)
    }
    seen.add(workflow.id)
  }
}
