/**
 * content-point browser half: the 「指一下」 button in the composer's tool row,
 * at the `conversation.input.left` seat, and the page marker point-anchor's
 * pick script checks.
 *
 * A click on the button runs a point over the console document (`./pick.ts`);
 * the place picked is filed with `createReferenceDraft` under the
 * `content-point` source and added to that session's attachment row, where the
 * chip shows its label only. The payload is resolved when the draft is sent,
 * and is the payload the pick produced: a point-anchor description as a
 * reference may carry it, or a block reference.
 *
 * Every word the picker and the button show comes from this package's
 * dictionary, in the console's locale: how a place is labelled, why a place is
 * refused, and, for every refusal that becomes a block reference, 「指这一整块」.
 * @module @deepseek-ai/dsh-experimental-content-point/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: the ui-conversation SlotMap merge (the input.left seat) and `ctx.conversation`.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the slot registry's Context merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { DraftAttachmentId, IConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { writePageMarker } from '@haoran/dsh-point-anchor/page'
import { POINT_SOURCE } from '../text.ts'
import { en, NS, zh } from './locales.ts'
import type { ContentPointKey } from './locales.ts'
import { point } from './pick.ts'
import type { ReferenceData } from './pick.ts'
import { PointButton } from './PointButton.tsx'
import type { PointButtonInjected } from './PointButton.tsx'
import { labelWords, pointNames, refusalWords } from './words.ts'
import type { Translate } from './words.ts'

export type { ContentPointKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The 「指一下」 button's copy, the picker's words, and the names a reference shows. */
    contentPoint: ContentPointKey
  }
}

/** Required services: the slots the button is put in, the locale, and the conversation it files drafts with. */
export const inject = ['slots', 'locale', 'conversation']

/** The slot entry id of the button. */
const ENTRY_ID = '@deepseek-ai/dsh-experimental-content-point'

/**
 * The conversation service's release of one draft attachment. The public face
 * offers no release for a draft that never entered a row; the service's own
 * method is called where it is present.
 */
interface DraftRelease {
  readonly releaseDraftAttachment?: (id: DraftAttachmentId) => void
}

/**
 * Put the button in the composer's tool row and the marker on the document.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'content-point: dictionaries')
  ctx.effect(() => writePageMarker(document), 'content-point: page marker')
  const t: Translate = ctx.locale.bind(NS)
  const conversation: IConversation & DraftRelease = ctx.conversation
  // The drafts this entry filed; one leaves the row when it is sent or removed and never returns to it.
  const drafts = new Set<DraftAttachmentId>()
  const injected: PointButtonInjected = {
    point: signal => point(document, { names: pointNames(t), words: labelWords(t), refusalWords: refusalWords(t), signal }),
    draft: (label: string, data: ReferenceData): DraftAttachmentId => {
      const { id } = conversation.createReferenceDraft({ source: POINT_SOURCE, label, resolve: () => Promise.resolve(data) })
      drafts.add(id)
      return id
    },
    drafted: ids => ids.filter(id => drafts.has(id)).length,
    release: (id) => {
      drafts.delete(id)
      conversation.releaseDraftAttachment?.(id)
    },
    refusal: reason => t(`refusal.${reason}`),
  }
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: ENTRY_ID,
    locale: NS,
    inject: (): PointButtonInjected => injected,
  }, PointButton))
}
