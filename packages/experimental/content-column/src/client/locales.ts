/** `contentSurface` namespace dictionaries (the content column's own copy). */

/** Dictionary namespace this package owns. */
export const NS = 'contentSurface'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'switcher.label': '内容条目',
  'column.empty': '这里还没有可以展示的内容。',
  'entry.unsupported': '当前组合里没有能画出「{kind}」这类内容的插件。',
  'entry.dismiss': '关闭「{title}」',
} satisfies Record<string, string>

/** The contentSurface namespace key union. */
export type ContentSurfaceKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'switcher.label': 'Content entries',
  'column.empty': 'There is nothing to show here yet.',
  'entry.unsupported': 'Nothing in this composition renders "{kind}" content.',
  'entry.dismiss': 'Close "{title}"',
} satisfies Record<ContentSurfaceKey, string>
