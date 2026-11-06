/** Panel state shared by the plugin body and its presentation component. */
import type {
  SessionMessageSearchValue, SessionSearchIndexProgress,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Index preparation the Host reports while a read is outstanding. */
export type SearchIndexProgress = SessionSearchIndexProgress

/** Continuation handle the Host minted for the next page. */
export type SearchCursor = NonNullable<SessionMessageSearchValue['nextCursor']>

/** One matched span inside a rendered string, in UTF-16 code units. */
export interface SearchMatch {
  /** Offset of the first matched code unit. */
  start: number
  /** Length of the match in code units. */
  length: number
}

/** One Workspace whose name matches, listed under the Workspace section. */
export interface SearchWorkspaceRow {
  /** Which list the row belongs to; opening it connects the Workspace. */
  readonly kind: 'workspace'
  /** Workspace to open. */
  readonly workspaceId: WorkspaceId
  /** Display title the query matched. */
  readonly title: string
  /** Matched spans inside `title`. */
  readonly matches: readonly SearchMatch[]
}

/** One Session whose title matches, listed under the Session section. */
export interface SearchSessionRow {
  /** Which list the row belongs to; opening it selects the Session. */
  readonly kind: 'session'
  /** Session to open. */
  readonly sessionId: SessionId
  /** Session title the query matched. */
  readonly title: string
  /** Display title of the owning Workspace, or an empty string when ungrouped. */
  readonly workspace: string
  /** Matched spans inside `title`. */
  readonly matches: readonly SearchMatch[]
}

/** One Host message hit, listed under the Message section. */
export interface SearchMessageRow {
  /** Which list the row belongs to; opening it reveals the message. */
  readonly kind: 'message'
  /** Session that owns the matching event. */
  readonly sessionId: SessionId
  /** Event position inside that Session. */
  readonly seq: number
  /** Session title resolved from the list snapshot, or undefined when absent. */
  readonly title: string | undefined
  /** Host excerpt around the match. */
  readonly snippet: string
  /** Matched spans inside `snippet`. */
  readonly matches: readonly SearchMatch[]
}

/** One addressable result in any of the panel's three sections. */
export type SearchRow = SearchWorkspaceRow | SearchSessionRow | SearchMessageRow

/** Where one search sequence is. */
export type SearchPhase = 'idle' | 'loading' | 'ready' | 'loadingMore' | 'error'

/** Everything the panel renders. */
export interface SearchPanelState {
  /** Whether the overlay is mounted. */
  open: boolean
  /** Current input value. */
  query: string
  /** Matching Workspaces, then Sessions, then message hits from every page read so far. */
  rows: readonly SearchRow[]
  /** Index of the keyboard selection, or -1 when none. */
  active: number
  /** Sequence status of the Host message read. */
  phase: SearchPhase
  /** Cursor for the next page, absent when the Host finished. */
  nextCursor: SearchCursor | undefined
  /** Whether every observed Session was readable. */
  coverage: SessionMessageSearchValue['coverage']
}

/** The empty panel state a fresh sequence starts from. */
export const IDLE_STATE: SearchPanelState = {
  open: false,
  query: '',
  rows: [],
  active: -1,
  phase: 'idle',
  nextCursor: undefined,
  coverage: undefined,
}
