/**
 * Host-wide index preparation on the Session control stream: a new baseline
 * carries the last reported progress, later reports arrive as `search-index`
 * frames, and the Remote `control` switch delivers them to a subscriber.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionQueryEngine, { type SessionSearchIndexProgress } from '@deepseek-ai/dsh-session-query'
import { createSessionTestRemote } from './test-remote.ts'
import type { SessionControlFrame } from '../src/types.ts'

/** Query backend whose index preparation the test advances directly. */
class ReportingQuery extends SessionQueryEngine {
  override searchSessions(): Promise<never> {
    return Promise.reject(new Error('session search is not configured in this test'))
  }

  override searchMessages(): Promise<never> {
    return Promise.reject(new Error('message search is not configured in this test'))
  }

  override searchEvents(): Promise<never> {
    return Promise.reject(new Error('event search is not configured in this test'))
  }

  /**
   * Report one preparation state exactly as a real backend would.
   * @param progress - phase and counters to publish.
   */
  report(progress: SessionSearchIndexProgress): void {
    this._reportSearchIndexProgress(progress)
  }
}

const defaults = { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' }

async function harness(): Promise<{
  query: ReportingQuery
  control: (signal: AbortSignal) => AsyncIterable<SessionControlFrame>
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  const query = new ReportingQuery(ctx)
  const remote = await createSessionTestRemote(ctx, defaults)
  return { query, control: signal => remote.control(signal) }
}

/** Read the opening baseline of one control stream generation. */
async function baseline(
  iterator: AsyncIterator<SessionControlFrame>,
): Promise<Extract<SessionControlFrame, { type: 'baseline' }>> {
  const opened = await iterator.next()
  if (opened.done === true || opened.value.type !== 'baseline') throw new Error('missing control baseline')
  return opened.value
}

describe('session control index preparation', () => {
  it('carries the last reported preparation in a new baseline and streams later reports', async () => {
    const { query, control } = await harness()
    query.report({ phase: 'opening', examined: 0, total: 0, skipped: 0 })

    const abort = new AbortController()
    const iterator = control(abort.signal)[Symbol.asyncIterator]()
    expect((await baseline(iterator)).value.searchIndex)
      .toEqual({ phase: 'opening', examined: 0, total: 0, skipped: 0 })

    query.report({ phase: 'reconciling', examined: 3, total: 7, skipped: 1 })
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: 'search-index', value: { phase: 'reconciling', examined: 3, total: 7, skipped: 1 } },
    })

    abort.abort()
    await iterator.next()
  })

  it('reports no preparation until the Host starts an index', async () => {
    const { control } = await harness()
    const abort = new AbortController()
    const iterator = control(abort.signal)[Symbol.asyncIterator]()
    expect('searchIndex' in (await baseline(iterator)).value).toBe(false)

    abort.abort()
    await iterator.next()
  })
})
