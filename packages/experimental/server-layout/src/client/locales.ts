/** `serverLayout` namespace dictionaries (this shell's own copy). */

/** Dictionary namespace this plugin owns. */
export const NS = 'serverLayout'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'content.title': '内容区待接入',
  'content.hint': '这一栏由 content 槽承载，目前没有插件注册进来。',
} satisfies Record<string, string>

/** The serverLayout namespace key union. */
export type ServerLayoutKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'content.title': 'Content column is empty',
  'content.hint': 'This column is the `content` slot; no plugin has registered into it yet.',
} satisfies Record<ServerLayoutKey, string>
