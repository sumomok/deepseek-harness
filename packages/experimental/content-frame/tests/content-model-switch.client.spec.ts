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
import {
  effectiveRoute, imageCapableRoutes, optionLabels, routeGate, switchQuestion,
} from '../src/access/model-switch.ts'
import type { CandidateRoute, RouteSelectionState } from '../src/access/model-switch.ts'
import { noImageRouteRefusal, UNRESOLVED_ROUTE_REFUSAL } from '../src/access/text.ts'
import { catalogue, fixedModalities, routeServices } from './route-services.client.ts'

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

/** The catalogue a deployment with one vision route and two text routes lists. */
const DEPLOYMENT = [
  {
    id: PROVIDER,
    name: 'DeepSeek',
    models: [
      { id: TEXT_MODEL, name: 'DeepSeek-V4-Flash' },
      { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', inputModalities: ['text'] },
      { id: VISION_MODEL, name: 'DeepSeek-V4-Flash-Vision-Exp', inputModalities: ['text', 'image'] },
    ],
  },
]

describe('which routes the card can offer', () => {
  it('lists every configured route that declares image input, and no other', async () => {
    expect(await imageCapableRoutes(catalogue(DEPLOYMENT))).toEqual([{
      provider: PROVIDER,
      model: VISION_MODEL,
      providerName: 'DeepSeek',
      modelName: 'DeepSeek-V4-Flash-Vision-Exp',
    }])
  })

  it('lists nothing where no configured route declares image input', async () => {
    expect(await imageCapableRoutes(catalogue([
      { id: PROVIDER, name: 'DeepSeek', models: [{ id: TEXT_MODEL, name: 'DeepSeek-V4-Flash' }] },
    ]))).toEqual([])
  })

  it('leaves out a provider whose catalogue cannot be read and keeps the rest', async () => {
    const candidates = await imageCapableRoutes(catalogue([
      { id: 'broken', name: 'Broken' },
      ...DEPLOYMENT,
    ]))
    expect(candidates.map(candidate => candidate.model)).toEqual([VISION_MODEL])
  })
})

describe('how the options are labelled', () => {
  it('names the provider and the model where that already tells them apart', () => {
    expect(optionLabels([
      { provider: PROVIDER, model: VISION_MODEL, providerName: 'DeepSeek', modelName: 'Vision' },
      { provider: 'other', model: 'other-vision', providerName: 'Other', modelName: 'Vision' },
    ])).toEqual([
      { provider: PROVIDER, model: VISION_MODEL, label: 'DeepSeek：Vision' },
      { provider: 'other', model: 'other-vision', label: 'Other：Vision' },
    ])
  })

  it('adds the model id where two providers share a name and a model name', () => {
    const twins: CandidateRoute[] = [
      { provider: 'a', model: 'first', providerName: 'DeepSeek', modelName: 'Vision' },
      { provider: 'b', model: 'second', providerName: 'DeepSeek', modelName: 'Vision' },
    ]
    expect(optionLabels(twins).map(route => route.label))
      .toEqual(['DeepSeek：Vision · first', 'DeepSeek：Vision · second'])
  })

  it('adds the model id where one provider lists two models under one name', () => {
    const twins: CandidateRoute[] = [
      { provider: PROVIDER, model: 'exp-1', providerName: 'DeepSeek', modelName: 'Vision' },
      { provider: PROVIDER, model: 'exp-2', providerName: 'DeepSeek', modelName: 'Vision' },
    ]
    expect(optionLabels(twins).map(route => route.label))
      .toEqual(['DeepSeek：Vision · exp-1', 'DeepSeek：Vision · exp-2'])
  })

  it('leaves a label alone where no other candidate carries it', () => {
    expect(optionLabels([
      { provider: PROVIDER, model: VISION_MODEL, providerName: '先不换', modelName: 'Vision' },
    ]).map(route => route.label)).toEqual(['先不换：Vision'])
  })
})

describe('the card the user is asked', () => {
  it('offers no route under the label of the option that changes nothing', () => {
    const options = switchQuestion(optionLabels([
      { provider: PROVIDER, model: VISION_MODEL, providerName: '先不换', modelName: '先不换' },
    ])).options ?? []
    expect(new Set(options.map(option => option.label)).size).toBe(options.length)
  })

  it('asks one single-select question, listing every route and one that changes nothing', () => {
    expect(switchQuestion(optionLabels([{
      provider: PROVIDER,
      model: VISION_MODEL,
      providerName: 'DeepSeek',
      modelName: 'DeepSeek-V4-Flash-Vision-Exp',
    }]))).toEqual({
      id: 'content-image-model',
      header: '内容区的图',
      question: '当前模型看不了图片，换一个能看图的模型吗？',
      detail: '换过之后，这次对话接下来都用你选的那个模型；你随时可以自己换回来。',
      options: [
        { label: 'DeepSeek：DeepSeek-V4-Flash-Vision-Exp' },
        { label: '先不换', description: '这次就不看这张图了' },
      ],
    })
  })
})
