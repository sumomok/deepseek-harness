// @vitest-environment jsdom
/**
 * `console-shortcuts.ts`: the console's catalog of `dsh-client-ui-workspace`'s
 * keyboard shortcuts — the five it withholds left out, the one it keeps under
 * the console's label, in both languages and free of the vocabulary the
 * console keeps off the screen; the binding check that reports a withheld
 * command's combination as reserved; the key guard over the real shortcut
 * registry, which runs no withheld command and every other one; the shortcut
 * reference's entry, registered again over the console's catalog and followed
 * as it comes and goes; and the command ids, the entry id, and the namespace,
 * checked against their owners' source.
 */
import { readFileSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ShortcutsService, { type ShortcutCatalogEntry, type ShortcutCommandId, type Shortcuts } from '@deepseek-ai/dsh-client-shortcuts/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { createSnapshotStore, defineStore } from '@deepseek-ai/dsh-client-store'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import {
  consoleCatalog, consoleDescribeBinding, installShortcutGuard, RELABELED_COMMANDS, WITHHELD_COMMANDS,
  withholdWorkspaceShortcuts,
} from '../src/client/console-shortcuts.ts'
import { en, zh } from '../src/client/locales.ts'

/** Words the console keeps off the screen, in either language. */
const BANNED = /工作区|会话|归档|workspace|session|archive/iu

/** The six commands `ui-workspace` registers, with the label its own dictionary gives each. */
const WORKSPACE_COMMANDS: readonly [string, string][] = [
  ['session.new', '新会话'],
  ['session.search', '搜索会话'],
  ['workspace.add', '添加工作区'],
  ['session.rename', '重命名会话'],
  ['session.fork', '分叉会话'],
  ['session.archive', '归档会话'],
]

/**
 * One effective catalog row, bound and enabled unless the overrides say otherwise.
 * @param id - the command.
 * @param label - its label.
 * @param overrides - fields to replace.
 * @returns the row.
 */
function row(id: string, label: string, overrides: Partial<ShortcutCatalogEntry> = {}): ShortcutCatalogEntry {
  return {
    id: id as ShortcutCommandId,
    label,
    aliases: [],
    keys: ['⌘', '⌥', 'X'],
    aria: 'Meta+Alt+X',
    binding: { code: 'KeyX', modifiers: ['alt', 'meta'] },
    modified: false,
    conflicts: [],
    issue: null,
    ...overrides,
  }
}

/** The registry's catalog as the console sees it: `ui-workspace`'s six and two of the shell's own. */
const CATALOG: readonly ShortcutCatalogEntry[] = [
  row('shortcuts.open', '快捷键速查'),
  ...WORKSPACE_COMMANDS.map(([id, label]) => row(id, label)),
  row('settings.open', '打开设置'),
]

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('consoleCatalog', () => {
  it('leaves out the five withheld commands and gives the kept one the console\'s label, in Chinese', () => {
    const catalog = consoleCatalog(createSnapshotStore(CATALOG), makeTranslate(zh))
    const rows = catalog.getSnapshot()
    expect(rows.map(entry => [entry.id, entry.label])).toEqual([
      ['shortcuts.open', '快捷键速查'],
      ['session.archive', '移出列表'],
      ['settings.open', '打开设置'],
    ])
    expect(rows.map(entry => entry.label).join('\n')).not.toMatch(BANNED)
    // Everything but the label is the registry's own row.
    expect(rows[1]).toEqual({ ...CATALOG[6], label: '移出列表' })
    expect(rows[0]).toBe(CATALOG[0])
  })

  it('reads in English under the English dictionary', () => {
    const rows = consoleCatalog(createSnapshotStore(CATALOG), makeTranslate(en)).getSnapshot()
    expect(rows.map(entry => entry.label)).toEqual(['快捷键速查', 'Remove from list', '打开设置'])
  })

  it('keeps a snapshot\'s identity until the catalog changes, and follows the catalog\'s notifications', () => {
    const source = createSnapshotStore(CATALOG)
    const catalog = consoleCatalog(source, makeTranslate(zh))
    const first = catalog.getSnapshot()
    expect(catalog.getSnapshot()).toBe(first)
    const listener = vi.fn()
    const stop = catalog.subscribe(listener)
    source.set([...CATALOG, row('page.refresh', '刷新页面')])
    expect(listener).toHaveBeenCalledOnce()
    expect(catalog.getSnapshot()).not.toBe(first)
    expect(catalog.getSnapshot().map(entry => entry.id)).toEqual(['shortcuts.open', 'session.archive', 'settings.open', 'page.refresh'])
    stop()
    source.set(CATALOG)
    expect(listener).toHaveBeenCalledOnce()
  })
})

describe('consoleDescribeBinding', () => {
  /** The registry's check, answering what the case gives it. */
  function described(result: ReturnType<Shortcuts['describeBinding']>): Shortcuts['describeBinding'] {
    return () => result
  }

  const BINDING = { code: 'KeyN', modifiers: ['meta', 'alt'] } as const
  const DESCRIBED = { binding: { code: 'KeyN', modifiers: ['alt', 'meta'] }, keys: ['⌘', '⌥', 'N'] } as const

  it('reports a combination a withheld command holds as reserved, naming no withheld command', () => {
    const check = consoleDescribeBinding(described({ ...DESCRIBED, issue: null, conflicts: ['session.new', 'settings.open'] as ShortcutCommandId[] }))
    expect(check(BINDING)).toEqual({ ...DESCRIBED, issue: 'reserved', conflicts: ['settings.open'] })
  })

  it('keeps an issue the registry found, and drops the withheld conflict', () => {
    const check = consoleDescribeBinding(described({ ...DESCRIBED, issue: 'unsupported-browser', conflicts: ['session.fork'] as ShortcutCommandId[] }))
    expect(check(BINDING)).toEqual({ ...DESCRIBED, issue: 'unsupported-browser', conflicts: [] })
  })

  it('answers the registry\'s own result where no withheld command holds the combination', () => {
    const result = { ...DESCRIBED, issue: null, conflicts: ['settings.open', 'session.archive'] as ShortcutCommandId[] }
    expect(consoleDescribeBinding(described(result))(BINDING)).toBe(result)
  })
})

describe('installShortcutGuard', () => {
  /**
   * Press one key on the page.
   * @param init - the key and its modifiers.
   * @returns the dispatched event.
   */
  function press(init: KeyboardEventInit): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
    document.body.dispatchEvent(event)
    return event
  }

  const PRESS_N = { code: 'KeyN', metaKey: true, altKey: true } as const

  it('consumes only the exact combination of a withheld command the registry would run', () => {
    const catalog = createSnapshotStore<readonly ShortcutCatalogEntry[]>([
      row('session.new', '新会话', { binding: { code: 'KeyN', modifiers: ['alt', 'meta'] } }),
      row('session.fork', '分叉会话', { binding: { code: 'KeyF', modifiers: ['shift', 'meta'] }, conflicts: ['settings.open' as ShortcutCommandId] }),
      row('session.rename', '重命名会话', { binding: { code: 'KeyG', modifiers: ['alt', 'meta'] }, issue: 'unsupported-browser' }),
      row('session.search', '搜索会话', { binding: null }),
      row('workspace.add', '添加工作区', { binding: { code: 'KeyO', secondCode: 'KeyP', modifiers: ['alt', 'meta'] } }),
      row('session.archive', '归档会话', { binding: { code: 'KeyA', modifiers: ['alt', 'meta'] } }),
    ])
    const stop = installShortcutGuard({ catalog }, document)
    expect(press(PRESS_N).defaultPrevented).toBe(true)
    for (const init of [
      // The same key with one modifier more, one fewer, or another key.
      { ...PRESS_N, shiftKey: true }, { code: 'KeyN', metaKey: true }, { ...PRESS_N, code: 'KeyM' },
      // Withheld, but one the registry would not run: a conflict, an issue, an unbound row, a two-key chord.
      { code: 'KeyF', metaKey: true, shiftKey: true }, { code: 'KeyG', metaKey: true, altKey: true },
      { code: 'KeyO', metaKey: true, altKey: true },
      // The kept command.
      { code: 'KeyA', metaKey: true, altKey: true },
      // Input that is mid-composition.
      { ...PRESS_N, isComposing: true },
    ]) {
      expect({ init, consumed: press(init).defaultPrevented }).toEqual({ init, consumed: false })
    }
    stop()
    expect(press(PRESS_N).defaultPrevented).toBe(false)
  })

  it('leaves a key press another listener already consumed as it was', () => {
    const catalog = createSnapshotStore<readonly ShortcutCatalogEntry[]>([row('session.new', '新会话', { binding: { code: 'KeyN', modifiers: ['alt', 'meta'] } })])
    const stop = installShortcutGuard({ catalog }, document)
    const consumed = vi.fn((event: Event) => { event.preventDefault() })
    document.body.addEventListener('keydown', consumed)
    const prevented = vi.spyOn(KeyboardEvent.prototype, 'preventDefault')
    press(PRESS_N)
    expect(prevented).toHaveBeenCalledOnce()
    document.body.removeEventListener('keydown', consumed)
    stop()
  })
})

describe('withheld shortcut keys over the real registry', () => {
  /** A stand-in for each `ui-workspace` command with its Web defaults, and one of the shell's own. */
  const DEFAULTS: readonly [string, string, ('primary' | 'alt' | 'shift')[]][] = [
    ['session.new', 'KeyN', ['primary', 'alt']],
    ['session.search', 'KeyK', ['primary', 'alt']],
    ['workspace.add', 'KeyO', ['primary', 'alt']],
    ['session.rename', 'KeyG', ['primary', 'alt']],
    ['session.fork', 'KeyF', ['primary', 'shift']],
    ['session.archive', 'KeyA', ['primary', 'alt']],
    ['test.visible', 'KeyY', ['primary', 'alt']],
  ]

  beforeEach(() => {
    // The registry reads the visiting device off the navigator: a Mac browser,
    // which `ui-workspace` gives Web defaults.
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true })
  })

  afterEach(() => {
    Reflect.deleteProperty(navigator, 'platform')
  })

  /**
   * Boot the real shortcut registry with the stand-ins, then the console's guard.
   * @param stored - the browser's stored shortcut document, if any.
   * @returns each command's run spy, the context, and a key press.
   */
  async function registry(stored?: object) {
    if (stored !== undefined) localStorage.setItem('dsh.keybindings.v1', JSON.stringify(stored))
    const ctx = new Context()
    ctx.provide('locale', { subscribe: () => () => {}, bind: () => (key: string) => key, register: () => () => {} } as never)
    await ctx.plugin(SlotRegistry).await()
    await ctx.plugin(ShortcutsService).await()
    const runs = new Map(DEFAULTS.map(([id]) => [id, vi.fn()]))
    for (const [id, code, modifiers] of DEFAULTS) {
      ctx.shortcuts.register({
        id: id as ShortcutCommandId, label: () => id, aliases: [],
        defaults: { 'web:macos': { code, modifiers } }, regions: ['page', 'editable'], modals: [],
        resolve: () => ({ status: 'handled', run: () => { runs.get(id)?.() } }),
      })
    }
    await vi.waitFor(() => { expect(ctx.shortcuts.config.getSnapshot().status).toBe('ready') })
    const plugin = ctx.plugin({ name: 'server-sidebar', apply: withholdWorkspaceShortcuts })
    await plugin.await()
    const press = (code: string, shift = false): void => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { code, metaKey: true, altKey: !shift, shiftKey: shift, bubbles: true, cancelable: true }))
    }
    return { ctx, plugin, runs, press }
  }

  it('runs no withheld command for its key, and runs the kept command and the shell\'s own', async () => {
    const { ctx, runs, press } = await registry()
    for (const [, code, modifiers] of DEFAULTS) press(code, modifiers.includes('shift'))
    expect(Object.fromEntries([...runs].map(([id, run]) => [id, run.mock.calls.length]))).toEqual({
      'session.new': 0, 'session.search': 0, 'workspace.add': 0, 'session.rename': 0, 'session.fork': 0,
      'session.archive': 1, 'test.visible': 1,
    })
    await ctx.fiber.dispose()
  })

  it('withholds the key a person rebound a withheld command to, and lets the command that took its old key run', async () => {
    const { ctx, runs, press } = await registry({
      schemaVersion: 1,
      profiles: { 'web:macos': { 'session.new': { code: 'KeyJ', modifiers: ['primary', 'alt'] }, 'test.visible': { code: 'KeyN', modifiers: ['primary', 'alt'] } } },
    })
    press('KeyJ')
    press('KeyN')
    expect([runs.get('session.new')?.mock.calls.length, runs.get('test.visible')?.mock.calls.length]).toEqual([0, 1])
    await ctx.fiber.dispose()
  })

  it('gives every key back to the registry once the console unloads', async () => {
    const { ctx, plugin, runs, press } = await registry()
    await plugin.dispose()
    press('KeyN')
    expect(runs.get('session.new')).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })
})

describe('the console\'s shortcut reference', () => {
  /** The reference's component, standing in for `ui-shortcuts`' own. */
  function OwnerReference(): null {
    return null
  }

  /** The reference's store, standing in for `ui-shortcuts`' own. */
  const STORE = defineStore({ init: () => ({ open: false }), actions: {} })

  /** The shortcut registry the console reads, standing in for the real one. */
  function shortcutsStub() {
    return {
      catalog: createSnapshotStore(CATALOG),
      describeBinding: vi.fn((): ReturnType<Shortcuts['describeBinding']> => ({
        binding: null, keys: [], issue: null, conflicts: ['session.rename' as ShortcutCommandId],
      })),
    }
  }

  /** A root context with the slot registry, locale, and shortcut registry, and `shell.overlay` declared as the shell declares it. */
  async function referenceBench() {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    ctx.slots.register({ name: 'root', children: { 'shell.overlay': { kind: 'list', scope: 'root' } } } as never, () => null)
    ctx.provide('locale', { bind: () => makeTranslate(zh) } as never)
    const shortcuts = shortcutsStub()
    ctx.provide('shortcuts', shortcuts as never)
    return { ctx, shortcuts }
  }

  /** The reference's own face, as `ui-shortcuts` builds it. */
  function ownerFace(shortcuts: ReturnType<typeof shortcutsStub>) {
    const config = createSnapshotStore({ status: 'ready' })
    return {
      config,
      inject: () => ({
        platform: 'macos', runtime: 'web', edit: vi.fn(), recording: vi.fn(), describeBinding: shortcuts.describeBinding,
        hooks: { catalog: shortcuts.catalog, config, fixedCatalog: createSnapshotStore([]) },
      }),
    }
  }

  /**
   * Register an entry under the reference's id, as `ui-shortcuts` does.
   * @param ctx - the bench context.
   * @param options - the entry's options past its name and id.
   * @param component - its component.
   * @returns the registration's disposer.
   */
  function registerOwner(ctx: Context, options: object, component: unknown = OwnerReference): () => void {
    return ctx.slots.register({ name: 'shell.overlay', id: 'shortcuts', ...options } as never, component as never)
  }

  /** Let the ledger report the registrations of this turn. */
  function settle(): Promise<void> {
    return new Promise((resolveTurn) => { setTimeout(resolveTurn, 0) })
  }

  /** The one entry drawn for the reference's id. */
  function drawn(ctx: Context) {
    const winners = ctx.slots.entriesOfSlot('shell.overlay').filter(entry => entry.options.id === 'shortcuts')
    expect(winners).toHaveLength(1)
    return winners[0]!
  }

  it('draws the reference\'s own component, store, and namespace over the console\'s catalog, whichever registers first', async () => {
    for (const ownerFirst of [true, false]) {
      const { ctx, shortcuts } = await referenceBench()
      const owner = ownerFace(shortcuts)
      const options = { locale: 'shortcuts', store: STORE, inject: owner.inject }
      if (ownerFirst) registerOwner(ctx, options)
      await ctx.plugin({ name: 'server-sidebar', apply: withholdWorkspaceShortcuts }).await()
      if (!ownerFirst) registerOwner(ctx, options)
      await settle()
      const winner = drawn(ctx)
      expect(winner.component).toBe(OwnerReference)
      expect(winner.options).toMatchObject({ id: 'shortcuts', priority: -1 })
      expect([winner.locale, winner.store]).toEqual(['shortcuts', STORE])
      const face = winner.inject?.() ?? {}
      const hooks = face['hooks'] as Record<string, HostObservable<unknown>>
      expect(hooks['config']).toBe(owner.config)
      expect((hooks['catalog']?.getSnapshot() as ShortcutCatalogEntry[]).map(entry => entry.label)).toEqual(['快捷键速查', '移出列表', '打开设置'])
      expect([face['platform'], face['runtime']]).toEqual(['macos', 'web'])
      const describe = face['describeBinding'] as Shortcuts['describeBinding']
      expect(describe({ code: 'KeyG', modifiers: ['meta', 'alt'] })).toEqual({ binding: null, keys: [], issue: 'reserved', conflicts: [] })
      await ctx.fiber.dispose()
    }
  })

  it('follows the reference\'s entry as it leaves and comes back, and leaves it alone once the console unloads', async () => {
    const { ctx, shortcuts } = await referenceBench()
    const plugin = ctx.plugin({ name: 'server-sidebar', apply: withholdWorkspaceShortcuts })
    await plugin.await()
    const owner = ownerFace(shortcuts)
    const leave = registerOwner(ctx, { locale: 'shortcuts', store: STORE, inject: owner.inject })
    await settle()
    expect(ctx.slots.entries('shell.overlay')).toHaveLength(2)
    leave()
    await settle()
    expect(ctx.slots.entries('shell.overlay')).toEqual([])
    function NextReference(): null {
      return null
    }
    registerOwner(ctx, { locale: 'shortcuts', store: STORE, inject: owner.inject }, NextReference)
    await settle()
    expect(drawn(ctx).component).toBe(NextReference)
    expect(drawn(ctx).options.priority).toBe(-1)
    await plugin.dispose()
    expect(drawn(ctx).component).toBe(NextReference)
    expect(drawn(ctx).options.priority).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('draws nothing for a reference entry it cannot read, and reports that once to the browser console', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const shortcuts = shortcutsStub()
    const face = ownerFace(shortcuts)
    const unreadable: [object, unknown][] = [
      [{ store: STORE, inject: face.inject }, OwnerReference],
      [{ locale: 'other', store: STORE, inject: face.inject }, OwnerReference],
      [{ locale: 'shortcuts', inject: face.inject }, OwnerReference],
      [{ locale: 'shortcuts', store: STORE }, OwnerReference],
      [{ locale: 'shortcuts', store: STORE, inject: () => ({ platform: 'macos' }) }, OwnerReference],
      [{ locale: 'shortcuts', store: STORE, inject: () => ({ hooks: null }) }, OwnerReference],
      [{ locale: 'shortcuts', store: STORE, inject: face.inject }, 'not a component'],
    ]
    for (const [options, component] of unreadable) {
      const { ctx } = await referenceBench()
      registerOwner(ctx, options, component)
      await ctx.plugin({ name: 'server-sidebar', apply: withholdWorkspaceShortcuts }).await()
      const winner = drawn(ctx)
      expect({ options, priority: winner.options.priority, drawn: (winner.component as () => unknown)() })
        .toEqual({ options, priority: -1, drawn: null })
      await ctx.fiber.dispose()
    }
    expect(warn.mock.calls).toEqual(unreadable.map(() => ['server-sidebar: the shortcut reference is not one the console can show, so it is withheld']))
  })
})

describe('the copied ids', () => {
  /** A client source directory of another package. */
  const client = (name: string): string => resolvePath(import.meta.dirname, `../../../client/${name}/src/client`)

  it('names every command `ui-workspace` registers, once each', () => {
    // Literal copies: `ui-workspace` exports no constant for its command ids,
    // and a command it adds needs the console's decision before it reaches
    // the reference unwithheld.
    const source = readFileSync(resolvePath(client('ui-workspace'), 'shortcuts.ts'), 'utf8')
    const registered = [...source.matchAll(/^ {2}register\('([\w.]+)',/gmu)].map(match => match[1])
    expect(registered).toEqual(WORKSPACE_COMMANDS.map(([id]) => id))
    expect(new Set([...WITHHELD_COMMANDS, ...RELABELED_COMMANDS.keys()])).toEqual(new Set(registered))
  })

  it('is the id and namespace `ui-shortcuts` registers its reference under in `shell.overlay`, at the default priority', () => {
    // A literal copy: `ui-shortcuts` exports no constant for either. The
    // console's entry shadows it at -1 only while `ui-shortcuts` registers at
    // the default 0, and draws it with its store and its face's hooks.
    const source = readFileSync(resolvePath(client('ui-shortcuts'), 'index.ts'), 'utf8')
    const registration = /ctx\.slots\.register\(\{([^}]*)\}, ShortcutReference\)/u.exec(source)?.[1]
    expect(registration).toMatch(/name: 'shell\.overlay', id: 'shortcuts', locale: 'shortcuts', store,/u)
    expect(registration).toMatch(/inject: injected,/u)
    expect(registration).not.toMatch(/\bpriority\b/u)
    const hooks = 'hooks: { catalog: ctx.shortcuts.catalog, config: ctx.shortcuts.config, fixedCatalog: ctx.shortcuts.fixedCatalog }'
    expect(source).toContain(`describeBinding,\n    ${hooks}`)
  })
})
