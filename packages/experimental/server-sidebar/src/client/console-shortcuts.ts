/**
 * The keyboard shortcuts `dsh-client-ui-workspace` registers, as the console
 * offers them.
 *
 * `ui-workspace` registers six commands with the shortcut registry
 * (`installWorkspaceShortcuts`): 新会话 (`session.new`), 搜索会话
 * (`session.search`), 添加工作区 (`workspace.add`), 重命名会话
 * (`session.rename`), 分叉会话 (`session.fork`), and 归档会话
 * (`session.archive`). The shortcut reference `dsh-client-ui-shortcuts` draws
 * lists every registered command, by the label its owner gives it, and the
 * registry runs a command whenever its key is pressed. The console offers no
 * place to start, search, add, rename, or fork, so the first five are
 * withheld ({@link WITHHELD_COMMANDS}): their rows are left out of the
 * reference, and their keys do nothing. `session.archive` takes the
 * conversation on screen off the list, which the console's 临时工作流 section
 * also does, so it stays, under the console's words for it
 * ({@link RELABELED_COMMANDS}).
 *
 * The registry takes no second registration of a command id, so neither half
 * is a registration of the console's own. The reference is the shortcut
 * reference's own `shell.overlay` entry `shortcuts`, registered again at
 * {@link REPLACING_PRIORITY} with the same component, store, and dictionary
 * namespace, and an inject face whose catalog leaves the withheld rows out
 * ({@link replaceShortcutReference}). A key is withheld by a `keydown` listener
 * on the document, which the event reaches before the registry's listener on
 * the window: a key that is already consumed when it gets there is one the
 * registry passes over ({@link installShortcutGuard}). A Desktop shell that
 * delivers application keys as native accelerators does not use that path;
 * the console is served to browsers.
 *
 * The command ids, the entry id, and the dictionary namespace are literal
 * copies: neither package's `/client` entry exports a constant for them.
 * `tests/console-shortcuts.client.spec.ts` checks each copy against the owning
 * source.
 * @module @deepseek-ai/dsh-experimental-server-sidebar/client/console-shortcuts
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { HostObservable, StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import type { ShortcutCatalogEntry, Shortcuts } from '@deepseek-ai/dsh-client-shortcuts/client'
import type { NormalizedBinding } from '@deepseek-ai/dsh-client-shortcuts/protocol'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls ui-layout's declaration of `shell.overlay`.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: pulls the shortcut reference's `shortcuts` dictionary namespace.
import type {} from '@deepseek-ai/dsh-client-ui-shortcuts/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ServerSidebarKey } from './locales.ts'
import { REPLACING_PRIORITY } from './shadowed-overlay.ts'

/** The `ui-workspace` commands the console withholds. */
export const WITHHELD_COMMANDS: ReadonlySet<string> = new Set([
  'session.new', 'session.search', 'workspace.add', 'session.rename', 'session.fork',
])

/** The `ui-workspace` commands the console keeps, each under this package's label for it. */
export const RELABELED_COMMANDS: ReadonlyMap<string, ServerSidebarKey> = new Map([['session.archive', 'temporary.dismiss']])

/** Dictionary namespace this package's labels come from. */
const NS = 'serverSidebar'

/**
 * The modifiers a binding names, in the order a normalized binding lists them:
 * the registry's canonical order, copied with the comparison below.
 */
const MODIFIER_ORDER = ['control', 'alt', 'shift', 'meta'] as const

/**
 * The console's view of the effective shortcut catalog: the withheld rows
 * left out, and each kept row of {@link RELABELED_COMMANDS} under the label
 * `label` gives it. The view is recomputed only when the catalog changes, so
 * a snapshot keeps its identity while nothing changed.
 * @param catalog - the registry's effective catalog.
 * @param label - this package's label for one kept command.
 * @returns the console's catalog.
 */
export function consoleCatalog(
  catalog: HostObservable<readonly ShortcutCatalogEntry[]>,
  label: (key: ServerSidebarKey) => string,
): HostObservable<readonly ShortcutCatalogEntry[]> {
  let source: readonly ShortcutCatalogEntry[] | undefined
  let view: readonly ShortcutCatalogEntry[] = []
  return {
    getSnapshot: () => {
      const current = catalog.getSnapshot()
      if (current !== source) {
        source = current
        view = current.filter(row => !WITHHELD_COMMANDS.has(row.id)).map((row) => {
          const key = RELABELED_COMMANDS.get(row.id)
          return key === undefined ? row : { ...row, label: label(key) }
        })
      }
      return view
    },
    subscribe: listener => catalog.subscribe(listener),
  }
}

/**
 * The shortcut reference's binding check, with a withheld command's binding
 * reported as a reserved combination rather than as a conflict that names it.
 * A combination a withheld command holds cannot be taken by another command:
 * the registry would refuse to displace that command's binding, and its
 * refusal would name a command the reference does not list.
 * @param describeBinding - the registry's own check.
 * @returns the console's check.
 */
export function consoleDescribeBinding(describeBinding: Shortcuts['describeBinding']): Shortcuts['describeBinding'] {
  return (binding) => {
    const described = describeBinding(binding)
    const conflicts = described.conflicts.filter(id => !WITHHELD_COMMANDS.has(id))
    if (conflicts.length === described.conflicts.length) return described
    return { ...described, issue: described.issue ?? 'reserved', conflicts }
  }
}

/**
 * Whether a key press is the combination one binding names.
 * @param binding - a normalized binding.
 * @param event - the key press.
 * @returns true for the binding's own key with exactly its modifiers held; a
 * two-key binding never matches, since a browser key press carries one key.
 */
function pressedBinding(binding: NormalizedBinding, event: KeyboardEvent): boolean {
  if (binding.secondCode !== undefined || binding.code !== event.code) return false
  const held = MODIFIER_ORDER.filter(modifier => ({
    control: event.ctrlKey, alt: event.altKey, shift: event.shiftKey, meta: event.metaKey,
  })[modifier])
  return held.join('+') === binding.modifiers.join('+')
}

/**
 * Consume every key press of a withheld command's binding before the
 * registry's window listener sees it, so the registry runs nothing for it.
 * Only a binding the registry would run is consumed — one with no issue and
 * no conflict — so a key another command took over from a withheld one still
 * reaches that command.
 * @param shortcuts - the registry's effective catalog.
 * @param target - the document the listener is installed on.
 * @returns the disposer that removes the listener.
 */
export function installShortcutGuard(shortcuts: Pick<Shortcuts, 'catalog'>, target: Document): () => void {
  const keydown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.isComposing) return
    const withheld = shortcuts.catalog.getSnapshot().some(row => WITHHELD_COMMANDS.has(row.id)
      && row.binding !== null && row.issue === null && row.conflicts.length === 0 && pressedBinding(row.binding, event))
    if (withheld) event.preventDefault()
  }
  target.addEventListener('keydown', keydown)
  return () => { target.removeEventListener('keydown', keydown) }
}

/** The parts of the shortcut reference's entry its replacement is built from. */
interface ReferenceParts {
  /** The reference's component. */
  component: unknown
  /** The store seat its dialog state lives in, shared with its Settings row. */
  store: NonNullable<StoredEntry['store']>
  /** What its inject factory returns. */
  face: Record<string, unknown>
  /** The face's `hooks` compartment. */
  hooks: object
}

/**
 * The parts of the shortcut reference's entry its replacement is built from.
 * @param entry - the reference's entry on the ledger.
 * @returns its component, store, and inject face, or undefined when any is
 * missing, the face carries no `hooks`, or the entry reads another namespace.
 */
function referenceParts(entry: StoredEntry): ReferenceParts | undefined {
  if (typeof entry.component !== 'function' || entry.store === undefined || entry.inject === undefined || entry.locale !== 'shortcuts') {
    return undefined
  }
  const face = entry.inject()
  const { hooks } = face
  if (typeof hooks !== 'object' || hooks === null) return undefined
  return { component: entry.component, store: entry.store, face, hooks }
}

/**
 * The entry that replaces a shortcut reference this module cannot read: it draws nothing.
 * @returns nothing to render.
 */
function WithheldReference(): null {
  return null
}

/**
 * Register the console's replacement for one shortcut reference entry: the
 * entry's own component, store, and namespace over the console's catalog and
 * binding check. An entry this module cannot read is replaced by one that
 * draws nothing, reported once to the browser console.
 * @param ctx - the context holding the slot registry.
 * @param entry - the reference's entry on the ledger.
 * @param catalog - the console's catalog.
 * @param describeBinding - the console's binding check.
 * @returns the replacement's disposer.
 */
function replaceReference(
  ctx: ClientContext, entry: StoredEntry,
  catalog: HostObservable<readonly ShortcutCatalogEntry[]>, describeBinding: Shortcuts['describeBinding'],
): () => void {
  const parts = referenceParts(entry)
  if (parts === undefined) {
    console.warn('server-sidebar: the shortcut reference is not one the console can show, so it is withheld')
    return ctx.slots.register({ name: 'shell.overlay', id: 'shortcuts', priority: REPLACING_PRIORITY }, WithheldReference)
  }
  const { face, hooks } = parts
  // The ledger erases the component's props; it is the owner's own component,
  // registered with the owner's own store, namespace, and face members.
  const ShortcutReference = parts.component as never
  return ctx.slots.register({
    name: 'shell.overlay',
    id: 'shortcuts',
    priority: REPLACING_PRIORITY,
    locale: 'shortcuts',
    store: parts.store,
    inject: () => ({ ...face, describeBinding, hooks: { ...hooks, catalog } }),
  }, ShortcutReference)
}

/**
 * Follow the shortcut reference's entry on the ledger and keep the console's
 * replacement registered over whichever one is there.
 * @param ctx - the context holding the slot registry, the shortcut registry, and the locale.
 * @returns the disposer that removes the replacement and stops following.
 */
function followReference(ctx: ClientContext): () => void {
  const t = ctx.locale.bind(NS)
  const catalog = consoleCatalog(ctx.shortcuts.catalog, key => t(key))
  const describeBinding = consoleDescribeBinding(binding => ctx.shortcuts.describeBinding(binding))
  let replaced: { entry: StoredEntry; dispose: () => void } | undefined
  const sync = (): void => {
    const entry = ctx.slots.entries('shell.overlay')
      .find(candidate => candidate.options.id === 'shortcuts' && candidate.options.priority !== REPLACING_PRIORITY)
    if (entry === replaced?.entry) return
    replaced?.dispose()
    replaced = entry === undefined ? undefined : { entry, dispose: replaceReference(ctx, entry, catalog, describeBinding) }
  }
  const stop = ctx.slots.subscribe('shell.overlay', sync)
  sync()
  return () => {
    stop()
    replaced?.dispose()
    replaced = undefined
  }
}

/**
 * Withhold `ui-workspace`'s commands the console has no place for, once the
 * shortcut registry is running: their keys, and, once the shell declares
 * `shell.overlay`, their rows in the shortcut reference.
 * @param ctx - client root context; its unload removes the listener and the replacement.
 */
export function withholdWorkspaceShortcuts(ctx: ClientContext): void {
  ctx.inject(['shortcuts', 'slots', 'locale'], (scope) => {
    scope.effect(() => installShortcutGuard(scope.shortcuts, document), 'server-sidebar: withheld shortcut keys')
    scope.effect(
      () => scope.slots.inject('shell.overlay', () => followReference(scope)),
      'server-sidebar: the console\'s shortcut reference',
    )
  })
}
