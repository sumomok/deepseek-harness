/**
 * Desktop composition layer, node half, mounted by the `desktop-brand` row.
 * It registers one global system-prompt section that names the app's
 * installation directory and data directory and tells the model to leave them
 * alone unless the user asks; the browser half ships through
 * `exports["./client"]`.
 * @module @deepseek-ai/dsh-desktop-app
 */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type {} from '@deepseek-ai/dsh-system-prompt'

/** Cordis plugin name. */
export const name = 'desktop-app'

/** Name of the global system-prompt section this plugin registers. */
export const PROTECTED_DIRECTORIES_SECTION = 'desktop:protected-directories'

/**
 * The user skill folder under the data directory. `@deepseek-ai/dsh-skill-filesystem`
 * reads its `user-dsh` root at this name under the resolved home and exports no
 * constant for it; `tests/protected-directories.spec.ts` loads a skill from here
 * through that provider, so a move there fails the test.
 */
export const SKILLS_DIR_NAME = 'skills'

/** Configuration the `desktop-brand` row states. */
export interface Config {
  /**
   * Template used when `installDir` is set. It must contain exactly the
   * placeholders `{installDir}`, `{dataDir}`, and `{skillsDir}`.
   */
  protectedDirsPrompt: string
  /**
   * Template used when `installDir` is unset, as in a development launch. It
   * must contain exactly `{dataDir}` and `{skillsDir}`.
   */
  protectedDirsPromptDataOnly: string
  /** The installation directory; absent when the launch has none. */
  installDir?: string
}

/** Configuration schema; each text must contain a non-whitespace character. */
export const Config: z<Config> = z.object({
  protectedDirsPrompt: z.string().pattern(/\S/).required(),
  protectedDirsPromptDataOnly: z.string().pattern(/\S/).required(),
  installDir: z.string().pattern(/\S/),
})

/** The directories one prompt names. */
export interface ProtectedDirectories {
  /** The installation directory, or `undefined` when the launch has none. */
  installDir?: string | undefined
  /** The resolved harness home. */
  dataDir: string
  /** The user skill folder under {@link ProtectedDirectories.dataDir}. */
  skillsDir: string
}

/** One `{name}` placeholder, letters only. */
const PLACEHOLDER = /\{([A-Za-z]+)\}/gu

/**
 * Refuse a template whose placeholders are not exactly the required set.
 * @param field - the config field, named in the error.
 * @param template - the template text.
 * @param required - the placeholder names the template must contain.
 * @throws {Error} when a required placeholder is missing or an unknown one is present.
 */
function checkPlaceholders(field: string, template: string, required: readonly string[]): void {
  const found = new Set([...template.matchAll(PLACEHOLDER)].map(match => match[1] ?? ''))
  const missing = required.filter(placeholder => !found.has(placeholder))
  const unknown = [...found].filter(placeholder => !required.includes(placeholder))
  if (missing.length === 0 && unknown.length === 0) return
  const list = (names: readonly string[]): string => names.map(placeholder => `{${placeholder}}`).join(', ')
  throw new Error(`desktop-app: ${field} must contain exactly ${list(required)}`
    + (missing.length > 0 ? `; missing ${list(missing)}` : '')
    + (unknown.length > 0 ? `; unknown ${list(unknown)}` : ''))
}

/**
 * Validate both templates' placeholders.
 * @param config - the validated {@link Config}.
 * @throws {Error} when either template's placeholders are not exactly its required set.
 */
export function checkTemplates(config: Config): void {
  checkPlaceholders('protectedDirsPrompt', config.protectedDirsPrompt, ['installDir', 'dataDir', 'skillsDir'])
  checkPlaceholders('protectedDirsPromptDataOnly', config.protectedDirsPromptDataOnly, ['dataDir', 'skillsDir'])
}

/**
 * Fill the template that fits the directories, each path in backticks.
 * @param config - a {@link Config} whose templates passed {@link checkTemplates}.
 * @param directories - the paths to name.
 * @returns the prompt text.
 */
export function renderProtectedDirsPrompt(config: Config, directories: ProtectedDirectories): string {
  const template = directories.installDir === undefined ? config.protectedDirsPromptDataOnly : config.protectedDirsPrompt
  const values: Record<string, string | undefined> = { ...directories }
  return template.replace(PLACEHOLDER, (placeholder, key: string) => {
    const value = values[key]
    return value === undefined ? placeholder : `\`${value}\``
  })
}

/**
 * Check the templates, then register the protected-directories section once
 * the prompt registry is available. The data directory is the harness home
 * `resolveDshHome()` resolves, the resolver the server's own plugins use. The
 * section is global and ordered at `DEPLOYMENT_PERSONA_SUFFIX`; equal orders
 * sort by name, so it follows the persona suffix in every scope. A scope
 * whose persona is `complete` replaces the whole prompt and does not carry it.
 * @param ctx - the plugin context.
 * @param config - the validated {@link Config}.
 * @throws {Error} at mount when a template's placeholders are wrong.
 */
export function apply(ctx: Context, config: Config): void {
  checkTemplates(config)
  const dataDir = resolveDshHome()
  const text = renderProtectedDirsPrompt(config, {
    installDir: config.installDir,
    dataDir,
    skillsDir: join(dataDir, SKILLS_DIR_NAME),
  })
  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.systemPrompt.section({
      name: PROTECTED_DIRECTORIES_SECTION,
      order: promptCtx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX'),
      text,
      interpolate: false,
    })
  })
}
