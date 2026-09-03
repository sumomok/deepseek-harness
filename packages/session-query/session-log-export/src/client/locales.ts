/** Locale namespace owned by Session export browser feedback. */
export const NS = 'session-log-download'

/** Simplified-Chinese Session export strings. */
export const zh = {
  'header.action': 'Session 日志',
  'dialog.preparingTitle': '正在导出 Session',
  'dialog.preparingDescription': '正在准备包含当前 Session、子 Session 和附件的 ZIP 文件。',
  'dialog.progressLabel': '导出进度',
  'dialog.progress': '已导出 {size}',
  'dialog.successTitle': '导出完成',
  'dialog.successDescription': '已交给浏览器保存。',
  'dialog.errorTitle': '导出失败',
  'dialog.close': '关闭',
  'dialog.cancel': '取消',
  'dialog.commandFailed': '无法启动 Session 导出。',
} as const

/** English Session export strings. */
export const en: Record<keyof typeof zh, string> = {
  'header.action': 'Session log',
  'dialog.preparingTitle': 'Exporting Session',
  'dialog.preparingDescription': 'Preparing a ZIP containing this Session, its sub-Sessions, and attachments.',
  'dialog.progressLabel': 'Export progress',
  'dialog.progress': 'Exported {size}',
  'dialog.successTitle': 'Export complete',
  'dialog.successDescription': 'Handed to the browser to save.',
  'dialog.errorTitle': 'Export failed',
  'dialog.close': 'Close',
  'dialog.cancel': 'Cancel',
  'dialog.commandFailed': 'Could not start the Session export.',
}

/** Stable locale keys consumed by the shared panel. */
export type SessionLogDownloadKey = keyof typeof zh
