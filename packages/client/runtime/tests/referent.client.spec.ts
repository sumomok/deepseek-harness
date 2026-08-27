/**
 * The `referent/open` waterfall seam: claim/delegate semantics, registration
 * order and prepend, disposer lifecycle via ctx.effect, and the
 * throw/reject-falls-back-to-default recovery `dispatchReferentOpen` adds on
 * top of plain `ctx.waterfall`.
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { dispatchReferentOpen } from '../src/client/referent.ts'
import type { ReferentRef } from '../src/client/referent.ts'

function ref(overrides: Partial<ReferentRef> = {}): ReferentRef {
  return {
    kind: 'file',
    target: '/proj/a.txt',
    raw: 'a.txt',
    source: 'test',
    provenance: 'structured',
    ...overrides,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('dispatchReferentOpen', () => {
  it('runs the default action when no listener is registered', async () => {
    const ctx = new Context()
    const onDefault = vi.fn(() => {})
    await dispatchReferentOpen(ctx, ref(), onDefault)
    expect(onDefault).toHaveBeenCalledOnce()
  })

  it('a claiming listener (returns without calling next()) suppresses the default', async () => {
    const ctx = new Context()
    const claimed = vi.fn()
    ctx.on('referent/open', (r) => {
      claimed(r)
      return Promise.resolve()
    })
    const onDefault = vi.fn(() => {})
    await dispatchReferentOpen(ctx, ref(), onDefault)
    expect(claimed).toHaveBeenCalledOnce()
    expect(onDefault).not.toHaveBeenCalled()
  })

  it('a listener that calls next() delegates to the default', async () => {
    const ctx = new Context()
    const seen = vi.fn()
    ctx.on('referent/open', (r, next) => {
      seen(r)
      return next()
    })
    const onDefault = vi.fn(() => {})
    await dispatchReferentOpen(ctx, ref(), onDefault)
    expect(seen).toHaveBeenCalledOnce()
    expect(onDefault).toHaveBeenCalledOnce()
  })

  it('runs listeners outermost-first in registration order, finally the default', async () => {
    const ctx = new Context()
    const order: string[] = []
    ctx.on('referent/open', (_r, next) => {
      order.push('first')
      return next()
    })
    ctx.on('referent/open', (_r, next) => {
      order.push('second')
      return next()
    })
    await dispatchReferentOpen(ctx, ref(), () => {
      order.push('default')
    })
    expect(order).toEqual(['first', 'second', 'default'])
  })

  it('prepend places a listener ahead of already-registered ones', async () => {
    const ctx = new Context()
    const order: string[] = []
    ctx.on('referent/open', (_r, next) => {
      order.push('registered-first')
      return next()
    })
    ctx.on('referent/open', (_r, next) => {
      order.push('prepended')
      return next()
    }, true)
    await dispatchReferentOpen(ctx, ref(), () => {
      order.push('default')
    })
    expect(order).toEqual(['prepended', 'registered-first', 'default'])
  })

  it('a disposer registered through ctx.effect removes its listener', async () => {
    const root = new Context()
    const seen = vi.fn()
    const fiber = root.plugin({
      name: 'referent-probe',
      apply: (ctx: Context) => {
        ctx.effect(() => ctx.on('referent/open', (_r, next) => {
          seen()
          return next()
        }), 'probe listener')
      },
    })
    await fiber.await()
    await dispatchReferentOpen(root, ref(), () => {})
    expect(seen).toHaveBeenCalledOnce()
    seen.mockClear()
    await fiber.dispose()
    await dispatchReferentOpen(root, ref(), () => {})
    expect(seen).not.toHaveBeenCalled()
  })

  it('falls back to the default when a listener throws synchronously, and logs it', async () => {
    const ctx = new Context()
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    ctx.on('referent/open', () => {
      throw new Error('boom')
    })
    const onDefault = vi.fn(() => {})
    await dispatchReferentOpen(ctx, ref(), onDefault)
    expect(onDefault).toHaveBeenCalledOnce()
    expect(errorLog).toHaveBeenCalledOnce()
  })

  it('falls back to the default when a listener rejects, and logs it', async () => {
    const ctx = new Context()
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    ctx.on('referent/open', () => Promise.reject(new Error('nope')))
    const onDefault = vi.fn(() => {})
    await dispatchReferentOpen(ctx, ref(), onDefault)
    expect(onDefault).toHaveBeenCalledOnce()
    expect(errorLog).toHaveBeenCalledOnce()
  })

  it('does not re-run the default when a listener throws after already delegating to it', async () => {
    const ctx = new Context()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const onDefault = vi.fn(() => {})
    ctx.on('referent/open', async (_r, next) => {
      await next()
      throw new Error('cleanup failed after a successful default')
    })
    await dispatchReferentOpen(ctx, ref(), onDefault)
    expect(onDefault).toHaveBeenCalledTimes(1)
  })

  it('an unrecognized kind is a documented no-op (delegates via next(), never throws)', async () => {
    const ctx = new Context()
    const handled = vi.fn()
    const devLog = vi.fn()
    ctx.on('referent/open', (r, next) => {
      switch (r.kind) {
        case 'file':
        case 'dir':
          handled(r.kind)
          return Promise.resolve()
        default:
          devLog(r.kind)
          return next()
      }
    })
    const onDefault = vi.fn(() => {})
    await dispatchReferentOpen(ctx, ref({ kind: 'url' }), onDefault)
    expect(devLog).toHaveBeenCalledWith('url')
    expect(handled).not.toHaveBeenCalled()
    expect(onDefault).toHaveBeenCalledOnce()
  })
})
