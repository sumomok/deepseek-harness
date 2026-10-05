/**
 * `withheld-rename.ts`: the entry the console draws in place of
 * `dsh-client-ui-workspace`'s rename dialog — nothing — and the rename
 * requests it settles as soon as they are raised, over a real slot registry,
 * whichever of the two entries registers first, as the owner's entry comes
 * and goes, and once the console unloads; and the entry id and the face
 * members, checked against `ui-workspace`'s source.
 *
 * The `.client.` suffix names the typecheck aggregate this package belongs to,
 * not the face under test.
 */
import { readFileSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { withholdRenameDialog, WithheldRenameDialog } from '../src/client/withheld-rename.ts'

/** A rename request as `ui-workspace` raises one. */
const REQUEST = { sessionId: 'session-a', currentTitle: '月度报表' }

/** `ui-workspace`'s dialog, standing in for its own. */
function OwnerDialog(): null {
  return null
}

/** A root context with the slot registry and `shell.overlay` declared as the shell declares it. */
async function bench(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({ name: 'root', children: { 'shell.overlay': { kind: 'list', scope: 'root' } } } as never, () => null)
  return ctx
}

/**
 * `ui-workspace`'s rename request and the face its entry carries.
 * @returns the request store, the settlement spy, and the inject factory.
 */
function ownerFace() {
  const request = createSnapshotStore<typeof REQUEST | null>(null)
  const settle = vi.fn(() => { request.set(null) })
  return { request, settle, inject: () => ({ hooks: { renameRequest: request }, settleSessionRename: settle, renameSession: vi.fn() }) }
}

/**
 * Register an entry under the rename dialog's id, as `ui-workspace` does.
 * @param ctx - the bench context.
 * @param inject - the entry's inject factory.
 * @returns the registration's disposer.
 */
function registerOwner(ctx: Context, inject: () => object): () => void {
  return ctx.slots.register({ name: 'shell.overlay', id: 'workspace.session-rename', locale: 'workspace', inject } as never, OwnerDialog)
}

/** The one entry drawn for the rename dialog's id. */
function drawn(ctx: Context) {
  const winners = ctx.slots.entriesOfSlot('shell.overlay').filter(entry => entry.options.id === 'workspace.session-rename')
  expect(winners).toHaveLength(1)
  return winners[0]!
}

/** Let the ledger report the registrations of this turn. */
function settled(): Promise<void> {
  return new Promise((resolveTurn) => { setTimeout(resolveTurn, 0) })
}

describe('the withheld rename dialog', () => {
  it('draws nothing in its place and settles each request as it is raised, whichever entry registers first', async () => {
    for (const ownerFirst of [true, false]) {
      const ctx = await bench()
      const owner = ownerFace()
      if (ownerFirst) registerOwner(ctx, owner.inject)
      await ctx.plugin({ name: 'server-sidebar', inject: ['slots'], apply: withholdRenameDialog }).await()
      if (!ownerFirst) registerOwner(ctx, owner.inject)
      await settled()
      const winner = drawn(ctx)
      expect([winner.component, winner.options.priority, WithheldRenameDialog()]).toEqual([WithheldRenameDialog, -1, null])
      owner.request.set(REQUEST)
      expect([owner.settle.mock.calls.length, owner.request.getSnapshot()]).toEqual([1, null])
      owner.request.set(REQUEST)
      expect([owner.settle.mock.calls.length, owner.request.getSnapshot()]).toEqual([2, null])
      await ctx.fiber.dispose()
    }
  })

  it('settles a request already pending when the console loads', async () => {
    const ctx = await bench()
    const owner = ownerFace()
    registerOwner(ctx, owner.inject)
    owner.request.set(REQUEST)
    await ctx.plugin({ name: 'server-sidebar', inject: ['slots'], apply: withholdRenameDialog }).await()
    expect([owner.settle.mock.calls.length, owner.request.getSnapshot()]).toEqual([1, null])
    await ctx.fiber.dispose()
  })

  it('follows the owner\'s entry as it leaves and comes back, and leaves its requests alone once the console unloads', async () => {
    const ctx = await bench()
    const plugin = ctx.plugin({ name: 'server-sidebar', inject: ['slots'], apply: withholdRenameDialog })
    await plugin.await()
    const first = ownerFace()
    const leave = registerOwner(ctx, first.inject)
    await settled()
    leave()
    await settled()
    first.request.set(REQUEST)
    expect(first.settle).not.toHaveBeenCalled()
    const next = ownerFace()
    next.request.set(REQUEST)
    registerOwner(ctx, next.inject)
    await settled()
    expect([next.settle.mock.calls.length, next.request.getSnapshot()]).toEqual([1, null])
    await plugin.dispose()
    expect([drawn(ctx).component, drawn(ctx).options.priority]).toEqual([OwnerDialog, undefined])
    next.request.set(REQUEST)
    expect(next.settle).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })

  it('still draws nothing for an owner face it cannot read, and leaves that face\'s request pending', async () => {
    const pending = createSnapshotStore<typeof REQUEST | null>(REQUEST)
    const settle = vi.fn()
    for (const inject of [
      () => ({ settleSessionRename: settle }),
      () => ({ hooks: { renameRequest: pending }, settleSessionRename: 'not a function' }),
    ]) {
      const ctx = await bench()
      registerOwner(ctx, inject)
      await ctx.plugin({ name: 'server-sidebar', inject: ['slots'], apply: withholdRenameDialog }).await()
      expect(drawn(ctx).component).toBe(WithheldRenameDialog)
      await ctx.fiber.dispose()
    }
    expect([settle.mock.calls.length, pending.getSnapshot()]).toEqual([0, REQUEST])
  })

  it('shadows the id `ui-workspace` registers its dialog under, at the default priority, and reads the face it builds', () => {
    // Literal copies: `ui-workspace` exports no constant for the id and no
    // type for the face. The console's entry shadows it at -1 only while
    // `ui-workspace` registers at the default 0.
    const source = readFileSync(resolvePath(import.meta.dirname, '../../../client/ui-workspace/src/client/index.ts'), 'utf8')
    const registration = /ctx\.slots\.register\(\{([^}]*)\}, SessionRenameDialog\)/u.exec(source)?.[1]
    expect(registration).toMatch(/name: 'shell\.overlay', id: 'workspace\.session-rename', locale: NS, inject: renameDialogInjected,/u)
    expect(registration).not.toMatch(/\bpriority\b/u)
    const face = /const renameDialogInjected = \(\): SessionRenameDialogInjected => \(\{([^)]*)\}\)/u.exec(source)?.[1]
    expect(face).toMatch(/hooks: \{ renameRequest \},/u)
    expect(face).toMatch(/settleSessionRename: shortcutControls\.closeRename,/u)
  })
})
