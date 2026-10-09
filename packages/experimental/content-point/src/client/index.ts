/**
 * content-point browser half: the 「指一下」 button in the composer's tool row,
 * at the `conversation.input.left` seat, and the page marker point-anchor's
 * pick script checks.
 *
 * A click on the button runs a point over the console document (`./pick.ts`);
 * the place picked is filed with `createReferenceDraft` under the
 * `content-point` source and added to that session's attachment row, where the
 * chip shows its label only. The payload is resolved when the draft is sent,
 * and is the payload the pick produced: a point-anchor description without its
 * DataPage row, or a block reference.
 * @module @deepseek-ai/dsh-experimental-content-point/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: the ui-conversation SlotMap merge (the input.left seat) and `ctx.conversation`.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { DraftAttachmentId } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { REFUSAL_WORDS } from '@haoran/dsh-point-anchor'
import type { DescribeRefusal } from '@haoran/dsh-point-anchor'
import { writePageMarker } from '@haoran/dsh-point-anchor/page'
import { POINT_SOURCE } from '../text.ts'
import { en, NS, zh } from './locales.ts'
import type { ContentPointKey } from './locales.ts'
import { point } from './pick.ts'
import type { BlockNames, ReferenceData } from './pick.ts'
import { PointButton } from './PointButton.tsx'
import type { PointButtonInjected } from './PointButton.tsx'

export type { ContentPointKey } from './locales.ts'
export { PointButton } from './PointButton.tsx'
export type { PointButtonInjected, PointButtonProps } from './PointButton.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The 「指一下」 button's copy and the names a block reference shows. */
    contentPoint: ContentPointKey
  }
}

/** Required services: the slots the button is put in, the locale, and the conversation it files drafts with. */
export const inject = ['slots', 'locale', 'conversation']

/** The slot entry id of the button. */
const ENTRY_ID = '@deepseek-ai/dsh-experimental-content-point'

/** Component ids whose display name the locale holds. */
const NAMED_COMPONENTS: ReadonlySet<string> = new Set([
  'toy.data-page', 'toy.form-page', 'toy.info-card', 'toy.table', 'toy.record', 'el.metric', 'el.filter-bar', 'el.confirm-bar',
])

/** Seat kinds whose display name the locale holds. */
const NAMED_SEATS: ReadonlySet<string> = new Set(['component', 'page', 'office'])

/**
 * Put the button in the composer's tool row and the marker on the document.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'content-point: dictionaries')
  ctx.effect(() => writePageMarker(document), 'content-point: page marker')
  const t = ctx.locale.bind(NS)
  const names: BlockNames = {
    component: component => (component !== undefined && NAMED_COMPONENTS.has(component)
      ? t(`block.${component}` as ContentPointKey)
      : t('block.component')),
    seat: seat => t(NAMED_SEATS.has(seat) ? `seat.${seat}` as ContentPointKey : 'seat.other'),
  }
  const injected: PointButtonInjected = {
    point: signal => point(document, { names, signal, refusalWords: { 'unsupported-component': t('picker.block') } }),
    draft: (label: string, data: ReferenceData): DraftAttachmentId => ctx.conversation.createReferenceDraft({
      source: POINT_SOURCE,
      label,
      resolve: () => Promise.resolve(data),
    }).id,
    refusal: (reason: DescribeRefusal) => REFUSAL_WORDS[reason],
  }
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: ENTRY_ID,
    locale: NS,
    inject: (): PointButtonInjected => injected,
  }, PointButton))
}
