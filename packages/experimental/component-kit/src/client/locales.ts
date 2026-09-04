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
} satisfies Record<string, string>

/** The componentKit namespace key union. */
export type ComponentKitKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'block.unsupported': 'Nothing here can draw this block yet.',
  'block.unreadable': 'This block cannot be displayed.',
  'confirmBar.actions': 'Available actions',
} satisfies Record<ComponentKitKey, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The component row's copy, shared with whichever package places its blocks. */
    componentKit: ComponentKitKey
  }
}
