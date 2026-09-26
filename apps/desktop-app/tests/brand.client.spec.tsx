// @vitest-environment jsdom
/**
 * The desktop brand occupant on the production slot runtime and the real
 * locale runtime: the sidebar name follows the active language, and the
 * version line is the build's `DSH_CLIENT_VERSION`.
 * @module
 */
import { act } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as localeClient from '@deepseek-ai/dsh-client-locale/client'
import { SlotTestRuntime, stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as hostApply } from '../src/index.ts'
import { apply, inject } from '../src/client/index.ts'

const runtimes: SlotTestRuntime[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  for (const runtime of runtimes.splice(0)) await runtime.dispose()
})

/** Mount the locale runtime and the brand half on a page that declares the brand-name slot. */
async function page() {
  const runtime = await SlotTestRuntime.create()
  runtimes.push(runtime)
  await runtime.declare({ 'sidebar.brand.name': { kind: 'single', scope: 'root' } })
  runtime.ctx.provide('configForms', {
    get: () => stubConfigForm().scope,
    whileServed: (namespaces: readonly string[], register: (served: ReadonlySet<string>) => () => void) =>
      register(new Set(namespaces)),
  } as never)
  await runtime.ctx.plugin(localeClient).await()
  const brand = await runtime.mount({ inject: [...inject], apply })
  const view = runtime.renderSlot('sidebar.brand.name', {})
  const setLocale = (id: string) => { act(() => { runtime.ctx.locale.setLocale(id) }) }
  return { runtime, brand, view, setLocale }
}

describe('desktop brand occupant', () => {
  it('keeps the host Loader entry inert', () => {
    expect(hostApply).not.toThrow()
  })

  it('names the product 北冥 in Chinese and Beiming in English', async () => {
    vi.stubEnv('DSH_CLIENT_VERSION', undefined)
    const { view, setLocale } = await page()
    setLocale('zh')
    expect(view.container.textContent).toBe('北冥')
    setLocale('en')
    expect(view.container.textContent).toBe('Beiming')
  })

  it('stacks the embedded desktop version under the name', async () => {
    vi.stubEnv('DSH_CLIENT_VERSION', '0.1.0-rc.34')
    const { view, setLocale } = await page()
    setLocale('zh')
    expect(view.view.getByText('北冥')).toBeTruthy()
    expect(view.view.getByText('0.1.0-rc.34')).toBeTruthy()
    expect(view.container.textContent).toBe('北冥0.1.0-rc.34')
  })

  it('leaves the slot to the sidebar fallback once the half is disposed', async () => {
    const { runtime, brand } = await page()
    expect(runtime.slots.entries('sidebar.brand.name')).toHaveLength(1)
    await brand.dispose()
    expect(runtime.slots.entries('sidebar.brand.name')).toHaveLength(0)
  })
})
