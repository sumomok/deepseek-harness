/**
 * The two palettes the desktop shell paints before the web UI takes over, and
 * the rule for choosing between them.
 * @module @deepseek-ai/dsh-desktop/theme
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { nativeTheme } from 'electron'
import { load } from 'js-yaml'

/**
 * The DeepSeek Harness home and its override, copied from
 * `@deepseek-ai/dsh-home-paths` rather than imported: the packaged app ships
 * only `apps/desktop/lib`, so it carries no workspace dependencies. These two
 * names are the contract that package defines.
 */
const DSH_HOME_DIR_NAME = '.dsh'
const DSH_HOME_ENV = 'DSH_HOME'

/**
 * Boot-page palettes, taken from the web UI's token sheet
 * (`packages/client/ui-theme/src/styles/design-platform.css`) so the splash and
 * the app it hands over to are the same two colors rather than two designs.
 * Dark keeps the deep-navy treatment this splash already had; only its text and
 * accent are aligned to the shared tokens.
 */
export const PALETTES = {
  light: {
    /** `--dsw-alias-bg-base` */
    background: '#FFFFFF',
    gradient: 'linear-gradient(135deg, #FFFFFF 0%, #F2F4F8 100%)',
    /** `--dsw-alias-label-primary` */
    text: '#0F1115',
    /** `--dsw-alias-label-tertiary` */
    muted: '#81858C',
    /** `--dsw-alias-state-business-primary` */
    accent: '#4176E6',
    /** Red is not a shared token; this is the one boot-page-only color. */
    danger: '#D93F4C',
    grid: 'rgba(0, 0, 0, .03)',
    vignette: 'rgba(15, 17, 21, .06)',
    glow: 'rgba(65, 118, 230, .10)',
    /** Progress-bar trough, the one surface only the download window uses. */
    track: '#E6E8EC',
  },
  dark: {
    background: '#0B101F',
    gradient: 'linear-gradient(135deg, #0B101F 0%, #111A33 100%)',
    /** `--dsw-alias-label-primary` (dark) */
    text: '#F9FAFB',
    /** `--dsw-alias-label-tertiary` (dark) */
    muted: '#ADB2B8',
    /** `--dsw-alias-state-business-primary` (dark) */
    accent: '#679EFE',
    danger: '#FF5470',
    grid: 'rgba(255, 255, 255, .02)',
    vignette: 'rgba(4, 7, 16, .55)',
    glow: 'rgba(103, 158, 254, .08)',
    track: '#232A3A',
  },
} as const

/** Which palette a launch uses. */
export type Appearance = keyof typeof PALETTES

/**
 * Resolve the appearance the app itself will use, so the window opens in the
 * colors the UI is about to paint instead of flashing the other theme.
 *
 * The web UI keeps a durable `light`/`dark`/`system` preference in the shared
 * settings file, and its default is `system`. Reading it here is what makes an
 * explicit choice survive the splash; anything else — no file, unreadable file,
 * or `system` — falls back to what the OS reports.
 * @returns the palette key for this launch.
 */
export function resolveAppearance(): Appearance {
  const home = process.env[DSH_HOME_ENV] ?? join(homedir(), DSH_HOME_DIR_NAME)
  try {
    const settings = load(readFileSync(join(home, 'settings.yaml'), 'utf8'))
    const preference = (settings as { 'ui-theme'?: { preference?: unknown } } | null)?.['ui-theme']?.preference
    if (preference === 'light' || preference === 'dark') return preference
  } catch {
    // No settings file yet, or nothing readable in it: the OS decides, which is
    // also what the web UI does for its default `system` preference.
  }
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
}
