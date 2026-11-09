/** Selected child routes reach the real AgentLoop independently of inherited model state. */
import { describe, expect, it } from 'vitest'
import { startTestActivation } from '../../subagent/tests/local-activation.ts'
import {
  childDefaultEffort, childExplicitEffort, childSelection, completeParentTurn,
  laterSelection, leadSelection, modelSelectionFixture,
} from '../../subagent/tests/model-selection-fixture.ts'

const contexts = [
  { label: 'fresh spawn', provider: 'spawn', history: false },
  { label: 'empty fork', provider: 'fork', history: false },
  { label: 'history fork', provider: 'fork', history: true },
] as const

describe.each(contexts)('$label model selection', ({ provider, history }) => {
  it.each([
    { label: 'route default', effort: undefined, expected: childDefaultEffort },
    { label: 'explicit effort', effort: childExplicitEffort, expected: childExplicitEffort },
  ])('uses the child route with $label in its first model request', async ({ effort, expected }) => {
    const { boot } = await modelSelectionFixture()
    const { ctx, parent, childAdapter, leadAdapter } = await boot()
    if (history) await completeParentTurn(parent)
    const selected = { ...childSelection, ...effort === undefined ? {} : { reasoningEffort: effort } }
    const run = await startTestActivation(ctx, provider, {
      parent,
      prompt: [{ type: 'text', text: 'child task' }],
      agentOptions: selected,
    })
    expect((await run.result).stopReason).toBe('completed')
    expect(childAdapter.requests).toHaveLength(1)
    expect(childAdapter.requests[0]).toMatchObject({ ...childSelection, reasoningEffort: expected })
    expect(leadAdapter.requests).toHaveLength(history ? 1 : 0)

    const session = run.localAgent.session
    expect(session.inheritedEventCount > 0).toBe(history)
    const ownEvents = session.snapshotEvents().slice(session.inheritedEventCount)
    const selection = ownEvents.find(event => event.type === 'model/selection')
    const request = ownEvents.find(event => event.type === 'request/header')
    expect(selection?.data).toEqual(selected)
    expect(selection!.seq).toBeLessThan(request!.seq)
    expect(request?.data).toMatchObject({ header: { config: { ...childSelection, reasoningEffort: expected } } })
    expect(ownEvents.find(event => event.type === 'subagent/descriptor')?.data).toMatchObject({
      version: 3,
      agentProvider: childSelection.provider,
      agentModel: childSelection.model,
      ...effort === undefined ? {} : { agentReasoningEffort: effort },
    })
    expect(parent.session.snapshotEvents().some(event => event.type === 'model/selection'
      && event.data.provider === childSelection.provider)).toBe(false)
  })

  it('inherits the latest request or creation options without adopting a pending parent switch', async () => {
    const { boot } = await modelSelectionFixture()
    const { ctx, parent, leadAdapter, laterAdapter } = await boot()
    const inherited = history ? { ...leadSelection, model: 'lead-latest' } : leadSelection
    if (history) {
      parent.model.select(inherited)
      ctx.on('agent/turn-stopping', ({ agent }) => {
        if (agent === parent) agent.model.select(laterSelection)
      })
      await completeParentTurn(parent)
    }
    parent.model.select(laterSelection)
    const run = await startTestActivation(ctx, provider, {
      parent,
      prompt: [{ type: 'text', text: 'inherit the established route' }],
    })
    expect((await run.result).stopReason).toBe('completed')
    expect(leadAdapter.requests.at(-1)).toMatchObject(inherited)
    expect(laterAdapter.requests).toHaveLength(0)
    expect(parent.model.current()).toEqual(laterSelection)
  })
})
