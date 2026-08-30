/**
 * `nextOrder`/`sortedWorkflows`/`reordered` (pure array helpers) and
 * `openWorkbenchOnLoad`/`openWorkbenchOnClick`/`openWorkflow`
 * (session-orchestration, decisions ①/⑥/⑧).
 */
import { describe, expect, it, vi } from 'vitest'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import {
  nextOrder, openWorkbenchOnClick, openWorkbenchOnLoad, openWorkflow, reordered, sortedWorkflows,
} from '../src/client/workflow-actions.ts'
import type { ServerMenuWorkflow } from '../src/client/workflow-api.ts'

function workflow(overrides: Partial<ServerMenuWorkflow>): ServerMenuWorkflow {
  return { id: 'w1', name: 'A', order: 0, homeSessionId: 's1', navSnapshot: [], savedAt: 1, ...overrides }
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

describe('reordered', () => {
  it('moves the dragged workflow before the named row, shifting the rest down', () => {
    const workflows = [
      workflow({ id: 'a', order: 0 }), workflow({ id: 'b', order: 1 }), workflow({ id: 'c', order: 2 }),
    ]
    const next = reordered(workflows, 'c', 'a')
    expect(sortedWorkflows(next).map(w => w.id)).toEqual(['c', 'a', 'b'])
  })

  it('moves the dragged workflow after the named row by naming its successor', () => {
    const workflows = [
      workflow({ id: 'a', order: 0 }), workflow({ id: 'b', order: 1 }), workflow({ id: 'c', order: 2 }),
    ]
    // "Drop after b" is expressed as "insert before b's successor" (c).
    const next = reordered(workflows, 'a', 'c')
    expect(sortedWorkflows(next).map(w => w.id)).toEqual(['b', 'a', 'c'])
  })

  it('appends to the end when beforeId is undefined', () => {
    const workflows = [workflow({ id: 'a', order: 0 }), workflow({ id: 'b', order: 1 })]
    const next = reordered(workflows, 'a', undefined)
    expect(sortedWorkflows(next).map(w => w.id)).toEqual(['b', 'a'])
  })

  it('appends to the end on a self-drop (beforeId equal to dragId)', () => {
    const workflows = [workflow({ id: 'a', order: 0 }), workflow({ id: 'b', order: 1 })]
    const next = reordered(workflows, 'a', 'a')
    expect(sortedWorkflows(next).map(w => w.id)).toEqual(['b', 'a'])
  })

  it('appends to the end when beforeId names no workflow (a stale drop target)', () => {
    const workflows = [workflow({ id: 'a', order: 0 }), workflow({ id: 'b', order: 1 })]
    const next = reordered(workflows, 'a', 'gone')
    expect(sortedWorkflows(next).map(w => w.id)).toEqual(['b', 'a'])
  })

  it('answers a plain copy, order untouched, when dragId names no workflow', () => {
    const workflows = [workflow({ id: 'a', order: 0 }), workflow({ id: 'b', order: 1 })]
    const next = reordered(workflows, 'gone', 'a')
    expect(next).toEqual(workflows)
    expect(next).not.toBe(workflows)
  })

  it('rewrites order to a clean 0..n-1 sequence, ignoring the previous values entirely', () => {
    // Pre-drag display order (c's order is lowest; a and b tie and break on
    // id) is c, a, b. Dragging c to the end yields a, b, c.
    const workflows = [
      workflow({ id: 'a', order: 5 }), workflow({ id: 'b', order: 5 }), workflow({ id: 'c', order: 1 }),
    ]
    const next = reordered(workflows, 'c', undefined)
    expect(next.find(w => w.id === 'a')?.order).toBe(0)
    expect(next.find(w => w.id === 'b')?.order).toBe(1)
    expect(next.find(w => w.id === 'c')?.order).toBe(2)
  })

  it('does not mutate the input array', () => {
    const workflows = [workflow({ id: 'a', order: 0 }), workflow({ id: 'b', order: 1 })]
    const copy = [...workflows]
    reordered(workflows, 'b', 'a')
    expect(workflows).toEqual(copy)
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
      list: { getSnapshot: () => ({ current: undefined }) },
      open,
    },
    workspaces: {
      list: { getSnapshot: () => ({ recentWorkspaceId: overrides.recentWorkspaceId }) },
      connectWorkspace: overrides.connectWorkspace ?? (() => Promise.resolve('new-session')),
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
  it('reopens the recorded session when it is live and still blank', async () => {
    const { ctx, open } = fakeContext({})
    const outcome = await openWorkbenchOnClick(ctx, 'home-1', true, true)
    expect(outcome).toEqual({ sessionId: 'home-1', created: false })
    expect(open).toHaveBeenCalledWith('home-1')
  })

  it('creates a fresh session when the recorded one is live but no longer blank', async () => {
    const { ctx, open } = fakeContext({ recentWorkspaceId: 'workspace-1' })
    const outcome = await openWorkbenchOnClick(ctx, 'home-1', true, false)
    expect(outcome).toEqual({ sessionId: 'new-session', created: true })
    // The fresh session, not the recorded (non-blank) one, is what gets opened.
    expect(open).toHaveBeenCalledWith('new-session')
  })

  it('creates a fresh session when the recorded id is no longer live, ignoring isBlank', async () => {
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
    const outcome = await openWorkflow(ctx, workflow({ navSnapshot: ['home', 'reports'] }), false)
    expect(outcome).toEqual({ sessionId: 'new-session', created: true })
    expect(execute).toHaveBeenNthCalledWith(1, 'new-session', '/show-content-page home', [])
    expect(execute).toHaveBeenNthCalledWith(2, 'new-session', '/show-content-page reports', [])
  })

  it('answers undefined with nowhere to create a session on degrade', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ctx } = fakeContext({})
    expect(await openWorkflow(ctx, workflow({}), false)).toBeUndefined()
    warn.mockRestore()
  })
})
