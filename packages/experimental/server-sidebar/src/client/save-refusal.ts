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

/**
 * What the section calls the menu entry one field path of a sent patch names.
 * @param path - a field path a refusal lists.
 * @param sent - the patch the refused save sent.
 * @param t - this package's dictionary lookup.
 * @returns the workflow's name at that index of the sent list, the workbench's
 * label for `workbenchSessionId`, or undefined for any other path and for an
 * index the sent list does not reach.
 */
function entryName(path: string, sent: ServerMenuPatch, t: ServerSidebarTranslate): string | undefined {
  if (path === 'workbenchSessionId') return t('workbench.label')
  const index = WORKFLOW_FIELD.exec(path)?.[1]
  return index === undefined ? undefined : sent.workflows?.[Number(index)]?.name
}

/**
 * The fixed copy for a save of the menu that failed, framed by
 * `workflows.error` where the section shows it.
 * @param error - what `saveServerMenu` threw.
 * @param sent - the patch the save sent; a refusal's field paths index into it.
 * @param t - this package's dictionary lookup.
 * @returns `workflows.retry` for a save that reached no member's menu (401 or
 * 503); `workflows.foreign` for a 400 that lists the fields naming someone
 * else's conversations, quoting each entry it can name and leaving out a path
 * it cannot; `workflows.refused` for any other 4xx, and for such a 400 whose
 * paths it can name none of; and `workflows.later` for any other status, a
 * request that never reached the route, and an answer with no usable document.
 */
export function saveRefusalCopy(error: unknown, sent: ServerMenuPatch, t: ServerSidebarTranslate): string {
  if (error instanceof ServerMenuUnplacedError) return t('workflows.retry')
  if (!(error instanceof ServerMenuRefusedError) || error.status < 400 || error.status >= 500) return t('workflows.later')
  const paths = error.status === 400 ? error.fields ?? [] : []
  const names = paths.map(path => entryName(path, sent, t))
    .filter(name => name !== undefined)
    .map(name => t('workflows.foreignItem', { name }))
  return names.length === 0
    ? t('workflows.refused')
    : t('workflows.foreign', { items: names.join(t('workflows.foreignSeparator')) })
}
