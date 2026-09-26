/**
 * Sidebar product name for the desktop application, with the desktop release
 * version stacked under it.
 * @module @deepseek-ai/dsh-desktop-app/client/BrandName
 */
import type { CSSProperties } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { NS } from './locales.ts'

/** Props the occupant reads: its own dictionary. */
export type DesktopBrandNameProps = PropsLocale<typeof NS>

// Same geometry as ui-sidebar's local-build fallback, so the brand row keeps
// its height when this occupant replaces that fallback.
const STACK: CSSProperties = {
  flex: 'none',
  display: 'inline-flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  justifyContent: 'center',
  gap: 1,
  height: 24,
  whiteSpace: 'nowrap',
}
const NAME_ONLY: CSSProperties = { fontSize: 17, letterSpacing: 0, whiteSpace: 'nowrap' }
const NAME_STACKED: CSSProperties = { fontSize: 12, lineHeight: '13px', letterSpacing: 0 }
const VERSION: CSSProperties = {
  flex: 'none',
  display: 'inline-flex',
  alignItems: 'center',
  height: 10,
  padding: '0 3px',
  borderRadius: 2,
  color: 'var(--dsw-alias-label-primary-inverted)',
  background: 'var(--dsw-alias-label-primary)',
  fontFamily: 'var(--ds-font-family-code)',
  fontSize: 6,
  fontWeight: 500,
  lineHeight: '10px',
  whiteSpace: 'nowrap',
}

/**
 * Render the localized product name, and under it the release version the
 * desktop packaging build embeds as `DSH_CLIENT_VERSION`. A build without that
 * value shows the name alone.
 * @param props - localized copy.
 * @returns the brand-name occupant.
 */
export function DesktopBrandName({ t }: DesktopBrandNameProps) {
  const version = process.env.DSH_CLIENT_VERSION
  if (version === undefined) return <span style={NAME_ONLY}>{t('name')}</span>
  return (
    <span style={STACK}>
      <span style={NAME_STACKED}>{t('name')}</span>
      <span style={VERSION}>{version}</span>
    </span>
  )
}
