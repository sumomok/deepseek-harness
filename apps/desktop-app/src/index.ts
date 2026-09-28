/**
 * Desktop composition layer, node half, mounted by the `desktop-brand` row.
 * It registers one global system-prompt section that names the app's own
 * directories and tells the model to leave them alone unless the user asks;
 * the browser half ships through `exports["./client"]`.
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

/**
 * The directories the line can name, in the order it lists them. `dataDir` is
 * always named; each other one only when the launch supplies its path.
 */
export const DIRECTORY_KEYS = ['installDir', 'dataDir', 'appDataDir', 'logDir', 'updateCacheDir'] as const

/** One directory the line can name. */
export type DirectoryKey = typeof DIRECTORY_KEYS[number]

/** Configuration the `desktop-brand` row states. */
export interface Config {
  /** The line; it must contain exactly the placeholders `{directories}` and `{skillsDir}`. */
  protectedDirsPrompt: string
  /** One clause per directory; each must contain exactly its own `{key}` placeholder. */
  directoryClauses: Record<DirectoryKey, string>
  /** Text between listed clauses except the last two. */
  directorySeparator: string
  /** Text between the last two listed clauses. */
  directoryLastSeparator: string
  /** The installation directory; absent when the launch has none. */
  installDir?: string
  /** The desktop shell's Electron `userData` directory; absent outside the shell. */
  appDataDir?: string
  /** The desktop shell's log directory; absent outside the shell. */
  logDir?: string
  /** The desktop shell's update download cache; absent outside the shell. */
  updateCacheDir?: string
}

/** @returns a required template text with a non-whitespace character. */
const text = (): z<string> => z.string().pattern(/\S/).required()

/** @returns an optional path that is not blank when present. */
const path = (): z<string> => z.string().pattern(/\S/)

/** Configuration schema; every text is required, every path optional and non-blank. */
export const Config: z<Config> = z.object({
  protectedDirsPrompt: text(),
  directoryClauses: z.object({
    installDir: text(),
    dataDir: text(),
    appDataDir: text(),
    logDir: text(),
    updateCacheDir: text(),
  }).required(),
  directorySeparator: z.string().required(),
  directoryLastSeparator: z.string().required(),
  installDir: path(),
  appDataDir: path(),
  logDir: path(),
  updateCacheDir: path(),
})

/** The paths one line names: the data directory and its skills folder always, the rest when known. */
export type ProtectedDirectories = { [K in DirectoryKey]?: string | undefined } & { dataDir: string; skillsDir: string }

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
 * Validate the line's and every clause's placeholders.
 * @param config - the validated {@link Config}.
 * @throws {Error} when a template's placeholders are not exactly its required set.
 */
export function checkTemplates(config: Config): void {
  checkPlaceholders('protectedDirsPrompt', config.protectedDirsPrompt, ['directories', 'skillsDir'])
  for (const key of DIRECTORY_KEYS) checkPlaceholders(`directoryClauses.${key}`, config.directoryClauses[key], [key])
}

/**
 * Replace each placeholder in one pass; inserted values are not scanned again.
 * @param template - the template text.
 * @param values - the text each placeholder becomes.
 * @returns the filled text.
 */
function fill(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(PLACEHOLDER, (placeholder, key: string) => values[key] ?? placeholder)
}

/**
 * Fill the line: one clause per known directory in {@link DIRECTORY_KEYS}
 * order, joined with the configured separators, each path in backticks.
 * @param config - a {@link Config} whose templates passed {@link checkTemplates}.
 * @param directories - the paths to name.
 * @returns the prompt text.
 */
export function renderProtectedDirsPrompt(config: Config, directories: ProtectedDirectories): string {
  const clauses = DIRECTORY_KEYS.flatMap((key) => {
    const value = directories[key]
    return value === undefined ? [] : [fill(config.directoryClauses[key], { [key]: `\`${value}\`` })]
  })
  const last = clauses.pop() ?? ''
  const joined = clauses.length === 0 ? last : `${clauses.join(config.directorySeparator)}${config.directoryLastSeparator}${last}`
  return fill(config.protectedDirsPrompt, { directories: joined, skillsDir: `\`${directories.skillsDir}\`` })
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
  const line = renderProtectedDirsPrompt(config, {
    installDir: config.installDir,
    dataDir,
    appDataDir: config.appDataDir,
    logDir: config.logDir,
    updateCacheDir: config.updateCacheDir,
    skillsDir: join(dataDir, SKILLS_DIR_NAME),
  })
  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.systemPrompt.section({
      name: PROTECTED_DIRECTORIES_SECTION,
      order: promptCtx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX'),
      text: line,
      interpolate: false,
    })
  })
}
