/**
 * The route gate the picture read runs before it opens its wait: which route it
 * decides the session's next request would go to, and what it answers for each
 * composition it can find itself in.
 *
 * The three tiers are asserted one at a time and against each other, because
 * the tier that matters most is the one a gate reading only the log would miss:
 * a selection the user made in the console that no request has consumed yet.
 *
 * The `.client.` suffix names the typecheck aggregate this package belongs to,
 * not the face under test.
 */

import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { effectiveRoute, routeGate } from '../src/access/model-switch.ts'
import type { RouteSelectionState } from '../src/access/model-switch.ts'
import { noImageRouteRefusal, UNRESOLVED_ROUTE_REFUSAL } from '../src/access/text.ts'
import { fixedModalities, routeServices } from './route-services.client.ts'

/** The provider every route here is registered under. */
const PROVIDER = 'deepseek-official'

/** A model that takes pictures. */
const VISION_MODEL = 'deepseek-v4-flash-vision-exp'

/** A model that takes text only. */
const TEXT_MODEL = 'deepseek-v4-flash'

let sessions = 0

/**
 * One execution over a fresh session, as the gate reads it.
 * @param options - the log the session carries and the options its agent was created with.
 * @returns the execution the gate reads.
 */
function execution(options: {
  header?: { provider: string; model: string }
  agentOptions?: { provider?: string; model?: string }
  ownerless?: boolean
}): { exec: ToolRunContext } {
  const session = Session.create(SessionId(`content-switch-${++sessions}`))
  if (options.header !== undefined) {
    session.append('request/header', { header: { config: options.header }, reason: 'initial' } as never)
  }
  const agent = { id: session.id, session, options: options.agentOptions ?? {} }
  return {
    exec: {
      signal: new AbortController().signal,
      ...options.ownerless === true ? {} : { agent },
    } as unknown as ToolRunContext,
  }
}

/**
 * A projection registry whose model-selection unit holds one pending selection.
 * @param pending - the selection no request has consumed, or `null` for none.
 * @returns the narrowed registry.
 */
function selectionState(pending: { provider: string; model: string } | null): RouteSelectionState {
  return { stateOf: () => ({ pending }) }
}

describe('the route the picture read is gated on', () => {
  it('takes the selection the user made over the one the log recorded', () => {
    const { exec } = execution({ header: { provider: PROVIDER, model: TEXT_MODEL } })
    const services = routeServices({ selection: selectionState({ provider: PROVIDER, model: VISION_MODEL }) })
    expect(effectiveRoute(services, exec)).toEqual({ provider: PROVIDER, model: VISION_MODEL })
  })

  it('takes the logged request header where no selection is waiting', () => {
    const { exec } = execution({
      header: { provider: PROVIDER, model: TEXT_MODEL },
      agentOptions: { provider: PROVIDER, model: VISION_MODEL },
    })
    expect(effectiveRoute(routeServices({ selection: selectionState(null) }), exec))
      .toEqual({ provider: PROVIDER, model: TEXT_MODEL })
  })

  it('takes the agent\'s own options where the session has logged no request', () => {
    const { exec } = execution({ agentOptions: { provider: PROVIDER, model: TEXT_MODEL } })
    expect(effectiveRoute(routeServices({}), exec)).toEqual({ provider: PROVIDER, model: TEXT_MODEL })
  })

  it('names no route for a session whose provider or model is unset', () => {
    expect(effectiveRoute(routeServices({}), execution({ agentOptions: { model: TEXT_MODEL } }).exec))
      .toBeUndefined()
    expect(effectiveRoute(routeServices({}), execution({ agentOptions: { provider: PROVIDER } }).exec))
      .toBeUndefined()
  })

  it('names no route for a call with no owning agent', () => {
    expect(effectiveRoute(routeServices({}), execution({ ownerless: true }).exec)).toBeUndefined()
  })
})

describe('what the gate answers', () => {
  it('lets a route declaring image input through', async () => {
    const { exec } = execution({ agentOptions: { provider: PROVIDER, model: VISION_MODEL } })
    const services = routeServices({ llm: fixedModalities(['text', 'image']) })
    expect(await routeGate(services, exec)).toBeUndefined()
  })

  it('lets the waiting selection through before any request has used it', async () => {
    const { exec } = execution({ header: { provider: PROVIDER, model: TEXT_MODEL } })
    const services = routeServices({
      llm: {
        resolveModelInfo: (_provider, model) => Promise.resolve(
          model === VISION_MODEL ? { inputModalities: ['text', 'image'] } : { inputModalities: ['text'] },
        ),
      },
      selection: selectionState({ provider: PROVIDER, model: VISION_MODEL }),
    })
    expect(await routeGate(services, exec)).toBeUndefined()
  })

  it('refuses a route declaring text only, naming the model', async () => {
    const { exec } = execution({ agentOptions: { provider: PROVIDER, model: TEXT_MODEL } })
    expect(await routeGate(routeServices({ llm: fixedModalities(['text']) }), exec))
      .toBe(noImageRouteRefusal(TEXT_MODEL))
  })

  it('refuses a route that declares nothing, because unknown is not yes', async () => {
    const { exec } = execution({ agentOptions: { provider: PROVIDER, model: TEXT_MODEL } })
    expect(await routeGate(routeServices({ llm: fixedModalities() }), exec))
      .toBe(noImageRouteRefusal(TEXT_MODEL))
  })

  it('refuses a session whose route no tier names', async () => {
    const { exec } = execution({})
    expect(await routeGate(routeServices({ llm: fixedModalities(['text', 'image']) }), exec))
      .toBe(UNRESOLVED_ROUTE_REFUSAL)
  })

  it('refuses a composition with no registry to resolve the route through', async () => {
    const { exec } = execution({ agentOptions: { provider: PROVIDER, model: VISION_MODEL } })
    expect(await routeGate(routeServices({}), exec)).toBe(UNRESOLVED_ROUTE_REFUSAL)
  })
})
