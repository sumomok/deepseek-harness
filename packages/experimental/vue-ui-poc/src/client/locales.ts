/** `vuePoc` namespace dictionaries (the Vue probe's copy). */

/** Dictionary namespace this plugin owns. */
export const NS = 'vuePoc'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'probe.title': 'Vue 组件已挂载',
  'probe.count': '计数',
  'probe.echo': 'React 回声',
  'probe.aria': 'Vue 计数按钮',
} satisfies Record<string, string>

/** The vuePoc namespace key union. */
export type VuePocKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'probe.title': 'Vue component mounted',
  'probe.count': 'Count',
  'probe.echo': 'React echo',
  'probe.aria': 'Vue count button',
} satisfies Record<VuePocKey, string>
