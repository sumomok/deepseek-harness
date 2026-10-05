// @vitest-environment jsdom
/**
 * `console-shortcuts.ts`: the console's catalog, with the commands it
 * withholds left out and the rest free of the vocabulary the console keeps
 * off the screen; the binding check and the save that report a withheld
 * command's combination as reserved; the key guard, alone and over the real
 * shortcut registry, which runs no withheld command, every other one, and
 * passes composition, dead keys, and AltGraph through as the registry does;
 * the shortcut reference's entry, registered again over the console's catalog
 * and followed as it comes and goes; and the command ids, their regions, the
 * entry id, and the namespace, checked against their owners' source.
 */
import { readFileSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ShortcutsService, {
  type ShortcutCatalogEntry, type ShortcutCommandId, type ShortcutContext, type ShortcutFixedInput, type ShortcutGesture,
  type Shortcuts,
} from '@deepseek-ai/dsh-client-shortcuts/client'
import type { ShortcutSaveResult } from '@deepseek-ai/dsh-client-shortcuts/protocol'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { createSnapshotStore, defineStore } from '@deepseek-ai/dsh-client-store'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import {
  consoleCatalog, consoleDescribeBinding, consoleEdit, installShortcutGuard, WITHHELD_COMMANDS, withholdShortcuts,
} from '../src/client/console-shortcuts.ts'

/** Words the console keeps off the screen, in either language. */
const BANNED = /工作区|会话|归档|workspace|session|archive/iu

/** The seven commands the console withholds, with the label their owners' dictionaries give each. */
const WITHHELD: readonly [string, string][] = [
  ['session.new', '新会话'],
  ['session.search', '搜索会话'],
  ['workspace.add', '添加工作区'],
  ['session.rename', '重命名会话'],
  ['session.fork', '分叉会话'],
  ['session.archive', '归档会话'],
  ['workspace.files', '工作区文件'],
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

/** The registry's catalog as the console sees it: the seven withheld commands and three of the shell's own. */
const CATALOG: readonly ShortcutCatalogEntry[] = [
  row('shortcuts.open', '快捷键速查'),
  ...WITHHELD.map(([id, label]) => row(id, label)),
  row('settings.open', '打开设置'),
  row('sidebar.right.toggle', '切换右侧栏'),
]

/** An accepted configuration snapshot, as far as these tests read one. */
const SNAPSHOT: ShortcutSaveResult['snapshot'] = { status: 'ready' } as never

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('consoleCatalog', () => {
  it('leaves out every withheld command and keeps the registry\'s own rows for the rest', () => {
    const rows = consoleCatalog(createSnapshotStore(CATALOG)).getSnapshot()
    expect(rows.map(entry => entry.id)).toEqual(['shortcuts.open', 'settings.open', 'sidebar.right.toggle'])
    expect(rows.map(entry => entry.label).join('\n')).not.toMatch(BANNED)
    expect(rows[0]).toBe(CATALOG[0])
  })

  it('keeps a snapshot\'s identity until the catalog changes, and follows the catalog\'s notifications', () => {
    const source = createSnapshotStore(CATALOG)
    const catalog = consoleCatalog(source)
    const first = catalog.getSnapshot()
    expect(catalog.getSnapshot()).toBe(first)
    const listener = vi.fn()
    const stop = catalog.subscribe(listener)
    source.set([...CATALOG, row('page.refresh', '刷新页面')])
    expect(listener).toHaveBeenCalledOnce()
    expect(catalog.getSnapshot()).not.toBe(first)
    expect(catalog.getSnapshot().map(entry => entry.id)).toEqual(['shortcuts.open', 'settings.open', 'sidebar.right.toggle', 'page.refresh'])
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
    const check = consoleDescribeBinding(described({ ...DESCRIBED, issue: 'unsupported-browser', conflicts: ['workspace.files'] as ShortcutCommandId[] }))
    expect(check(BINDING)).toEqual({ ...DESCRIBED, issue: 'unsupported-browser', conflicts: [] })
  })

  it('answers the registry\'s own result where no withheld command holds the combination', () => {
    const result = { ...DESCRIBED, issue: null, conflicts: ['settings.open', 'shortcuts.open'] as ShortcutCommandId[] }
    expect(consoleDescribeBinding(described(result))(BINDING)).toBe(result)
  })
})

describe('consoleEdit', () => {
  const RESET = { type: 'reset', id: 'settings.open' as ShortcutCommandId } as const
  const REVISION: Parameters<Shortcuts['edit']>[1] = 3 as never

  it('reports a refusal only withheld commands caused as a reserved combination, naming none of them', async () => {
    const edit = vi.fn(() => Promise.resolve<ShortcutSaveResult>({ status: 'conflict', snapshot: SNAPSHOT, conflicts: ['session.new' as ShortcutCommandId] }))
    expect(await consoleEdit(edit)(RESET, REVISION)).toEqual({ status: 'conflict', snapshot: SNAPSHOT, conflicts: [], issue: 'reserved' })
    expect(edit).toHaveBeenCalledWith(RESET, REVISION)
  })

  it('keeps the commands the reference lists, and the registry\'s issue', async () => {
    const edit = () => Promise.resolve<ShortcutSaveResult>({
      status: 'conflict', snapshot: SNAPSHOT, issue: 'unsupported-key', conflicts: ['workspace.files', 'shortcuts.open'] as ShortcutCommandId[],
    })
    expect(await consoleEdit(edit)(RESET, REVISION))
      .toEqual({ status: 'conflict', snapshot: SNAPSHOT, issue: 'unsupported-key', conflicts: ['shortcuts.open'] })
  })

  it('answers the registry\'s own result where no withheld command is named', async () => {
    for (const result of [
      { status: 'saved', snapshot: SNAPSHOT },
      { status: 'conflict', snapshot: SNAPSHOT, conflicts: ['shortcuts.open' as ShortcutCommandId] },
    ] satisfies ShortcutSaveResult[]) {
      expect(await consoleEdit(() => Promise.resolve(result))(RESET, REVISION)).toBe(result)
    }
  })
})

describe('installShortcutGuard', () => {
  /**
   * A registry stand-in: its catalog, its configuration, its device, and the
   * observers the guard installs.
   * @param rows - the effective catalog.
   * @param device - the visiting device; a Mac browser unless given.
   * @returns a key press delivered as the registry's keyboard adapter delivers it, and the stand-in's parts.
   */
  function guarded(rows: readonly ShortcutCatalogEntry[], device: Pick<Shortcuts, 'runtime' | 'platform'> = { runtime: 'web', platform: 'macos' }) {
    const observers = new Set<(input: ShortcutFixedInput) => void>()
    const config = createSnapshotStore<{ status: string }>({ status: 'ready' })
    const stop = installShortcutGuard({
      ...device,
      catalog: createSnapshotStore(rows),
      config: config as never,
      observeFixedInput: (listener) => {
        observers.add(listener)
        return () => { observers.delete(listener) }
      },
    })
    const press = (gesture: Partial<ShortcutGesture>, region: ShortcutContext['region'] = 'page'): boolean => {
      const consume = vi.fn()
      for (const observer of observers) {
        observer({
          type: 'keydown',
          gesture: { code: 'KeyN', control: false, alt: true, shift: false, meta: true, repeat: false, composing: false, defaultPrevented: false, ...gesture },
          context: { region, modal: null, target: null },
          consume,
        })
      }
      return consume.mock.calls.length > 0
    }
    return { press, stop, config, observers }
  }

  const ROWS: readonly ShortcutCatalogEntry[] = [
    row('session.new', '新会话', { binding: { code: 'KeyN', modifiers: ['alt', 'meta'] } }),
    row('session.fork', '分叉会话', { binding: { code: 'KeyF', modifiers: ['shift', 'meta'] }, conflicts: ['settings.open' as ShortcutCommandId] }),
    row('session.rename', '重命名会话', { binding: { code: 'KeyG', modifiers: ['alt', 'meta'] }, issue: 'unsupported-browser' }),
    row('session.search', '搜索会话', { binding: null }),
    row('workspace.add', '添加工作区', { binding: { code: 'KeyO', secondCode: 'KeyP', modifiers: ['alt', 'meta'] } }),
    row('workspace.files', '工作区文件', { binding: { code: 'KeyP', modifiers: ['alt', 'meta'] } }),
    row('settings.open', '打开设置', { binding: { code: 'KeyS', modifiers: ['alt', 'meta'] } }),
  ]

  it('consumes only the exact combination of a withheld command the registry would run', () => {
    const { press, stop, observers } = guarded(ROWS)
    expect(press({})).toBe(true)
    for (const gesture of [
      // The same key with one modifier more, one fewer, or another key.
      { shift: true }, { alt: false }, { code: 'KeyM' },
      // Withheld, but one the registry would not run: a conflict, an issue, an unbound row, a two-key chord.
      { code: 'KeyF', alt: false, shift: true }, { code: 'KeyG' }, { code: 'KeyO' },
      // A command the console keeps.
      { code: 'KeyS' },
      // Input another observer consumed already.
      { defaultPrevented: true },
    ] satisfies Partial<ShortcutGesture>[]) {
      expect({ gesture, consumed: press(gesture) }).toEqual({ gesture, consumed: false })
    }
    stop()
    expect(observers.size).toBe(0)
  })

  it('consumes a withheld command\'s press only in the regions its owner runs it in', () => {
    const { press } = guarded(ROWS)
    expect([press({}, 'editable'), press({}, 'terminal')]).toEqual([true, false])
    expect([press({ code: 'KeyP' }, 'page'), press({ code: 'KeyP' }, 'terminal')]).toEqual([true, true])
  })

  it('leaves Control+W and Control+R in a terminal to the terminal, whichever command holds them', () => {
    const { press } = guarded([
      row('workspace.files', '工作区文件', { binding: { code: 'KeyW', modifiers: ['control'] } }),
      row('workspace.files', '工作区文件', { binding: { code: 'KeyR', modifiers: ['control'] } }),
      row('workspace.files', '工作区文件', { binding: { code: 'KeyE', modifiers: ['control'] } }),
    ])
    const control = { control: true, alt: false, meta: false }
    expect([press({ ...control, code: 'KeyW' }, 'terminal'), press({ ...control, code: 'KeyR' }, 'terminal')]).toEqual([false, false])
    expect([press({ ...control, code: 'KeyW' }, 'page'), press({ ...control, code: 'KeyR' }, 'editable')]).toEqual([true, true])
    // Another key, or one more modifier, in a terminal is the command's.
    expect([press({ ...control, code: 'KeyE' }, 'terminal'), press({ ...control, code: 'KeyW', shift: true }, 'terminal')])
      .toEqual([true, false])
  })

  it('consumes nothing before the registry\'s accepted bindings are active', () => {
    const { press, config } = guarded(ROWS)
    config.set({ status: 'loading' })
    expect(press({})).toBe(false)
    config.set({ status: 'unreadable' })
    expect(press({})).toBe(true)
  })

  it('passes a composing press through, except the Option+Command+N a Mac browser reports as a dead key', () => {
    const rows = [
      ...ROWS,
      row('session.search', '搜索会话', { binding: { code: 'KeyK', modifiers: ['alt', 'meta'] } }),
      row('session.archive', '归档会话', { binding: { code: 'KeyN', modifiers: ['control', 'alt', 'meta'] } }),
      row('session.rename', '重命名会话', { binding: { code: 'KeyN', modifiers: ['alt', 'shift', 'meta'] } }),
      row('session.fork', '分叉会话', { binding: { code: 'KeyN', modifiers: ['meta'] } }),
      row('workspace.add', '添加工作区', { binding: { code: 'KeyN', modifiers: ['alt'] } }),
    ]
    const { press } = guarded(rows)
    expect(press({ composing: true })).toBe(true)
    for (const gesture of [
      { code: 'KeyK' }, { control: true }, { shift: true }, { alt: false }, { meta: false },
    ] satisfies Partial<ShortcutGesture>[]) {
      expect({ gesture, consumed: press({ ...gesture, composing: true }) }).toEqual({ gesture, consumed: false })
    }
    for (const device of [{ runtime: 'desktop', platform: 'macos' }, { runtime: 'web', platform: 'windows' }] as const) {
      expect({ device, consumed: guarded(rows, device).press({ composing: true }) }).toEqual({ device, consumed: false })
    }
  })

  it('ignores the adapter\'s sequence resets', () => {
    const { observers } = guarded(ROWS)
    expect(observers.size).toBe(1)
    for (const observer of observers) expect(() => { observer({ type: 'reset' }) }).not.toThrow()
  })
})

describe('withheld shortcut keys over the real registry', () => {
  /** A stand-in for each withheld command with its Web defaults and regions, and one of the shell's own. */
  const DEFAULTS: readonly [string, string, ('primary' | 'alt' | 'shift')[], ShortcutContext['region'][]][] = [
    ['session.new', 'KeyN', ['primary', 'alt'], ['page', 'editable']],
    ['session.search', 'KeyK', ['primary', 'alt'], ['page', 'editable']],
    ['workspace.add', 'KeyO', ['primary', 'alt'], ['page', 'editable']],
    ['session.rename', 'KeyG', ['primary', 'alt'], ['page', 'editable']],
    ['session.fork', 'KeyF', ['primary', 'shift'], ['page', 'editable']],
    ['session.archive', 'KeyA', ['primary', 'alt'], ['page', 'editable']],
    ['workspace.files', 'KeyP', ['primary', 'alt'], ['page', 'editable', 'terminal']],
    ['test.visible', 'KeyY', ['primary', 'alt'], ['page', 'editable']],
  ]

  afterEach(() => {
    Reflect.deleteProperty(navigator, 'platform')
  })

  /**
   * Boot the real shortcut registry with the stand-ins, then the console's guard.
   * @param platform - the visiting device, as `navigator.platform` reports it.
   * @param stored - the browser's stored shortcut document, if any.
   * @returns the context, the plugin, each command's run count, and key presses.
   */
  async function registry(platform: 'MacIntel' | 'Win32' = 'MacIntel', stored?: object) {
    // The registry reads the visiting device off the navigator.
    Object.defineProperty(navigator, 'platform', { value: platform, configurable: true })
    if (stored !== undefined) localStorage.setItem('dsh.keybindings.v1', JSON.stringify(stored))
    const ctx = new Context()
    ctx.provide('locale', { subscribe: () => () => {}, bind: () => (key: string) => key, register: () => () => {} } as never)
    await ctx.plugin(SlotRegistry).await()
    await ctx.plugin(ShortcutsService).await()
    const runs = new Map(DEFAULTS.map(([id]) => [id, vi.fn()]))
    for (const [id, code, modifiers, regions] of DEFAULTS) {
      ctx.shortcuts.register({
        id: id as ShortcutCommandId, label: () => id, aliases: [],
        defaults: { 'web:macos': { code, modifiers }, 'web:windows': { code, modifiers } }, regions, modals: [],
        resolve: () => ({ status: 'handled', run: () => { runs.get(id)?.() } }),
      })
    }
    await vi.waitFor(() => { expect(ctx.shortcuts.config.getSnapshot().status).toBe('ready') })
    const plugin = ctx.plugin({ name: 'server-sidebar', apply: withholdShortcuts })
    await plugin.await()
    const press = (init: KeyboardEventInit): KeyboardEvent => {
      const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
      document.body.dispatchEvent(event)
      return event
    }
    const mac = (code: string, shift = false): KeyboardEvent => press({ code, metaKey: true, altKey: !shift, shiftKey: shift })
    const counts = (): Record<string, number> => Object.fromEntries([...runs].map(([id, run]) => [id, run.mock.calls.length]))
    return { ctx, plugin, press, mac, counts }
  }

  it('runs no withheld command for its key, and runs the shell\'s own', async () => {
    const { ctx, mac, counts } = await registry()
    const consumed = DEFAULTS.map(([, code, modifiers]) => mac(code, modifiers.includes('shift')).defaultPrevented)
    expect(counts()).toEqual({
      'session.new': 0, 'session.search': 0, 'workspace.add': 0, 'session.rename': 0, 'session.fork': 0,
      'session.archive': 0, 'workspace.files': 0, 'test.visible': 1,
    })
    // Every press is consumed: a withheld one by the console, the shell's own by the registry.
    expect(consumed).toEqual(DEFAULTS.map(() => true))
    await ctx.fiber.dispose()
  })

  it('withholds the key a person rebound a withheld command to, and lets the command that took its old key run', async () => {
    const { ctx, mac, counts } = await registry('MacIntel', {
      schemaVersion: 1,
      profiles: { 'web:macos': { 'session.new': { code: 'KeyJ', modifiers: ['primary', 'alt'] }, 'test.visible': { code: 'KeyN', modifiers: ['primary', 'alt'] } } },
    })
    mac('KeyJ')
    mac('KeyN')
    expect([counts()['session.new'], counts()['test.visible']]).toEqual([0, 1])
    await ctx.fiber.dispose()
  })

  it('lets AltGraph input through on a Windows browser, as the registry does', async () => {
    const { ctx, press, counts } = await registry('Win32')
    // Control+Alt+N is `session.new`'s Windows default; with AltGraph held it
    // is the character a Polish layout types there.
    expect(press({ code: 'KeyN', key: 'ń', ctrlKey: true, altKey: true, modifierAltGraph: true }).defaultPrevented).toBe(false)
    expect(press({ code: 'KeyN', key: 'n', ctrlKey: true, altKey: true }).defaultPrevented).toBe(true)
    expect(counts()['session.new']).toBe(0)
    await ctx.fiber.dispose()
  })

  it('consumes the Option+Command+N a Mac browser reports as a dead key without swallowing the press after it', async () => {
    const { ctx, press, counts } = await registry()
    expect(press({ code: 'KeyN', key: 'Dead', metaKey: true, altKey: true }).defaultPrevented).toBe(true)
    press({ code: 'KeyY', key: 'y', metaKey: true, altKey: true })
    expect([counts()['session.new'], counts()['test.visible']]).toEqual([0, 1])
    await ctx.fiber.dispose()
  })

  it('gives every key back to the registry once the console unloads', async () => {
    const { ctx, plugin, mac, counts } = await registry()
    await plugin.dispose()
    mac('KeyN')
    expect(counts()['session.new']).toBe(1)
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
      edit: vi.fn((): Promise<ShortcutSaveResult> => Promise.resolve({
        status: 'conflict', snapshot: SNAPSHOT, conflicts: ['session.archive' as ShortcutCommandId],
      })),
    }
  }

  /** A root context with the slot registry and shortcut registry, and `shell.overlay` declared as the shell declares it. */
  async function referenceBench() {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    ctx.slots.register({ name: 'root', children: { 'shell.overlay': { kind: 'list', scope: 'root' } } } as never, () => null)
    const shortcuts = shortcutsStub()
    ctx.provide('shortcuts', {
      ...shortcuts, config: createSnapshotStore({ status: 'ready' }), observeFixedInput: () => () => {},
    } as never)
    return { ctx, shortcuts }
  }

  /** The reference's own face, as `ui-shortcuts` builds it. */
  function ownerFace(shortcuts: ReturnType<typeof shortcutsStub>) {
    const config = createSnapshotStore({ status: 'ready' })
    return {
      config,
      inject: () => ({
        platform: 'macos', runtime: 'web', edit: shortcuts.edit, recording: vi.fn(), describeBinding: shortcuts.describeBinding,
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

  it('draws the reference\'s own component, store, and namespace over the console\'s catalog, check, and save, whichever registers first', async () => {
    for (const ownerFirst of [true, false]) {
      const { ctx, shortcuts } = await referenceBench()
      const owner = ownerFace(shortcuts)
      const options = { locale: 'shortcuts', store: STORE, inject: owner.inject }
      if (ownerFirst) registerOwner(ctx, options)
      await ctx.plugin({ name: 'server-sidebar', apply: withholdShortcuts }).await()
      if (!ownerFirst) registerOwner(ctx, options)
      await settle()
      const winner = drawn(ctx)
      expect(winner.component).toBe(OwnerReference)
      expect(winner.options).toMatchObject({ id: 'shortcuts', priority: -1 })
      expect([winner.locale, winner.store]).toEqual(['shortcuts', STORE])
      const face = winner.inject?.() ?? {}
      const hooks = face['hooks'] as Record<string, HostObservable<unknown>>
      expect(hooks['config']).toBe(owner.config)
      expect((hooks['catalog']?.getSnapshot() as ShortcutCatalogEntry[]).map(entry => entry.label)).toEqual(['快捷键速查', '打开设置', '切换右侧栏'])
      expect([face['platform'], face['runtime']]).toEqual(['macos', 'web'])
      const describe = face['describeBinding'] as Shortcuts['describeBinding']
      expect(describe({ code: 'KeyG', modifiers: ['meta', 'alt'] })).toEqual({ binding: null, keys: [], issue: 'reserved', conflicts: [] })
      const edit = face['edit'] as Shortcuts['edit']
      const reset = { type: 'reset', id: 'settings.open' as ShortcutCommandId } as const
      expect(await edit(reset, 1 as never)).toEqual({ status: 'conflict', snapshot: SNAPSHOT, conflicts: [], issue: 'reserved' })
      expect(shortcuts.edit).toHaveBeenCalledWith(reset, 1)
      await ctx.fiber.dispose()
    }
  })

  it('follows the reference\'s entry as it leaves and comes back, and leaves it alone once the console unloads', async () => {
    const { ctx, shortcuts } = await referenceBench()
    const plugin = ctx.plugin({ name: 'server-sidebar', apply: withholdShortcuts })
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
      await ctx.plugin({ name: 'server-sidebar', apply: withholdShortcuts }).await()
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

  it('names every command `ui-workspace` registers, once each, in the regions it registers them with', () => {
    // Literal copies: `ui-workspace` exports no constant for its command ids,
    // and a command it adds needs the console's decision before it reaches
    // the reference unwithheld.
    const source = readFileSync(resolvePath(client('ui-workspace'), 'shortcuts.ts'), 'utf8')
    const registered = [...source.matchAll(/^ {2}register\('([\w.]+)',/gmu)].map(match => match[1] ?? '')
    expect(registered).toEqual(WITHHELD.slice(0, 6).map(([id]) => id))
    // Every command goes through the one `register` helper, which fixes the regions.
    expect(source.match(/regions: \[[^\]]*\]/gu)).toEqual(['regions: [\'page\', \'editable\']'])
    for (const id of registered) expect({ id, regions: WITHHELD_COMMANDS.get(id) }).toEqual({ id, regions: ['page', 'editable'] })
  })

  it('names the command `ui-sidebar-files` registers, in the regions it registers it with', () => {
    const source = readFileSync(resolvePath(client('ui-sidebar-files'), 'index.ts'), 'utf8')
    const registration = /ctx\.shortcuts\.register\(\{([\s\S]*?)resolve:/u.exec(source)?.[1]
    expect(registration).toMatch(/id: 'workspace\.files' as ShortcutCommandId/u)
    expect(registration).toMatch(/regions: \['page', 'editable', 'terminal'\]/u)
    expect(WITHHELD_COMMANDS.get('workspace.files')).toEqual(['page', 'editable', 'terminal'])
    expect([...WITHHELD_COMMANDS.keys()]).toEqual(WITHHELD.map(([id]) => id))
  })

  it('is the id and namespace `ui-shortcuts` registers its reference under in `shell.overlay`, at the default priority', () => {
    // A literal copy: `ui-shortcuts` exports no constant for either. The
    // console's entry shadows it at -1 only while `ui-shortcuts` registers at
    // the default 0, and draws it with its store and its face's hooks; the
    // face's check and save are the registry's own, which the console wraps.
    const source = readFileSync(resolvePath(client('ui-shortcuts'), 'index.ts'), 'utf8')
    const registration = /ctx\.slots\.register\(\{([^}]*)\}, ShortcutReference\)/u.exec(source)?.[1]
    expect(registration).toMatch(/name: 'shell\.overlay', id: 'shortcuts', locale: 'shortcuts', store,/u)
    expect(registration).toMatch(/inject: injected,/u)
    expect(registration).not.toMatch(/\bpriority\b/u)
    const hooks = 'hooks: { catalog: ctx.shortcuts.catalog, config: ctx.shortcuts.config, fixedCatalog: ctx.shortcuts.fixedCatalog }'
    expect(source).toContain(`describeBinding,\n    ${hooks}`)
    expect(source).toContain('const edit: typeof ctx.shortcuts.edit = (...args) => ctx.shortcuts.edit(...args)')
    expect(source).toContain('const describeBinding: typeof ctx.shortcuts.describeBinding = binding => ctx.shortcuts.describeBinding(binding)')
  })
})
