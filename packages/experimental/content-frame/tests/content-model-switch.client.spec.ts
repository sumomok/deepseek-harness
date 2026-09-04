/**
 * The route gate the picture read runs before it opens its wait: which route it
 * decides the session's next request would go to, which routes it offers to
 * change to, and what it answers for each composition and each answer.
 *
 * The three tiers are asserted one at a time and against each other, because
 * the tier that matters most is the one a gate reading only the log would miss:
 * a selection the user made in the console that no request has consumed yet.
 * The card's own copy is pinned verbatim, because it is the one surface of this
 * package a person rather than a model reads.
 *
 * The `.client.` suffix names the typecheck aggregate this package belongs to,
 * not the face under test.
 */

import { describe, expect, it, vi } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { AskUserQuestionAnswer, AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
import type { SessionSelectModelRequest } from '@deepseek-ai/dsh-api-session-controller/types'
import {
  effectiveRoute, imageCapableRoutes, optionLabels, routeGate, switchQuestion,
} from '../src/access/model-switch.ts'
import type {
  CandidateRoute, ModelRouteServices, RouteQuestionAsker, RouteSelectionState, RouteSwitcher,
} from '../src/access/model-switch.ts'
import {
  CANCELLED_REFUSAL, noImageAnywhereRefusal, noImageRouteRefusal, routeSwitchRefusal, UNRESOLVED_ROUTE_REFUSAL,
} from '../src/access/text.ts'
import { catalogue, fixedModalities, routeServices } from './route-services.client.ts'

/** The provider every route here is registered under. */
const PROVIDER = 'deepseek-official'

/** A model that takes pictures. */
const VISION_MODEL = 'deepseek-v4-flash-vision-exp'

/** A model that takes text only. */
const TEXT_MODEL = 'deepseek-v4-flash'

/** The label the one candidate of {@link DEPLOYMENT} is offered under. */
const VISION_LABEL = 'DeepSeek：DeepSeek-V4-Flash-Vision-Exp'

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

let sessions = 0

/** The agent a call runs for, as this gate reads it. */
type CallingAgent = NonNullable<ToolRunContext['agent']>

/** One execution over a fresh session, and the agent behind it. */
interface Call {
  /** The execution the gate is handed. */
  exec: ToolRunContext
  /** That execution's agent, for the tier reads that take one directly. */
  agent: CallingAgent
  /** Cancel the call, the way the agent loop cancels one. */
  abort: () => void
}

/**
 * One execution over a fresh session, as the gate reads it.
 * @param options - the log the session carries and the options its agent was created with.
 * @returns the call.
 */
function call(options: {
  header?: { provider: string; model: string }
  agentOptions?: { provider?: string; model?: string }
} = {}): Call {
  const session = Session.create(SessionId(`content-switch-${++sessions}`))
  if (options.header !== undefined) {
    session.append('request/header', { header: { config: options.header }, reason: 'initial' } as never)
  }
  const agent = { id: session.id, session, options: options.agentOptions ?? {} } as unknown as CallingAgent
  const controller = new AbortController()
  return {
    agent,
    abort: () => { controller.abort() },
    exec: { agent, signal: controller.signal } as unknown as ToolRunContext,
  }
}

/** An execution with no owning agent, which has no session to read a route from. */
const OWNERLESS = { signal: new AbortController().signal } as unknown as ToolRunContext

/**
 * A projection registry whose model-selection unit holds one pending selection.
 * @param pending - the selection no request has consumed, or `null` for none.
 * @returns the narrowed registry.
 */
function selectionState(pending: { provider: string; model: string } | null): RouteSelectionState {
  return { stateOf: () => ({ pending }) }
}

/**
 * A question service answering every card the same way.
 * @param answer - what the user chose, or a rejection standing in for a card
 * nobody answered.
 * @returns the narrowed service, and every request it received.
 */
function asker(answer: AskUserQuestionAnswer | Error): {
  service: RouteQuestionAsker
  asked: AskUserQuestionRequest[]
} {
  const asked: AskUserQuestionRequest[] = []
  return {
    asked,
    service: {
      ask: (request) => {
        asked.push(request)
        return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)
      },
    },
  }
}

/**
 * One answer choosing one option.
 * @param label - the option's label.
 * @returns the answer.
 */
function chose(label: string): AskUserQuestionAnswer {
  return { answers: [{ id: 'content-image-model', selected: [label] }] }
}

/**
 * A session controller recording every model change asked of it.
 * @param failure - what the change rejects with, absent for one that succeeds.
 * @returns the narrowed service, and every request it received.
 */
function switcher(failure?: unknown): { service: RouteSwitcher; changed: SessionSelectModelRequest[] } {
  const changed: SessionSelectModelRequest[] = []
  return {
    changed,
    service: {
      selectModel: async (request) => {
        changed.push(request)
        // The host rejects with whatever it rejects with, and one of the two
        // arms this stands in for is a rejection that is not an Error.
        if (failure !== undefined) throw failure
        return { selected: { provider: request.provider, model: request.model } }
      },
    },
  }
}

/**
 * The composition a session sitting on a text route finds itself in.
 * @param parts - what this composition mounts beyond the catalogue.
 * @returns the narrowed services the gate reads.
 */
function textRouteComposition(parts: {
  asker?: RouteQuestionAsker
  switcher?: RouteSwitcher
}): ModelRouteServices {
  return routeServices({ llm: catalogue(DEPLOYMENT, ['text']), ...parts })
}

describe('the route the picture read is gated on', () => {
  it('takes the selection the user made over the one the log recorded', () => {
    const { agent } = call({ header: { provider: PROVIDER, model: TEXT_MODEL } })
    const services = routeServices({ selection: selectionState({ provider: PROVIDER, model: VISION_MODEL }) })
    expect(effectiveRoute(services, agent)).toEqual({ provider: PROVIDER, model: VISION_MODEL })
  })

  it('takes the logged request header where no selection is waiting', () => {
    const { agent } = call({
      header: { provider: PROVIDER, model: TEXT_MODEL },
      agentOptions: { provider: PROVIDER, model: VISION_MODEL },
    })
    expect(effectiveRoute(routeServices({ selection: selectionState(null) }), agent))
      .toEqual({ provider: PROVIDER, model: TEXT_MODEL })
  })

  it('takes the agent\'s own options where the session has logged no request', () => {
    const { agent } = call({ agentOptions: { provider: PROVIDER, model: TEXT_MODEL } })
    expect(effectiveRoute(routeServices({}), agent)).toEqual({ provider: PROVIDER, model: TEXT_MODEL })
  })

  it('names no route for a session whose provider or model is unset', () => {
    expect(effectiveRoute(routeServices({}), call({ agentOptions: { model: TEXT_MODEL } }).agent))
      .toBeUndefined()
    expect(effectiveRoute(routeServices({}), call({ agentOptions: { provider: PROVIDER } }).agent))
      .toBeUndefined()
  })
})

describe('what the gate answers before it asks anyone', () => {
  it('lets a route declaring image input through without reading a catalogue', async () => {
    const llm = catalogue(DEPLOYMENT, ['text', 'image'])
    const listModels = vi.spyOn(llm, 'listModels')
    const { service, asked } = asker(chose(VISION_LABEL))
    const { exec } = call({ agentOptions: { provider: PROVIDER, model: VISION_MODEL } })
    expect(await routeGate(routeServices({ llm, asker: service }), exec)).toBeUndefined()
    expect(listModels).not.toHaveBeenCalled()
    expect(asked).toEqual([])
  })

  it('lets the waiting selection through before any request has used it', async () => {
    const { exec } = call({ header: { provider: PROVIDER, model: TEXT_MODEL } })
    const services = routeServices({
      llm: {
        ...fixedModalities(),
        resolveModelInfo: (_provider, model) => Promise.resolve(
          model === VISION_MODEL ? { inputModalities: ['text', 'image'] } : { inputModalities: ['text'] },
        ),
      },
      selection: selectionState({ provider: PROVIDER, model: VISION_MODEL }),
    })
    expect(await routeGate(services, exec)).toBeUndefined()
  })

  it('refuses a session whose route no tier names', async () => {
    const { exec } = call()
    expect(await routeGate(routeServices({ llm: fixedModalities(['text', 'image']) }), exec))
      .toBe(UNRESOLVED_ROUTE_REFUSAL)
  })

  it('refuses a call with no owning agent', async () => {
    expect(await routeGate(routeServices({ llm: fixedModalities(['text', 'image']) }), OWNERLESS))
      .toBe(UNRESOLVED_ROUTE_REFUSAL)
  })

  it('refuses a composition with no registry to resolve the route through', async () => {
    const { exec } = call({ agentOptions: { provider: PROVIDER, model: VISION_MODEL } })
    expect(await routeGate(routeServices({}), exec)).toBe(UNRESOLVED_ROUTE_REFUSAL)
  })

  it('refuses without a card where no configured route takes pictures', async () => {
    const { service, asked } = asker(chose(VISION_LABEL))
    const { exec } = call({ agentOptions: { provider: PROVIDER, model: TEXT_MODEL } })
    const services = routeServices({
      llm: catalogue([{ id: PROVIDER, name: 'DeepSeek', models: [{ id: TEXT_MODEL, name: 'Flash' }] }], ['text']),
      asker: service,
      switcher: switcher().service,
    })
    expect(await routeGate(services, exec)).toBe(noImageAnywhereRefusal(TEXT_MODEL))
    expect(asked).toEqual([])
  })

  it('refuses without a card where nobody could be asked or nothing could change the model', async () => {
    const { service, asked } = asker(chose(VISION_LABEL))
    const noAsker = call({ agentOptions: { provider: PROVIDER, model: TEXT_MODEL } })
    expect(await routeGate(textRouteComposition({ switcher: switcher().service }), noAsker.exec))
      .toBe(noImageRouteRefusal(TEXT_MODEL))
    const noSwitcher = call({ agentOptions: { provider: PROVIDER, model: TEXT_MODEL } })
    expect(await routeGate(textRouteComposition({ asker: service }), noSwitcher.exec))
      .toBe(noImageRouteRefusal(TEXT_MODEL))
    expect(asked).toEqual([])
  })
})

describe('the card the gate puts up', () => {
  it('asks the card verbatim, for the calling agent and under its own cancellation', async () => {
    const { service, asked } = asker(chose(VISION_LABEL))
    const { exec, agent } = call({ agentOptions: { provider: PROVIDER, model: TEXT_MODEL } })
    await routeGate(textRouteComposition({ asker: service, switcher: switcher().service }), exec)
    expect(asked).toHaveLength(1)
    expect(asked[0]?.agent).toBe(agent)
    expect(asked[0]?.signal).toBe(exec.signal)
    expect(asked[0]?.questions).toEqual([{
      id: 'content-image-model',
      header: '内容区的图',
      question: '当前模型看不了图片，换一个能看图的模型吗？',
      detail: '换过之后，这次对话接下来都用你选的那个模型；你随时可以自己换回来。',
      options: [
        { label: VISION_LABEL },
        { label: '先不换', description: '这次就不看这张图了' },
      ],
    }])
  })

  it('changes the session\'s model to the route the user chose, and lets the read run', async () => {
    const changer = switcher()
    const { exec, agent } = call({ agentOptions: { provider: PROVIDER, model: TEXT_MODEL } })
    const services = textRouteComposition({ asker: asker(chose(VISION_LABEL)).service, switcher: changer.service })
    expect(await routeGate(services, exec)).toBeUndefined()
    expect(changer.changed).toEqual([{
      sessionId: agent.session.header.id,
      provider: PROVIDER,
      model: VISION_MODEL,
    }])
  })

  it('changes nothing for every answer that is not one of the routes offered', async () => {
    const answers: (AskUserQuestionAnswer | Error)[] = [
      { answers: [{ id: 'content-image-model', selected: [] }] },
      { answers: [{ id: 'content-image-model', selected: [], custom: '换个别的' }] },
      { answers: [{ id: 'content-image-model', selected: ['先不换'] }] },
      { answers: [{ id: 'content-image-model', selected: ['DeepSeek：Nothing'] }] },
      { answers: [{ id: 'content-image-model', selected: [VISION_LABEL, '先不换'] }] },
      { answers: [{ id: 'another-question', selected: [VISION_LABEL] }] },
      new Error('no user-questions answerer accepted the request'),
    ]
    for (const answer of answers) {
      const changer = switcher()
      const { exec } = call({ agentOptions: { provider: PROVIDER, model: TEXT_MODEL } })
      const services = textRouteComposition({ asker: asker(answer).service, switcher: changer.service })
      expect(await routeGate(services, exec), JSON.stringify(answer)).toBe(noImageRouteRefusal(TEXT_MODEL))
      expect(changer.changed).toEqual([])
    }
  })

  it('reports a cancelled call as cancelled rather than as a route that takes no picture', async () => {
    const { exec, abort } = call({ agentOptions: { provider: PROVIDER, model: TEXT_MODEL } })
    abort()
    const services = textRouteComposition({
      asker: asker(new Error('ask_user_question was aborted before the user answered')).service,
      switcher: switcher().service,
    })
    expect(await routeGate(services, exec)).toBe(CANCELLED_REFUSAL)
  })

  it('reports a refused model change with the reason the host gave', async () => {
    const { exec } = call({ agentOptions: { provider: PROVIDER, model: TEXT_MODEL } })
    const services = textRouteComposition({
      asker: asker(chose(VISION_LABEL)).service,
      switcher: switcher(new Error('no adapter registered for provider "deepseek-official"')).service,
    })
    expect(await routeGate(services, exec))
      .toBe(routeSwitchRefusal('no adapter registered for provider "deepseek-official"'))
  })

  it('reports a model change that rejected with something other than an error', async () => {
    const { exec } = call({ agentOptions: { provider: PROVIDER, model: TEXT_MODEL } })
    const services = textRouteComposition({
      asker: asker(chose(VISION_LABEL)).service,
      switcher: switcher('session/model-unavailable').service,
    })
    expect(await routeGate(services, exec)).toBe(routeSwitchRefusal('session/model-unavailable'))
  })
})

describe('one decision per session', () => {
  it('answers two parallel reads with one card and one model change', async () => {
    let pending: { provider: string; model: string } | null = null
    const asked: AskUserQuestionRequest[] = []
    const changed: SessionSelectModelRequest[] = []
    const services = routeServices({
      llm: {
        ...catalogue(DEPLOYMENT),
        resolveModelInfo: (_provider, model) => Promise.resolve(
          model === VISION_MODEL ? { inputModalities: ['text', 'image'] } : { inputModalities: ['text'] },
        ),
      },
      selection: { stateOf: () => ({ pending }) },
      asker: {
        ask: (request) => {
          asked.push(request)
          return Promise.resolve(chose(VISION_LABEL))
        },
      },
      switcher: {
        selectModel: (request) => {
          changed.push(request)
          pending = { provider: request.provider, model: request.model }
          return Promise.resolve({ selected: { provider: request.provider, model: request.model } })
        },
      },
    })
    const { exec } = call({ header: { provider: PROVIDER, model: TEXT_MODEL } })
    expect(await Promise.all([routeGate(services, exec), routeGate(services, exec)]))
      .toEqual([undefined, undefined])
    // The second read runs after the first has changed the model and reads that
    // change as its own first tier.
    expect(asked).toHaveLength(1)
    expect(changed).toHaveLength(1)
  })

  it('asks once per session, however many times the model retries', async () => {
    const { service, asked } = asker(chose('先不换'))
    const services = textRouteComposition({ asker: service, switcher: switcher().service })
    const { exec } = call({ agentOptions: { provider: PROVIDER, model: TEXT_MODEL } })
    expect(await routeGate(services, exec)).toBe(noImageRouteRefusal(TEXT_MODEL))
    expect(await routeGate(services, exec)).toBe(noImageRouteRefusal(TEXT_MODEL))
    expect(asked).toHaveLength(1)
    // Having said no once suppresses the card and nothing else: a session whose
    // model the user changes in the console passes at the first tier.
    expect(await routeGate(routeServices({ llm: catalogue(DEPLOYMENT, ['text', 'image']) }), exec))
      .toBeUndefined()
  })

  it('leaves the session decidable again after a route lookup failed', async () => {
    const { exec } = call({ agentOptions: { provider: PROVIDER, model: TEXT_MODEL } })
    const broken = routeServices({
      llm: { ...fixedModalities(), resolveModelInfo: () => Promise.reject(new Error('the route could not be read')) },
    })
    await expect(routeGate(broken, exec)).rejects.toThrow('the route could not be read')
    expect(await routeGate(routeServices({ llm: fixedModalities(['text', 'image']) }), exec)).toBeUndefined()
  })
})

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
        { label: VISION_LABEL },
        { label: '先不换', description: '这次就不看这张图了' },
      ],
    })
  })
})
