/** `contentFrame` namespace dictionaries (the hosted application's copy). */

/** Dictionary namespace this plugin owns. */
export const NS = 'contentFrame'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'frame.title': '内容应用',
} satisfies Record<string, string>

/** The contentFrame namespace key union. */
export type ContentFrameKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'frame.title': 'Content application',
} satisfies Record<ContentFrameKey, string>
