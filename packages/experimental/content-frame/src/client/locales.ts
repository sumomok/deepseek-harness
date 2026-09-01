/** `contentFrame` namespace dictionaries (the page seat's and the read row's copy). */

/** Dictionary namespace this plugin owns. */
export const NS = 'contentFrame'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'frame.title': '内容应用',
  'frame.missing': '这个页面已不在本部署的页面清单中。',
  'read.pending': '正在读取内容区…',
  'read.done': '看了一眼「{page}」',
  'read.done.unknown': '看了一眼内容区',
  'read.failed': '读取内容区失败',
} satisfies Record<string, string>

/** The contentFrame namespace key union. */
export type ContentFrameKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'frame.title': 'Content application',
  'frame.missing': 'This page is no longer in the deployment\'s page list.',
  'read.pending': 'Reading the content column…',
  'read.done': 'Looked at “{page}”',
  'read.done.unknown': 'Looked at the content column',
  'read.failed': 'Could not read the content column',
} satisfies Record<ContentFrameKey, string>
