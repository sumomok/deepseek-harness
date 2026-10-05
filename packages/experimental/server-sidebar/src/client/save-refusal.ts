/**
 * The fixed copy 我的工作流 shows for a save of the menu that failed. The
 * server's refusal names fields such as `workbenchSessionId`, so the section
 * never shows it: the caller sends it to the browser console, and the section
 * says, in this package's dictionary, which of four things happened.
 * @module @deepseek-ai/dsh-experimental-server-sidebar/client/save-refusal
 */
import type { ServerSidebarTranslate } from './locales.ts'
import { ServerMenuRefusedError, ServerMenuUnplacedError, type ServerMenuPatch } from './workflow-api.ts'

/** The field path of a workflow's conversation in a sent workflow list, by the workflow's index. */
const WORKFLOW_FIELD = /^workflows\[(\d+)\]\.homeSessionId$/u

/** A menu entry one field path of a refusal names. */
interface NamedEntry {
  /** What the section calls it: the workflow's sent name, or the workbench's label. */
  readonly name: string
  /** Whether it is the workbench, which sits in no list a member removes it from. */
  readonly workbench: boolean
}

/**
 * The menu entry one field path of a sent patch names.
 * @param path - a field path a refusal lists.
 * @param sent - the patch the refused save sent.
 * @param t - this package's dictionary lookup.
 * @returns the workflow at that index of the sent list, by its name, or the
 * workbench, by its label, for `workbenchSessionId`; undefined for any other
 * path and for an index the sent list does not reach.
 */
function namedEntry(path: string, sent: ServerMenuPatch, t: ServerSidebarTranslate): NamedEntry | undefined {
  if (path === 'workbenchSessionId') return { name: t('workbench.label'), workbench: true }
  const index = WORKFLOW_FIELD.exec(path)?.[1]
  const name = index === undefined ? undefined : sent.workflows?.[Number(index)]?.name
  return name === undefined ? undefined : { name, workbench: false }
}

/**
 * The fixed copy for a save of the menu that failed, framed by
 * `workflows.error` where the section shows it.
 * @param error - what `saveServerMenu` threw.
 * @param sent - the patch the save sent; a refusal's field paths index into it.
 * @param t - this package's dictionary lookup.
 * @returns `workflows.retry` for a save that reached no member's menu (401 or
 * 503); for a 400 that lists the fields naming someone else's conversations,
 * each entry it can name quoted by `workflows.foreignItem` and joined by
 * `workflows.foreignSeparator`, leaving out a path it cannot name, in
 * `workflows.foreignWorkbench` when the workbench is among them and in
 * `workflows.foreign` otherwise, each in its `one` form for a single entry and
 * its `other` form for more; `workflows.refused` for any other 4xx, and for
 * such a 400 whose paths it can name none of; and `workflows.later` for a 5xx,
 * a status below 400, a request that never reached the route, and a 2xx
 * answer with no usable document.
 */
export function saveRefusalCopy(error: unknown, sent: ServerMenuPatch, t: ServerSidebarTranslate): string {
  if (error instanceof ServerMenuUnplacedError) return t('workflows.retry')
  if (!(error instanceof ServerMenuRefusedError) || error.status < 400 || error.status >= 500) return t('workflows.later')
  const paths = error.status === 400 ? error.fields ?? [] : []
  const entries = paths.map(path => namedEntry(path, sent, t)).filter(entry => entry !== undefined)
  if (entries.length === 0) return t('workflows.refused')
  const items = entries.map(({ name }) => t('workflows.foreignItem', { name })).join(t('workflows.foreignSeparator'))
  const count = entries.length === 1 ? 'one' : 'other'
  return t(entries.some(entry => entry.workbench) ? `workflows.foreignWorkbench.${count}` : `workflows.foreign.${count}`, { items })
}
