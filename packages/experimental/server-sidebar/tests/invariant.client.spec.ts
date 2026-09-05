/**
 * Package-owned invariant: a `settings/updated` commit for this package's
 * namespace holds every cross-element constraint of the server-menu document
 * — one workflow per id, one group per id, the reserved temporary id unclaimed,
 * a showable group name, and no workflow filed under a group nothing defines.
 * Emitted directly (bypassing the real settings provider's own write path,
 * whose `validate` hook already refuses these before they could commit) to
 * prove the invariant logic itself, matching `@deepseek-ai/dsh-settings`'s own
 * invariant test technique.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import * as ServerSidebarInvariant from '../src/invariant.ts'
import { SERVER_SIDEBAR_NAMESPACE, type ServerMenuSettings } from '../src/workflows.ts'
import { TEMPORARY_GROUP_ID } from '../src/menu-constants.ts'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(ServerSidebarInvariant)
  return ctx
}

/** One committed document, defaults filled in as the schema fills them. */
function document(fields: Partial<ServerMenuSettings>): ServerMenuSettings {
  return { workflows: [], groups: [], ...fields }
}

function workflow(overrides: Partial<ServerMenuSettings['workflows'][number]>): ServerMenuSettings['workflows'][number] {
  return { id: 'w1', name: 'A', order: 0, homeSessionId: 's1', navSnapshot: [], savedAt: 1, ...overrides }
}

/** Emit one commit for this package's namespace. */
function commit(ctx: Context, value: ServerMenuSettings): void {
  ctx.emit('settings/updated', SERVER_SIDEBAR_NAMESPACE, value, document({}), 'update')
}

describe('server-sidebar invariants', () => {
  it('fails a commit whose workflows carry a duplicate id', async () => {
    const ctx = await setup()
    expect(() => {
      commit(ctx, document({ workflows: [workflow({}), workflow({ name: 'B', order: 1, homeSessionId: 's2' })] }))
    }).toThrow('server-sidebar: committed server-menu document: duplicate workflow id "w1"')
  })

  it('fails a commit whose groups carry a duplicate id', async () => {
    const ctx = await setup()
    expect(() => {
      commit(ctx, document({
        groups: [{ id: 'g1', name: 'A', pinned: false, order: 0 }, { id: 'g1', name: 'B', pinned: false, order: 1 }],
      }))
    }).toThrow('duplicate group id "g1"')
  })

  it('fails a commit whose group claims the reserved temporary id', async () => {
    const ctx = await setup()
    expect(() => {
      commit(ctx, document({ groups: [{ id: TEMPORARY_GROUP_ID, name: 'A', pinned: false, order: 0 }] }))
    }).toThrow(`group id "${TEMPORARY_GROUP_ID}" is reserved`)
  })

  it('fails a commit whose group name is blank', async () => {
    const ctx = await setup()
    expect(() => {
      commit(ctx, document({ groups: [{ id: 'g1', name: '   ', pinned: false, order: 0 }] }))
    }).toThrow('group "g1" has a blank name')
  })

  it('fails a commit whose workflow names a group nothing defines', async () => {
    const ctx = await setup()
    expect(() => {
      commit(ctx, document({ workflows: [workflow({ groupId: 'gone' })] }))
    }).toThrow('workflow "w1" names group "gone", which no group defines')
  })

  it('passes a commit that holds every constraint', async () => {
    const ctx = await setup()
    expect(() => {
      commit(ctx, document({
        workflows: [workflow({ groupId: 'g1' }), workflow({ id: 'w2', name: 'B', order: 1, homeSessionId: 's2' })],
        groups: [{ id: 'g1', name: '每日', pinned: true, order: 0 }],
      }))
    }).not.toThrow()
  })

  it('ignores a commit for an unrelated namespace', async () => {
    const ctx = await setup()
    expect(() => {
      ctx.emit('settings/updated', 'ui-theme' as SettingsNamespace, { theme: 'dark' }, { theme: 'light' }, 'update')
    }).not.toThrow()
  })
})
