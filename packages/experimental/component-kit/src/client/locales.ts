/**
 * `componentKit` namespace dictionaries — the vocabulary of the component row.
 *
 * One namespace covers both what a renderer draws inside a block and what a
 * placement package draws in place of one — a block this row has no component
 * for, and a block whose properties are still waiting on the block that feeds it.
 * Which components exist and what they publish is this package's fact, so the
 * sentences standing in for one belong here rather than in the package that
 * merely asked for it.
 */

/** Dictionary namespace this package owns. */
export const NS = 'componentKit'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'block.unsupported': '这里暂时没有能显示这块内容的组件。',
  'block.unreadable': '这块内容暂时显示不了。',
  'block.awaiting': '请先选择要看的内容',
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
} satisfies Record<string, string>

/** The componentKit namespace key union. */
export type ComponentKitKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'block.unsupported': 'Nothing here can draw this block yet.',
  'block.unreadable': 'This block cannot be displayed.',
  'block.awaiting': 'Pick something to show here',
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
} satisfies Record<ComponentKitKey, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The component row's copy, shared with whichever package places its blocks. */
    componentKit: ComponentKitKey
  }
}
