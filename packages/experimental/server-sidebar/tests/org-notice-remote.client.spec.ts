/**
 * The notice namespace as the card's port: each method's `RemoteResult`
 * envelope unwrapped and its answer checked, a refusal turned into a
 * rejection carrying the plugin's code, a namespace without one of the
 * three methods refused before any call, and a `pending` wait the card's
 * timer can hold.
 */
import { describe, expect, it, vi } from 'vitest'
import { ORG_NOTICE_NAMESPACE, OrgNoticeRefusal, remotePort } from '../src/client/org-notice-remote.ts'
import { createOrgNoticeStore, OrgNoticeAnswerError, type OrgNoticePort } from '../src/client/org-notice.ts'

/**
 * A namespace whose three methods resolve to the given envelopes.
 * @param envelopes - what each method resolves to.
 * @returns the namespace.
 */
function namespace(envelopes: { due?: unknown; markSeen?: unknown; confirm?: unknown }) {
  return {
    due: vi.fn(() => Promise.resolve(envelopes.due)),
    markSeen: vi.fn((_version: number) => Promise.resolve(envelopes.markSeen)),
    confirm: vi.fn((_version: number) => Promise.resolve(envelopes.confirm)),
  }
}

/**
 * The port over a namespace, failing the test when a method is missing.
 * @param service - the namespace.
 * @param report - where an unknown kind is reported.
 * @returns the port.
 */
function portOver(service: object, report = vi.fn()): OrgNoticePort {
  const port = remotePort(service, report)
  if ('missing' in port) throw new Error(`missing ${port.missing}`)
  return port
}

describe('remotePort', () => {
  it('names the namespace the organization plugin mounts', () => {
    expect(ORG_NOTICE_NAMESPACE).toBe('sumomokOrgNotice')
  })

  it('names the first of the three methods a namespace lacks', () => {
    expect(remotePort(undefined, vi.fn())).toEqual({ missing: 'due' })
    expect(remotePort({ due: vi.fn() }, vi.fn())).toEqual({ missing: 'markSeen' })
    expect(remotePort({ due: vi.fn(), markSeen: vi.fn(), confirm: 'confirm' }, vi.fn())).toEqual({ missing: 'confirm' })
  })

  it('unwraps and checks each answer, passing the version through', async () => {
    const service = namespace({
      due: { ok: true, value: { kind: 'pending', retryAfterMs: 500 } },
      markSeen: { ok: true, value: { kind: 'stale' } },
      confirm: { ok: true, value: { kind: 'accepted', version: 3 } },
    })
    const port = portOver(service)
    await expect(port.due()).resolves.toEqual({ kind: 'pending', retryAfterMs: 500 })
    await expect(port.markSeen(2)).resolves.toEqual({ kind: 'stale' })
    await expect(port.confirm(3)).resolves.toEqual({ kind: 'accepted' })
    expect(service.markSeen).toHaveBeenCalledWith(2)
    expect(service.confirm).toHaveBeenCalledWith(3)
  })

  it('reports a due answer of a kind the page does not know, and reads it as nothing to show', async () => {
    const report = vi.fn()
    const port = portOver(namespace({ due: { ok: true, value: { kind: 'reminder' } } }), report)
    await expect(port.due()).resolves.toEqual({ kind: 'none' })
    expect(report).toHaveBeenCalledWith(
      'kind',
      'server-sidebar: the organization notice answer has a kind the page does not know ("reminder"), so nothing is shown',
    )
  })

  it('rejects with the plugin\'s code and message when it refuses', async () => {
    const port = portOver(namespace({
      due: { ok: false, error: { code: 'sumomokOrg/caller-unknown', message: 'no member', details: {} } },
      confirm: { ok: false, error: { code: 'sumomokOrg/unavailable', message: 'offline' } },
    }))
    const refusal = await port.due().catch((error: unknown) => error)
    expect(refusal).toBeInstanceOf(OrgNoticeRefusal)
    expect(refusal).toMatchObject({
      method: 'due',
      code: 'sumomokOrg/caller-unknown',
      message: 'server-sidebar: sumomokOrgNotice.due was refused: no member',
    })
    await expect(port.confirm(1)).rejects.toMatchObject({ method: 'confirm', code: 'sumomokOrg/unavailable' })
  })

  it('rejects an answer that is no Remote result, or a refusal without a code or a message', async () => {
    for (const envelope of [undefined, 'ok', { ok: 'yes' }]) {
      await expect(portOver(namespace({ due: envelope })).due())
        .rejects.toMatchObject({ code: undefined, message: 'server-sidebar: sumomokOrgNotice.due was refused: the answer is not a Remote result' })
    }
    for (const error of [undefined, { code: 7, message: null }]) {
      await expect(portOver(namespace({ markSeen: { ok: false, error } })).markSeen(1))
        .rejects.toMatchObject({ code: undefined, message: 'server-sidebar: sumomokOrgNotice.markSeen was refused' })
    }
  })

  it('rejects an answer it cannot read, naming the field', async () => {
    const port = portOver(namespace({ markSeen: { ok: true, value: { kind: 'accepted' } } }))
    await expect(port.markSeen(1)).rejects.toBeInstanceOf(OrgNoticeAnswerError)
  })

  it('has the card wait out a wait longer than a timer can hold instead of asking again at once', async () => {
    vi.useFakeTimers()
    try {
      const service = namespace({ due: { ok: true, value: { kind: 'pending', retryAfterMs: Number.MAX_SAFE_INTEGER } } })
      const store = createOrgNoticeStore(portOver(service), vi.fn())
      await store.refresh()
      await vi.advanceTimersByTimeAsync(1000)
      expect(service.due).toHaveBeenCalledOnce()
      store.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})
