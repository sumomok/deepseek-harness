/**
 * The summary blank bit means "nothing to show and nothing to address". A
 * command run clears it alongside the first turn, unless the run recorded
 * `engages: false` — the declaration a command makes when it configures the
 * session rather than contributing to the conversation. Configuration events
 * (plan/mode, session titles, permission and sandbox knobs) never flip it, so
 * a fresh session carrying only those and a configuration command stays
 * list-hidden and reusable as New Session. The host/session-added frame shares
 * the same predicate function (covered by the workspace spec's frame
 * assertion).
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import { CommandId } from '@deepseek-ai/dsh-commands/brand'
// Side-effect type imports: the configuration-event SessionEventMap merges.
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { applySessionListMetadata } from '../src/list.ts'
import { createSessionTestRemote, type TestSessionRemote } from './test-remote.ts'

async function harness(): Promise<{ ctx: Context; remote: TestSessionRemote; attach: (session: Session) => Promise<void> }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  return {
    ctx,
    remote: createSessionTestRemote(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' }),
    attach: async (session) => {
      await ctx.agents.register({ id: session.id, session, status: 'idle', ctx } as Agent)
    },
  }
}

/** Append the configuration-event family a fresh session can accumulate without content. */
function appendConfiguration(session: Session): void {
  session.append('plan/mode', { active: true })
  session.append('session/title', {
    title: 'standalone title', messageSeqs: [], source: { kind: 'fallback' },
  })
  // Permission configuration events from a /permission switch on a fresh session.
  session.append('permission/preset', { preset: 'danger-full-access' })
  session.append('sandbox/mode', { mode: 'danger-full-access' })
}

/** Append one complete lifecycle of a command that contributes to the conversation. */
function appendEngagingCommand(session: Session): void {
  session.append('command/run', {
    commandId: CommandId('blank-cmd-1'), name: 'btw', args: ' 天气', source: { kind: 'user' },
  })
  session.append('command/done', { commandId: CommandId('blank-cmd-1'), kind: 'success', text: 'Sunny.' })
}

/** Append one complete lifecycle of a command that declared it configures the session. */
function appendConfigurationCommand(session: Session): void {
  session.append('command/run', {
    commandId: CommandId('blank-cmd-0'), name: 'plan', args: '', source: { kind: 'user' }, engages: false,
  })
  session.append('command/done', { commandId: CommandId('blank-cmd-0'), kind: 'success', text: 'Plan mode on.' })
}

async function listBlank(remote: TestSessionRemote, id: string): Promise<boolean | undefined> {
  const result = await remote.list({})
  if (!result.ok) throw new Error('list failed')
  return result.value.items.find(item => item.sessionId === id)?.blank
}

describe('summary blank = nothing to show', () => {
  it('configuration events (plan/mode, title, permission knobs) keep the session blank', async () => {
    const { ctx, remote, attach } = await harness()
    const session = ctx.sessions.create()
    await attach(session)
    expect(await listBlank(remote, session.id)).toBe(true)
    appendConfiguration(session)
    expect(await listBlank(remote, session.id)).toBe(true)
  })

  it('a command that declared it configures the session keeps it blank', async () => {
    const { ctx, remote, attach } = await harness()
    const session = ctx.sessions.create()
    await attach(session)
    appendConfiguration(session)
    appendConfigurationCommand(session)
    expect(await listBlank(remote, session.id)).toBe(true)
  })

  it('an engaging command run clears blank', async () => {
    const { ctx, remote, attach } = await harness()
    const session = ctx.sessions.create()
    await attach(session)
    appendConfiguration(session)
    appendConfigurationCommand(session)
    expect(await listBlank(remote, session.id)).toBe(true)
    appendEngagingCommand(session)
    expect(await listBlank(remote, session.id)).toBe(false)
  })

  it('the first turn clears blank', async () => {
    const { ctx, remote, attach } = await harness()
    const session = ctx.sessions.create()
    await attach(session)
    appendConfiguration(session)
    session.append('turn/start', { turn: 0 })
    expect(await listBlank(remote, session.id)).toBe(false)
  })
})

describe('the blank fold itself', () => {
  const state = { blank: true, lastPromptAt: null }
  const fold = (type: string, data: Record<string, unknown> = {}): boolean =>
    applySessionListMetadata(state, { type, seq: 1, time: 10, data } as never).blank

  it('reads the declaration: engages false keeps blank, absent or true clears it', () => {
    expect(fold('command/run', { engages: false })).toBe(true)
    expect(fold('command/run')).toBe(false)
    expect(fold('command/run', { engages: true })).toBe(false)
  })

  it('clears on the run, not on the command result', () => {
    expect(fold('command/done')).toBe(true)
  })

  it('leaves an already-cleared bit down', () => {
    expect(applySessionListMetadata(
      { blank: false, lastPromptAt: null },
      { type: 'plan/mode', seq: 1, time: 10, data: {} } as never,
    )).toEqual({ blank: false, lastPromptAt: null })
  })
})
