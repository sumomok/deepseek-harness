/**
 * `serverSidebar` namespace dictionaries: shell controls (ported from
 * `dsh-client-ui-sidebar`'s own `sidebar` namespace, which this package does
 * not reuse — see the module doc in `index.ts`) plus the two menu groups
 * this package adds.
 */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'session.new': '新会话',
  'session.new.label': '新建会话',
  'toggle.open': '打开侧边栏',
  'toggle.collapse': '收起侧边栏',
  'menu.trigger': '打开页面与收藏菜单',
  'menu.pages.title': '页面',
  'menu.pages.empty': '未配置页面',
  'menu.favorites.title': '收藏',
  'menu.favorites.empty': '暂无收藏',
  'menu.favorites.add': '收藏当前会话',
  'menu.favorites.rename': '重命名',
  'menu.favorites.remove': '取消收藏',
  'menu.favorites.namePlaceholder': '收藏名称',
  'menu.favorites.stale': '会话已删除',
  'menu.favorites.error': '收藏保存失败：{message}',
} satisfies Record<string, string>

/** The serverSidebar namespace key union. */
export type ServerSidebarKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'session.new': 'New Session',
  'session.new.label': 'New session',
  'toggle.open': 'Open sidebar',
  'toggle.collapse': 'Collapse sidebar',
  'menu.trigger': 'Open the pages and favorites menu',
  'menu.pages.title': 'Pages',
  'menu.pages.empty': 'No pages configured',
  'menu.favorites.title': 'Favorites',
  'menu.favorites.empty': 'No favorites yet',
  'menu.favorites.add': 'Favorite current session',
  'menu.favorites.rename': 'Rename',
  'menu.favorites.remove': 'Remove favorite',
  'menu.favorites.namePlaceholder': 'Favorite name',
  'menu.favorites.stale': 'Session deleted',
  'menu.favorites.error': 'Failed to save favorites: {message}',
} satisfies Record<ServerSidebarKey, string>
