/** `vue2EchartsPoc` namespace dictionaries (the Vue 2.7 chart panel's copy). */

/** Dictionary namespace this package owns. */
export const NS = 'vue2EchartsPoc'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'panel.title': 'ECharts 柱状图（Vue 2.7 组件）',
  'panel.randomize': '换一组数据',
  'panel.unselected': '尚未选择柱子',
  'panel.selected': '已选择 {category}：{value}',
  'panel.category.1': '周一',
  'panel.category.2': '周二',
  'panel.category.3': '周三',
  'panel.category.4': '周四',
  'panel.category.5': '周五',
  'panel.category.6': '周六',
  'panel.category.7': '周日',
} satisfies Record<string, string>

/** The vue2EchartsPoc namespace key union. */
export type Vue2EchartsPocKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'panel.title': 'ECharts bar chart (Vue 2.7 component)',
  'panel.randomize': 'Randomize',
  'panel.unselected': 'No bar selected',
  'panel.selected': 'Selected {category}: {value}',
  'panel.category.1': 'Mon',
  'panel.category.2': 'Tue',
  'panel.category.3': 'Wed',
  'panel.category.4': 'Thu',
  'panel.category.5': 'Fri',
  'panel.category.6': 'Sat',
  'panel.category.7': 'Sun',
} satisfies Record<Vue2EchartsPocKey, string>
