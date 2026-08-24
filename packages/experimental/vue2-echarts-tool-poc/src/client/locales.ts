/** `showChart` namespace dictionaries (the transcript chart row's copy). */

/** Dictionary namespace this package owns. */
export const NS = 'showChart'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'row.title': '图表',
  'row.rendering': '正在绘制图表…',
  'row.failed': '图表未能绘制：{error}',
  'row.unreadable': '这次调用的参数读不出图表。',
  'row.superseded': '{title}：已由后面一次调用重新绘制。',
} satisfies Record<string, string>

/** The showChart namespace key union. */
export type ShowChartKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'row.title': 'Chart',
  'row.rendering': 'Drawing the chart…',
  'row.failed': 'The chart did not render: {error}',
  'row.unreadable': 'This call carries no readable chart arguments.',
  'row.superseded': '{title}: updated by a later call.',
} satisfies Record<ShowChartKey, string>
