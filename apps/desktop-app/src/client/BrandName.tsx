/**
 * Sidebar product name for the desktop application.
 * @module @deepseek-ai/dsh-desktop-app/client/BrandName
 */
import type { CSSProperties } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { NS } from './locales.ts'

/** Props the occupant reads: its own dictionary. */
export type DesktopBrandNameProps = PropsLocale<typeof NS>

// The weight stays ui-sidebar's, which a Windows titlebar lowers to 400.
const NAME: CSSProperties = { fontSize: 18, lineHeight: '24px', letterSpacing: 0, whiteSpace: 'nowrap' }

/**
 * Render the localized product name.
 * @param props - localized copy.
 * @returns the brand-name occupant.
 */
export function DesktopBrandName({ t }: DesktopBrandNameProps) {
  return <span style={NAME}>{t('name')}</span>
}
