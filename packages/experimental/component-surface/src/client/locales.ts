/**
 * `contentComponent` namespace dictionaries — what the seat says in place of a
 * block, and what it says around one question.
 *
 * Three of the sentences stand in for a block: one no component plugin
 * registered a renderer for, one this build cannot read at all, and one still
 * waiting on the block that feeds it. Which components exist is a deployment's
 * runtime fact now, so the sentences standing in for one belong to the row that
 * looks the component up and misses, not to any package that happens to ship
 * components.
 *
 * The other three belong to the question a click on a data page is answered
 * with. The card itself is the host's, word for word the one a call for that
 * page is put through, and it arrives as text; what is here is everything
 * around it — the two words a person answers with, and the line left behind
 * when they decline.
 * @module @deepseek-ai/dsh-experimental-component-surface/client/locales
 */

/** Dictionary namespace this package owns. */
export const NS = 'contentComponent'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'block.unsupported': '这里暂时没有能显示这块内容的组件。',
  'block.unreadable': '这块内容暂时显示不了。',
  'block.awaiting': '请先选择要看的内容',
  'consent.allow': '允许',
  'consent.decline': '拒绝',
  'consent.declined': '没有打开。',
} satisfies Record<string, string>

/** The contentComponent namespace key union. */
export type ContentComponentKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'block.unsupported': 'Nothing here can draw this block yet.',
  'block.unreadable': 'This block cannot be displayed.',
  'block.awaiting': 'Pick something to show here',
  'consent.allow': 'Allow',
  'consent.decline': 'Decline',
  'consent.declined': 'Not opened.',
} satisfies Record<ContentComponentKey, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** What the content column's component seat says in place of a block it cannot draw. */
    contentComponent: ContentComponentKey
  }
}
