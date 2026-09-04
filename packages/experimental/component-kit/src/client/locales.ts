/**
 * `componentKit` namespace dictionaries — the vocabulary of the component row.
 *
 * One namespace covers both what a renderer draws inside a block and what a
 * placement package draws in place of a block it cannot get from this row:
 * which components exist is this package's fact, so the sentence stating that
 * one is missing belongs here rather than in the package that merely asked for
 * it.
 */

/** Dictionary namespace this package owns. */
export const NS = 'componentKit'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'block.unsupported': '这里暂时没有能显示这块内容的组件。',
  'block.unreadable': '这块内容暂时显示不了。',
  'confirmBar.actions': '可选操作',
  'confirmBar.sending': '正在发送…',
  'confirmBar.sent': '已发送到对话',
  'confirmBar.queued': '已记下，你下次发消息时对话会看到',
  'confirmBar.refused': '这个动作没能记下来，可以再试',
} satisfies Record<string, string>

/** The componentKit namespace key union. */
export type ComponentKitKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'block.unsupported': 'Nothing here can draw this block yet.',
  'block.unreadable': 'This block cannot be displayed.',
  'confirmBar.actions': 'Available actions',
  'confirmBar.sending': 'Sending…',
  'confirmBar.sent': 'Sent to the conversation',
  'confirmBar.queued': 'Noted — the conversation will see it with your next message',
  'confirmBar.refused': 'This was not recorded. You can try again.',
} satisfies Record<ComponentKitKey, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The component row's copy, shared with whichever package places its blocks. */
    componentKit: ComponentKitKey
  }
}
