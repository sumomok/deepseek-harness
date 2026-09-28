/**
 * Desktop composition layer, node half, mounted by the `desktop-brand` row.
 * It registers one global system-prompt section that tells the model to leave
 * the app's installation directory and data directory alone unless the user
 * asks; the browser half ships through `exports["./client"]`.
 * @module @deepseek-ai/dsh-desktop-app
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-system-prompt'

/** Cordis plugin name. */
export const name = 'desktop-app'

/** Name of the global system-prompt section this plugin registers. */
export const PROTECTED_DIRECTORIES_SECTION = 'desktop:protected-directories'

/** Configuration the `desktop-brand` row states. */
export interface Config {
  /**
   * Model-facing instruction about the app's installation and data
   * directories. Registered as literal text: `{{…}}` is not interpolated.
   */
  protectedDirsPrompt: string
}

/** Configuration schema; the text is required and must contain a non-whitespace character. */
export const Config: z<Config> = z.object({
  protectedDirsPrompt: z.string().pattern(/\S/).required(),
})

/**
 * Register the protected-directories section once the prompt registry is
 * available. The section is global and ordered at
 * `DEPLOYMENT_PERSONA_SUFFIX`; equal orders sort by name, so it follows the
 * persona suffix in every scope. A scope whose persona is `complete` replaces
 * the whole prompt and does not carry it.
 * @param ctx - the plugin context.
 * @param config - the validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.systemPrompt.section({
      name: PROTECTED_DIRECTORIES_SECTION,
      order: promptCtx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX'),
      text: config.protectedDirsPrompt,
      interpolate: false,
    })
  })
}
