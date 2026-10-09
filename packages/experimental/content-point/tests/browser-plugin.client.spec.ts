// @vitest-environment jsdom
/**
 * The browser half on a real SlotRegistry and LocaleRuntime: it puts one entry
 * in the composer's `conversation.input.left` seat and point-anchor's page
 * marker on the document; the entry's injected share points over the document,
 * names blocks from the locale (English under jsdom), files a reference draft under the
 * `content-point` source with the payload it is given, and words a refusal as
 * point-anchor does; teardown empties the seat and removes the marker.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { ComposerReferenceAttachment, DraftAttachmentId } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { pageMarkerValue } from '@haoran/dsh-point-anchor/page'
import { apply, inject } from '../src/client/index.ts'
import type { PointButtonInjected } from '../src/client/index.ts'
import { clickTrusted, mountConsole, probe } from './console-fixture.client.ts'

/** What an owner hands `createReferenceDraft`. */
type ReferenceDraftInput = Omit<ComposerReferenceAttachment, 'kind' | 'id'>

/**
 * A client context with the slots, the locale and a conversation that files drafts.
 * @returns the context, the registry and the draft spy.
 */
async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({ name: 'root', children: { 'conversation.input.left': { kind: 'list', scope: 'session' } } } as never, () => null)
  ctx.provide('locale', new LocaleRuntime(ctx))
  const filed: ReferenceDraftInput[] = []
  const createReferenceDraft = vi.fn((input: ReferenceDraftInput): ComposerReferenceAttachment => {
    filed.push(input)
    return { kind: 'reference', id: `draft-${String(filed.length)}` as DraftAttachmentId, ...input }
  })
  ctx.provide('conversation', { createReferenceDraft })
  return { ctx, slots, filed, createReferenceDraft }
}

describe('the browser half', () => {
  it('puts the button in the tool row and the marker on the document, and takes both away', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.slots.entries('conversation.input.left')).toHaveLength(1)
    expect(document.documentElement.getAttribute('data-dsh-point')).toBe(pageMarkerValue())
    await fiber.dispose()
    expect(b.slots.entries('conversation.input.left')).toHaveLength(0)
    expect(document.documentElement.hasAttribute('data-dsh-point')).toBe(false)
  })

  it('injects a point over the document that names blocks from the locale (English under jsdom), a draft filed under content-point, and point-anchor\'s refusal words', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    try {
      await fiber.await()
      const entry = b.slots.entries('conversation.input.left')[0]
      if (entry?.inject === undefined) throw new Error('the entry injects nothing')
      const injected = (entry.inject as (() => PointButtonInjected) & NonNullable<typeof entry.inject>)()
      mountConsole(document)
      const named = async (name: string) => {
        const pending = injected.point(new AbortController().signal)
        clickTrusted(probe(document, name))
        const outcome = await pending
        return outcome.kind === 'reference' ? outcome.label : outcome.kind
      }
      expect(await named('metric')).toBe('Metric')
      expect(await named('chart')).toBe('Component')
      expect(await named('office')).toBe('Document')
      document.querySelector('[data-content-surface-seat="office"]')?.setAttribute('data-content-surface-seat', 'video')
      expect(await named('office')).toBe('Content panel')

      expect(injected.draft('列「名称」', { v: 1 })).toBe('draft-1')
      expect(b.filed[0]).toMatchObject({ source: 'content-point', label: '列「名称」' })
      await expect(b.filed[0]?.resolve(new AbortController().signal)).resolves.toEqual({ v: 1 })
      expect(injected.refusal('popup')).toBe('弹出层不能指')
    } finally {
      await fiber.dispose()
    }
  })
})
