import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createSystemMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionSeq } from '@deepseek-ai/dsh-session'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'

function mount(): { ctx: Context; meter: TokenMeter } {
  const ctx = new Context()
  new SessionProjectionRegistry(ctx)
  const meter = new TokenMeter(ctx)
  return { ctx, meter }
}

function systemNode(session: Session, text: string): SessionSeq {
  return session.append('system/message', {
    turn: 1, step: 1, message: createSystemMessage(text),
  }, { surfaceOp: 'append' }).seq
}
function emptySystemNode(session: Session): SessionSeq {
  return session.append('system/message', {
    turn: 1, step: 1, message: createSystemMessage(''),
  }, { surfaceOp: 'append' }).seq
}
function userNode(session: Session, text = 'user'): void {
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
}
function replaceWithUser(session: Session, target: SessionSeq): SessionSeq {
  return session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'replacement' }], source: { kind: 'user' } }), {
    surfaceOp: { op: 'replace', startSeq: target, endSeq: target }, sourceEventSeqs: [target],
  }).seq
}

describe('TokenMeter.hasSystemMessage incremental state', () => {
  it('tracks head, later, multiple, empty, and replacement system nodes', () => {
    const { meter } = mount()
    const session = Session.create(SessionId('system-presence'))
    expect(meter.hasSystemMessage(session)).toBe(false)

    systemNode(session, 'head')
    expect(meter.hasSystemMessage(session)).toBe(true)

    userNode(session)
    const later = systemNode(session, 'later')
    expect(meter.hasSystemMessage(session)).toBe(true)

    replaceWithUser(session, later)
    expect(meter.hasSystemMessage(session)).toBe(true) // head remains

    emptySystemNode(session)
    expect(meter.hasSystemMessage(session)).toBe(true) // empty still exists

    const onlyEmpty = Session.create(SessionId('only-empty'))
    emptySystemNode(onlyEmpty)
    expect(meter.hasSystemMessage(onlyEmpty)).toBe(true)
  })

  it('removes the last system on replacement and adds the replacement system', () => {
    const { meter } = mount()
    const session = Session.create(SessionId('system-replacement'))
    userNode(session)
    const only = systemNode(session, 'later-only')
    const replacement = replaceWithUser(session, only)
    expect(meter.hasSystemMessage(session)).toBe(false)

    session.append('system/message', {
      turn: 1, step: 1, message: createSystemMessage('new prompt'),
    }, { surfaceOp: { op: 'replace', startSeq: replacement, endSeq: replacement }, sourceEventSeqs: [replacement] })
    expect(meter.hasSystemMessage(session)).toBe(true)
  })

  it('keeps a head system when a system replaces a system', () => {
    const { meter } = mount()
    const session = Session.create(SessionId('system-head-replacement'))
    const head = systemNode(session, 'old prompt')
    session.append('system/message', {
      turn: 1, step: 1, message: createSystemMessage('new prompt'),
    }, { surfaceOp: { op: 'replace', startSeq: head, endSeq: head }, sourceEventSeqs: [head] })
    expect(meter.hasSystemMessage(session)).toBe(true)
  })

  it('answers from synchronized state without a surface eventAt scan', () => {
    const { meter } = mount()
    const session = Session.create(SessionId('system-no-scan'))
    systemNode(session, 'prompt')
    userNode(session)
    meter.measure(session)
    const eventAt = vi.spyOn(session, 'eventAt')
    expect(meter.hasSystemMessage(session)).toBe(true)
    expect(eventAt).not.toHaveBeenCalled()
  })

  it('reconstructs the set from a fork prefix and from a resumed seed', () => {
    const { ctx, meter } = mount()
    const store = new SessionStore(ctx)
    const parent = store.create(SessionId('system-parent'), { meta: { createdAt: 1, cwd: '/work' } })
    systemNode(parent, 'inherited prompt')
    userNode(parent)
    const child = store.fork(parent.id, undefined, SessionId('system-child'))
    expect(meter.hasSystemMessage(child)).toBe(true)

    const resumed = Session.create(SessionId('system-resumed'), parent.snapshotEvents())
    expect(meter.hasSystemMessage(resumed)).toBe(true)
  })
})
