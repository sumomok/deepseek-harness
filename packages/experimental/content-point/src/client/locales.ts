/** `contentPoint` namespace dictionaries: the composer button, the picker's block wording, and the names a block reference shows. */

/** Dictionary namespace this plugin owns. */
export const NS = 'contentPoint'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'button.label': '指一下',
  'button.picking': '正在指：点内容栏里的一处，按 Esc 取消',
  'refused.text': '这一处指不了：{reason}',
  'picker.block': '指这一整块',
  'block.toy.data-page': '数据页',
  'block.toy.form-page': '表单页',
  'block.toy.info-card': '信息卡',
  'block.toy.table': '表格',
  'block.toy.record': '记录详情',
  'block.el.metric': '指标',
  'block.el.filter-bar': '筛选栏',
  'block.el.confirm-bar': '确认栏',
  'block.component': '组件',
  'seat.component': '组件视图',
  'seat.page': '原系统页面',
  'seat.office': '文档',
  'seat.other': '内容栏',
} satisfies Record<string, string>

/** The contentPoint namespace key union. */
export type ContentPointKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'button.label': 'Point',
  'button.picking': 'Pointing: click a place in the content panel, or press Esc to cancel',
  'refused.text': 'This place can\'t be pointed at: {reason}',
  'picker.block': 'Point at this whole block',
  'block.toy.data-page': 'Data page',
  'block.toy.form-page': 'Form page',
  'block.toy.info-card': 'Info card',
  'block.toy.table': 'Table',
  'block.toy.record': 'Record details',
  'block.el.metric': 'Metric',
  'block.el.filter-bar': 'Filter bar',
  'block.el.confirm-bar': 'Confirmation bar',
  'block.component': 'Component',
  'seat.component': 'Component view',
  'seat.page': 'Original system page',
  'seat.office': 'Document',
  'seat.other': 'Content panel',
} satisfies Record<ContentPointKey, string>
