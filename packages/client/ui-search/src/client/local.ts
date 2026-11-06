/**
 * Local name matches the panel derives without the Host index: Workspaces whose
 * display title contains the query, then Sessions whose title does, newest
 * first. Message hits stay a Host concern.
 *
 * @module @deepseek-ai/dsh-client-ui-search/local
 */
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { workspaceDisplayTitle } from '@deepseek-ai/dsh-api-workspace-controller/default-workspace'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SearchMatch, SearchRow, SearchSessionRow } from './state.ts'

/**
 * Every occurrence of `needle` in `text`, compared case-insensitively. A blank
 * needle matches nothing: the caller's blank-query branch decides what an empty
 * field shows, and an empty search term would otherwise match everywhere.
 * @param text - string to search, in its displayed spelling.
 * @param needle - query text; surrounding whitespace is the caller's concern.
 * @returns matched spans in `text`, in ascending offset order.
 */
export function matchSpans(text: string, needle: string): SearchMatch[] {
  const spans: SearchMatch[] = []
  const wanted = needle.toLowerCase()
  if (wanted === '') return spans
  const haystack = text.toLowerCase()
  let from = 0
  for (;;) {
    const start = haystack.indexOf(wanted, from)
    if (start < 0) return spans
    spans.push({ start, length: wanted.length })
    from = start + wanted.length
  }
}

/**
 * Match Workspaces by display title and Sessions by durable title.
 * @param list - Session catalog snapshot.
 * @param workspaces - Workspace projection with membership and display titles.
 * @param query - trimmed query text; case is ignored.
 * @param archived - Session ids the sidebar hides from lists.
 * @param defaultWorkspaceName - active-language label for the automatic Workspace.
 * @returns Workspace rows in Host order, then matching Sessions newest first.
 */
export function localMatches(
  list: SessionListState,
  workspaces: WorkspaceSnapshot,
  query: string,
  archived: ReadonlySet<SessionId>,
  defaultWorkspaceName: string,
): SearchRow[] {
  const workspacesRows: SearchRow[] = []
  const workspaceOf = new Map<SessionId, string>()
  for (const workspace of workspaces.items) {
    const title = workspaceDisplayTitle(workspace.title, defaultWorkspaceName)
    for (const sessionId of workspace.sessionIds) workspaceOf.set(sessionId, title)
    const spans = matchSpans(title, query)
    if (spans.length > 0) {
      workspacesRows.push({ kind: 'workspace', workspaceId: workspace.workspaceId, title, matches: spans })
    }
  }
  const sessions: { row: SearchSessionRow; updatedAt: number }[] = []
  for (const sessionId of list.ids) {
    const summary = list.byId[sessionId]
    /* v8 ignore next -- the Session list contract pairs every id with a byId row. */
    if (summary === undefined) continue
    // Subagent Sessions and blank placeholders stay out of the Workspace browser,
    // so a local name match never surfaces one the sidebar does not list.
    if (summary.blank || summary.origin === 'subagent' || archived.has(sessionId)) continue
    const title = summary.title?.trim() ?? ''
    if (title === '') continue
    const spans = matchSpans(title, query)
    if (spans.length === 0) continue
    sessions.push({
      row: { kind: 'session', sessionId, title, workspace: workspaceOf.get(sessionId) ?? '', matches: spans },
      updatedAt: summary.updatedAt,
    })
  }
  sessions.sort((left, right) => right.updatedAt - left.updatedAt)
  for (const session of sessions) workspacesRows.push(session.row)
  return workspacesRows
}
