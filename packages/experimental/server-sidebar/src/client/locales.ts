/**
 * `serverSidebar` namespace dictionaries: the three-section sidebar (工作台 /
 * 导航 / 我的工作流), the 临时工作流 section under it, and the "存为工作流"
 * session-header action this package registers alongside them. No
 * shipped-sidebar controls survive here — decision ① drops New Session and
 * the collapse toggle outright, so this package no longer reuses
 * `dsh-client-ui-sidebar`'s own `sidebar` namespace keys at all.
 *
 * Every key here is screened by decision ②'s banned-word list (会话 / 新会话
 * / session / workspace must never appear in user-visible text); see the
 * package README for the full rationale. `temporary.untitled` exists because
 * of that list: a conversation with no durable title of its own falls back to
 * this fixed copy rather than to the session list's own `displayTitle`, whose
 * lower rungs are a directory basename and a bare session id. `temporary.error`
 * carries no interpolation slot for the same reason: a refused archive rejects
 * with the host runtime's own wording (`session archive failed: …`), so the
 * refusal goes to the browser console and the section says only that the
 * removal did not go through.
 */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'workbench.label': '工作台',
  'nav.title': '导航',
  'nav.empty': '未配置内容',
  'workflows.title': '我的工作流',
  'workflows.empty': '暂无工作流',
  'workflows.rename': '重命名',
  'workflows.remove': '移除',
  'workflows.namePlaceholder': '工作流名称',
  'workflows.error': '保存失败：{message}',
  'groups.new': '新建分组',
  'groups.namePlaceholder': '分组名称',
  'groups.rename': '重命名分组',
  'groups.remove': '删除分组',
  'groups.pin': '置顶',
  'groups.unpin': '取消置顶',
  'groups.pinned': '已置顶',
  'groups.expand': '展开',
  'groups.collapse': '收起',
  'groups.empty': '此分组暂无内容',
  'groups.dropToUngroup': '拖到这里放回未分组',
  'groups.moveTo': '移动到…',
  'groups.ungrouped': '未分组',
  'temporary.title': '临时工作流',
  'temporary.empty': '暂无临时工作流',
  'temporary.untitled': '未命名对话',
  'temporary.dismiss': '移出列表',
  'temporary.dismissConfirm': '确定移出',
  'temporary.dismissCancel': '取消',
  'temporary.more': '显示更多',
  'temporary.error': '移出失败，请稍后重试',
  'time.now': '刚刚',
  'time.minutes': '{count} 分钟前',
  'time.hours': '{count} 小时前',
  'time.days': '{count} 天前',
  'saveWorkflow.action': '存为工作流',
  'avatar.namePlaceholder': '用户',
  'signOut.action': '退出登录',
  'brand.name.fallback': '工作台小助手',
} satisfies Record<string, string>

/** The serverSidebar namespace key union. */
export type ServerSidebarKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'workbench.label': 'Workbench',
  'nav.title': 'Navigation',
  'nav.empty': 'Nothing configured',
  'workflows.title': 'My Workflows',
  'workflows.empty': 'No workflows yet',
  'workflows.rename': 'Rename',
  'workflows.remove': 'Remove',
  'workflows.namePlaceholder': 'Workflow name',
  'workflows.error': 'Failed to save: {message}',
  'groups.new': 'New group',
  'groups.namePlaceholder': 'Group name',
  'groups.rename': 'Rename group',
  'groups.remove': 'Delete group',
  'groups.pin': 'Pin to top',
  'groups.unpin': 'Unpin',
  'groups.pinned': 'Pinned',
  'groups.expand': 'Expand',
  'groups.collapse': 'Collapse',
  'groups.empty': 'Nothing in this group yet',
  'groups.dropToUngroup': 'Drop here to leave every group',
  'groups.moveTo': 'Move to…',
  'groups.ungrouped': 'Ungrouped',
  'temporary.title': 'Temporary workflows',
  'temporary.empty': 'Nothing temporary right now',
  'temporary.untitled': 'Untitled chat',
  'temporary.dismiss': 'Remove from list',
  'temporary.dismissConfirm': 'Confirm removal',
  'temporary.dismissCancel': 'Cancel',
  'temporary.more': 'Show more',
  'temporary.error': 'Could not remove it from the list. Try again.',
  'time.now': 'Just now',
  'time.minutes': '{count} min ago',
  'time.hours': '{count} h ago',
  'time.days': '{count} d ago',
  'saveWorkflow.action': 'Save as workflow',
  'avatar.namePlaceholder': 'User',
  'signOut.action': 'Sign out',
  'brand.name.fallback': 'Workbench Assistant',
} satisfies Record<ServerSidebarKey, string>
