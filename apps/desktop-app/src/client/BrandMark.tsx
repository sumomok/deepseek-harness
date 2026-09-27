/**
 * Sidebar brand mark for the desktop application: the fish logo drawn larger
 * than the size the sidebar asks for.
 * @module @deepseek-ai/dsh-desktop-app/client/BrandMark
 */
import { FishLogo } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'

/**
 * Width of the rendered logo relative to the owner's `size`. ui-sidebar asks
 * for 24 in the expanded brand row and in the collapsed rail, so the logo is 30
 * wide and 22 tall: inside the row's 24px identity box, and inside the rail's
 * 36px toggle.
 */
export const BRAND_MARK_SCALE = 1.25

/**
 * Render the fish logo at {@link BRAND_MARK_SCALE} times the owner's size.
 * @param props - owner geometry.
 * @returns the brand-mark occupant.
 */
export function DesktopBrandMark({ size }: SidebarBrandMarkOwnerProps) {
  return <FishLogo size={size * BRAND_MARK_SCALE} />
}
