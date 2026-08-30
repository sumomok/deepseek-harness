/**
 * Tests for `AttachmentSpill` (`ctx.attachmentSpill`): config validation, the
 * no-initiator and no-backend/failure fallbacks (both return `undefined`,
 * best-effort), a successful materialization (backend call, logged
 * `attachment/materialized`, cached `SpillRef`), and idempotent reuse across
 * repeated calls for the same (session, attachment id) — no second `saveText`
 * call and no second logged event.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { AttachmentId, type FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { SpillLocator, SpillStore } from '@deepseek-ai/dsh-spill'
import type { SaveTextSpill, SpillRef } from '@deepseek-ai/dsh-spill'
import AttachmentSpillPlugin, { AttachmentSpill, fileSpillOptionsFrom } from '../src/index.ts'
import type { AttachmentMaterializedEventData } from '../src/index.ts'

/** A stub spill backend recording its saves; `fail` exercises the best-effort fallback. */
class StubStore extends SpillStore {
  saves: SaveTextSpill[] = []
  fail = false

  async saveText(input: SaveTextSpill): Promise<SpillRef> {
    if (this.fail) throw new Error('disk full')
    this.saves.push(input)
    return {
      locator: SpillLocator(`/spill/${input.suggestedName}`),
      bytes: Buffer.byteLength(input.content, 'utf8'),
      retrievalHint: 'Use the stub retrieval path.',
    }
  }
}

const REF = (): FileAttachmentRef => ({
  attachmentId: AttachmentId('sha256:3f2a9c1bdeadbeef00000000000000000000000000000000000000000000'),
  name: 'notes.md',
  bytes: 1234,
})

/** Build a context with the plugin and, optionally, a spill backend and agent registry. */
async function setup(
  config: import('../src/index.ts').Config = {},
  { withAgents = true, withSpill = true }: { withAgents?: boolean; withSpill?: boolean } = {},
): Promise<{ ctx: Context; spill?: StubStore }> {
  const ctx = new Context()
  if (withAgents) await ctx.plugin(AgentRegistry)
  let spill: StubStore | undefined
  if (withSpill) {
    await ctx.plugin(StubStore)
    spill = ctx.spillStore as StubStore
  }
  await ctx.plugin(AttachmentSpillPlugin, config)
  return { ctx, ...spill ? { spill } : {} }
}

/** A structural Agent stub: only `.session` is read by `resolveSpill`. */
function agentFor(session: Session): Agent {
  return { session } as unknown as Agent
}

describe('config validation', () => {
  // `ctx.plugin(...)` validates against the `static Config` schema (`.step(1).min(0)`)
  // before the constructor runs, so it already fails loud on a negative or
  // fractional value with schemastery's own message. The constructor's own
  // check below is defense for construction that bypasses that schema parse
  // (e.g. `new AttachmentSpill(ctx, config)` directly).
  it('rejects a negative inlineWholeUnderChars through ctx.plugin (schema-level)', async () => {
    await expect(setup({ inlineWholeUnderChars: -1 })).rejects.toThrow(/inlineWholeUnderChars/)
  })

  it('rejects a fractional previewChars through ctx.plugin (schema-level)', async () => {
    await expect(setup({ previewChars: 1.5 })).rejects.toThrow(/previewChars/)
  })

  it('rejects a negative inlineWholeUnderChars constructed directly, bypassing the schema parse', () => {
    const ctx = new Context()
    expect(() => new AttachmentSpill(ctx, { inlineWholeUnderChars: -1 })).toThrow(/non-negative integer/)
  })

  it('rejects a fractional previewChars constructed directly, bypassing the schema parse', () => {
    const ctx = new Context()
    expect(() => new AttachmentSpill(ctx, { previewChars: 1.5 })).toThrow(/non-negative integer/)
  })

  it('defaults inlineWholeUnderChars and previewChars when omitted', async () => {
    const { ctx } = await setup({})
    expect(ctx.attachmentSpill.inlineWholeUnderChars).toBe(16_000)
    expect(ctx.attachmentSpill.previewChars).toBe(4_000)
  })

  it('honors explicit config values', async () => {
    const { ctx } = await setup({ inlineWholeUnderChars: 100, previewChars: 10 })
    expect(ctx.attachmentSpill.inlineWholeUnderChars).toBe(100)
    expect(ctx.attachmentSpill.previewChars).toBe(10)
  })
})

describe('no live initiating agent', () => {
  it('returns undefined without touching the backend', async () => {
    const { ctx, spill } = await setup()
    const ref = await ctx.attachmentSpill.resolveSpill(REF(), 'content')
    expect(ref).toBeUndefined()
    expect(spill?.saves).toHaveLength(0)
  })
})

describe('no spillStore backend', () => {
  it('returns undefined when ctx.spillStore is not loaded', async () => {
    const { ctx } = await setup({}, { withSpill: false })
    const session = Session.create(SessionId('s1'))
    const ref = await ctx.agents.withInitiator(
      agentFor(session),
      () => ctx.attachmentSpill.resolveSpill(REF(), 'content'),
    )
    expect(ref).toBeUndefined()
  })
})

describe('a saveText failure', () => {
  it('returns undefined and logs a warning, without caching or appending', async () => {
    const { ctx, spill } = await setup()
    if (spill === undefined) throw new Error('spill backend missing')
    spill.fail = true
    const session = Session.create(SessionId('s1'))
    const ref = await ctx.agents.withInitiator(
      agentFor(session),
      () => ctx.attachmentSpill.resolveSpill(REF(), 'content'),
    )
    expect(ref).toBeUndefined()
    expect(session.events.some(e => e.type === 'attachment/materialized')).toBe(false)
  })
})

describe('a successful materialization', () => {
  it('saves the content, logs attachment/materialized, and returns the SpillRef', async () => {
    const { ctx, spill } = await setup()
    if (spill === undefined) throw new Error('spill backend missing')
    const session = Session.create(SessionId('s1'))
    const attachment = REF()
    const ref = await ctx.agents.withInitiator(
      agentFor(session),
      () => ctx.attachmentSpill.resolveSpill(attachment, 'the full file text'),
    )
    expect(ref).toBeDefined()
    expect(spill.saves).toHaveLength(1)
    expect(spill.saves[0]?.content).toBe('the full file text')
    expect(spill.saves[0]?.owner.sessionId).toBe('s1')
    expect(spill.saves[0]?.source.toolName).toBe('attachment')
    expect(spill.saves[0]?.source.label).toBe('notes.md')
    expect(spill.saves[0]?.suggestedName).toBe('attachment-3f2a9c1b-notes.md')

    const logged = session.events.find(e => e.type === 'attachment/materialized')
    expect(logged).toBeDefined()
    const data = logged?.data as AttachmentMaterializedEventData
    expect(data.attachmentId).toBe(attachment.attachmentId)
    expect(data.locator).toBe(ref?.locator)
  })

  it('reuses the cached SpillRef for a repeated call, without a second save or log record', async () => {
    const { ctx, spill } = await setup()
    if (spill === undefined) throw new Error('spill backend missing')
    const session = Session.create(SessionId('s1'))
    const attachment = REF()
    const first = await ctx.agents.withInitiator(
      agentFor(session),
      () => ctx.attachmentSpill.resolveSpill(attachment, 'the full file text'),
    )
    const second = await ctx.agents.withInitiator(
      agentFor(session),
      () => ctx.attachmentSpill.resolveSpill(attachment, 'the full file text'),
    )
    expect(second).toEqual(first)
    expect(spill.saves).toHaveLength(1)
    expect(session.events.filter(e => e.type === 'attachment/materialized')).toHaveLength(1)
  })

  it('keys the cache by session, so a different session re-materializes the same attachment', async () => {
    const { ctx, spill } = await setup()
    if (spill === undefined) throw new Error('spill backend missing')
    const attachment = REF()
    const sessionA = Session.create(SessionId('a'))
    const sessionB = Session.create(SessionId('b'))
    await ctx.agents.withInitiator(agentFor(sessionA), () => ctx.attachmentSpill.resolveSpill(attachment, 'text'))
    await ctx.agents.withInitiator(agentFor(sessionB), () => ctx.attachmentSpill.resolveSpill(attachment, 'text'))
    expect(spill.saves).toHaveLength(2)
  })

  it('caches a second distinct attachment under the same already-populated session entry', async () => {
    const { ctx, spill } = await setup()
    if (spill === undefined) throw new Error('spill backend missing')
    const session = Session.create(SessionId('s1'))
    const first = REF()
    const second: FileAttachmentRef = { ...REF(), attachmentId: AttachmentId('sha256:another00000000000000000000000000000000000000000000000000000'), name: 'second.md' }
    await ctx.agents.withInitiator(agentFor(session), () => ctx.attachmentSpill.resolveSpill(first, 'text one'))
    await ctx.agents.withInitiator(agentFor(session), () => ctx.attachmentSpill.resolveSpill(second, 'text two'))
    expect(spill.saves).toHaveLength(2)
    expect(session.events.filter(e => e.type === 'attachment/materialized')).toHaveLength(2)
  })
})

describe('AttachmentSpill class', () => {
  it('is the plugin default export', () => {
    expect(AttachmentSpillPlugin).toBe(AttachmentSpill)
  })
})

describe('fileSpillOptionsFrom', () => {
  it('returns undefined when attachmentSpill is undefined', () => {
    expect(fileSpillOptionsFrom(undefined)).toBeUndefined()
  })

  it('binds inlineWholeUnderChars, previewChars, and resolveSpill from the instance', async () => {
    const { ctx } = await setup({ inlineWholeUnderChars: 42, previewChars: 7 }, { withAgents: false, withSpill: false })
    const options = fileSpillOptionsFrom(ctx.attachmentSpill)
    expect(options?.inlineWholeUnderChars).toBe(42)
    expect(options?.previewChars).toBe(7)
    await expect(options?.resolveSpill(REF(), 'text')).resolves.toBeUndefined()
  })
})
