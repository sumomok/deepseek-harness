// @vitest-environment jsdom
/**
 * The show-component browser half against the real SlotRegistry: the wait for
 * the content column's declaration, the kind key it claims, the component row's
 * namespace it translates through, the action face it injects, the two
 * `conversation.chat.commandview` registrations that own what this package's
 * commands draw in the chat, and removal on fiber teardown (HMR safety).
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as applyLocale, inject as localeInject } from '@deepseek-ai/dsh-client-locale/client'
import { NS } from '@deepseek-ai/dsh-experimental-component-kit/client'
import { apply, inject } from '../src/client/index.ts'
import { ComponentSurface, type ComponentSurfaceInjected } from '../src/client/ComponentSurface.tsx'
import { ActionCommandRow } from '../src/client/ActionCommandRow.tsx'
import { ViewCommandRow } from '../src/client/ViewCommandRow.tsx'
import { CONFIRM_BAR_ID, CONFIRM_BAR_PRESS_ID } from '../src/component-call.ts'

/**
 * Declare the content column and its kind slot the way `content-column` does,
 * and the chat view's per-command slot the way `ui-conversation` does.
 */
function declareColumn(ctx: Context): void {
  ctx.slots.register({
    name: 'root',
    children: {
      content: { kind: 'single', scope: 'root' },
      'conversation.chat.commandview': { kind: 'keyed', scope: 'session' },
    },
  } as never, () => null)
  ctx.slots.register({
    name: 'content',
    children: { 'content.surface.kind': { kind: 'keyed', scope: 'root' } },
  } as never, () => null)
}

/** Boot the browser half over a real slot tree that declares the column. */
async function bench(): Promise<{ ctx: Context; fiber: ReturnType<Context['plugin']>; execute: ReturnType<typeof vi.fn> }> {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  declareColumn(ctx)
  const execute = vi.fn(() => Promise.resolve({ ok: true, value: undefined }))
  // The locale plugin binds a settings scope, which reads the connection handle
  // and the forwarded-event port.
  ctx.provide('connection', { api: { settings: {} }, isLoopback: false } as never)
  ctx.provide('remote', { commands: { execute }, $on: () => () => {} } as never)
  ctx.provide('remote.commands', { execute } as never)
  ctx.provide('settingsScope', { bind: () => stubSettingsScope().scope } as never)
  await ctx.plugin({ inject: localeInject, apply: applyLocale }).await()
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { ctx, fiber, execute }
}

describe('show-component browser half', () => {
  it('declares the services it binds', () => {
    expect(inject).toEqual(['slots', 'locale', 'remote', 'remote.commands'])
  })

  it('waits for the content column to declare its kind slot before claiming a key', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    ctx.provide('locale', { register: () => () => {}, bind: () => () => '' } as never)
    ctx.provide('remote', { commands: { execute: vi.fn() } } as never)
    ctx.provide('remote.commands', { execute: vi.fn() } as never)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(ctx.slots.entries('content.surface.kind')).toHaveLength(0)

    declareColumn(ctx)
    await Promise.resolve()
    expect(ctx.slots.entries('content.surface.kind')).toHaveLength(1)
  })

  it(
    'registers a chat row for each of its commands, and teardown removes both (HMR safety)',
    async () => {
      // Both commands are run for the record they write; without these seats
      // `ui-conversation` falls back to its GenericCommandCard and the reader
      // gets an English `component-action · Completed` or `show-content-view ·
      // Completed` row for something they did themselves. What each row draws
      // instead is `action-command-row.client.spec.tsx`'s and
      // `view-command-row.client.spec.tsx`'s subject.
      const { ctx, fiber } = await bench()
      const rows = ctx.slots.entries('conversation.chat.commandview')
      expect(new Map(rows.map(entry => [entry.options.key, entry.component])))
        .toEqual(new Map([['component-action', ActionCommandRow], ['show-content-view', ViewCommandRow]]))

      await fiber.dispose()
      expect(ctx.slots.entries('conversation.chat.commandview')).toHaveLength(0)
    },
  )

  it('claims the component key against the component row\'s namespace, and teardown removes it (HMR safety)', async () => {
    const { ctx, fiber } = await bench()
    const [entry] = ctx.slots.entries('content.surface.kind')
    expect(entry?.component).toBe(ComponentSurface)
    expect(entry?.options.key).toBe('component')
    // The seat has no dictionary of its own: it reads the component row's.
    expect(entry?.locale).toBe(NS)

    await fiber.dispose()
    expect(ctx.slots.entries('content.surface.kind')).toHaveLength(0)
  })

  it('injects an action face that executes component-action against the named session', async () => {
    const { ctx, execute } = await bench()
    const [entry] = ctx.slots.entries('content.surface.kind')
    const injected = entry?.inject?.() as unknown as ComponentSurfaceInjected
    // The seat awaits this: what it answers is whether a record is coming, not
    // what became of the gesture.
    expect(await injected.onAction('session-a', {
      entryId: 'budget',
      componentId: CONFIRM_BAR_ID,
      actionId: CONFIRM_BAR_PRESS_ID,
      nodeId: 'ask',
      payload: { buttonId: 'approve' },
    })).toBe('dispatched')
    expect(execute).toHaveBeenCalledWith(
      'session-a',
      `/component-action {"entryId":"budget","componentId":"${CONFIRM_BAR_ID}","actionId":"${CONFIRM_BAR_PRESS_ID}","nodeId":"ask","payload":{"buttonId":"approve"}}`,
      [],
    )
  })

  it('injects one in-flight table for the page, not one per mounted seat', async () => {
    // A press outlives the seat that made it: the column unmounts a kind's
    // blocks on every switch, and a table built per injection would hand the
    // block that comes back a clean slate and let one decision be reported
    // twice.
    const { ctx } = await bench()
    const [entry] = ctx.slots.entries('content.surface.kind')
    const first = entry?.inject?.() as unknown as ComponentSurfaceInjected
    const second = entry?.inject?.() as unknown as ComponentSurfaceInjected
    expect(first.pending).toBe(second.pending)
    expect(first.pending.size).toBe(0)
  })
})
