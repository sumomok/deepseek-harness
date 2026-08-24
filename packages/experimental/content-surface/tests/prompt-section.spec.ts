/**
 * The one model-visible thing this package contributes: the rule that a
 * follow-up about content already on display updates that content in place.
 *
 * The expected text lives here as a literal rather than as an import, so that
 * editing the source wording fails this spec instead of passing it along. The
 * rule's effect was measured at the end of the system prompt, which makes its
 * position part of what is pinned; whether order 200 still lands last in the
 * real Web composition is `apps/web/tests/content-surface.e2e.ts`'s assertion,
 * against every section that composition registers.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ContentSurfaceRegistry from '../src/index.ts'

/** What the model reads, verbatim. */
const RULE = `# Working with content already on display

When the user refers to something you have already produced and put on display — quoting it, naming its title, or otherwise pointing at it — and asks for a change, update that same piece of content in place through the tool that produced it, reusing its identity, rather than producing a new one beside it.`

/** Mount the prompt registry and this package's registry over it. */
async function bench(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ContentSurfaceRegistry).await()
  return ctx
}

describe('content surface prompt section', () => {
  it('contributes the on-display rule verbatim, last of the assembled sections', async () => {
    const ctx = await bench()
    const assembly = await ctx.systemPrompt.assemble()
    // No extractor is registered here: the rule is about what the user points
    // at, so an empty table is not a reason to withhold it.
    expect(assembly.sections.at(-1)).toEqual({ name: 'content:on-display', text: RULE })
    // Nothing renders after it, which is where the rule was measured.
    expect(renderPrompt(assembly).endsWith(RULE)).toBe(true)
  })

  it('withdraws the rule when the row unloads (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    const fiber = ctx.plugin(ContentSurfaceRegistry)
    await fiber.await()
    expect((await ctx.systemPrompt.assemble()).sections.map(section => section.name))
      .toContain('content:on-display')

    await fiber.dispose()
    expect((await ctx.systemPrompt.assemble()).sections.map(section => section.name))
      .not.toContain('content:on-display')
  })

  it('keeps the extractor table without a prompt registry composed', async () => {
    const ctx = new Context()
    await ctx.plugin(ContentSurfaceRegistry).await()
    expect(typeof ctx.contentSurface.register).toBe('function')
  })
})
