/**
 * Document-level theme writes for this shell.
 *
 * `ctx.theme` resolves the active theme but never touches the DOM: the shipped
 * shell plugin is what projects each snapshot onto the document, so a
 * composition that replaces the shell has to carry the projection with it or
 * the Appearance preference stops repainting anything. The projection is pure
 * DOM writes with no React involvement, and it only ever retracts names it
 * wrote itself, so a foreign inline variable on body survives.
 *
 * The host-rendered boot script (`dsh-client-ui-theme`) writes the same root
 * `color-scheme` and body palette attribute before any plugin loads; these
 * functions take that state over rather than initialize it.
 */
import type { ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'

/** Body attribute the token stylesheets read to select the dark base palette. */
export const DARK_PALETTE_ATTRIBUTE = 'data-ds-dark-theme'

/**
 * Project one resolved snapshot onto the document: root `color-scheme` for
 * native UA chrome, the body palette attribute from `active.colorScheme`
 * (never the theme id — `system` is resolved upstream), and the active theme's
 * alias-token overrides as inline variables on body.
 * @param snapshot - resolved theme snapshot from ctx.theme.
 * @param applied - token names the previous projection wrote, removed first.
 * @returns the token names this projection wrote, to pass back as `applied` next time.
 */
export function projectTheme(snapshot: ThemeSnapshot, applied: readonly string[]): string[] {
  const body = document.body
  for (const name of applied) body.style.removeProperty(name)
  const { colorScheme, tokens } = snapshot.active
  document.documentElement.style.colorScheme = colorScheme
  body.toggleAttribute(DARK_PALETTE_ATTRIBUTE, colorScheme === 'dark')
  for (const [name, value] of Object.entries(tokens)) body.style.setProperty(name, value)
  return Object.keys(tokens)
}

/**
 * Retract every field {@link projectTheme} owns, leaving the document as it was
 * before the shell mounted.
 * @param applied - token names the last projection wrote.
 */
export function retractTheme(applied: readonly string[]): void {
  const body = document.body
  for (const name of applied) body.style.removeProperty(name)
  body.removeAttribute(DARK_PALETTE_ATTRIBUTE)
  document.documentElement.style.removeProperty('color-scheme')
}
