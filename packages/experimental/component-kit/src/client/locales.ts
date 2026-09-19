/**
 * `componentKit` namespace dictionaries — the vocabulary of the component row.
 *
 * The copy the row's own renderers draw, and nothing else. What a placement
 * package says in place of a block it cannot draw is that package's, because
 * which components exist is decided by which component plugins a deployment
 * composed rather than by this row.
 */

import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'

/** Dictionary namespace this package owns. */
export const NS = 'componentKit'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'confirmBar.actions': '可选操作',
  'confirmBar.sending': '正在发送…',
  'confirmBar.sent': '已发送到对话',
  'confirmBar.queued': '已记下，你下次发消息时对话会看到',
  'confirmBar.refused': '这个动作没能记下来，可以再试',
  'action.sending': '正在发送…',
  'action.sent': '已发送到对话',
  'action.queued': '已记下，你下次发消息时对话会看到',
  'action.refused': '这个动作没能记下来，可以再试',
  'filterBar.submit': '查询',
  'dataPage.preparing': '正在准备数据页…',
  'dataPage.unavailable': '数据页的地址没有配置好，这块内容打不开。',
  'dataPage.noTable': '这块内容没说要打开哪张表，打不开。',
} satisfies Record<string, string>

/** The componentKit namespace key union. */
export type ComponentKitKey = keyof typeof zh

/** Translate bound to this row's namespace, as its renderers receive it. */
export type ComponentKitTranslate = Translate<ComponentKitKey>

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'confirmBar.actions': 'Available actions',
  'confirmBar.sending': 'Sending…',
  'confirmBar.sent': 'Sent to the conversation',
  'confirmBar.queued': 'Noted — the conversation will see it with your next message',
  'confirmBar.refused': 'This was not recorded. You can try again.',
  'action.sending': 'Sending…',
  'action.sent': 'Sent to the conversation',
  'action.queued': 'Noted — the conversation will see it with your next message',
  'action.refused': 'This was not recorded. You can try again.',
  'filterBar.submit': 'Search',
  'dataPage.preparing': 'Preparing the data page…',
  'dataPage.unavailable': 'The data page\'s address is not configured, so this block cannot open.',
  'dataPage.noTable': 'This block does not say which table to open, so it cannot open.',
} satisfies Record<ComponentKitKey, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The component row's own copy, drawn inside the blocks it registers. */
    componentKit: ComponentKitKey
  }
}
