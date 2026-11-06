/**
 * Name matching the panel derives from the client catalogs: case-insensitive
 * substring spans, Workspace order, Session recency, and the visibility rules
 * the Workspace browser applies to the same rows.
 */
import { describe, expect, it } from 'vitest'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { localMatches, matchSpans } from '../src/client/local.ts'
import type { SearchSessionRow, SearchWorkspaceRow } from '../src/client/state.ts'

/** One Session summary a name query may match. */
function summary(over: { id: SessionId; updatedAt: number } & Partial<Omit<SessionSummary, 'id'>>): SessionSummary {
  return {
    id: over.id,
    ...(over.title === undefined ? {} : { title: over.title }),
    displayTitle: over.title ?? '',
    blank: over.blank ?? false,
    ...(over.origin === undefined ? {} : { origin: over.origin }),
    running: false,
    retainedBy: {},
    updatedAt: over.updatedAt,
  }
}

/** A Session list snapshot over the given rows, in Host order. */
function list(rows: readonly SessionSummary[]): SessionListState {
  return {
    ids: rows.map(row => row.id),
    byId: Object.fromEntries(rows.map(row => [row.id, row])),
    phase: 'ready',
    projectionsBySession: {},
  }
}

/** One Workspace row with the caller's membership. */
function workspace(workspaceId: string, title: string, sessionIds: readonly string[]): WorkspaceView {
  return {
    workspaceId: workspaceId as WorkspaceView['workspaceId'],
    path: `/work/${workspaceId}`,
    title,
    sessionIds: sessionIds as readonly SessionId[],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

/** A Workspace projection over the given rows. */
function snapshot(items: readonly WorkspaceView[]): WorkspaceSnapshot {
  return {
    items,
    archivedSessionIds: [],
    pinnedSessionIds: [],
    state: 'idle',
    phase: 'ready',
    error: null,
  }
}

describe('matchSpans', () => {
  it('finds every occurrence regardless of case', () => {
    expect(matchSpans('DeepSeek harness', 'deep')).toEqual([{ start: 0, length: 4 }])
    expect(matchSpans('aa-AA', 'aa')).toEqual([{ start: 0, length: 2 }, { start: 3, length: 2 }])
    expect(matchSpans('no hit here', 'zzz')).toEqual([])
  })

  it('matches nothing for a blank needle', () => {
    expect(matchSpans('anything', '')).toEqual([])
  })
})

describe('localMatches', () => {
  const sessions = list([
    summary({ id: SessionId('sess-old'), title: '检索旧记录', updatedAt: 5 }),
    summary({ id: SessionId('sess-new'), title: '检索新记录', updatedAt: 9 }),
    summary({ id: SessionId('sess-blank'), title: '检索空白', blank: true, updatedAt: 8 }),
    summary({ id: SessionId('sess-sub'), title: '检索子代理', origin: 'subagent', updatedAt: 7 }),
    summary({ id: SessionId('sess-archived'), title: '检索归档', updatedAt: 6 }),
    summary({ id: SessionId('sess-untitled'), updatedAt: 4 }),
    summary({ id: SessionId('sess-ungrouped'), title: '检索孤立', updatedAt: 1 }),
  ])
  const workspaces = snapshot([
    workspace('ws-search', '检索工作区', ['sess-old', 'sess-blank']),
    workspace('ws-default', 'default-workspace', ['sess-new']),
  ])
  const archived = new Set([SessionId('sess-archived')])

  it('lists matching Workspaces in Host order, then Sessions newest first', () => {
    const rows = localMatches(sessions, workspaces, '检索', archived, '默认工作区')
    expect(rows.map(row => row.kind)).toEqual(['workspace', 'session', 'session', 'session'])
    expect((rows[0] as SearchWorkspaceRow).title).toBe('检索工作区')
    expect(rows.slice(1).map(row => (row as SearchSessionRow).sessionId))
      .toEqual(['sess-new', 'sess-old', 'sess-ungrouped'])
  })

  it('labels each Session with its owning Workspace and hides unlisted rows', () => {
    const rows = localMatches(sessions, workspaces, '检索', archived, '默认工作区')
    const sessionsRows = rows.slice(1) as SearchSessionRow[]
    expect(sessionsRows.map(row => row.workspace)).toEqual(['默认工作区', '检索工作区', ''])
    expect(sessionsRows.map(row => row.title)).not.toContain('检索空白')
    expect(sessionsRows.map(row => row.title)).not.toContain('检索子代理')
    expect(sessionsRows.map(row => row.title)).not.toContain('检索归档')
  })

  it('matches the automatic Workspace by its localized name', () => {
    const rows = localMatches(sessions, workspaces, '默认', archived, '默认工作区')
    expect(rows).toHaveLength(1)
    const row = rows[0] as SearchWorkspaceRow
    expect(row.title).toBe('默认工作区')
    expect(row.matches).toEqual([{ start: 0, length: 2 }])
  })

  it('returns nothing when no name matches', () => {
    expect(localMatches(sessions, workspaces, 'zzz', archived, '默认工作区')).toEqual([])
  })
})
