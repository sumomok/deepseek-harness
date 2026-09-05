/**
 * `nextOrder`/`sortedWorkflows`/`isCleanWorkbenchDraft`/`hasShownHome`
 * (pure array/predicate helpers), the group transforms and
 * derived menu views (`createGroup` through `collapsedRows`), and
 * `openWorkbenchOnLoad`/`openWorkbenchOnClick`/`openWorkflow`/
 * `dismissTemporarySession` (session-orchestration, decisions ①/⑥/⑧).
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import {
  collapsedRows, createGroup, deleteGroup, dismissTemporarySession, hasShownHome, isCleanWorkbenchDraft, moveWorkflow,
  nextOrder, openTemporarySession, openWorkbenchOnClick, openWorkbenchOnLoad, openWorkflow,
  otherGroups, pinGroup, pinnedGroups, renameGroup,
  reorderWithinGroup, sortedWorkflows, temporarySessions, TEMPORARY_VISIBLE_LIMIT,
  ungroupedWorkflows, workflowsInGroup,
  type ContentSurfaceEntryLike, type TemporaryGroupScope, type TemporarySessionFacts,
} from '../src/client/workflow-actions.ts'
import type { ServerMenuGroup, ServerMenuWorkflow } from '../src/client/workflow-api.ts'

function workflow(overrides: Partial<ServerMenuWorkflow>): ServerMenuWorkflow {
  return { id: 'w1', name: 'A', order: 0, homeSessionId: 's1', navSnapshot: [], savedAt: 1, ...overrides }
}

function group(overrides: Partial<ServerMenuGroup>): ServerMenuGroup {
  return { id: 'g1', name: 'A', pinned: false, order: 0, ...overrides }
}

describe('nextOrder', () => {
  it('answers 0 for an empty list', () => {
    expect(nextOrder([])).toBe(0)
  })

  it('answers one past the current highest order', () => {
    expect(nextOrder([workflow({ order: 4 }), workflow({ id: 'w2', order: 1 })])).toBe(5)
  })
})

describe('sortedWorkflows', () => {
  it('sorts by order ascending', () => {
    const workflows = [workflow({ id: 'w2', order: 1 }), workflow({ id: 'w1', order: 0 })]
    expect(sortedWorkflows(workflows).map(w => w.id)).toEqual(['w1', 'w2'])
  })

  it('breaks a tied order on id, comparing every pair both ways', () => {
    const workflows = [
      workflow({ id: 'zeta', order: 0 }),
      workflow({ id: 'mike', order: 0 }),
      workflow({ id: 'delta', order: 0 }),
      workflow({ id: 'bravo', order: 0 }),
      workflow({ id: 'alpha', order: 0 }),
    ]
    expect(sortedWorkflows(workflows).map(w => w.id)).toEqual(['alpha', 'bravo', 'delta', 'mike', 'zeta'])
  })

  it('leaves an already-ordered tied pair as-is', () => {
    const workflows = [workflow({ id: 'alpha', order: 0 }), workflow({ id: 'bravo', order: 0 })]
    expect(sortedWorkflows(workflows).map(w => w.id)).toEqual(['alpha', 'bravo'])
  })

  it('does not mutate the input array', () => {
    const workflows = [workflow({ id: 'w2', order: 1 }), workflow({ id: 'w1', order: 0 })]
    const copy = [...workflows]
    sortedWorkflows(workflows)
    expect(workflows).toEqual(copy)
  })
})

function pageEntry(entryId: string): ContentSurfaceEntryLike {
  return { kind: 'page', entryId }
}

function componentEntry(entryId: string): ContentSurfaceEntryLike {
  return { kind: 'component', entryId }
}

const HOME_PAGE = { kind: 'page', entryId: 'home' } as const
const HOME_VIEW = { kind: 'view', entryId: 'sales' } as const

describe('isCleanWorkbenchDraft', () => {
  it('is clean when blank with no entries at all, a home configured or not', () => {
    expect(isCleanWorkbenchDraft(true, [], undefined)).toBe(true)
    expect(isCleanWorkbenchDraft(true, [], HOME_PAGE)).toBe(true)
  })

  it('is clean when blank and the only entry is the configured home page', () => {
    expect(isCleanWorkbenchDraft(true, [pageEntry('home')], HOME_PAGE)).toBe(true)
  })

  it('is clean when blank and the only entry is the configured home view', () => {
    expect(isCleanWorkbenchDraft(true, [componentEntry('sales')], HOME_VIEW)).toBe(true)
  })

  it('is not clean when a turn has run, regardless of entries', () => {
    expect(isCleanWorkbenchDraft(false, [], undefined)).toBe(false)
    expect(isCleanWorkbenchDraft(false, [pageEntry('home')], HOME_PAGE)).toBe(false)
  })

  it('is not clean when the one entry names something other than the configured home', () => {
    expect(isCleanWorkbenchDraft(true, [pageEntry('reports')], HOME_PAGE)).toBe(false)
  })

  it('is not clean when an entry matches the home id but not the kind it lands as', () => {
    expect(isCleanWorkbenchDraft(true, [{ kind: 'chart', entryId: 'home' }], HOME_PAGE)).toBe(false)
    expect(isCleanWorkbenchDraft(true, [pageEntry('sales')], HOME_VIEW)).toBe(false)
  })

  it('is not clean when no home is configured but an entry exists anyway', () => {
    expect(isCleanWorkbenchDraft(true, [pageEntry('home')], undefined)).toBe(false)
  })

  it('is not clean when a second, non-home entry accompanies the home entry', () => {
    expect(isCleanWorkbenchDraft(true, [pageEntry('home'), pageEntry('reports')], HOME_PAGE)).toBe(false)
  })

  it('is not clean when entries are of an unrecognized shape', () => {
    expect(isCleanWorkbenchDraft(true, [{}], HOME_PAGE)).toBe(false)
  })
})

describe('createGroup', () => {
  it('appends an unpinned group after every existing one, trimming the typed name', () => {
    const groups = [group({ order: 0 }), group({ id: 'g2', order: 3 })]
    expect(createGroup(groups, 'g3', '  每日  ')).toEqual([
      ...groups, { id: 'g3', name: '每日', pinned: false, order: 4 },
    ])
  })

  it('orders the first group at zero', () => {
    expect(createGroup([], 'g1', 'A')).toEqual([{ id: 'g1', name: 'A', pinned: false, order: 0 }])
  })
})

describe('renameGroup', () => {
  it('renames the named group and trims the typed name, leaving the rest alone', () => {
    const groups = [group({}), group({ id: 'g2', name: 'B' })]
    expect(renameGroup(groups, 'g1', ' 每日 ')).toEqual([group({ name: '每日' }), group({ id: 'g2', name: 'B' })])
  })

  it('answers an unchanged copy when the id names no group', () => {
    const groups = [group({})]
    expect(renameGroup(groups, 'gone', 'B')).toEqual(groups)
  })
})

describe('pinGroup', () => {
  it('pins and unpins the named group only', () => {
    const groups = [group({}), group({ id: 'g2' })]
    expect(pinGroup(groups, 'g1', true)).toEqual([group({ pinned: true }), group({ id: 'g2' })])
    expect(pinGroup(pinGroup(groups, 'g1', true), 'g1', false)).toEqual(groups)
  })

  it('answers an unchanged copy when the id names no group', () => {
    const groups = [group({})]
    expect(pinGroup(groups, 'gone', true)).toEqual(groups)
  })
})

describe('deleteGroup', () => {
  it('drops the group and returns its members to the ungrouped list in one patch', () => {
    const next = deleteGroup(
      [group({}), group({ id: 'g2' })],
      [workflow({ groupId: 'g1' }), workflow({ id: 'w2', groupId: 'g2' }), workflow({ id: 'w3' })],
      'g1',
    )
    expect(next.groups).toEqual([group({ id: 'g2' })])
    expect(next.workflows).toEqual([workflow({}), workflow({ id: 'w2', groupId: 'g2' }), workflow({ id: 'w3' })])
    expect(Object.hasOwn(next.workflows[0]!, 'groupId')).toBe(false)
  })

  it('keeps every workflow when the id names no group', () => {
    const workflows = [workflow({ groupId: 'g1' })]
    expect(deleteGroup([group({})], workflows, 'gone')).toEqual({ groups: [group({})], workflows })
  })
})

describe('moveWorkflow', () => {
  it('files a workflow under a group, landing it after that group\'s current members', () => {
    const workflows = [
      workflow({ id: 'a', groupId: 'g1', order: 0 }),
      workflow({ id: 'b', groupId: 'g1', order: 4 }),
      workflow({ id: 'c', order: 9 }),
    ]
    const next = moveWorkflow(workflows, 'c', 'g1')
    expect(next[2]).toEqual(workflow({ id: 'c', groupId: 'g1', order: 5 }))
    expect(next.slice(0, 2)).toEqual(workflows.slice(0, 2))
  })

  it('takes a workflow out of every group, dropping the field rather than storing an empty one', () => {
    const next = moveWorkflow([workflow({ id: 'a', order: 3 }), workflow({ id: 'b', groupId: 'g1' })], 'b', undefined)
    expect(next[1]).toEqual(workflow({ id: 'b', order: 4 }))
    expect(Object.hasOwn(next[1]!, 'groupId')).toBe(false)
  })

  it('answers an unchanged copy when the id names no workflow', () => {
    const workflows = [workflow({})]
    expect(moveWorkflow(workflows, 'gone', 'g1')).toEqual(workflows)
  })
})

describe('reorderWithinGroup', () => {
  it('rewrites the named workflows to their position in the sequence', () => {
    const workflows = [
      workflow({ id: 'a', groupId: 'g1', order: 0 }),
      workflow({ id: 'b', groupId: 'g1', order: 1 }),
      workflow({ id: 'c', groupId: 'g1', order: 2 }),
    ]
    expect(workflowsInGroup(reorderWithinGroup(workflows, 'g1', ['c', 'b', 'a']), 'g1').map(w => w.id))
      .toEqual(['c', 'b', 'a'])
  })

  it('files a row dragged in from elsewhere into the destination by the same call', () => {
    const workflows = [workflow({ id: 'a', groupId: 'g1', order: 0 }), workflow({ id: 'b', order: 7 })]
    const next = reorderWithinGroup(workflows, 'g1', ['b', 'a'])
    expect(next).toEqual([
      workflow({ id: 'a', groupId: 'g1', order: 1 }), workflow({ id: 'b', groupId: 'g1', order: 0 }),
    ])
  })

  it('takes rows out of every group when the section is the ungrouped one', () => {
    const next = reorderWithinGroup([workflow({ id: 'a', groupId: 'g1', order: 3 })], undefined, ['a'])
    expect(next).toEqual([workflow({ id: 'a', order: 0 })])
    expect(Object.hasOwn(next[0]!, 'groupId')).toBe(false)
  })

  it('leaves a workflow no id names exactly where it was, and ignores an id naming none', () => {
    const workflows = [workflow({ id: 'a', groupId: 'g1', order: 4 }), workflow({ id: 'b', order: 1 })]
    expect(reorderWithinGroup(workflows, undefined, ['gone', 'b'])).toEqual([
      workflow({ id: 'a', groupId: 'g1', order: 4 }), workflow({ id: 'b', order: 0 }),
    ])
  })
})

describe('the group views the menu renders', () => {
  const groups = [
    group({ id: 'b', pinned: true, order: 1 }),
    group({ id: 'a', pinned: true, order: 0 }),
    group({ id: 'd', order: 1 }),
    group({ id: 'c', order: 0 }),
  ]

  it('puts pinned groups first, each section in its own dragged order', () => {
    expect(pinnedGroups(groups).map(g => g.id)).toEqual(['a', 'b'])
    expect(otherGroups(groups).map(g => g.id)).toEqual(['c', 'd'])
  })

  it('breaks a tied order on id so the render is stable, comparing a pair both ways', () => {
    expect(otherGroups([group({ id: 'zeta' }), group({ id: 'alpha' })]).map(g => g.id)).toEqual(['alpha', 'zeta'])
    expect(otherGroups([group({ id: 'alpha' }), group({ id: 'zeta' })]).map(g => g.id)).toEqual(['alpha', 'zeta'])
  })

  it('does not mutate the group list', () => {
    const copy = [...groups]
    pinnedGroups(groups)
    otherGroups(groups)
    expect(groups).toEqual(copy)
  })

  it('collects one group\'s members in display order', () => {
    const workflows = [
      workflow({ id: 'b', groupId: 'g1', order: 1 }),
      workflow({ id: 'a', groupId: 'g1', order: 0 }),
      workflow({ id: 'c', groupId: 'g2', order: 0 }),
      workflow({ id: 'd' }),
    ]
    expect(workflowsInGroup(workflows, 'g1').map(w => w.id)).toEqual(['a', 'b'])
  })

  it('shows every workflow exactly once across the group views and the ungrouped remainder', () => {
    const workflows = [
      workflow({ id: 'a', groupId: 'g1' }),
      workflow({ id: 'b' }),
      // A `groupId` the document's own constraint refuses, which only an
      // outside edit can produce: it stays reachable rather than vanishing.
      workflow({ id: 'c', groupId: 'gone' }),
    ]
    const stored = [group({ id: 'g1' })]
    const shown = [
      ...pinnedGroups(stored).flatMap(g => workflowsInGroup(workflows, g.id)),
      ...otherGroups(stored).flatMap(g => workflowsInGroup(workflows, g.id)),
      ...ungroupedWorkflows(workflows, stored),
    ]
    expect(shown.map(w => w.id).sort()).toEqual(['a', 'b', 'c'])
  })

  it('orders the ungrouped remainder by the same key as a group\'s members', () => {
    const workflows = [workflow({ id: 'b', order: 1 }), workflow({ id: 'a', order: 0 })]
    expect(ungroupedWorkflows(workflows, []).map(w => w.id)).toEqual(['a', 'b'])
  })
})

describe('temporarySessions', () => {
  const scope: TemporaryGroupScope = {
    boundHomeSessionIds: new Set(),
    workbenchSessionId: undefined,
    currentSessionId: undefined,
    archivedSessionIds: new Set(),
  }

  function session(overrides: Partial<TemporarySessionFacts> & { id: string }): TemporarySessionFacts {
    return { blank: false, updatedAt: 0, ...overrides }
  }

  it('keeps the conversations no other row in this shell shows', () => {
    const sessions = [session({ id: 's1', updatedAt: 1 }), session({ id: 's2', updatedAt: 2 })]
    expect(temporarySessions(sessions, scope).map(s => s.id)).toEqual(['s2', 's1'])
  })

  it('breaks a tied update time on id', () => {
    const sessions = [session({ id: 'zeta' }), session({ id: 'alpha' })]
    expect(temporarySessions(sessions, scope).map(s => s.id)).toEqual(['alpha', 'zeta'])
  })

  it('leaves out the workbench conversation, which has its own entry', () => {
    const sessions = [session({ id: 's1' }), session({ id: 'home-1' })]
    expect(temporarySessions(sessions, { ...scope, workbenchSessionId: 'home-1' }).map(s => s.id)).toEqual(['s1'])
  })

  it('leaves out a conversation a workflow already binds', () => {
    const sessions = [session({ id: 's1' }), session({ id: 's2' })]
    const bound = { ...scope, boundHomeSessionIds: new Set(['s2']) }
    expect(temporarySessions(sessions, bound).map(s => s.id)).toEqual(['s1'])
  })

  it('leaves out subagent children, which their parent lists', () => {
    const sessions = [session({ id: 's1' }), session({ id: 's2', origin: 'subagent' })]
    expect(temporarySessions(sessions, scope).map(s => s.id)).toEqual(['s1'])
  })

  it('leaves out a conversation taken out of the list', () => {
    const sessions = [session({ id: 's1' }), session({ id: 's2' })]
    const archived = { ...scope, archivedSessionIds: new Set(['s1']) }
    expect(temporarySessions(sessions, archived).map(s => s.id)).toEqual(['s2'])
  })

  it('keeps only the selected empty draft, so a visit to the workbench leaves no row behind', () => {
    const sessions = [
      session({ id: 's1', blank: true }), session({ id: 's2', blank: true }), session({ id: 's3' }),
    ]
    expect(temporarySessions(sessions, { ...scope, currentSessionId: 's2' }).map(s => s.id)).toEqual(['s2', 's3'])
    expect(temporarySessions(sessions, scope).map(s => s.id)).toEqual(['s3'])
  })

  it('does not mutate the session list it reads', () => {
    const sessions = [session({ id: 's1', updatedAt: 1 }), session({ id: 's2', updatedAt: 2 })]
    const copy = [...sessions]
    temporarySessions(sessions, scope)
    expect(sessions).toEqual(copy)
  })
})

describe('collapsedRows', () => {
  const rows = Array.from({ length: 7 }, (_unused, index) => `row-${String(index)}`)

  it('shows the first few rows and counts the rest', () => {
    expect(collapsedRows(rows, false)).toEqual({ visible: rows.slice(0, TEMPORARY_VISIBLE_LIMIT), hiddenCount: 2 })
  })

  it('shows every row once expanded, with nothing left over', () => {
    expect(collapsedRows(rows, true)).toEqual({ visible: rows, hiddenCount: 0 })
  })

  it('hides nothing at or under the limit', () => {
    expect(collapsedRows(rows.slice(0, TEMPORARY_VISIBLE_LIMIT), false))
      .toEqual({ visible: rows.slice(0, TEMPORARY_VISIBLE_LIMIT), hiddenCount: 0 })
    expect(collapsedRows([], false)).toEqual({ visible: [], hiddenCount: 0 })
  })

  it('does not mutate the row list', () => {
    const copy = [...rows]
    collapsedRows(rows, true)
    collapsedRows(rows, false)
    expect(rows).toEqual(copy)
  })
})

describe('hasShownHome', () => {
  it('is false with no home configured, regardless of entries', () => {
    expect(hasShownHome([pageEntry('home')], undefined)).toBe(false)
    expect(hasShownHome([], undefined)).toBe(false)
  })

  it('is true when one entry is the configured home, in either vocabulary', () => {
    expect(hasShownHome([pageEntry('home')], HOME_PAGE)).toBe(true)
    expect(hasShownHome([componentEntry('sales')], HOME_VIEW)).toBe(true)
  })

  it('is false when entries carry something else, or nothing at all', () => {
    expect(hasShownHome([pageEntry('reports')], HOME_PAGE)).toBe(false)
    expect(hasShownHome([], HOME_PAGE)).toBe(false)
  })

  it('is false when an entry matches the home id but not the kind it lands as', () => {
    expect(hasShownHome([{ kind: 'chart', entryId: 'home' }], HOME_PAGE)).toBe(false)
  })
})

/**
 * Build a fake context, plus the raw `sessions.open` spy on the side: reading
 * it back off `ctx` for an assertion would type it as `ClientContext`'s
 * declared method (an unbound-method lint violation), not as the `vi.fn()`
 * it actually is.
 */
function fakeContext(overrides: {
  recentWorkspaceId?: string
  connectWorkspace?: () => Promise<string>
  execute?: () => Promise<unknown>
}): { ctx: ClientContext; open: ReturnType<typeof vi.fn> } {
  const open = vi.fn()
  const ctx = {
    sessions: {
      list: { getSnapshot: () => ({ current: undefined, phase: 'ready', ids: [], byId: {} }) },
      open,
    },
    uiWorkspace: {
      connectWorkspace: overrides.connectWorkspace ?? (() => Promise.resolve('new-session')),
    },
    workspaces: {
      list: {
        getSnapshot: () => ({
          phase: 'ready',
          archivedSessionIds: [],
          items: overrides.recentWorkspaceId === undefined
            ? []
            : [{ workspaceId: overrides.recentWorkspaceId, path: '/workspace', sessionIds: [], createdAt: '2026-01-01T00:00:00.000Z' }],
        }),
      },
    },
    remote: {
      commands: { execute: overrides.execute ?? (() => Promise.resolve({ ok: true, value: undefined })) },
    },
  } as unknown as ClientContext
  return { ctx, open }
}

describe('openWorkbenchOnLoad', () => {
  it('reopens the recorded session whenever it is live, regardless of content', async () => {
    const { ctx, open } = fakeContext({})
    const outcome = await openWorkbenchOnLoad(ctx, 'home-1', true)
    expect(outcome).toEqual({ sessionId: 'home-1', created: false })
    expect(open).toHaveBeenCalledWith('home-1')
  })

  it('creates a fresh session, ignoring any current session, when there is no recorded id', async () => {
    const { ctx } = fakeContext({ recentWorkspaceId: 'workspace-1' })
    const outcome = await openWorkbenchOnLoad(ctx, undefined, false)
    expect(outcome).toEqual({ sessionId: 'new-session', created: true })
  })

  it('creates a fresh session when the recorded id is no longer live', async () => {
    const { ctx } = fakeContext({ recentWorkspaceId: 'workspace-1' })
    const outcome = await openWorkbenchOnLoad(ctx, 'gone', false)
    expect(outcome).toEqual({ sessionId: 'new-session', created: true })
  })

  it('answers undefined with nowhere to create a session', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ctx } = fakeContext({})
    expect(await openWorkbenchOnLoad(ctx, undefined, false)).toBeUndefined()
    warn.mockRestore()
  })
})

describe('openWorkbenchOnClick', () => {
  it('reopens the recorded session when it is live and still clean', async () => {
    const { ctx, open } = fakeContext({})
    const outcome = await openWorkbenchOnClick(ctx, 'home-1', true, true)
    expect(outcome).toEqual({ sessionId: 'home-1', created: false })
    expect(open).toHaveBeenCalledWith('home-1')
  })

  it('creates a fresh session when the recorded one is live but no longer clean', async () => {
    const { ctx, open } = fakeContext({ recentWorkspaceId: 'workspace-1' })
    const outcome = await openWorkbenchOnClick(ctx, 'home-1', true, false)
    expect(outcome).toEqual({ sessionId: 'new-session', created: true })
    // The fresh session, not the recorded (no-longer-clean) one, is what gets opened.
    expect(open).toHaveBeenCalledWith('new-session')
  })

  it('creates a fresh session when the recorded id is no longer live, ignoring isClean', async () => {
    const { ctx } = fakeContext({ recentWorkspaceId: 'workspace-1' })
    const outcome = await openWorkbenchOnClick(ctx, 'gone', false, true)
    expect(outcome).toEqual({ sessionId: 'new-session', created: true })
  })

  it('creates a fresh session, ignoring any current session, when there is no recorded id', async () => {
    const { ctx } = fakeContext({ recentWorkspaceId: 'workspace-1' })
    const outcome = await openWorkbenchOnClick(ctx, undefined, false, false)
    expect(outcome).toEqual({ sessionId: 'new-session', created: true })
  })

  it('answers undefined with nowhere to create a session', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ctx } = fakeContext({})
    expect(await openWorkbenchOnClick(ctx, undefined, false, false)).toBeUndefined()
    warn.mockRestore()
  })
})

describe('openWorkflow', () => {
  it('opens the bound session directly when live, without replaying anything', async () => {
    const execute = vi.fn()
    const { ctx, open } = fakeContext({ execute })
    const outcome = await openWorkflow(ctx, workflow({ homeSessionId: 's1' }), true)
    expect(outcome).toEqual({ sessionId: 's1', created: false })
    expect(open).toHaveBeenCalledWith('s1')
    expect(execute).not.toHaveBeenCalled()
  })

  it('degrades to a fresh session and replays the navigation snapshot when the bound session is gone', async () => {
    const execute = vi.fn(() => Promise.resolve({ ok: true, value: undefined }))
    const { ctx } = fakeContext({ recentWorkspaceId: 'workspace-1', execute })
    const navSnapshot = [{ kind: 'page', entryId: 'home' }, { kind: 'view', entryId: 'sales' }] as const
    const outcome = await openWorkflow(ctx, workflow({ navSnapshot: [...navSnapshot] }), false)
    expect(outcome).toEqual({ sessionId: 'new-session', created: true })
    expect(execute).toHaveBeenNthCalledWith(1, 'new-session', '/show-content-page home', [])
    expect(execute).toHaveBeenNthCalledWith(2, 'new-session', '/show-content-view sales', [])
  })

  it('answers undefined with nowhere to create a session on degrade', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ctx } = fakeContext({})
    expect(await openWorkflow(ctx, workflow({}), false)).toBeUndefined()
    warn.mockRestore()
  })
})

describe('openTemporarySession', () => {
  it('selects the conversation, with no liveness judgment to make', async () => {
    const open = vi.fn()
    const ctx = { sessions: { open } } as unknown as ClientContext
    await openTemporarySession(ctx, 's1')
    expect(open).toHaveBeenCalledWith('s1')
  })
})

describe('dismissTemporarySession', () => {
  it('archives the conversation, which keeps its log and takes only the row away', async () => {
    const archiveSession = vi.fn(() => Promise.resolve())
    const ctx = { workspaces: { archiveSession } } as unknown as ClientContext
    await dismissTemporarySession(ctx, 's1')
    expect(archiveSession).toHaveBeenCalledWith('s1')
  })

  it('lets the archive failure through for the caller to report', async () => {
    const ctx = {
      workspaces: { archiveSession: () => Promise.reject(new Error('session archive failed: rpc: down')) },
    } as unknown as ClientContext
    await expect(dismissTemporarySession(ctx, 's1')).rejects.toThrow('session archive failed: rpc: down')
  })
})
