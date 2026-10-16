/** The raw upload route for non-owner Peers: remote access decides each upload by its Session. */
import { Context } from '@deepseek-ai/cordis'
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
import { apply as applyConnection, inject as connectionInject, type PeerScope } from '@deepseek-ai/dsh-client-connection'
import type { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { PrincipalMap } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { FileUploads } from '../src/index.ts'
import { FILE_UPLOAD_PATH } from '../src/protocol.ts'
import type { FileUploadReceiptId, FileUploadValue } from '../src/types.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap {
    /** Test-only non-owner caller of the upload route specs. */
    'upload-test-member': { readonly kind: 'upload-test-member'; readonly session: string }
  }
}

const STAGED: FileUploadValue = {
  receiptId: 'receipt-1' as FileUploadReceiptId,
  file: { attachmentId: 'file-1' as AttachmentId, name: 'a.bin', bytes: 3 },
}

const roots: Context[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function mount(options: { readonly remoteAccess?: boolean } = {}): Promise<{
  readonly ctx: Context
  readonly stored: MockInstance<FileUploads['uploadStream']>
}> {
  const ctx = new Context()
  roots.push(ctx)
  const records = new Map<unknown, unknown>()
  ctx.provide('credentials', {
    async modifyRecord(key: unknown, mutate: (current: unknown) => Promise<unknown>): Promise<unknown> {
      const next = await mutate(records.get(key))
      if (next !== undefined) records.set(key, next)
      return next ?? records.get(key)
    },
  } as never)
  ctx.provide('agents', {} as never)
  ctx.provide('attachments', { imageLimits: { maxMessageImageBytes: 1024 } } as never)
  ctx.provide('commands', { registerFileReceiptResolver: () => () => {} } as never)
  await ctx.plugin({ inject: [...connectionInject], apply: applyConnection })
  if (options.remoteAccess !== false) {
    await ctx.plugin(RemoteAccessService)
    ctx.remoteAccess.registerPolicy('upload-test-member', {
      bindings: (member: PrincipalMap['upload-test-member']) => [{
        role: { name: 'uploader', resource: 'session', actions: [FILE_UPLOAD_PATH] },
        resource: { kind: 'session', id: member.session as SessionId },
      }],
    })
  }
  const stored = vi.spyOn(FileUploads.prototype, 'uploadStream').mockImplementation(async (request) => {
    for await (const chunk of request.data) void chunk
    return STAGED
  })
  await ctx.plugin(FileUploads)
  return { ctx, stored }
}

function member(ctx: Context, session: string): PeerScope {
  return ctx.connection.createPeer({ principal: { kind: 'upload-test-member', session } })
}

async function upload(ctx: Context, peer: PeerScope, query: string): Promise<{ readonly status: number; readonly body: string }> {
  const response = await ctx.connection.createSharedFetchHandler('/api').fetch(new Request(`http://host${FILE_UPLOAD_PATH}${query}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: new Blob([Uint8Array.of(1, 2, 3)]),
  }), peer)
  return { status: response.status, body: await response.text() }
}

describe('raw upload route for non-owner Peers', () => {
  it('stores a member\'s upload into a Session remote access grants it', async () => {
    const { ctx, stored } = await mount()
    const response = await upload(ctx, member(ctx, 's1'), '?sessionId=s1&name=a.bin')
    expect(response.status).toBe(200)
    expect(JSON.parse(response.body)).toEqual({ ok: true, value: STAGED })
    expect(stored).toHaveBeenCalledOnce()
    expect(stored.mock.calls[0]![0]).toMatchObject({ sessionId: 's1', name: 'a.bin' })
  })

  it('refuses a member\'s upload into another member\'s Session, or without a Session, before storing anything', async () => {
    const { ctx, stored } = await mount()
    const alice = member(ctx, 's1')
    expect(await upload(ctx, alice, '?sessionId=s2')).toEqual({ status: 403, body: 'forbidden' })
    expect(await upload(ctx, alice, '')).toEqual({ status: 403, body: 'forbidden' })
    expect(await upload(ctx, alice, '?sessionId=')).toEqual({ status: 403, body: 'forbidden' })
    expect(stored).not.toHaveBeenCalled()
  })

  it('stores a member\'s upload into the Session its repeated sessionId values were decided on', async () => {
    const { ctx, stored } = await mount()
    const alice = member(ctx, 's1')
    expect(await upload(ctx, alice, '?sessionId=s2&sessionId=s1')).toEqual({ status: 403, body: 'forbidden' })
    expect(stored).not.toHaveBeenCalled()
    expect((await upload(ctx, alice, '?sessionId=s1&sessionId=s2')).status).toBe(200)
    expect(stored).toHaveBeenCalledOnce()
    expect(stored.mock.calls[0]![0]).toMatchObject({ sessionId: 's1' })
  })

  it('refuses every member upload on a Host without remote access', async () => {
    const { ctx, stored } = await mount({ remoteAccess: false })
    expect(await upload(ctx, member(ctx, 's1'), '?sessionId=s1')).toEqual({ status: 403, body: 'forbidden' })
    expect(stored).not.toHaveBeenCalled()
  })

  it('stores the owner\'s upload into any Session without asking remote access', async () => {
    const { ctx, stored } = await mount()
    const decide = vi.spyOn(RemoteAccessService.prototype, 'decide')
    expect((await upload(ctx, ctx.connection.browserPeer, '?sessionId=s2')).status).toBe(200)
    expect(stored).toHaveBeenCalledOnce()
    expect(decide).not.toHaveBeenCalled()
  })
})
