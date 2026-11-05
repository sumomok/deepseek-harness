/** Panel state shared by the plugin body and its presentation component. */
import type {
  SessionMessageSearchValue, SessionSearchIndexProgress,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Index preparation the Host reports while a read is outstanding. */
export type SearchIndexProgress = SessionSearchIndexProgress

/** Continuation handle the Host minted for the next page. */
export type SearchCursor = NonNullable<SessionMessageSearchValue['nextCursor']>

/** One matched span inside a result excerpt, in UTF-16 code units. */
export interface SearchMatch {
  /** Offset of the first matched code unit. */
  start: number
  /** Length of the match in code units. */
  length: number
}

/** One addressable search result. */
export interface SearchResultRow {
  /** Session that owns the matching event. */
  sessionId: SessionId
  /** Event position inside that Session. */
  seq: number
  /** Session title resolved from the list snapshot, or undefined when absent. */
  title: string | undefined
  /** Host excerpt around the match. */
  snippet: string
  /** Matched spans inside `snippet`. */
  matches: readonly SearchMatch[]
}

/** Where one search sequence is. */
export type SearchPhase = 'idle' | 'loading' | 'ready' | 'loadingMore' | 'error'

/** Everything the panel renders. */
export interface SearchPanelState {
  /** Whether the overlay is mounted. */
  open: boolean
  /** Current input value. */
  query: string
  /** Rows from every page read so far. */
  rows: readonly SearchResultRow[]
  /** Index of the keyboard selection, or -1 when none. */
  active: number
  /** Sequence status. */
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
