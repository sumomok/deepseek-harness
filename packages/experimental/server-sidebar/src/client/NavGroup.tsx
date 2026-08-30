/**
 * The 导航 (navigation) group: `dsh-experimental-content-frame`'s configured
 * pages, one click away from the content column. Pure presentation — every
 * list comes from props (decision ⑤: navigation follows deployment
 * configuration order, never user-reordered).
 * @module @deepseek-ai/dsh-experimental-server-sidebar/client/NavGroup
 */
import type { MenuPage } from './pages.ts'
import type { ServerSidebarKey } from './locales.ts'
import css from './SidebarGroups.module.css'

/** Full props of the navigation group. */
export interface NavGroupProps {
  /** The deployment's configured content-column pages, in declaration order. */
  pages: readonly MenuPage[]
  /** Open a configured page, creating a session first when none is current. Not awaited by this component. */
  onOpenPage: (pageId: string) => Promise<void>
  /** Locale seat. */
  t: (key: ServerSidebarKey, vars?: Record<string, string>) => string
}

/**
 * Render the navigation group.
 * @param props - see {@link NavGroupProps}.
 * @returns the group element tree.
 */
export function NavGroup({ pages, onOpenPage, t }: NavGroupProps) {
  return (
    <section className={css.group} data-server-sidebar-section="nav">
      <h3 className={css.groupTitle}>{t('nav.title')}</h3>
      {pages.length === 0
        ? <p className={css.empty}>{t('nav.empty')}</p>
        : (
          <ul className={css.list}>
            {pages.map(page => (
              <li key={page.id}>
                <button type="button" className={css.itemButton} onClick={() => { void onOpenPage(page.id) }}>
                  {page.title}
                </button>
              </li>
            ))}
          </ul>
        )}
    </section>
  )
}
