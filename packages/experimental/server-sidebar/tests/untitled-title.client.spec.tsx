// @vitest-environment jsdom
/**
 * `UntitledTitle`: which sessions get the console's own header title, and the
 * mark `terminology-guard.ts` keys the crumb rule on. The guard rule itself is
 * applied to a header tree built the way `ConversationSessionHeader` renders
 * it, so the pairing of the mark and the selector is checked in one place.
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { installTerminologyGuard } from '../src/client/terminology-guard.ts'
import { lacksDurableTitle, UntitledTitle, type UntitledTitleProps } from '../src/client/UntitledTitle.tsx'
import { en, zh } from '../src/client/locales.ts'

/** The session list `useSessions` selects from. */
type SessionList = Parameters<Parameters<UntitledTitleProps['useSessions']>[0]>[0]

/** The session every case renders the header for. */
const SESSION = SessionId('session-a')

/**
 * Render the component over a session list carrying at most one row.
 * @param row - the session's own title fields, or undefined while its row has not arrived.
 * @param dictionary - the locale table `t` reads.
 */
function renderTitle(row: { title?: string; origin?: 'subagent' } | undefined, dictionary: typeof zh = zh): void {
  const list: SessionList = {
    ids: row === undefined ? [] : [SESSION],
    phase: 'ready',
    projectionsBySession: {},
    byId: row === undefined
      ? {}
      : { [SESSION]: { id: SESSION, displayTitle: 'workspace', running: false, retainedBy: {}, blank: false, updatedAt: 0, ...row } },
  }
  const useSessions: UntitledTitleProps['useSessions'] = selector => selector(list)
  const t: UntitledTitleProps['t'] = key => (dictionary as Record<string, string>)[key] ?? key
  const props = { sessionId: SESSION, useSessions, t } as UntitledTitleProps
  render(<UntitledTitle {...props} />)
}

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  document.getElementById('dsh-server-sidebar-terminology-guard')?.remove()
})

describe('lacksDurableTitle', () => {
  it('is true for a row with no title, a blank title, or no row yet', () => {
    expect(lacksDurableTitle({})).toBe(true)
    expect(lacksDurableTitle({ title: '   ' })).toBe(true)
    expect(lacksDurableTitle(undefined)).toBe(true)
  })

  it('is false for a durable title, whatever it says, and for a delegated session', () => {
    expect(lacksDurableTitle({ title: '周报' })).toBe(false)
    // The working directory's basename as a durable title is still the conversation's own.
    expect(lacksDurableTitle({ title: 'workspace' })).toBe(false)
    expect(lacksDurableTitle({ origin: 'subagent' })).toBe(false)
  })
})

describe('UntitledTitle', () => {
  it('renders the console\'s title under the guard\'s mark for an untitled conversation', () => {
    renderTitle({})
    const title = screen.getByText('工作台')
    expect(title.hasAttribute('data-server-sidebar-untitled-title')).toBe(true)
  })

  it('reads the sidebar\'s own name for the workbench conversation', () => {
    renderTitle({}, en)
    expect(screen.getByText(en['workbench.label'])).toBeTruthy()
    expect(zh['workbench.label']).toBe('工作台')
  })

  it('renders nothing for a titled conversation, so the shipped crumb stays', () => {
    renderTitle({ title: '周报' })
    expect(document.querySelector('[data-server-sidebar-untitled-title]')).toBeNull()
  })
})

describe('the guard rule the mark drives', () => {
  /**
   * The session header's title row as `ConversationSessionHeader` builds it:
   * the crumb `nav` and the action row inside `titleCluster`, class names in
   * tsdown's `[hash]_[local]` form.
   * @param actions - the action row's markup.
   */
  function header(actions: string): void {
    document.body.innerHTML = `
      <div class="h1_titleRow">
        <div class="h2_titleCluster">
          <nav class="h3_crumbs"><span class="h4_crumb h5_crumbCurrent">workspace</span></nav>
          <div class="h6_headerActions">${actions}</div>
        </div>
      </div>`
  }

  const selector = '[class*="titleCluster"]:has([data-server-sidebar-untitled-title]) > nav'

  it('is the rule the guard installs', () => {
    installTerminologyGuard()
    const css = document.getElementById('dsh-server-sidebar-terminology-guard')?.textContent ?? ''
    expect(css).toContain(`${selector} { display: none !important; }`)
  })

  it('matches the crumb navigation while the header holds the mark, and nothing else', () => {
    header('<span data-server-sidebar-untitled-title="">工作台</span>')
    const matched = [...document.querySelectorAll(selector)]
    expect(matched).toHaveLength(1)
    expect(matched[0]?.tagName).toBe('NAV')
  })

  it('matches nothing in a titled conversation\'s header', () => {
    header('<button>存为工作流</button>')
    expect(document.querySelectorAll(selector)).toHaveLength(0)
  })
})
