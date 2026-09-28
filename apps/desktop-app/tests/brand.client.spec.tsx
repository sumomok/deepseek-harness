// @vitest-environment jsdom
/**
 * The desktop brand occupants on the production slot runtime and the real
 * locale runtime: the sidebar name follows the active language and carries no
 * version, whatever `DSH_CLIENT_VERSION` the build sets; the mark is the fish
 * logo at 1.25 times the owner's size; Settings → General's current-version
 * row is shadowed while every other row renders.
 * @module
 */
import { act } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FISH_LOGO_PATH, FISH_LOGO_VIEWBOX } from '@deepseek-ai/dsh-client-ui-primitives'
import * as localeClient from '@deepseek-ai/dsh-client-locale/client'
import { SlotTestRuntime, stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import { CurrentVersionRow } from '@deepseek-ai/dsh-client-ui-settings-general/src/client/CurrentVersionRow.tsx'
import { en as settingsEn, zh as settingsZh } from '@deepseek-ai/dsh-client-ui-settings-general/src/client/locales.ts'
import { apply, inject } from '../src/client/index.ts'

const runtimes: SlotTestRuntime[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  for (const runtime of runtimes.splice(0)) await runtime.dispose()
})

/** Mount the locale runtime and the brand half on a page that declares both brand slots. */
async function page() {
  const runtime = await SlotTestRuntime.create()
  runtimes.push(runtime)
  await runtime.declare({
    'sidebar.brand.mark': { kind: 'single', scope: 'root' },
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
  // ui-sidebar asks for 24 in both the expanded row and the collapsed rail.
  const mark = runtime.renderSlot('sidebar.brand.mark', { size: 24 })
  const view = runtime.renderSlot('sidebar.brand.name', {})
  const general = runtime.renderSlot('settings.general.item', {})
  const setLocale = (id: string) => { act(() => { runtime.ctx.locale.setLocale(id) }) }
  return { runtime, brand, mark, view, general, setLocale }
}

describe('desktop brand occupants', () => {
  it('names the product 北冥 in Chinese and Beiming in English, with no version beside it', async () => {
    vi.stubEnv('DSH_CLIENT_VERSION', '0.1.7-rc.2')
    const { view, setLocale } = await page()
    setLocale('zh')
    expect(view.container.textContent).toBe('北冥')
    setLocale('en')
    expect(view.container.textContent).toBe('Beiming')
    expect(view.container.querySelectorAll('span')).toHaveLength(1)
  })

  it('sets the name at 18px on the sidebar\'s 24px line and leaves its weight to the sidebar', async () => {
    const { view, setLocale } = await page()
    setLocale('zh')
    const name = view.container.querySelector('span')
    expect(name?.style.fontSize).toBe('18px')
    expect(name?.style.lineHeight).toBe('24px')
    expect(name?.style.fontWeight).toBe('')
  })

  it('draws the fish logo 30 wide and 22 tall for the sidebar\'s requested 24', async () => {
    const { mark } = await page()
    const svgs = mark.container.querySelectorAll('svg')
    expect(svgs).toHaveLength(1)
    const svg = svgs[0]!
    expect(svg.getAttribute('width')).toBe('30')
    expect(Number(svg.getAttribute('height'))).toBeCloseTo((30 * FISH_LOGO_VIEWBOX.height) / FISH_LOGO_VIEWBOX.width)
    expect(Number(svg.getAttribute('height'))).toBeLessThanOrEqual(24)
    expect(svg.querySelector('path')?.getAttribute('d')).toBe(FISH_LOGO_PATH)
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

  it('gives every slot back to its fallback and shadowed row once the half is disposed', async () => {
    vi.stubEnv('DSH_CLIENT_VERSION', '0.1.7-rc.2')
    const { runtime, brand, general, setLocale } = await page()
    setLocale('zh')
    expect(runtime.slots.entries('sidebar.brand.mark')).toHaveLength(1)
    expect(runtime.slots.entries('sidebar.brand.name')).toHaveLength(1)
    await brand.dispose()
    expect(runtime.slots.entries('sidebar.brand.mark')).toHaveLength(0)
    expect(runtime.slots.entries('sidebar.brand.name')).toHaveLength(0)
    expect(general.container.textContent).toContain('当前版本：0.1.7-rc.2')
    expect(general.container.textContent).toContain('other row')
  })
})
