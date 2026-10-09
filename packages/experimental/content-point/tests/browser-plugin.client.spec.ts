// @vitest-environment jsdom
/**
 * The browser half on a real SlotRegistry and LocaleRuntime: it puts one entry
 * in the composer's `conversation.input.left` seat — one again when the seat
 * is declared anew — and point-anchor's page marker on the document. The
 * entry's injected share runs the picker for a reference with every word in
 * the locale, each refusal that becomes a block reference stated as the whole
 * block; names places and blocks from the locale (English under jsdom); files
 * a reference draft under the `content-point` source with the payload it is
 * given, counts and releases its own drafts, and words a refusal from the
 * locale. Teardown empties the seat and removes the marker.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ComposerReferenceAttachment, DraftAttachmentId } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { DESCRIBE_REFUSALS, ZH_LABEL_WORDS } from '@haoran/dsh-point-anchor'
import type { PickerOptions } from '@haoran/dsh-point-anchor/page'
import { pageMarkerValue } from '@haoran/dsh-point-anchor/page'
import { apply, inject } from '../src/client/index.ts'
import { en, zh } from '../src/client/locales.ts'
import { WHOLE_BLOCK_REASONS } from '../src/client/pick.ts'
import type { PointButtonInjected } from '../src/client/PointButton.tsx'
import { labelWords, pointNames, refusalWords } from '../src/client/words.ts'
import type { Translate } from '../src/client/words.ts'
import { clickTrusted, mountConsole, probe } from './console-fixture.client.ts'

/** Every option the picker was created with, in order. */
const picked = vi.hoisted(() => ({ options: [] as unknown[] }))

vi.mock('@haoran/dsh-point-anchor/page', async (importOriginal) => {
  const page = await importOriginal<typeof import('@haoran/dsh-point-anchor/page')>()
  return {
    ...page,
    createPicker: (doc: Document, options: PickerOptions) => {
      picked.options.push(options)
      return page.createPicker(doc, options)
    },
  }
})

/** What the conversation service does with a draft, as far as the entry reaches it. */
interface Drafts {
  readonly filed: Omit<ComposerReferenceAttachment, 'kind' | 'id'>[]
  readonly released: DraftAttachmentId[]
}

/**
 * A client context with the slots, the locale and a conversation that files drafts.
 * @returns the context, the registry, the declaration of the seat, and the drafts.
 */
async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  const declare = () => slots.register({ name: 'root', children: { 'conversation.input.left': { kind: 'list', scope: 'session' } } } as never, () => null)
  const undeclare = declare()
  ctx.provide('locale', new LocaleRuntime(ctx))
  const drafts: Drafts = { filed: [], released: [] }
  const createReferenceDraft = vi.fn((input: Omit<ComposerReferenceAttachment, 'kind' | 'id'>): ComposerReferenceAttachment => {
    drafts.filed.push(input)
    return { kind: 'reference', id: `draft-${String(drafts.filed.length)}` as DraftAttachmentId, ...input }
  })
  const releaseDraftAttachment = vi.fn((id: DraftAttachmentId) => { drafts.released.push(id) })
  ctx.provide('conversation', { createReferenceDraft, releaseDraftAttachment })
  return { ctx, slots, declare, undeclare, drafts }
}

/**
 * The entry's injected share.
 * @param slots - the registry.
 * @returns the share.
 */
function injectedOf(slots: SlotRegistry): PointButtonInjected {
  const entry = slots.entries('conversation.input.left')[0]
  if (entry?.inject === undefined) throw new Error('the entry injects nothing')
  return (entry.inject as (() => PointButtonInjected) & NonNullable<typeof entry.inject>)()
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

  it('takes the button out of a seat that collapses, and puts one back when it is declared anew', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    try {
      await fiber.await()
      b.undeclare()
      expect(b.slots.entries('conversation.input.left')).toHaveLength(0)
      const again = b.declare()
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(b.slots.entries('conversation.input.left')).toHaveLength(1)
      again()
    } finally {
      await fiber.dispose()
    }
  })

  it('runs the picker for a reference, in the locale\'s words, each refusal that becomes a block stated as the whole block', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    try {
      await fiber.await()
      mountConsole(document)
      picked.options.length = 0
      const pending = injectedOf(b.slots).point(new AbortController().signal)
      clickTrusted(probe(document, 'nav'))
      const outcome = await pending
      const options = picked.options[0] as PickerOptions
      expect(options.purpose).toBe('reference')
      for (const reason of DESCRIBE_REFUSALS) {
        expect(options.refusalWords?.[reason], reason).toBe(WHOLE_BLOCK_REASONS.has(reason) ? en['picker.block'] : en[`refusal.${reason}`])
      }
      expect(options.words?.button?.('Search')).toBe('Button “Search”')
      expect(outcome.kind === 'reference' && outcome.label).toBe('Sidebar “图层完成率”')
    } finally {
      await fiber.dispose()
    }
  })

  it('names blocks from the locale, files drafts under content-point, counts and releases its own, and words a refusal', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    try {
      await fiber.await()
      const injected = injectedOf(b.slots)
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

      const first = injected.draft('Column “Name”', { v: 1 })
      expect(first).toBe('draft-1')
      expect(b.drafts.filed[0]).toMatchObject({ source: 'content-point', label: 'Column “Name”' })
      await expect(b.drafts.filed[0]?.resolve(new AbortController().signal)).resolves.toEqual({ v: 1 })
      const second = injected.draft('Metric', { v: 1 })
      expect(injected.drafted([first, second, 'other' as DraftAttachmentId])).toBe(2)
      injected.release(second)
      expect(b.drafts.released).toEqual([second])
      expect(injected.drafted([first, second])).toBe(1)
      expect(injected.refusal('popup')).toBe('Popups can\'t be pointed at')
    } finally {
      await fiber.dispose()
    }
  })
})

describe('the words of a point', () => {
  const tZh: Translate = makeTranslate(zh)
  const tEn: Translate = makeTranslate(en)

  it('in Chinese are describe format 1\'s, so a chip reads as the model text names the place', () => {
    const words = labelWords(tZh)
    expect(words.regions).toEqual(ZH_LABEL_WORDS.regions)
    expect(words.roles).toEqual(ZH_LABEL_WORDS.roles)
    expect(words.role).toBe(ZH_LABEL_WORDS.role)
    for (const key of ['header', 'cell', 'operation', 'button', 'field', 'nav'] as const) expect(words[key]('名'), key).toBe(ZH_LABEL_WORDS[key]('名'))
    expect(words.control('按钮', '查询')).toBe(ZH_LABEL_WORDS.control('按钮', '查询'))
    expect(words.nameless('按钮')).toBe(ZH_LABEL_WORDS.nameless('按钮'))
    for (const key of ['row', 'picture', 'untitledNav'] as const) expect(words[key], key).toBe(ZH_LABEL_WORDS[key])
  })

  it('in English cover every region, role and refusal in English', () => {
    const words = labelWords(tEn)
    expect(Object.keys(words.roles)).toEqual(Object.keys(ZH_LABEL_WORDS.roles))
    for (const value of [...Object.values(words.regions), ...Object.values(words.roles), ...Object.values(refusalWords(tEn))]) {
      expect(value).toMatch(/^[\x20-\x7e“”]+$/u)
    }
    expect(words.nameless('Button')).toBe('Button (no name)')
  })

  it('name a block, a seat, a role and the places the locale labels itself', () => {
    const names = pointNames(tEn)
    expect(names.component('el.metric')).toBe('Metric')
    expect(names.component('custom.chart')).toBe('Component')
    expect(names.component(undefined)).toBe('Component')
    expect(names.seat('page')).toBe('Original system page')
    expect(names.seat('video')).toBe('Content panel')
    expect(names.role('button')).toBe('Button')
    expect(names.role('widget')).toBe('Control')
    expect(names.cellControl('Name', 'Button')).toBe('Button in the “Name” column')
    expect(names.tableItem('Link')).toBe('Link in a table')
    expect(labelWords(tEn).roles['widget']).toBeUndefined()
  })
})
