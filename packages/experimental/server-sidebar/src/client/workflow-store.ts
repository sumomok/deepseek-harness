/**
 * The sidebar entry's server-menu store: the workflow list, the group list,
 * the workbench session id, the last save error and whether the last 移出列表
 * was refused (each shown inline in the section its click was in), and the browser-local
 * view preferences (which groups are collapsed, and whether the temporary
 * group shows every row). Module level exports the factory
 * only; a module-level handle would pin the store's identity in the module
 * cache and survive plugin reloads as a de-facto singleton.
 *
 * The view half persists to `localStorage` by hand rather than through
 * `defineStore`'s own `persist` key: that mechanism stores and rehydrates the
 * WHOLE state, so a stale copy of the workflow list would replace the
 * server-read document this store is seeded from on every page load. Only the
 * two view fields are written, and only they are read back.
 * @module @deepseek-ai/dsh-experimental-server-sidebar/client/workflow-store
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'
import { TEMPORARY_GROUP_ID } from '../menu-constants.ts'
import type { ServerMenuGroup, ServerMenuState } from './workflow-api.ts'

/**
 * `localStorage` key the view preferences live under, versioned like the
 * shipped browser's own view account (`dsh.workspace.view.v5`): a format
 * change bumps the suffix and abandons the old key rather than migrating a
 * display preference.
 */
export const SIDEBAR_VIEW_STORAGE_KEY = 'dsh.server-sidebar.view.v1'

/** Browser-local display preferences, persisted under {@link SIDEBAR_VIEW_STORAGE_KEY}. */
export interface SidebarViewState {
  /**
   * Whether each group's rows are hidden, keyed by group id — the temporary
   * group's reserved id included. A group with no key here is expanded.
   */
  collapsed: Record<string, boolean>
  /** Whether the temporary group lists every row rather than its first few. */
  temporaryExpanded: boolean
}

/** Server-menu state. */
export interface ServerMenuStoreState {
  /** The current workflow list, authoritative from the server's own answer to the last read or write. */
  workflows: ServerMenuState['workflows']
  /** The current group list, authoritative from the same source. */
  groups: ServerMenuState['groups']
  /** The persistent workbench conversation's id, authoritative from the same source. */
  workbenchSessionId: string | undefined
  /** The last save's failure message, cleared by the next successful save. */
  error: string | undefined
  /**
   * Whether the last 移出列表 was refused, cleared by the next one that is
   * not. A flag rather than a message: the refusal's own text is the host
   * runtime's and names vocabulary this console keeps off the screen, so the
   * section reports it in fixed copy (`temporary.error`) and the refusal
   * itself goes to the browser console. Kept apart from
   * {@link ServerMenuStoreState.error} so each failure is reported in the
   * section its click was in, in that section's own words.
   */
  temporaryFailed: boolean
  /** Browser-local display preferences (see {@link SidebarViewState}). */
  view: SidebarViewState
}

/**
 * Annotation twin of the actions literal below (the export needs a declared
 * return type); drift fails assignability at the defineStore call.
 */
type ServerMenuStoreActions = {
  setServerMenu: (draft: ServerMenuStoreState, next: ServerMenuState) => void
  setError: (draft: ServerMenuStoreState, message: string) => void
  setTemporaryFailed: (draft: ServerMenuStoreState, failed: boolean) => void
  setGroupCollapsed: (draft: ServerMenuStoreState, groupId: string, collapsed: boolean) => void
  setTemporaryExpanded: (draft: ServerMenuStoreState, expanded: boolean) => void
}

/** Whether a decoded JSON value is a data object rather than an array, null, or a primitive. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The view a browser with nothing remembered (or nothing usable) starts from. */
function defaultView(): SidebarViewState {
  return { collapsed: {}, temporaryExpanded: false }
}

/** Keep the boolean entries of a stored collapse map, dropping anything else. */
function readCollapsed(value: unknown): Record<string, boolean> {
  if (!isRecord(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'),
  )
}

/**
 * Read one stored view document. A durable, user-editable store: every field
 * is checked, and anything unusable falls back to the default rather than
 * reaching the render tree.
 * @param raw - the stored text, or `null` when nothing is stored.
 * @returns the view to start from.
 * @throws {SyntaxError} when `raw` is not JSON; the caller contains it.
 */
function parseView(raw: string | null): SidebarViewState {
  if (raw === null) return defaultView()
  const stored = JSON.parse(raw) as unknown
  if (!isRecord(stored)) return defaultView()
  return { collapsed: readCollapsed(stored.collapsed), temporaryExpanded: stored.temporaryExpanded === true }
}

/**
 * Read the remembered view preferences.
 * @returns the stored view, or the default one when nothing is stored, the
 * browser has no `localStorage` (a node-hosted render of the client tree),
 * reading it is refused outright, or the stored text is unreadable.
 */
function readStoredView(): SidebarViewState {
  try {
    // Inside the `try` with the read itself: a browser configured to block
    // site data throws on the global's own getter, so even the guard against
    // there being no `localStorage` at all is a statement that can fail.
    if (typeof localStorage === 'undefined') return defaultView()
    return parseView(localStorage.getItem(SIDEBAR_VIEW_STORAGE_KEY))
  } catch (error) {
    console.warn('server-sidebar: could not read the remembered sidebar view:', error)
    return defaultView()
  }
}

/**
 * Remember the view preferences.
 * @param view - the view to store; a plain value, never a live draft.
 */
function writeStoredView(view: SidebarViewState): void {
  try {
    // Guarded inside the `try` for the reason {@link readStoredView} gives.
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(SIDEBAR_VIEW_STORAGE_KEY, JSON.stringify(view))
  } catch (error) {
    // A full, disabled or unreachable store costs the memory of one display
    // preference, which is not worth failing the click that changed it.
    console.warn('server-sidebar: could not remember the sidebar view:', error)
  }
}

/**
 * Drop the fold entries of groups an authoritative document does not define.
 * The stored map is the only thing here that would otherwise grow for the
 * life of the browser profile, and every document this store sees — the one
 * it loads with and each one a save answers — is a chance to collect.
 * @param view - the view to prune, plain or an immer draft.
 * @param groups - the authoritative group list; {@link TEMPORARY_GROUP_ID} is
 * live alongside it, since that section exists without being stored.
 * @returns the pruned view, or `undefined` when every entry still names a
 * live group and there is nothing to write back.
 */
function pruneView(
  view: SidebarViewState, groups: readonly ServerMenuGroup[],
): SidebarViewState | undefined {
  const live = new Set([TEMPORARY_GROUP_ID, ...groups.map(group => group.id)])
  const kept = Object.entries(view.collapsed).filter(([groupId]) => live.has(groupId))
  if (kept.length === Object.keys(view.collapsed).length) return undefined
  return { collapsed: Object.fromEntries(kept), temporaryExpanded: view.temporaryExpanded }
}

/**
 * The view this store starts from: what the browser remembered, pruned
 * against the document being loaded and written back when that changed it.
 * @param groups - the loaded document's group list.
 * @returns the view to seed state with.
 */
function initialView(groups: readonly ServerMenuGroup[]): SidebarViewState {
  const stored = readStoredView()
  const pruned = pruneView(stored, groups)
  if (pruned === undefined) return stored
  writeStoredView(pruned)
  return pruned
}

/**
 * Create the server-menu store handle, seeded with the document this
 * package's client half already read before registering — matching how
 * `dsh-experimental-content-frame`'s own client half awaits its settings
 * route before claiming its slot, rather than rendering a loading state — and
 * with the view preferences this browser last remembered.
 * @param initial - the document read before registration.
 * @returns the store handle (spec + type + identity + factory in one).
 */
export function createWorkflowStore(initial: ServerMenuState): EngineStoreHandle<ServerMenuStoreState, ServerMenuStoreActions> {
  return defineStore({
    init: (): ServerMenuStoreState => ({
      workflows: [...initial.workflows],
      groups: [...initial.groups],
      workbenchSessionId: initial.workbenchSessionId,
      error: undefined,
      temporaryFailed: false,
      view: initialView(initial.groups),
    }),
    actions: {
      setServerMenu: (draft, next) => {
        draft.workflows = next.workflows
        draft.groups = next.groups
        draft.workbenchSessionId = next.workbenchSessionId
        draft.error = undefined
        const view = pruneView(draft.view, next.groups)
        if (view === undefined) return
        draft.view = view
        writeStoredView(view)
      },
      setError: (draft, message) => { draft.error = message },
      setTemporaryFailed: (draft, failed) => { draft.temporaryFailed = failed },
      // Both view mutators write through to storage with a value built from
      // the draft rather than the draft itself, so what is stored is plain
      // JSON and not a live immer proxy.
      setGroupCollapsed: (draft, groupId: string, collapsed: boolean) => {
        const next: SidebarViewState = {
          collapsed: { ...draft.view.collapsed, [groupId]: collapsed },
          temporaryExpanded: draft.view.temporaryExpanded,
        }
        draft.view = next
        writeStoredView(next)
      },
      setTemporaryExpanded: (draft, expanded: boolean) => {
        const next: SidebarViewState = { collapsed: { ...draft.view.collapsed }, temporaryExpanded: expanded }
        draft.view = next
        writeStoredView(next)
      },
    },
  })
}
