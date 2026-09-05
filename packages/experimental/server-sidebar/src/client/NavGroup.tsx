/**
 * The 导航 (navigation) group: everything the deployment configured as
 * one-click content — `dsh-experimental-content-frame`'s pages and
 * `dsh-experimental-component-surface`'s views, merged into one list. Pure
 * presentation — every row comes from props (decision ⑤: navigation follows
 * deployment configuration order, never user-reordered).
 * @module @deepseek-ai/dsh-experimental-server-sidebar/client/NavGroup
 */
import type { NavSnapshotItem } from '../workflows.ts'
import type { NavItem } from './nav-catalog.ts'
import type { ServerSidebarKey } from './locales.ts'
import css from './SidebarGroups.module.css'

/** Full props of the navigation group. */
export interface NavGroupProps {
  /** The deployment's configured navigation items, in menu order (see `nav-catalog.ts`). */
  items: readonly NavItem[]
  /** Show one item, creating a session first when none is current. Not awaited by this component. */
  onOpenNavItem: (target: NavSnapshotItem) => Promise<void>
  /** Locale seat. */
  t: (key: ServerSidebarKey, vars?: Record<string, string>) => string
}

/**
 * Render the navigation group.
 * @param props - see {@link NavGroupProps}.
 * @returns the group element tree.
 */
export function NavGroup({ items, onOpenNavItem, t }: NavGroupProps) {
  return (
    <section className={css.group} data-server-sidebar-section="nav">
      <h3 className={css.groupTitle}>{t('nav.title')}</h3>
      {items.length === 0
        ? <p className={css.empty}>{t('nav.empty')}</p>
        : (
          <ul className={css.list}>
            {items.map(item => (
              // Keyed by kind and id together: the two catalogs are configured
              // independently, so a page and a view may share an id.
              <li key={`${item.kind}:${item.entryId}`}>
                <button
                  type="button"
                  className={css.itemButton}
                  data-server-sidebar-nav-kind={item.kind}
                  onClick={() => { void onOpenNavItem({ kind: item.kind, entryId: item.entryId }) }}
                >
                  {item.title}
                </button>
              </li>
            ))}
          </ul>
        )}
    </section>
  )
}
