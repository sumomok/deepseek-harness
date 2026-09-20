/**
 * @deepseek-ai/dsh-experimental-system-map — the agent finds its way around the
 * deployment's own business system.
 *
 * A console assistant that cannot name this deployment's data models cannot
 * answer a question about them: asked in a person's own words about "空间图层",
 * it has to guess an English table name, or propose a step that person is not
 * allowed to take. This row closes that by offering three reads, layered
 * because the catalog is too large to carry around — the subject areas, the
 * models of one subject area, and one model in full.
 *
 * Perception, and nothing else. No read writes anything, asks anybody anything,
 * or looks at a screen, so none of them is put to a person first: what they
 * answer with is the deployment's own stored configuration and the signed-in
 * person's own rights. The values in a row are another seam's business and stay
 * there.
 *
 * Nothing here is named on the context. This row registers three tools and no
 * service, holds no credential and opens no socket: every backend read goes
 * through `ctx.bizBackend`, and a deployment that composed no backend is
 * offered no tool at all rather than three that refuse every call.
 * @module @deepseek-ai/dsh-experimental-system-map
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Type-only: resolves ctx.tools, which the three reads are registered on.
import type {} from '@deepseek-ai/dsh-tools'
// Type-only: resolves ctx.bizBackend, which every read goes through.
import type {} from '@deepseek-ai/dsh-experimental-biz-backend'
import { domainModelsTool, domainsTool, modelTool } from './tools.ts'
import type { MapBounds } from './types.ts'

export type * from './types.ts'
export {
  DOMAIN_MODELS_TOOL_NAME,
  DOMAINS_TOOL_NAME,
  MODEL_TOOL_NAME,
} from './text.ts'

/** Stable Cordis plugin name. */
export const name = 'system-map'

/**
 * The service the whole offer waits for.
 *
 * All three tools or none: each description promises an account of this
 * deployment's own business system, and a composition with no backend to read
 * has none to give. A row that registered them anyway would spend a call per
 * tool teaching a model that.
 */
export const inject = ['tools', 'bizBackend']

/** Plugin config: the ceilings one deployment's answers are built under. */
export interface Config {
  /**
   * Most characters one listing's lines may spend between them.
   *
   * The whole answer is this plus its heading, which is a sentence of fixed
   * shape plus the names this deployment gives the subject area or model and at
   * most one note of {@link Config.noteChars} characters.
   */
  listingChars: number
  /** Most fixed values one attribute contributes before the rest are only counted. */
  valuesPerAttribute: number
  /** Most characters one of this deployment's recorded notes contributes. */
  noteChars: number
}

export const Config: z<Config> = z.object({
  listingChars: z.natural().min(200).default(12000)
    .description('Most characters one listing\'s lines may spend between them.'),
  valuesPerAttribute: z.natural().min(1).default(12)
    .description('Most fixed values one attribute contributes before the rest are only counted.'),
  noteChars: z.natural().min(1).default(80)
    .description('Most characters one of this deployment\'s recorded notes contributes.'),
})

/**
 * Offer the three reads for as long as this deployment has a backend to read.
 *
 * Each `register` returns the disposer the effect owns, so disposing this
 * plugin's fiber takes all three offers back off the model's next request.
 * @param ctx - the injected context carrying the tool runtime and the backend seam.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  const bounds: MapBounds = config
  ctx.effect(() => ctx.tools.register(domainsTool(ctx, bounds)), 'system-map: the subject-area listing')
  ctx.effect(() => ctx.tools.register(domainModelsTool(ctx, bounds)), 'system-map: the model listing')
  ctx.effect(() => ctx.tools.register(modelTool(ctx, bounds)), 'system-map: the one-model read')
}
