// @vitest-environment jsdom
/**
 * The banner as a visitor reads it: one sentence per notice in either
 * language, the reload button only where a reload is offered, the build
 * check's notice ahead of the connection's, and nothing at all when there is
 * nothing to say.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { createBannerStore, type BannerState, type PageNotice } from '../src/client/banner-state.ts'
import { PageRefreshBanner } from '../src/client/PageRefreshBanner.tsx'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)

/** Test-local selector hook over the banner store. */
function hookOf(source: ObservableSnapshot<BannerState>) {
  const subscribe = (listener: () => void) => source.subscribe(listener)
  const getSnapshot = () => source.getSnapshot()
  return function useSelector<S>(select: (state: BannerState) => S): S {
    return select(useSyncExternalStore(subscribe, getSnapshot))
  }
}

/** Mount the banner over a fresh store in one language. */
function mount(dictionary: Record<string, string> = zh) {
  const store = createBannerStore()
  const reloadPage = vi.fn()
  const view = render(
    <PageRefreshBanner usePageRefresh={hookOf(store)} reloadPage={reloadPage} t={makeTranslate(dictionary)} />,
  )
  const set = (next: Partial<BannerState>): void => {
    act(() => { store.update((draft) => { Object.assign(draft, next) }) })
  }
  return { store, reloadPage, view, set }
}

describe('the banner', () => {
  it('draws nothing when there is nothing to say', () => {
    const { view } = mount()
    expect(view.container.innerHTML).toBe('')
  })

  it.each<[PageNotice, Partial<BannerState>, string, boolean]>([
    ['update', { refresh: 'update' }, '页面有新版本，请刷新后继续使用', true],
    ['reloading', { refresh: 'reloading' }, '正在刷新页面…', false],
    ['lost', { connection: 'lost' }, '连接已断开，正在重新连接…', false],
    ['stuck', { connection: 'stuck' }, '暂时连不上服务', true],
    ['recovered', { connection: 'recovered' }, '已重新连接', false],
  ])('says %s in Chinese, offering the reload only where it is the way forward', (notice, state, text, offersReload) => {
    const { set, view } = mount()
    set(state)
    const banner = screen.getByRole('status')
    expect(banner.getAttribute('data-page-refresh-notice')).toBe(notice)
    expect(banner.textContent).toContain(text)
    expect(screen.queryAllByRole('button', { name: '刷新页面' })).toHaveLength(offersReload ? 1 : 0)
    view.unmount()
  })

  it('speaks English from the English dictionary', () => {
    const { set } = mount(en)
    set({ connection: 'stuck' })
    expect(screen.getByRole('status').textContent).toContain('Can\'t reach the service')
    expect(screen.getByRole('button', { name: 'Reload page' })).toBeTruthy()
    set({ refresh: 'update' })
    expect(screen.getByRole('status').textContent).toContain('A new version is available. Reload the page to continue.')
  })

  it('reloads the page from its button', () => {
    const { set, reloadPage } = mount()
    set({ refresh: 'update' })
    fireEvent.click(screen.getByRole('button', { name: '刷新页面' }))
    expect(reloadPage).toHaveBeenCalledOnce()
  })

  it('puts the build check\'s notice ahead of the connection\'s, and the connection\'s back once it clears', () => {
    const { set } = mount()
    set({ connection: 'lost', refresh: 'update' })
    expect(screen.getByRole('status').getAttribute('data-page-refresh-notice')).toBe('update')
    set({ refresh: null })
    expect(screen.getByRole('status').getAttribute('data-page-refresh-notice')).toBe('lost')
  })

  it('keeps the English dictionary key-identical to the Chinese one', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })
})
