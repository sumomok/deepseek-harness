/** The /api/file route for non-owner Peers: only files inside the workspace of a Session remote access grants. */
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
import { HostConnectionService, type PeerScope } from '@deepseek-ai/dsh-client-connection'
import type { BrowserAuth } from '@deepseek-ai/dsh-client-connection/src/browser-auth.ts'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { PrincipalMap } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionMediaReferences } from '../src/media-references.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap {
    /** Test-only non-owner caller of the /api/file member specs. */
    'file-test-member': { readonly kind: 'file-test-member'; readonly sessions: readonly string[] }
  }
}

const BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
/** `alice-evil` shares the `alice` workspace's path as a string prefix but is a sibling directory. */
const DIRECTORIES = ['alice', 'alice-evil', 'bob', 'outside']
const sid = (value: string): SessionId => value as SessionId

let base: string
const contexts: Context[] = []

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'dsh-media-member-')))
  for (const dir of DIRECTORIES) await mkdir(join(base, dir))
  for (const dir of DIRECTORIES) await writeFile(join(base, dir, 'image.png'), BYTES)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await rm(base, { recursive: true, force: true })
})

/**
 * Session s1 is live with workspace `alice`, s2 is persisted only with
 * workspace `bob`, and s9 exists nowhere.
 */
async function mount(options: { readonly remoteAccess?: boolean } = {}): Promise<{
  readonly ctx: Context
  readonly connection: HostConnectionService
}> {
  const ctx = new Context()
  contexts.push(ctx)
  const live = new Map([['s1', { header: { cwd: join(base, 'alice') } }]])
  const persisted = new Map([['s2', { header: { cwd: join(base, 'bob') } }]])
  ctx.provide('sessions', { get: (id: SessionId) => live.get(id) } as never)
  ctx.provide('sessionPersistence', { stat: async (id: SessionId) => persisted.get(id) } as never)
  ctx.provide('attachments', { imageLimits: { maxImageBytes: 1024 } } as never)
  if (options.remoteAccess !== false) {
    await ctx.plugin(RemoteAccessService)
    ctx.remoteAccess.registerPolicy('file-test-member', {
      bindings: (member: PrincipalMap['file-test-member']) => member.sessions.map(id => ({
        role: { name: 'viewer', resource: 'session', actions: ['/api/file'] },
        resource: { kind: 'session', id: sid(id) },
      })),
    })
  }
  const connection = new HostConnectionService(ctx, [], {} as BrowserAuth)
  await ctx.plugin(LocalFileSystem, { cwd: base }).await()
  await ctx.plugin(SessionMediaReferences).await()
  return { ctx, connection }
}

function member(connection: HostConnectionService, ...sessions: string[]): PeerScope {
  return connection.createPeer({ principal: { kind: 'file-test-member', sessions } })
}

async function fileAs(
  connection: HostConnectionService,
  peer: PeerScope,
  path: string,
  sessionId?: string,
  method = 'GET',
): Promise<{ readonly status: number; readonly bytes: Uint8Array }> {
  const query = new URLSearchParams({ path, ...(sessionId === undefined ? {} : { sessionId }) })
  return fileQueryAs(connection, peer, query, method)
}

/** Request `/api/file` with a query whose parameters may repeat. */
async function fileQueryAs(
  connection: HostConnectionService,
  peer: PeerScope,
  query: URLSearchParams,
  method = 'GET',
): Promise<{ readonly status: number; readonly bytes: Uint8Array }> {
  const handler = connection.createSharedFetchHandler('/api')
  // A versioned read redirects once to the URL naming the exact file version.
  const original = new URL(`http://host/api/file?${query.toString()}`)
  let response = await handler.fetch(new Request(original, { method }), peer)
  const location = response.headers.get('location')
  if (response.status === 302 && location !== null) {
    // The redirect names the file version; the remaining query parameters are the request's own.
    const next = new URL(location, original)
    for (const [key, value] of original.searchParams) {
      if (!next.searchParams.has(key)) next.searchParams.set(key, value)
    }
    response = await handler.fetch(new Request(next, { method }), peer)
  }
  return { status: response.status, bytes: new Uint8Array(await response.arrayBuffer()) }
}

describe('/api/file for non-owner Peers', () => {
  it('serves a member a file inside the workspace of its own live or persisted Session', async () => {
    const { connection } = await mount()
    const alice = member(connection, 's1', 's2')
    expect(await fileAs(connection, alice, join(base, 'alice', 'image.png'), 's1')).toEqual({ status: 200, bytes: BYTES })
    expect(await fileAs(connection, alice, join(base, 'bob', 'image.png'), 's2')).toEqual({ status: 200, bytes: BYTES })
    const head = await fileAs(connection, alice, join(base, 'alice', 'image.png'), 's1', 'HEAD')
    expect(head).toEqual({ status: 200, bytes: new Uint8Array() })
    expect((await fileAs(connection, alice, join(base, 'alice', 'missing.png'), 's1')).status).toBe(404)
  })

  it('refuses a member another member\'s Session, or no Session, before resolving the path', async () => {
    const { ctx, connection } = await mount()
    const alice = member(connection, 's1')
    const resolve = vi.spyOn(ctx.fs, 'resolve')
    for (const sessionId of ['s2', '', undefined]) {
      for (const method of ['GET', 'HEAD']) {
        expect((await fileAs(connection, alice, join(base, 'bob', 'image.png'), sessionId, method)).status).toBe(403)
      }
    }
    expect((await fileAs(connection, alice, 'relative.png')).status).toBe(403)
    expect(resolve).not.toHaveBeenCalled()
    expect((await fileAs(connection, alice, 'relative.png', 's1')).status).toBe(400)
  })

  it('refuses a member a file outside its Session\'s workspace before reading or probing it', async () => {
    const { ctx, connection } = await mount()
    const alice = member(connection, 's1')
    const stat = vi.spyOn(ctx.fs, 'stat')
    const read = vi.spyOn(ctx.fs, 'readBytes')
    for (const path of [
      join(base, 'bob', 'image.png'),
      `${join(base, 'alice')}/../bob/image.png`,
      join(base, 'outside', 'missing.png'),
      base,
    ]) {
      expect((await fileAs(connection, alice, path, 's1')).status).toBe(403)
      expect((await fileAs(connection, alice, path, 's1', 'HEAD')).status).toBe(403)
    }
    expect(stat).not.toHaveBeenCalled()
    expect(read).not.toHaveBeenCalled()
  })

  it('refuses a member a sibling directory that shares its workspace path as a prefix', async () => {
    const { connection } = await mount()
    const alice = member(connection, 's1')
    for (const method of ['GET', 'HEAD']) {
      expect((await fileAs(connection, alice, join(base, 'alice-evil', 'image.png'), 's1', method)).status).toBe(403)
    }
  })

  it('confines a member\'s read to the workspace of the sessionId value remote access decided', async () => {
    const { connection } = await mount()
    const alice = member(connection, 's1')
    const repeated = (path: string, ...sessionIds: string[]): URLSearchParams =>
      new URLSearchParams([['path', path], ...sessionIds.map(id => ['sessionId', id])])
    expect((await fileQueryAs(connection, alice, repeated(join(base, 'bob', 'image.png'), 's1', 's2'))).status).toBe(403)
    expect((await fileQueryAs(connection, alice, repeated(join(base, 'alice', 'image.png'), 's2', 's1'))).status).toBe(403)
    expect(await fileQueryAs(connection, alice, repeated(join(base, 'alice', 'image.png'), 's1', 's2')))
      .toEqual({ status: 200, bytes: BYTES })
  })

  it('reads for a member the path value it decided containment on', async () => {
    const { connection } = await mount()
    const alice = member(connection, 's1')
    const outside = join(base, 'outside', 'other.bin')
    await writeFile(outside, Uint8Array.of(9, 9, 9))
    const paths = (...values: string[]): URLSearchParams =>
      new URLSearchParams([...values.map(path => ['path', path]), ['sessionId', 's1']])
    expect(await fileQueryAs(connection, alice, paths(join(base, 'alice', 'image.png'), outside)))
      .toEqual({ status: 200, bytes: BYTES })
    expect((await fileQueryAs(connection, alice, paths(outside, join(base, 'alice', 'image.png')))).status).toBe(403)
  })

  it('follows symbolic links to their real path before deciding containment', async () => {
    const { connection } = await mount()
    const alice = member(connection, 's1')
    await symlink(join(base, 'outside', 'image.png'), join(base, 'alice', 'out.png'))
    await symlink(join(base, 'outside'), join(base, 'alice', 'out-dir'))
    await symlink(join(base, 'alice', 'image.png'), join(base, 'alice', 'in.png'))
    expect((await fileAs(connection, alice, join(base, 'alice', 'out.png'), 's1')).status).toBe(403)
    expect((await fileAs(connection, alice, join(base, 'alice', 'out-dir', 'image.png'), 's1')).status).toBe(403)
    expect(await fileAs(connection, alice, join(base, 'alice', 'in.png'), 's1')).toEqual({ status: 200, bytes: BYTES })
  })

  it('refuses a granted Session that has no workspace on this Host', async () => {
    const { connection } = await mount()
    expect((await fileAs(connection, member(connection, 's9'), join(base, 'alice', 'image.png'), 's9')).status).toBe(403)
  })

  it('refuses every member read on a Host without remote access', async () => {
    const { connection } = await mount({ remoteAccess: false })
    expect((await fileAs(connection, member(connection, 's1'), join(base, 'alice', 'image.png'), 's1')).status).toBe(403)
  })

  it('serves the owner any file without a Session and without asking remote access', async () => {
    const { connection } = await mount()
    const decide = vi.spyOn(RemoteAccessService.prototype, 'decide')
    expect(await fileAs(connection, connection.browserPeer, join(base, 'outside', 'image.png'))).toEqual({ status: 200, bytes: BYTES })
    expect(await fileAs(connection, connection.browserPeer, join(base, 'bob', 'image.png'), 's1')).toEqual({ status: 200, bytes: BYTES })
    expect(decide).not.toHaveBeenCalled()
  })
})
