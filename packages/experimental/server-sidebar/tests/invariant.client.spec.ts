/**
 * Package-owned invariant: `settings/updated` commits for this package's
 * namespace never carry two favorites naming the same session. Emitted
 * directly (bypassing the real settings provider's own write path, whose
 * `validate` hook already refuses this before it could commit) to prove the
 * invariant logic itself, matching `@deepseek-ai/dsh-settings`'s own
 * invariant test technique.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import * as ServerSidebarInvariant from '../src/invariant.ts'
import { SERVER_SIDEBAR_NAMESPACE } from '../src/favorites.ts'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(ServerSidebarInvariant)
  return ctx
}

describe('server-sidebar invariants', () => {
  it('fails a commit whose favorites carry a duplicate session id', async () => {
    const ctx = await setup()
    expect(() => {
      ctx.emit('settings/updated', SERVER_SIDEBAR_NAMESPACE, {
        favorites: [{ sessionId: 's1', label: 'A', order: 0 }, { sessionId: 's1', label: 'B', order: 1 }],
      }, { favorites: [] }, 'update')
    }).toThrow(/duplicate session "s1"/)
  })

  it('passes a commit with no duplicate session', async () => {
    const ctx = await setup()
    expect(() => {
      ctx.emit('settings/updated', SERVER_SIDEBAR_NAMESPACE, {
        favorites: [{ sessionId: 's1', label: 'A', order: 0 }, { sessionId: 's2', label: 'B', order: 1 }],
      }, { favorites: [] }, 'update')
    }).not.toThrow()
  })

  it('ignores a commit for an unrelated namespace', async () => {
    const ctx = await setup()
    expect(() => {
      ctx.emit('settings/updated', settingsNamespace('ui-theme'), { theme: 'dark' }, { theme: 'light' }, 'update')
    }).not.toThrow()
  })
})
