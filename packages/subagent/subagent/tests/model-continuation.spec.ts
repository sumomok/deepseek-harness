/** Warm delivery and cold resume retain the child's durable model choices. */
import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { queueHostSubagentPrompt } from '../src/internal.ts'
import { startTestActivation } from './local-activation.ts'
import {
  childDefaultEffort, childSelection, completeParentTurn, laterSelection, modelSelectionFixture,
} from './model-selection-fixture.ts'
import { loadStoredSession } from './persistence-helpers.ts'

function selections(events: readonly SessionEvent[]) {
  return events.flatMap(event => event.type === 'model/selection' ? [event.data] : [])
}

function requestSelections(events: readonly SessionEvent[]) {
  return events.flatMap(event => event.type === 'request/header' ? [{
    provider: event.data.header.config.provider,
    model: event.data.header.config.model,
    reasoningEffort: event.data.header.config.reasoningEffort,
  }] : [])
}

const childRequestSelection = { ...childSelection, reasoningEffort: childDefaultEffort }

describe.each(['spawn', 'fork'])('%s child model continuation', (provider) => {
  it.each([false, true])('warm delivery preserves a later pending selection: %s', async (switchModel) => {
    const { boot } = await modelSelectionFixture()
    const { ctx, parent, childAdapter, laterAdapter } = await boot({ paused: true })
    if (provider === 'fork') await completeParentTurn(parent)
    const run = await startTestActivation(ctx, provider, {
      parent,
      prompt: [{ type: 'text', text: 'initial work' }],
      agentOptions: childSelection,
    })
    await childAdapter.entered.promise
    const child = run.localAgent
    if (switchModel) child.model.select(laterSelection)
    await queueHostSubagentPrompt(ctx.subagents, parent, child.id,
      [{ type: 'text', text: 'continue while resident' }], { kind: 'user' }, new AbortController().signal)
    expect(ctx.agents.get(child.id)).toBe(child)
    childAdapter.release.resolve(undefined)
    expect((await run.result).stopReason).toBe('completed')

    expect(childAdapter.requests).toHaveLength(switchModel ? 1 : 2)
    expect(laterAdapter.requests).toHaveLength(switchModel ? 1 : 0)
    const ownEvents = child.session.snapshotEvents().slice(child.session.inheritedEventCount)
    expect(requestSelections(ownEvents)).toEqual(switchModel
      ? [childRequestSelection, laterSelection]
      : [childRequestSelection])
    expect((switchModel ? laterAdapter : childAdapter).requests.at(-1))
      .toMatchObject(switchModel ? laterSelection : childRequestSelection)
    expect(selections(ownEvents)).toEqual(switchModel ? [childSelection, laterSelection] : [childSelection])
  })

  it.each(['initial', 'last-used', 'pending'] as const)(
    'cold resume preserves the %s child selection across a runtime restart',
    async (selectionState) => {
      const { boot } = await modelSelectionFixture()
      const first = await boot({ paused: true })
      if (provider === 'fork') await completeParentTurn(first.parent)
      const run = await startTestActivation(first.ctx, provider, {
        parent: first.parent,
        prompt: [{ type: 'text', text: 'initial work' }],
        agentOptions: childSelection,
      })
      await first.childAdapter.entered.promise
      const child = run.localAgent
      if (selectionState !== 'initial') child.model.select(laterSelection)
      if (selectionState === 'last-used') {
        await queueHostSubagentPrompt(first.ctx.subagents, first.parent, child.id,
          [{ type: 'text', text: 'use the later selection' }], { kind: 'user' }, new AbortController().signal)
      }
      first.childAdapter.release.resolve(undefined)
      expect((await run.result).stopReason).toBe('completed')
      expect(first.ctx.agents.get(child.id)).toBeUndefined()
      const before = await loadStoredSession(first.ctx.sessionPersistence, child.id)
      const ownBefore = before.events.slice(before.inheritedEventCount)
      expect(requestSelections(ownBefore)).toEqual(selectionState === 'last-used'
        ? [childRequestSelection, laterSelection]
        : [childRequestSelection])
      expect(selections(ownBefore)).toEqual(selectionState === 'initial'
        ? [childSelection]
        : [childSelection, laterSelection])
      await first.ctx.fiber.dispose()

      const resumed = await boot({ resume: true })
      // Parent notices are admitted but parked so only the child's requests consume this fixture's adapters.
      resumed.ctx.on('agent/pre-step', ({ agent }, next) => agent === resumed.parent
        ? Promise.resolve({ kind: 'reject', reason: 'park parent notices' } as const)
        : next())
      const settled = Promise.withResolvers<undefined>()
      resumed.ctx.on('subagent/end', (info) => {
        if (info.id === child.id) settled.resolve(undefined)
      })
      await queueHostSubagentPrompt(resumed.ctx.subagents, resumed.parent, child.id,
        [{ type: 'text', text: 'resume after restart' }], { kind: 'user' }, new AbortController().signal)
      await settled.promise
      expect(resumed.ctx.agents.get(child.id)).toBeUndefined()
      const after = await loadStoredSession(resumed.ctx.sessionPersistence, child.id)
      const ownAfter = after.events.slice(after.inheritedEventCount)
      const expected = selectionState === 'initial' ? childRequestSelection : laterSelection
      expect(requestSelections(ownAfter)).toEqual([...requestSelections(ownBefore), expected])
      expect(selections(ownAfter)).toEqual(selections(ownBefore))
      expect(resumed.childAdapter.requests).toHaveLength(selectionState === 'initial' ? 1 : 0)
      expect(resumed.laterAdapter.requests).toHaveLength(selectionState === 'initial' ? 0 : 1)
      expect((selectionState === 'initial' ? resumed.childAdapter : resumed.laterAdapter).requests[0])
        .toMatchObject(expected)
    },
  )
})
