/**
 * Read the explicit appearance and language choices the web UI stored, for a
 * window that opens before the server exists.
 * @module @deepseek-ai/dsh-desktop-shell/theme-preference
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isMap, isSeq, parseDocument } from 'yaml'
import { DESKTOP_PROFILE, profileDirectory } from './profile-seed.ts'

/** An explicit appearance; `system` and anything unreadable leave the choice to the OS. */
export type StoredAppearance = 'light' | 'dark'

/**
 * The `ui-theme` preference the user chose, or undefined when the OS decides.
 *
 * The profile's own patch layer holds it once the settings page or the
 * one-time `settings.yaml` migration has written the `ui-theme` row; the last
 * id-targeted row for that id is the one the loader applies. A profile with no
 * such row reads the preference from `settings.yaml`, which is where an
 * upgraded client keeps it until the migration has run: the boot window opens
 * before that, on the first launch after the upgrade.
 * @param home - the Harness home.
 * @returns `light` or `dark` when one was chosen explicitly.
 */
export function storedThemePreference(home: string): StoredAppearance | undefined {
  const preference = storedPreference(home, 'ui-theme')
  return preference === 'light' || preference === 'dark' ? preference : undefined
}

/** A language the shell writes its own copy in. */
export type StoredLanguage = 'zh' | 'en'

/**
 * The language the user chose in the web UI's settings, or undefined when the
 * UI follows the system. The `locale` row's `config.preference` holds it, read
 * the same way as the `ui-theme` preference; a Chinese or English locale id
 * (`zh`, `zh-CN`, `en-US`, …) maps to its language, and any other id is left
 * to the system locale.
 * @param home - the Harness home.
 * @returns `zh` or `en` when one was chosen explicitly.
 */
export function storedLanguagePreference(home: string): StoredLanguage | undefined {
  const preference = storedPreference(home, 'locale')
  if (typeof preference !== 'string') return undefined
  const language = preference.toLowerCase().split('-')[0]
  return language === 'zh' || language === 'en' ? language : undefined
}

/**
 * The `preference` a settings row holds: the last id-targeted row in the
 * profile's patch layer, or `settings.yaml` when the layer has no such row.
 * @param home - the Harness home.
 * @param id - the row id, which is also the `settings.yaml` section name.
 * @returns the stored value, unvalidated.
 */
function storedPreference(home: string, id: string): unknown {
  const row = rowPreference(join(profileDirectory(home, DESKTOP_PROFILE), 'cordis.patch.yml'), id)
  return row.found ? row.preference : legacyPreference(join(home, 'settings.yaml'), id)
}

/** The `config.preference` of the last row targeting `id`, and whether there is such a row. */
function rowPreference(patchPath: string, id: string): { found: boolean; preference?: unknown } {
  let text: string
  try {
    text = readFileSync(patchPath, 'utf8')
  } catch {
    // No patch layer yet: a profile the seeding has not created holds no row.
    return { found: false }
  }
  const document = parseDocument(text, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] })
  if (document.errors.length > 0 || !isSeq(document.contents)) return { found: false }
  const index = document.contents.items.findLastIndex((item, at) => isMap(item) && document.getIn([at, 'id']) === id && !item.has('insert'))
  if (index < 0) return { found: false }
  return { found: true, preference: document.getIn([index, 'config', 'preference']) }
}

/** `<section>.preference` in `settings.yaml`, or undefined when there is none. */
function legacyPreference(settingsPath: string, section: string): unknown {
  let text: string
  try {
    text = readFileSync(settingsPath, 'utf8')
  } catch {
    // No settings file: nothing was chosen.
    return undefined
  }
  const document = parseDocument(text)
  return document.errors.length > 0 ? undefined : document.getIn([section, 'preference'])
}
