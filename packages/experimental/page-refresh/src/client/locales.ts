/** `pageRefresh` namespace dictionaries: the banner's copy. */

/** Dictionary namespace this plugin owns. */
export const NS = 'pageRefresh'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'update.text': '页面有新版本，请刷新后继续使用',
  'reloading.text': '正在刷新页面…',
  'lost.text': '连接已断开，正在重新连接…',
  'recovered.text': '已重新连接',
  'stuck.text': '暂时连不上服务',
  'reload.label': '刷新页面',
} satisfies Record<string, string>

/** The pageRefresh namespace key union. */
export type PageRefreshKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'update.text': 'A new version is available. Reload the page to continue.',
  'reloading.text': 'Reloading…',
  'lost.text': 'Connection lost, reconnecting…',
  'recovered.text': 'Reconnected',
  'stuck.text': 'Can\'t reach the service',
  'reload.label': 'Reload page',
} satisfies Record<PageRefreshKey, string>
