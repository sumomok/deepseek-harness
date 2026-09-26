// @vitest-environment jsdom
/**
 * The desktop brand occupant on the production slot runtime and the real
 * locale runtime: the sidebar name follows the active language, and the
 * version line is the build's `DSH_CLIENT_VERSION`; Settings → General's
 * current-version row is shadowed while every other row renders.
 * @module
 */
import { act } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as localeClient from '@deepseek-ai/dsh-client-locale/client'
import { SlotTestRuntime, stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as hostApply } from '../src/index.ts'
import { CurrentVersionRow } from '@deepseek-ai/dsh-client-ui-settings-general/src/client/CurrentVersionRow.tsx'
import { en as settingsEn, zh as settingsZh } from '@deepseek-ai/dsh-client-ui-settings-general/src/client/locales.ts'
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
  await runtime.declare({
    'sidebar.brand.name': { kind: 'single', scope: 'root' },
    'settings.general.item': { kind: 'list', scope: 'root' },
  })
  // ui-settings-general's own current-version row as it registers it, beside
  // one other row; the brand half mounts after both, as it may in the page.
  runtime.ctx.slots.register({
    name: 'settings.general.item', id: 'current-version', order: 100, locale: 'settings',
  }, CurrentVersionRow)
  runtime.ctx.slots.register({ name: 'settings.general.item', id: 'other-row', order: 10 }, () => <div>other row</div>)
  runtime.ctx.provide('configForms', {
    get: () => stubConfigForm().scope,
    whileServed: (namespaces: readonly string[], register: (served: ReadonlySet<string>) => () => void) =>
      register(new Set(namespaces)),
  } as never)
  await runtime.ctx.plugin(localeClient).await()
  runtime.ctx.locale.register('settings', { zh: settingsZh, en: settingsEn })
  const brand = await runtime.mount({ inject: [...inject], apply })
  const view = runtime.renderSlot('sidebar.brand.name', {})
  const general = runtime.renderSlot('settings.general.item', {})
  const setLocale = (id: string) => { act(() => { runtime.ctx.locale.setLocale(id) }) }
  return { runtime, brand, view, general, setLocale }
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

  it('stacks the client build\'s upstream version under the name', async () => {
    vi.stubEnv('DSH_CLIENT_VERSION', '0.1.7-rc.2')
    const { view, setLocale } = await page()
    setLocale('zh')
    expect(view.view.getByText('北冥')).toBeTruthy()
    expect(view.view.getByText('0.1.7-rc.2')).toBeTruthy()
    expect(view.container.textContent).toBe('北冥0.1.7-rc.2')
  })

  it('renders no current-version row and no element in its place in Settings → General', async () => {
    vi.stubEnv('DSH_CLIENT_VERSION', '0.1.7-rc.2')
    const { general, setLocale } = await page()
    setLocale('zh')
    // The locale runtime contributes its own language row to the same list.
    const rows = [...general.container.children].map(row => row.textContent)
    expect(rows).toHaveLength(2)
    expect(rows).toContain('other row')
    expect(general.container.textContent).toBe(rows.join(''))
    expect(general.container.textContent).not.toContain('当前版本')
    expect(general.container.textContent).not.toContain('0.1.7-rc.2')
  })

  it('gives both slots back to their fallback and shadowed row once the half is disposed', async () => {
    vi.stubEnv('DSH_CLIENT_VERSION', '0.1.7-rc.2')
    const { runtime, brand, general, setLocale } = await page()
    setLocale('zh')
    expect(runtime.slots.entries('sidebar.brand.name')).toHaveLength(1)
    await brand.dispose()
    expect(runtime.slots.entries('sidebar.brand.name')).toHaveLength(0)
    expect(general.container.textContent).toContain('当前版本：0.1.7-rc.2')
    expect(general.container.textContent).toContain('other row')
  })
})
