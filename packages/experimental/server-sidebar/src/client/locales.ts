/**
 * `serverSidebar` namespace dictionaries: the three-section sidebar (工作台 /
 * 导航 / 我的工作流) plus the "存为工作流" session-header action this package
 * registers alongside it. No shipped-sidebar controls survive here — decision
 * ① drops New Session and the collapse toggle outright, so this package no
 * longer reuses `dsh-client-ui-sidebar`'s own `sidebar` namespace keys at all.
 *
 * Every key here is screened by decision ②'s banned-word list (会话 / 新会话
 * / session / workspace must never appear in user-visible text); see the
 * package README for the full rationale.
 */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'workbench.label': '工作台',
  'nav.title': '导航',
  'nav.empty': '未配置页面',
  'workflows.title': '我的工作流',
  'workflows.empty': '暂无工作流',
  'workflows.rename': '重命名',
  'workflows.remove': '移除',
  'workflows.namePlaceholder': '工作流名称',
  'workflows.error': '保存失败：{message}',
  'saveWorkflow.action': '存为工作流',
  'avatar.namePlaceholder': '用户',
} satisfies Record<string, string>

/** The serverSidebar namespace key union. */
export type ServerSidebarKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'workbench.label': 'Workbench',
  'nav.title': 'Navigation',
  'nav.empty': 'No pages configured',
  'workflows.title': 'My Workflows',
  'workflows.empty': 'No workflows yet',
  'workflows.rename': 'Rename',
  'workflows.remove': 'Remove',
  'workflows.namePlaceholder': 'Workflow name',
  'workflows.error': 'Failed to save: {message}',
  'saveWorkflow.action': 'Save as workflow',
  'avatar.namePlaceholder': 'User',
} satisfies Record<ServerSidebarKey, string>
