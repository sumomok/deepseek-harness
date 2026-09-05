/**
 * Server-menu domain: the durable shape, its schema, and the settings
 * namespace this package's node half registers.
 *
 * Persistence is per-account because it rides the settings capability: the
 * local file provider's document lives at `$DSH_HOME/settings.yaml`, and this
 * deployment shape is one process per signed-in user (see the package
 * README's workflows section). One document carries three independent facts:
 * the persistent 工作台 (workbench) conversation's id, the user's own named
 * workflow shortcuts, and the groups those shortcuts are filed under. A
 * workflow's `homeSessionId` is a weak reference to a session id — see
 * {@link ServerMenuWorkflow} — because nothing here owns session deletion and
 * a stale pointer must not corrupt the document it lives in.
 */

import z from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'

/** Settings namespace this package owns. */
export const SERVER_SIDEBAR_NAMESPACE: SettingsNamespace = settingsNamespace('server-sidebar')

/**
 * Which catalog one captured navigation stop came from: a
 * `dsh-experimental-content-frame` page, or a
 * `dsh-experimental-component-surface` composed view. The two are replayed
 * through different commands and land as different content-surface entry
 * kinds, so the snapshot has to carry which one it is rather than an id
 * alone.
 */
export type NavSnapshotKind = 'page' | 'view'

/** One captured navigation stop. */
export interface NavSnapshotItem {
  /** Which catalog it came from. */
  kind: NavSnapshotKind
  /** Its id within that catalog: a page id, or a view id. */
  entryId: string
}

/** How an operator converts a pre-`kind` settings document, named by {@link legacyNavSnapshotMessage}. */
export const NAV_SNAPSHOT_CONVERTER
  = 'pnpm --filter @deepseek-ai/dsh-experimental-server-sidebar run convert-nav-snapshot <settings file> [--dry-run]'

/**
 * Build the refusal for a `navSnapshot` entry still stored in the pre-`kind`
 * `string[]` form.
 *
 * Refused rather than read as a page id (which is what every stored one
 * meant): a document the process silently reinterprets is one nothing ever
 * converts, and this repository's pre-release stance rejects old on-disk
 * formats outright. The message carries the conversion command because the
 * only party that can act on it is an operator looking at a failed boot.
 * @param entry - the offending entry, as stored.
 * @returns the refusal text.
 */
export function legacyNavSnapshotMessage(entry: string): string {
  // Unprefixed with the package name for the reason `validateServerMenu`'s own
  // message is: the server-menu route adds that prefix to every write failure
  // it wraps. A load-time refusal reaches an operator through the failed
  // plugin row, which names the package itself.
  return `server-menu: navSnapshot entry ${JSON.stringify(entry)} is the pre-view string form; convert the settings document once with \`${NAV_SNAPSHOT_CONVERTER}\``
}

/**
 * What one stored `navSnapshot` element is allowed to parse as before
 * {@link NavSnapshotItemSchema} rules on it: the current pair, or the pre-view
 * `string` form. Refusing the old form by name needs it admitted here first —
 * schemastery's union discards a failing member's error and reports its own
 * "expected ..." text, so the refusal cannot live in a union member.
 *
 * Annotated rather than inferred because `z.object`'s inferred INPUT type
 * marks every property optional and nullable regardless of `.required()`,
 * while the value a transform callback actually receives is the resolved
 * output. The annotation states the resolved element type, which is what the
 * callback is handed.
 */
const NavSnapshotElement: z<string | NavSnapshotItem> = z.union([
  z.string(),
  z.object({
    kind: z.union([z.const('page'), z.const('view')]).required(),
    entryId: z.string().required(),
  }),
])

/** Element schema for {@link ServerMenuWorkflow.navSnapshot}: the stored pair, refusing the pre-view form by name. */
const NavSnapshotItemSchema: z<NavSnapshotItem> = z.transform(
  NavSnapshotElement,
  (value): NavSnapshotItem => {
    if (typeof value === 'string') throw new Error(legacyNavSnapshotMessage(value))
    return value
  },
)

/**
 * Group id the sidebar reserves for the conversations a user never named:
 * the one group nobody creates, renames, or deletes, and therefore the one
 * group that is never stored in {@link ServerMenuSettings.groups}. A
 * workflow's `groupId` naming it resolves against this constant instead (see
 * {@link validateServerMenu}), and its label comes from the `serverSidebar`
 * dictionary rather than from a stored `name`.
 *
 * Not a UUID, so a group a user creates cannot collide with it; a stored
 * group claiming it is refused rather than allowed to shadow it.
 *
 * Nothing renders groups yet — this is the durable half landing one format
 * change ahead of the interface that reads it (see the package README).
 */
export const TEMPORARY_GROUP_ID = 'temporary'

/** Longest a user-typed group name may be, in UTF-16 code units. */
const MAX_GROUP_NAME_LENGTH = 40

/**
 * One group: a user-named folder over their own workflows. Groups sort by
 * `pinned` first, then `order`; a workflow files itself into one by naming
 * its {@link ServerMenuGroup.id}, and a workflow naming none is ungrouped.
 */
export interface ServerMenuGroup {
  /** Stable identity, generated once at creation (a UUID); survives a rename. */
  id: string
  /** The user's own name for the group; non-empty, at most 40 characters. */
  name: string
  /** Whether the group sorts ahead of every unpinned one. */
  pinned: boolean
  /** Display order among groups of equal `pinned`, ascending. */
  order: number
}

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
   * The navigation stops shown in the bound conversation at save time,
   * oldest first — replayed in this order into a re-created conversation so
   * the last one replayed ends up on display, matching what was on display
   * when the workflow was saved. Only the two navigable kinds are captured;
   * a chart the agent drew is not (v1 boundary; see the package README).
   */
  navSnapshot: NavSnapshotItem[]
  /** When this workflow was first saved (epoch ms); unchanged by a later re-creation. */
  savedAt: number
  /**
   * The group this workflow is filed under: a stored {@link ServerMenuGroup}'s
   * id, or {@link TEMPORARY_GROUP_ID}. Absent means ungrouped, which is what
   * every workflow saved so far is.
   */
  groupId?: string
}

/** Durable section this package's namespace resolves to. */
export interface ServerMenuSettings {
  /** Every workflow, in no particular storage order — `order` is what the menu sorts by. */
  workflows: ServerMenuWorkflow[]
  /**
   * Every user-created group, in no particular storage order — `pinned` and
   * `order` are what the menu sorts by. {@link TEMPORARY_GROUP_ID}'s group is
   * never among them (see that constant).
   */
  groups: ServerMenuGroup[]
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
    navSnapshot: z.array(NavSnapshotItemSchema).default([]),
    savedAt: z.number().required(),
    groupId: z.string(),
  })).default([]),
  groups: z.array(z.object({
    id: z.string().required(),
    name: z.string().required(),
    pinned: z.boolean().default(false),
    order: z.number().required(),
  })).default([]),
  workbenchSessionId: z.string(),
})

/**
 * Reject the cross-element constraints the schema alone cannot express
 * (schemastery validates shape, not uniqueness or references between
 * elements): a duplicate workflow or group id, a group name a row cannot
 * show, a group claiming the reserved temporary id, and a workflow filed
 * under a group nothing defines.
 *
 * Every message here is unprefixed: their one consumer (the server-menu
 * route's error response) adds the "server-sidebar:" prefix itself, alongside
 * every other write failure it wraps the same way.
 * @param value - the resolved section, schema-valid by construction.
 * @throws {Error} when any of those constraints is broken.
 */
export function validateServerMenu(value: ServerMenuSettings): void {
  const groupIds = new Set<string>()
  for (const group of value.groups) {
    if (group.id === TEMPORARY_GROUP_ID) {
      throw new Error(`group id "${TEMPORARY_GROUP_ID}" is reserved and cannot be stored`)
    }
    if (groupIds.has(group.id)) throw new Error(`duplicate group id "${group.id}"`)
    groupIds.add(group.id)
    if (group.name.trim().length === 0) throw new Error(`group "${group.id}" has a blank name`)
    if (group.name.length > MAX_GROUP_NAME_LENGTH) {
      throw new Error(`group "${group.id}" has a name longer than ${String(MAX_GROUP_NAME_LENGTH)} characters`)
    }
  }
  const seen = new Set<string>()
  for (const workflow of value.workflows) {
    if (seen.has(workflow.id)) throw new Error(`duplicate workflow id "${workflow.id}"`)
    seen.add(workflow.id)
    if (workflow.groupId !== undefined && workflow.groupId !== TEMPORARY_GROUP_ID && !groupIds.has(workflow.groupId)) {
      throw new Error(`workflow "${workflow.id}" names group "${workflow.groupId}", which no group defines`)
    }
  }
}
