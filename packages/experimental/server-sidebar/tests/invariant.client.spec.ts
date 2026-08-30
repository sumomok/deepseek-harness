/**
 * Package-owned invariant: `settings/updated` commits for this package's
 * namespace never carry two workflows with the same id. Emitted directly
 * (bypassing the real settings provider's own write path, whose `validate`
 * hook already refuses this before it could commit) to prove the invariant
 * logic itself, matching `@deepseek-ai/dsh-settings`'s own invariant test
 * technique.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import * as ServerSidebarInvariant from '../src/invariant.ts'
import { SERVER_SIDEBAR_NAMESPACE } from '../src/workflows.ts'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(ServerSidebarInvariant)
  return ctx
}

describe('server-sidebar invariants', () => {
  it('fails a commit whose workflows carry a duplicate id', async () => {
    const ctx = await setup()
    expect(() => {
      ctx.emit('settings/updated', SERVER_SIDEBAR_NAMESPACE, {
        workflows: [
          { id: 'w1', name: 'A', order: 0, homeSessionId: 's1', navSnapshot: [], savedAt: 1 },
          { id: 'w1', name: 'B', order: 1, homeSessionId: 's2', navSnapshot: [], savedAt: 2 },
        ],
      }, { workflows: [] }, 'update')
    }).toThrow(/duplicate id "w1"/)
  })

  it('passes a commit with no duplicate id', async () => {
    const ctx = await setup()
    expect(() => {
      ctx.emit('settings/updated', SERVER_SIDEBAR_NAMESPACE, {
        workflows: [
          { id: 'w1', name: 'A', order: 0, homeSessionId: 's1', navSnapshot: [], savedAt: 1 },
          { id: 'w2', name: 'B', order: 1, homeSessionId: 's2', navSnapshot: [], savedAt: 2 },
        ],
      }, { workflows: [] }, 'update')
    }).not.toThrow()
  })

  it('ignores a commit for an unrelated namespace', async () => {
    const ctx = await setup()
    expect(() => {
      ctx.emit('settings/updated', settingsNamespace('ui-theme'), { theme: 'dark' }, { theme: 'light' }, 'update')
    }).not.toThrow()
  })
})
