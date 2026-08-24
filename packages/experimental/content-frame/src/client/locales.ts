/** `contentFrame` namespace dictionaries (the page seat's copy). */

/** Dictionary namespace this plugin owns. */
export const NS = 'contentFrame'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'frame.title': '内容应用',
  'frame.missing': '这个页面已不在本部署的页面清单中。',
} satisfies Record<string, string>

/** The contentFrame namespace key union. */
export type ContentFrameKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'frame.title': 'Content application',
  'frame.missing': 'This page is no longer in the deployment\'s page list.',
} satisfies Record<ContentFrameKey, string>
