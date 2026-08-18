/**
 * Labels for every menu this app shows — the application menu bar and the
 * Windows tray menu. Electron's `role` menus carry English labels and are not
 * localized for us, so each item names itself here.
 *
 * Only menus are covered: dialogs and notifications stay Chinese, which is a
 * deliberate stopping point rather than a half-done translation of the whole
 * surface.
 * @module @deepseek-ai/dsh-desktop/menu-text
 */

import { app } from 'electron'

/** The two label sets, keyed by the language they are written in. */
const MENU_TEXT = {
  zh: {
    file: '文件', edit: '编辑', view: '视图', window: '窗口', help: '帮助',
    about: '关于', services: '服务', hide: '隐藏', hideOthers: '隐藏其他', unhide: '全部显示', quit: '退出',
    undo: '撤销', redo: '重做', cut: '剪切', copy: '复制', paste: '粘贴', selectAll: '全选',
    reload: '重新加载', forceReload: '强制重新加载', devTools: '开发者工具',
    resetZoom: '实际大小', zoomIn: '放大', zoomOut: '缩小', fullscreen: '全屏',
    minimize: '最小化', close: '关闭', front: '前置全部窗口',
    checkUpdate: '检查更新', openLog: '查看日志',
    open: '打开', askOnClose: '关闭时询问',
  },
  en: {
    file: 'File', edit: 'Edit', view: 'View', window: 'Window', help: 'Help',
    about: 'About', services: 'Services', hide: 'Hide', hideOthers: 'Hide Others', unhide: 'Show All', quit: 'Quit',
    undo: 'Undo', redo: 'Redo', cut: 'Cut', copy: 'Copy', paste: 'Paste', selectAll: 'Select All',
    reload: 'Reload', forceReload: 'Force Reload', devTools: 'Developer Tools',
    resetZoom: 'Actual Size', zoomIn: 'Zoom In', zoomOut: 'Zoom Out', fullscreen: 'Toggle Full Screen',
    minimize: 'Minimize', close: 'Close', front: 'Bring All to Front',
    checkUpdate: 'Check for Updates', openLog: 'Open Log',
    open: 'Open', askOnClose: 'Ask When Closing',
  },
} as const

/** One label set; both languages carry the same keys. */
export type MenuText = typeof MENU_TEXT[keyof typeof MENU_TEXT]

/**
 * The labels for this launch, chosen by the system locale.
 * @returns the Chinese set on a `zh*` locale, the English set otherwise.
 */
export function menuText(): MenuText {
  return app.getLocale().startsWith('zh') ? MENU_TEXT.zh : MENU_TEXT.en
}
