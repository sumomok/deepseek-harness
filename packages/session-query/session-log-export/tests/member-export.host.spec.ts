/** The Session-log export route for non-owner Peers: remote access decides the Session and every exported descendant. */
import { Context } from '@deepseek-ai/cordis'
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
import { HostConnectionService, type PeerScope } from '@deepseek-ai/dsh-client-connection'
import type { BrowserAuth } from '@deepseek-ai/dsh-client-connection/src/browser-auth.ts'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { PrincipalMap } from '@deepseek-ai/dsh-typert-protocol'
import { unzipSync } from 'fflate'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SESSION_LOG_EXPORT_PATH, SESSION_LOG_FILENAME, apply, inject } from '../src/index.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap {
    /** Test-only non-owner caller of the export route specs. */
    'export-test-member': { readonly kind: 'export-test-member'; readonly sessions: readonly string[] }
  }
}

const sid = (value: string): SessionId => value as SessionId

function header(id: string): SessionHeader {
  return { version: SESSION_FORMAT_VERSION, id: sid(id), createdAt: 1, isSeeded: false, cwd: '/workspace', delegationDepth: 0 }
}

/** Subagent children per Session in the fixture corpus. */
const CHILDREN: Readonly<Record<string, readonly string[]>> = { s1: ['s1a'], s2: ['s2a'], s3: ['s3a', 's3b'] }

/** The Session whose lineage the fixture's Session query cannot read. */
const UNTRACEABLE = 's-untraceable'

function lineage(id: string): { readonly session: { readonly header: SessionHeader }; readonly descendants: readonly unknown[] } {
  return { session: { header: header(id) }, descendants: (CHILDREN[id] ?? []).map(lineage) }
}

const roots: Context[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function mount(): Promise<{
  readonly ctx: Context
  readonly connection: HostConnectionService
  readonly opened: string[]
}> {
  const ctx = new Context()
  roots.push(ctx)
  const opened: string[] = []
  ctx.provide('commands', { register: () => () => {} } as never)
  ctx.provide('sessionQuery', {
    traceSession: async (id: SessionId) => {
      if (id === UNTRACEABLE) throw new Error('fixture lineage is unreadable')
      return lineage(String(id))
    },
  } as never)
  ctx.provide('sessionPersistence', {
    stat: async (id: SessionId) => ({ header: header(String(id)) }),
    open: async (id: SessionId) => {
      opened.push(String(id))
      return { id, header: header(String(id)), access: 'read', read: async () => ({ eventState: 'detached', events: [] }), close: async () => {} }
    },
  } as never)
  ctx.provide('attachments', { readImage: async () => { throw new Error('fixture has no images') } } as never)
  await ctx.plugin(RemoteAccessService)
  ctx.remoteAccess.registerPolicy('export-test-member', {
    bindings: (member: PrincipalMap['export-test-member']) => member.sessions.map(id => ({
      role: { name: 'exporter', resource: 'session', actions: [SESSION_LOG_EXPORT_PATH] },
      resource: { kind: 'session', id: sid(id) },
    })),
  })
  const connection = new HostConnectionService(ctx, [], {} as BrowserAuth)
  await ctx.plugin({ inject: [...inject], apply })
  return { ctx, connection, opened }
}

function member(connection: HostConnectionService, ...sessions: string[]): PeerScope {
  return connection.createPeer({ principal: { kind: 'export-test-member', sessions } })
}

async function exportAs(
  connection: HostConnectionService,
  peer: PeerScope,
  query: string,
  method = 'GET',
): Promise<{ readonly status: number; readonly entries: readonly string[] }> {
  const response = await connection.createSharedFetchHandler('/api').fetch(
    new Request(`http://host${SESSION_LOG_EXPORT_PATH}${query}`, { method }), peer,
  )
  if (response.status !== 200 || method === 'HEAD') return { status: response.status, entries: [] }
  return { status: 200, entries: Object.keys(unzipSync(new Uint8Array(await response.arrayBuffer()))).sort() }
}

describe('Session-log export route for non-owner Peers', () => {
  it('exports a member\'s own Session', async () => {
    const { connection } = await mount()
    expect(await exportAs(connection, member(connection, 's1'), '?sessionId=s1')).toEqual({ status: 200, entries: [SESSION_LOG_FILENAME] })
  })

  it('refuses a member\'s export of another member\'s Session, or without a valid query, before reading any log', async () => {
    const { connection, opened } = await mount()
    const alice = member(connection, 's1')
    for (const query of ['?sessionId=s2', '?sessionId=s2&includeDescendants=true', '', '?sessionId=', '?sessionId=s1&includeDescendants=yes']) {
      expect(await exportAs(connection, alice, query)).toEqual({ status: 403, entries: [] })
    }
    expect(await exportAs(connection, alice, '?sessionId=s2', 'HEAD')).toEqual({ status: 403, entries: [] })
    expect(opened).toEqual([])
  })

  it('exports a Session\'s descendants only when every descendant is granted', async () => {
    const { connection, opened } = await mount()
    expect(await exportAs(connection, member(connection, 's1'), '?sessionId=s1&includeDescendants=true'))
      .toEqual({ status: 403, entries: [] })
    expect(opened).toEqual([])
    expect(await exportAs(connection, member(connection, 's1', 's1a'), '?sessionId=s1&includeDescendants=true'))
      .toEqual({ status: 200, entries: [SESSION_LOG_FILENAME, `subagents/s1a/${SESSION_LOG_FILENAME}`] })
  })

  it('refuses a member\'s export with descendants when any one descendant is not granted', async () => {
    const { connection, opened } = await mount()
    for (const granted of [['s3', 's3a'], ['s3', 's3b']]) {
      expect(await exportAs(connection, member(connection, ...granted), '?sessionId=s3&includeDescendants=true'))
        .toEqual({ status: 403, entries: [] })
    }
    expect(opened).toEqual([])
    expect(await exportAs(connection, member(connection, 's3', 's3a', 's3b'), '?sessionId=s3&includeDescendants=true'))
      .toEqual({ status: 200, entries: [SESSION_LOG_FILENAME, `subagents/s3a/${SESSION_LOG_FILENAME}`, `subagents/s3b/${SESSION_LOG_FILENAME}`] })
  })

  it('refuses a member\'s export with descendants when the lineage cannot be read', async () => {
    const { connection, opened } = await mount()
    const alice = member(connection, UNTRACEABLE)
    expect(await exportAs(connection, alice, `?sessionId=${UNTRACEABLE}&includeDescendants=true`)).toEqual({ status: 403, entries: [] })
    expect(opened).toEqual([])
  })

  it.each([
    '?sessionId=s1&sessionId=s2',
    '?sessionId=s1&includeDescendants=false&includeDescendants=true',
    '?sessionId=s1&includeDescendants=false&sessionId=s2&includeDescendants=true',
  ])('refuses a member\'s export whose repeated query values name what it is not granted: %s', async (query) => {
    const { connection, opened } = await mount()
    expect(await exportAs(connection, member(connection, 's1'), query)).toEqual({ status: 403, entries: [] })
    expect(opened).toEqual([])
  })

  it('exports for a member the Session and extent its repeated query values were decided on', async () => {
    const { connection, opened } = await mount()
    expect(await exportAs(connection, member(connection, 's1'), '?sessionId=s2&sessionId=s1&includeDescendants=true&includeDescendants=false'))
      .toEqual({ status: 200, entries: [SESSION_LOG_FILENAME] })
    expect(opened).toEqual(['s1'])
  })

  it('exports any Session with its descendants to the owner without asking remote access', async () => {
    const { connection } = await mount()
    const decide = vi.spyOn(RemoteAccessService.prototype, 'decide')
    expect(await exportAs(connection, connection.browserPeer, '?sessionId=s1&includeDescendants=true'))
      .toEqual({ status: 200, entries: [SESSION_LOG_FILENAME, `subagents/s1a/${SESSION_LOG_FILENAME}`] })
    expect(decide).not.toHaveBeenCalled()
  })
})
