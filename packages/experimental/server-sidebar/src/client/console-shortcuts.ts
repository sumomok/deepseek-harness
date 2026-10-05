/**
 * The keyboard shortcuts the console withholds: commands other packages
 * register for surfaces the console does not offer.
 *
 * `dsh-client-ui-workspace` registers six commands with the shortcut registry
 * (`installWorkspaceShortcuts`): 新会话 (`session.new`), 搜索会话
 * (`session.search`), 添加工作区 (`workspace.add`), 重命名会话
 * (`session.rename`), 分叉会话 (`session.fork`), and 归档会话
 * (`session.archive`). `dsh-client-ui-sidebar-files` registers 工作区文件
 * (`workspace.files`), which opens a file tree of the conversation's working
 * directory in the right column, and `dsh-client-ui-sidebar-right` registers
 * 展开／收起右侧栏 (`sidebar.right.toggle`), which opens and closes the right
 * column. The shortcut reference `dsh-client-ui-shortcuts` draws lists every
 * registered command, by the label its owner gives it, and the registry runs a
 * command whenever its key is pressed. The console offers no place to start,
 * search, add, rename, or fork a conversation, and no file tree. Its 移出列表
 * applies only to the 临时工作流 section, asks first, and returns to the
 * workbench, while `session.archive` archives whichever conversation is on
 * screen — the workbench and a workflow's own conversation included — and
 * leaves the page on no conversation. The right column opens on the console
 * for a file a visitor clicks, on that file's document tab; opened empty, it
 * shows a guide page that offers nothing to open, since the console composes
 * no tab type the guide lists. All eight are withheld
 * ({@link WITHHELD_COMMANDS}): their rows are left out of the reference, and
 * their keys do nothing. The console bundle also disables `ui-sidebar-files`,
 * so `workspace.files` is withheld for a composition that keeps that row.
 *
 * The registry takes no second registration of a command id, so neither half
 * is a registration of the console's own. The reference is the shortcut
 * reference's own `shell.overlay` entry `shortcuts`, registered again at
 * {@link REPLACING_PRIORITY} with the same component, store, and dictionary
 * namespace, and an inject face whose catalog leaves the withheld rows out
 * ({@link followReference}). A key is withheld through the registry's own
 * fixed-input observer, which sees each key press after local controls and
 * before the registry dispatches it: a press the observer consumes is one the
 * registry passes over ({@link installShortcutGuard}). A Desktop shell that
 * delivers application keys as native accelerators does not use that path;
 * the console is served to browsers.
 *
 * The command ids and their input regions, the entry id, and the dictionary
 * namespace are literal copies: no owner's `/client` entry exports a constant
 * for them. `tests/console-shortcuts.client.spec.ts` checks each copy against
 * the owning source.
 * @module @deepseek-ai/dsh-experimental-server-sidebar/client/console-shortcuts
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { HostObservable, StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  ShortcutCatalogEntry, ShortcutCommandId, ShortcutContext, ShortcutGesture, Shortcuts,
} from '@deepseek-ai/dsh-client-shortcuts/client'
import type { NormalizedBinding } from '@deepseek-ai/dsh-client-shortcuts/protocol'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls ui-layout's declaration of `shell.overlay`.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: pulls the shortcut reference's `shortcuts` dictionary namespace.
import type {} from '@deepseek-ai/dsh-client-ui-shortcuts/client'
import { REPLACING_PRIORITY } from './shadowed-overlay.ts'

/** The input regions a command runs in, as its owner registers them. */
type Regions = readonly ShortcutContext['region'][]

/** The regions `ui-workspace` registers every one of its commands with. */
const WORKSPACE_REGIONS: Regions = ['page', 'editable']

/** Every input region: the regions `ui-sidebar-files` and `ui-sidebar-right` register their withheld commands with. */
const EVERY_REGION: Regions = ['page', 'editable', 'terminal']

/** The commands the console withholds, each with the input regions its owner runs it in. */
export const WITHHELD_COMMANDS: ReadonlyMap<string, Regions> = new Map([
  ['session.new', WORKSPACE_REGIONS],
  ['session.search', WORKSPACE_REGIONS],
  ['workspace.add', WORKSPACE_REGIONS],
  ['session.rename', WORKSPACE_REGIONS],
  ['session.fork', WORKSPACE_REGIONS],
  ['session.archive', WORKSPACE_REGIONS],
  ['workspace.files', EVERY_REGION],
  ['sidebar.right.toggle', EVERY_REGION],
])

/**
 * The modifiers a binding names, in the order a normalized binding lists them:
 * the registry's canonical order, copied with the comparison below.
 */
const MODIFIER_ORDER = ['control', 'alt', 'shift', 'meta'] as const

/**
 * The console's view of the effective shortcut catalog: the withheld rows
 * left out. The view is recomputed only when the catalog changes, so a
 * snapshot keeps its identity while nothing changed.
 * @param catalog - the registry's effective catalog.
 * @returns the console's catalog.
 */
export function consoleCatalog(
  catalog: HostObservable<readonly ShortcutCatalogEntry[]>,
): HostObservable<readonly ShortcutCatalogEntry[]> {
  let source: readonly ShortcutCatalogEntry[] | undefined
  let view: readonly ShortcutCatalogEntry[] = []
  return {
    getSnapshot: () => {
      const current = catalog.getSnapshot()
      if (current !== source) {
        source = current
        view = current.filter(row => !WITHHELD_COMMANDS.has(row.id))
      }
      return view
    },
    subscribe: listener => catalog.subscribe(listener),
  }
}

/** A refusal's conflicting commands, and the issue it reports. */
interface Reported<Issue> {
  /** The conflicting commands the reference lists. */
  conflicts: ShortcutCommandId[]
  /** The registry's issue, or `reserved` where only withheld commands conflicted. */
  issue: Issue | 'reserved'
}

/**
 * A list of conflicting commands with the withheld ones left out, and the
 * issue a combination they alone hold is reported as.
 * @param conflicts - the commands the registry named.
 * @param issue - the issue the registry found, if any.
 * @returns undefined when no withheld command is named; otherwise the
 * remaining commands, and the registry's issue or, failing one, `reserved`.
 */
function withoutWithheld<Issue extends string>(
  conflicts: readonly ShortcutCommandId[], issue: Issue | null | undefined,
): Reported<Issue> | undefined {
  const kept = conflicts.filter(id => !WITHHELD_COMMANDS.has(id))
  if (kept.length === conflicts.length) return undefined
  return { conflicts: kept, issue: issue ?? 'reserved' }
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
    const reported = withoutWithheld(described.conflicts, described.issue)
    return reported === undefined ? described : { ...described, ...reported }
  }
}

/**
 * The shortcut reference's save, with a refusal that names a withheld command
 * reported the way {@link consoleDescribeBinding} reports that command's
 * combination. A browser that stored a binding for a withheld command before
 * the console withheld it can still hold a combination another command asks
 * for.
 * @param edit - the registry's own save.
 * @returns the console's save.
 */
export function consoleEdit(edit: Shortcuts['edit']): Shortcuts['edit'] {
  return async (...args) => {
    const result = await edit(...args)
    const reported = result.conflicts === undefined ? undefined : withoutWithheld(result.conflicts, result.issue)
    return reported === undefined ? result : { ...result, ...reported }
  }
}

/**
 * Whether a key press is the combination one binding names.
 * @param binding - a normalized binding.
 * @param gesture - the key press.
 * @returns true for the binding's own key with exactly its modifiers held; a
 * two-key binding never matches, since a browser key press carries one key.
 */
function pressedBinding(binding: NormalizedBinding, gesture: ShortcutGesture): boolean {
  if (binding.secondCode !== undefined || binding.code !== gesture.code) return false
  return MODIFIER_ORDER.filter(modifier => gesture[modifier]).join('+') === binding.modifiers.join('+')
}

/**
 * Whether the registry dispatches a press the observer sees as composing: the
 * Option+Command+N that a macOS browser can report as a dead key. The
 * observer cannot tell that report from input-method composition, which the
 * registry passes over, so such a press is consumed in both cases.
 * @param shortcuts - the registry's device.
 * @param gesture - the key press.
 * @returns true for Option+Command+N, and nothing else held, in a macOS browser.
 */
function dispatchedDeadKey(shortcuts: Pick<Shortcuts, 'runtime' | 'platform'>, gesture: ShortcutGesture): boolean {
  return shortcuts.runtime === 'web' && shortcuts.platform === 'macos' && gesture.code === 'KeyN'
    && gesture.meta && gesture.alt && !gesture.control && !gesture.shift
}

/**
 * Whether the registry leaves a press to a terminal regardless of its binding.
 * @param context - where the press landed.
 * @param gesture - the key press.
 * @returns true for Control+W and Control+R, and nothing else held, in a terminal.
 */
function terminalOwns(context: ShortcutContext, gesture: ShortcutGesture): boolean {
  return context.region === 'terminal' && gesture.control && !gesture.meta && !gesture.alt && !gesture.shift
    && (gesture.code === 'KeyW' || gesture.code === 'KeyR')
}

/**
 * Consume every key press the registry would dispatch to a withheld command,
 * before it does, so the registry runs nothing for it. A press is consumed
 * when the registry's accepted bindings are active, the press is neither
 * consumed already nor composing, it lands in a region the command runs in,
 * and it is the exact combination of a withheld command's binding that has no
 * issue and no conflict: a key another command took over from a withheld one
 * still reaches that command, and input-method composition, dead keys, and
 * AltGraph pass through as the registry passes them.
 * @param shortcuts - the registry: its effective catalog, accepted configuration, device, and fixed-input observer.
 * @returns the disposer that stops observing.
 */
export function installShortcutGuard(
  shortcuts: Pick<Shortcuts, 'catalog' | 'config' | 'observeFixedInput' | 'runtime' | 'platform'>,
): () => void {
  return shortcuts.observeFixedInput((input) => {
    if (input.type !== 'keydown') return
    const { gesture, context } = input
    if (gesture.defaultPrevented || shortcuts.config.getSnapshot().status === 'loading') return
    if (gesture.composing && !dispatchedDeadKey(shortcuts, gesture)) return
    if (terminalOwns(context, gesture)) return
    const withheld = shortcuts.catalog.getSnapshot().some(row => WITHHELD_COMMANDS.get(row.id)?.includes(context.region) === true
      && row.binding !== null && row.issue === null && row.conflicts.length === 0 && pressedBinding(row.binding, gesture))
    if (withheld) input.consume()
  })
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

/** What the console's reference reads in place of the registry's own. */
interface ConsoleReference {
  /** The console's catalog. */
  catalog: HostObservable<readonly ShortcutCatalogEntry[]>
  /** The console's binding check. */
  describeBinding: Shortcuts['describeBinding']
  /** The console's save. */
  edit: Shortcuts['edit']
}

/**
 * Register the console's replacement for one shortcut reference entry: the
 * entry's own component, store, and namespace over the console's catalog,
 * binding check, and save. An entry this module cannot read is replaced by one
 * that draws nothing, reported once to the browser console.
 * @param ctx - the context holding the slot registry.
 * @param entry - the reference's entry on the ledger.
 * @param reference - what the replacement reads in place of the registry's own.
 * @returns the replacement's disposer.
 */
function replaceReference(ctx: ClientContext, entry: StoredEntry, reference: ConsoleReference): () => void {
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
    inject: () => ({
      ...face, describeBinding: reference.describeBinding, edit: reference.edit, hooks: { ...hooks, catalog: reference.catalog },
    }),
  }, ShortcutReference)
}

/**
 * Follow the shortcut reference's entry on the ledger and keep the console's
 * replacement registered over whichever one is there.
 * @param ctx - the context holding the slot registry and the shortcut registry.
 * @returns the disposer that removes the replacement and stops following.
 */
function followReference(ctx: ClientContext): () => void {
  const reference: ConsoleReference = {
    catalog: consoleCatalog(ctx.shortcuts.catalog),
    describeBinding: consoleDescribeBinding(binding => ctx.shortcuts.describeBinding(binding)),
    edit: consoleEdit((...args) => ctx.shortcuts.edit(...args)),
  }
  let replaced: { entry: StoredEntry; dispose: () => void } | undefined
  const sync = (): void => {
    const entry = ctx.slots.entries('shell.overlay')
      .find(candidate => candidate.options.id === 'shortcuts' && candidate.options.priority !== REPLACING_PRIORITY)
    if (entry === replaced?.entry) return
    replaced?.dispose()
    replaced = entry === undefined ? undefined : { entry, dispose: replaceReference(ctx, entry, reference) }
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
 * Withhold the commands the console has no place for, once the shortcut
 * registry is running: their keys, and, once the shell declares
 * `shell.overlay`, their rows in the shortcut reference.
 * @param ctx - client root context; its unload stops the observer and removes the replacement.
 */
export function withholdShortcuts(ctx: ClientContext): void {
  ctx.inject(['shortcuts', 'slots'], (scope) => {
    scope.effect(() => installShortcutGuard(scope.shortcuts), 'server-sidebar: withheld shortcut keys')
    scope.effect(
      () => scope.slots.inject('shell.overlay', () => followReference(scope)),
      'server-sidebar: the console\'s shortcut reference',
    )
  })
}
