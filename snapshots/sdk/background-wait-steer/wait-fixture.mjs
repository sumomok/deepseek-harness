/** Non-blocking job reads preserve a running producer, steering, and one settlement notice. */
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const inject = ['jobs', 'tools']

const STEER_TEXT = 'STEER_WHILE_WAITING'
const PRODUCER_OUTPUT = 'producer ready'

/** @param {import('@deepseek-ai/cordis').Context} ctx - Scenario-owned runtime. */
export function apply(ctx) {
  let owner
  let id
  let released

  /** Wait for the producer's first line without consuming its output cursor. */
  const whenProducerReady = async (signal) => {
    const ready = Promise.withResolvers()
    const check = () => {
      const read = ctx.jobs.readAt(id, 0, owner.id)
      if (read.chunks.some(chunk => chunk.channel !== 'log' && chunk.text.includes(PRODUCER_OUTPUT))) {
        ready.resolve()
      } else if (ctx.jobs.get(id, owner.id).status !== 'running') {
        ready.reject(new Error('producer settled before its barrier output'))
      }
    }
    const unsubscribe = ctx.jobs.events.subscribe({ owner: owner.id }, event => {
      if ((event.type === 'output' ? event.id : event.job.id) === id) check()
    })
    const abort = () => ready.reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    try {
      signal.throwIfAborted()
      check()
      await ready.promise
    } finally {
      signal.removeEventListener('abort', abort)
      unsubscribe()
    }
  }

  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name === 'job_output') {
      owner = exec.agent
      id = exec.arguments.job_id
      await whenProducerReady(exec.signal)
      owner.steer(createUserMessage({ content: [{ type: 'text', text: STEER_TEXT }], source: { kind: 'user' } }))
    }
    return next()
  })

  ctx.on('tools/result', (exec, result) => {
    if (exec.name !== 'job_output') return
    released = {
      isError: result.isError === true,
      text: result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join(''),
      producer: ctx.jobs.get(id, owner.id).status,
    }
  })

  ctx.on('agent/turn-stopping', async ({ agent }) => {
    if (agent !== owner) return
    const settled = Promise.withResolvers()
    const unsubscribe = ctx.jobs.events.subscribe({ owner: agent.id }, event => {
      if (event.type === 'settled' && event.job.id === id) settled.resolve(event)
    })
    try {
      if (released === undefined) throw new Error('the non-blocking read returned no result')
      if (released.isError) throw new Error(`the non-blocking read failed: ${released.text}`)
      if (released.text !== 'producer ready\n[status: running]') {
        throw new Error(`the non-blocking read returned ${JSON.stringify(released.text)}`)
      }
      if (released.producer !== 'running') throw new Error('the read stopped the producer')
      const input = agent.session.deriveMessages()
        .find(message => message.role === 'user' && JSON.stringify(message.content).includes(STEER_TEXT))
      if (input === undefined) throw new Error('steer was not admitted for the next step')
      if (ctx.jobs.get(id, agent.id).status !== 'running') throw new Error('producer stopped before the steered step')
    } finally {
      try {
        if (ctx.jobs.kill(id, agent.id, 'barrier teardown') === 'requested') {
          const event = await settled.promise
          if (event.awaited) throw new Error('non-blocking read suppressed the completion notice')
        }
      } finally {
        unsubscribe()
      }
    }
    const notices = agent.inbox.nextStep.filter(message => message.source.kind === 'tool-jobs')
    if (notices.length !== 1) throw new Error(`expected exactly one completion notice, got ${notices.length}`)
    if (!JSON.stringify(notices[0].content).includes('finished')) throw new Error('completion notice does not report settlement')
    agent.inbox.remove(notices[0].id)
  })
}
