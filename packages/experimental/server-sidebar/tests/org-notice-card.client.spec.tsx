// @vitest-environment jsdom
/**
 * The organization notice card as a member reads it: the organization's
 * text in the page's language, this package's words around it, one button
 * for a notice and two for a disclosure to agree to, a refused agreement on
 * the card, where the card stands, and that it takes no focus.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { OrgNotice, type OrgNoticeProps } from '../src/client/OrgNotice.tsx'
import type { OrgNoticeView, ShownDue } from '../src/client/org-notice.ts'
import type { FootPlacement } from '../src/client/foot-placement.ts'
import { en, zh } from '../src/client/locales.ts'
import { DISCLOSURE, shownDue } from './fixtures/org-notice-port.client.ts'

afterEach(cleanup)

/** What one render shows. */
interface Bench {
  view: OrgNoticeView
  placement?: FootPlacement
  language?: 'zh' | 'en'
  dictionary?: Record<string, string>
}

/**
 * Render the card.
 * @param bench - the view, the placement, the language, and the dictionary.
 * @returns the three actions' spies and the render result.
 */
function mount({ view, placement, language = 'en', dictionary = en }: Bench) {
  const acknowledge = vi.fn()
  const later = vi.fn()
  const consent = vi.fn()
  const props: OrgNoticeProps = {
    useOrgNotice: select => select(view),
    useFootPlacement: select => select(placement),
    useLanguage: select => select(language),
    acknowledge,
    later,
    consent,
    t: makeTranslate(dictionary),
  }
  const result = render(<OrgNotice {...props} />)
  return { acknowledge, later, consent, result }
}

/**
 * A view showing one answer.
 * @param shown - the answer.
 * @param state - where its agreement stands.
 * @returns the view.
 */
function showing(shown: ShownDue, state: { confirming?: boolean; failed?: boolean } = {}): OrgNoticeView {
  return { shown, confirming: state.confirming ?? false, failed: state.failed ?? false }
}

describe('OrgNotice', () => {
  it('draws nothing while there is nothing to show', () => {
    const { result } = mount({ view: { shown: undefined } })
    expect(result.container.innerHTML).toBe('')
  })

  it('shows a notice as a non-modal dialog titled by the organization\'s title, with one button', () => {
    const { acknowledge } = mount({ view: showing(shownDue('notice', 2)) })
    const card = screen.getByRole('dialog', { name: 'About the data we collect' })
    expect(card.getAttribute('aria-modal')).toBeNull()
    expect(card.getAttribute('data-server-sidebar-org-notice')).toBe('notice')
    expect(screen.getAllByRole('button').map(button => button.textContent)).toEqual(['Got it'])
    expect(document.activeElement).toBe(document.body)
    fireEvent.click(screen.getByRole('button', { name: 'Got it' }))
    expect(acknowledge).toHaveBeenCalledOnce()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('reads every part of the disclosure in English', () => {
    mount({ view: showing(shownDue('notice', 2)) })
    const card = screen.getByRole('dialog')
    expect(card.querySelector('p')?.textContent).toBe('We collect how the console runs.\nSecond line.')
    expect([...card.querySelectorAll('li')].map(item => item.textContent)).toEqual(['Usage', 'Errors'])
    for (const text of [
      'What is collected', 'Sent to “Acme”', 'Who can view it', 'You and the administrators of “Acme”',
      'How long it is kept', '30 days', 'Contact: privacy@example.test',
      'You can read this again in Settings → Organization',
    ]) {
      expect(card.textContent).toContain(text)
    }
    const policy = screen.getByRole('link', { name: 'Read the full policy' })
    expect(policy.getAttribute('href')).toBe('https://example.test/policy')
    expect(policy.getAttribute('target')).toBe('_blank')
    expect(policy.getAttribute('rel')).toBe('noopener noreferrer')
  })

  it('reads the organization\'s text in Chinese on a Chinese page, with this package\'s Chinese words', () => {
    mount({ view: showing(shownDue('notice', 2)), language: 'zh', dictionary: zh })
    const card = screen.getByRole('dialog', { name: '数据收集说明' })
    expect([...card.querySelectorAll('li')].map(item => item.textContent)).toEqual(['使用情况', '运行出错信息'])
    for (const text of ['我们会收集运行情况。', '收集的内容', '发往「Acme」', '你本人和「Acme」的管理员', '30 天', '查看完整说明']) {
      expect(card.textContent).toContain(text)
    }
    expect(screen.getByRole('button', { name: '知道了' })).toBeTruthy()
  })

  it('names no organization when the plugin knows no name', () => {
    for (const orgName of [undefined, '  ']) {
      const shown: ShownDue = { kind: 'notice', version: 2, disclosure: DISCLOSURE, ...orgName === undefined ? {} : { orgName } }
      const { result } = mount({ view: showing(shown) })
      expect(result.container.textContent).toContain('Sent to your organization')
      expect(result.container.textContent).toContain('You and your organization’s administrators')
      result.unmount()
    }
  })

  it('says who can view it, how long it is kept, and leaves out what the organization did not give', () => {
    const disclosure = { ...DISCLOSURE, viewers: 'self' as const, retentionDays: 1, categories: [], contact: '', policyUrl: 'http://example.test/policy' }
    const { result } = mount({ view: showing(shownDue('notice', 2, { disclosure })) })
    expect(result.container.textContent).toContain('Only you')
    expect(result.container.textContent).toContain('1 day')
    expect(result.container.querySelector('ul')).toBeNull()
    expect(result.container.textContent).not.toContain('Contact:')
    expect(screen.queryByRole('link')).toBeNull()
    result.unmount()
    mount({ view: showing(shownDue('notice', 2, { disclosure: { ...DISCLOSURE, policyUrl: 'not a url' } })) })
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('asks for agreement with 稍后 and 同意, and sends each', () => {
    const { later, consent } = mount({ view: showing(shownDue('consent', 4)) })
    expect(screen.getByRole('dialog').getAttribute('data-server-sidebar-org-notice')).toBe('consent')
    expect(screen.getAllByRole('button').map(button => button.textContent)).toEqual(['Later', 'I agree'])
    fireEvent.click(screen.getByRole('button', { name: 'Later' }))
    fireEvent.click(screen.getByRole('button', { name: 'I agree' }))
    expect(later).toHaveBeenCalledOnce()
    expect(consent).toHaveBeenCalledOnce()
  })

  it('takes no second answer while an agreement travels', () => {
    mount({ view: showing(shownDue('consent', 4), { confirming: true }) })
    expect(screen.getByRole('button', { name: 'Later' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: 'I agree' }).hasAttribute('disabled')).toBe(true)
  })

  it('says on the card that an agreement was not recorded', () => {
    mount({ view: showing(shownDue('consent', 4), { failed: true }), language: 'zh', dictionary: zh })
    expect(screen.getByRole('alert').textContent).toBe('没有记下你的同意，请稍后再试')
    expect(screen.getByRole('button', { name: '同意' }).hasAttribute('disabled')).toBe(false)
  })

  it('stands where the sidebar measured its foot band, and draws nothing until it has', () => {
    const { result } = mount({ view: showing(shownDue('notice', 2)) })
    const unplaced = screen.getByRole('dialog')
    expect(unplaced.hasAttribute('data-unplaced')).toBe(true)
    expect(unplaced.getAttribute('style')).toBeNull()
    result.unmount()
    mount({ view: showing(shownDue('notice', 2)), placement: { left: 0, width: 210, bottom: 62.5 } })
    const placed = screen.getByRole('dialog')
    expect(placed.hasAttribute('data-unplaced')).toBe(false)
    expect(placed.style.getPropertyValue('--server-sidebar-notice-left')).toBe('0px')
    expect(placed.style.getPropertyValue('--server-sidebar-notice-width')).toBe('210px')
    expect(placed.style.getPropertyValue('--server-sidebar-notice-bottom')).toBe('62.5px')
  })
})
