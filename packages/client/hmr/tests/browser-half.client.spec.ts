/**
 * Browser half of the HMR plugin: where it opens the dev SSE channel, and that
 * the channel closes with the fiber.
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClientModuleLoader } from '@deepseek-ai/dsh-client-modules/client'
import type { Loader } from '@deepseek-ai/cordis-plugin-loader'
import { apply, EVENTS_ENDPOINT, inject } from '../src/client/index.ts'

const opened: string[] = []
const closed: string[] = []

class FakeEventSource {
  constructor(readonly url: string | URL) { opened.push(String(url)) }
  addEventListener(): void {}
  close(): void { closed.push(String(this.url)) }
}

afterEach(() => {
  opened.length = 0
  closed.length = 0
  vi.unstubAllGlobals()
})

/**
 * Mount the browser half over the two services it injects.
 * @returns the mounted fiber's disposer.
 */
async function mount(): Promise<() => Promise<void>> {
  const ctx = new Context()
  ctx.provide('modules', {} as ClientModuleLoader)
  ctx.provide('loader', {} as Loader)
  vi.stubGlobal('EventSource', FakeEventSource)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return () => fiber.dispose()
}

describe('client-hmr browser half', () => {
  it('opens the dev channel under the page deployment prefix and closes it with the fiber', async () => {
    vi.stubGlobal('location', { origin: 'https://harness.example' })
    vi.stubGlobal('__DSH_BASE__', '/console/')
    const dispose = await mount()
    expect(opened).toEqual(['https://harness.example/console/plugins/events'])
    await dispose()
    expect(closed).toEqual(opened)
  })

  it('opens the dev channel at the page root when nothing declares a prefix', async () => {
    vi.stubGlobal('location', { origin: 'https://harness.example' })
    const dispose = await mount()
    expect(opened).toEqual([`https://harness.example${EVENTS_ENDPOINT}`])
    await dispose()
  })
})
