/** `contentSurface` namespace dictionaries (the content column's own copy). */

/** Dictionary namespace this package owns. */
export const NS = 'contentSurface'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'switcher.label': '内容条目',
  'column.empty': '这个会话还没有产生可以展示的内容。',
  'entry.unsupported': '当前组合里没有能画出「{kind}」这类内容的插件。',
} satisfies Record<string, string>

/** The contentSurface namespace key union. */
export type ContentSurfaceKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'switcher.label': 'Content entries',
  'column.empty': 'This session has produced nothing to show here yet.',
  'entry.unsupported': 'Nothing in this composition renders "{kind}" content.',
} satisfies Record<ContentSurfaceKey, string>
