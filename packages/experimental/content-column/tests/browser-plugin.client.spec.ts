// @vitest-environment jsdom
/**
 * The content surface's browser half against the real SlotRegistry: the column
 * registration and the kind slot it declares, the wait for the shell's
 * declaration, removal on fiber teardown (HMR safety), the dictionaries, the
 * dismiss callback its `content` registration injects, the empty
 * `conversation.chat.commandview` registration for `dismiss-content-entry` and
 * its hiding stylesheet, the behaviorless node half, and the invariant
 * companion's ownership reservation.
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as applyLocale, inject as localeInject } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '../src/client/index.ts'
import { apply as nodeApply } from '../src/index.ts'
import { ContentSurface, type ContentSurfaceInjected } from '../src/client/ContentSurface.tsx'
import { HiddenCommandRow } from '../src/client/HiddenCommandRow.tsx'
import { en, NS, zh } from '../src/client/locales.ts'
import * as ContentColumnInvariant from '../src/invariant.ts'

const HIDE_STYLE_ID = 'dsh-content-column-hide-empty-command-row'

/** Declare the content column and the chat view's per-command slot, the way their owners do. */
function declareShell(ctx: Context): void {
  ctx.slots.register({
    name: 'root',
    children: {
      content: { kind: 'single', scope: 'root' },
      'conversation.chat.commandview': { kind: 'keyed', scope: 'session' },
    },
  } as never, () => null)
}

/** Boot the browser half over a real slot tree that declares the content column. */
async function bench(): Promise<{ ctx: Context; fiber: ReturnType<Context['plugin']>; execute: ReturnType<typeof vi.fn> }> {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  declareShell(ctx)
  const execute = vi.fn(() => Promise.resolve({ ok: true, value: undefined }))
  // The locale plugin binds a settings scope, which reads the connection handle
  // and the forwarded-event port.
  ctx.provide('connection', { api: { settings: {} }, isLoopback: false } as never)
  ctx.provide('remote', { commands: { execute }, $on: () => () => {} } as never)
  ctx.provide('remote.commands', { execute } as never)
  ctx.provide('settingsScope', { bind: () => stubSettingsScope().scope } as never)
  await ctx.plugin({ inject: localeInject, apply: applyLocale }).await()
  // These specs assert the shipped Chinese copy. This lane runs under jsdom
  // (the hiding stylesheet below needs a `document`), whose default
  // `navigator.language` would itself detect to 'en' — state the asserted
  // locale explicitly rather than resting on that coincidence.
  ctx.locale.setLocale('zh')
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { ctx, fiber, execute }
}

afterEach(() => {
  document.getElementById(HIDE_STYLE_ID)?.remove()
})

describe('content-column browser half', () => {
  it('declares the services it binds', () => {
    expect(inject).toEqual(['slots', 'locale', 'remote', 'remote.commands'])
  })

  it('waits for the shell to declare the content column before claiming it', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    ctx.provide('locale', { register: () => () => {}, bind: () => () => '' } as never)
    ctx.provide('remote', { commands: { execute: vi.fn() } } as never)
    ctx.provide('remote.commands', { execute: vi.fn() } as never)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(ctx.slots.entries('content')).toHaveLength(0)

    declareShell(ctx)
    await Promise.resolve()
    expect(ctx.slots.entries('content')).toHaveLength(1)
  })

  it('claims the column, opens the kind slot, and fiber teardown removes both (HMR safety)', async () => {
    const { ctx, fiber } = await bench()
    const [entry] = ctx.slots.entries('content')
    expect(entry?.component).toBe(ContentSurface)
    expect(entry?.children).toEqual({ 'content.surface.kind': { kind: 'keyed', scope: 'root' } })

    await fiber.dispose()
    expect(ctx.slots.entries('content')).toHaveLength(0)
    // The kind slot is the column's declaration, so it collapses with it: a
    // renderer registered against it has nowhere to be.
    expect(() => {
      ctx.slots.register({ name: 'content.surface.kind', key: 'page' } as never, () => null)
    }).toThrow()
  })

  it('injects a dismiss callback that executes dismiss-content-entry against the named session', async () => {
    const { ctx, execute } = await bench()
    const [entry] = ctx.slots.entries('content')
    const injected = entry?.inject?.() as unknown as ContentSurfaceInjected
    injected.onDismiss('session-a', 'page', 'reports')
    await Promise.resolve()
    expect(execute).toHaveBeenCalledWith('session-a', '/dismiss-content-entry page reports', [])
  })

  it(
    'registers an empty conversation.chat.commandview entry for dismiss-content-entry, and fiber teardown removes it (HMR safety)',
    async () => {
      const { ctx, fiber } = await bench()
      const [entry] = ctx.slots.entries('conversation.chat.commandview')
      expect(entry?.component).toBe(HiddenCommandRow)
      expect(entry?.options.key).toBe('dismiss-content-entry')
      expect((entry?.component as typeof HiddenCommandRow)()).toBeNull()

      await fiber.dispose()
      expect(ctx.slots.entries('conversation.chat.commandview')).toHaveLength(0)
    },
  )

  it('injects the hiding stylesheet, and fiber teardown removes it (HMR safety)', async () => {
    const { fiber } = await bench()
    const style = document.getElementById(HIDE_STYLE_ID)
    expect(style).not.toBeNull()
    expect(style?.textContent).toContain('[data-chat-flow-kind="command"]')
    expect(style?.textContent).toContain('[data-slot="conversation.chat.commandview"]:empty')

    await fiber.dispose()
    expect(document.getElementById(HIDE_STYLE_ID)).toBeNull()
  })

  it('registers both dictionaries under its own namespace and releases them with the fiber', async () => {
    const { ctx, fiber } = await bench()
    const translate = ctx.locale.bind(NS)
    expect(translate('switcher.label')).toBe(zh['switcher.label'])
    ctx.locale.setLocale('en')
    expect(translate('switcher.label')).toBe(en['switcher.label'])

    // Withdrawn dictionaries leave the key unresolved rather than translated.
    await fiber.dispose()
    expect(translate('switcher.label')).not.toBe(en['switcher.label'])
  })

  it('keeps the English dictionary key-identical to the Chinese source of truth', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })
})

describe('content-column node half', () => {
  it('contributes no host behavior', () => {
    expect(nodeApply).not.toThrow()
  })
})

describe('content-column invariant companion', () => {
  it('reserves package ownership under its declared companion name', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    const fiber = ctx.plugin(ContentColumnInvariant)
    await fiber.await()
    expect(ContentColumnInvariant.name).toBe('experimental-content-column-invariant')
    expect(ContentColumnInvariant.inject).toEqual(['invariants'])
    // Emitting an unrelated event proves the companion installed no audit.
    expect(() => { (ctx.emit as (event: string) => void)('slots/changed') }).not.toThrow()
    await fiber.dispose()
  })
})
