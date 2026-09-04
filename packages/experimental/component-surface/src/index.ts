/**
 * @deepseek-ai/dsh-experimental-component-surface — the agent places a block of
 * interface in the content panel.
 *
 * The host half offers `show_component` to the model, judges each call against
 * a fixed catalog before anything is drawn, claims the `component` kind of the
 * [content surface](../content-surface/README.md)'s entry stream, and takes back
 * what the user does inside a drawn block through the `/component-action`
 * command. What the column draws is a component package's — a browser row claims
 * the `component` key of the `content.surface.kind` slot and receives each
 * entry's validated spec as its payload.
 *
 * Nothing here appends a session event. A call's record is the `tool/call` the
 * loop already writes, and an action's is the `command/run` the command registry
 * already writes, so both directions replay from the log the agent actually
 * wrote and removing this row leaves every past session readable.
 *
 * The catalog, the ceilings, and the judgement live in three modules of their
 * own — `component-call.ts`, `sanitize.ts` and `validate.ts` — because the
 * browser seat runs the identical pass over the payload arriving on the wire and
 * must not pull a tool runtime into a page to do it. `component-call.ts`
 * therefore imports nothing at all, `sanitize.ts` imports only it, and
 * `validate.ts` imports only those two.
 *
 * Trust: `spec` is model output that becomes a rendered block inside the
 * shell's own origin. It is bounded rather than trusted, and the bound is the
 * catalog's property schema — which cannot express markup or a function body, so
 * there is no such value for a later pass to have to recognize. The one thing a
 * schema cannot say is what a string means, so a component reading one as a
 * path, a color, or a renderer name declares that beside the schema and
 * `sanitize.ts` drops what falls outside it (see the README's trust section).
 * @module @deepseek-ai/dsh-experimental-component-surface
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: resolves ctx.contentSurface for the optional extractor child.
import type {} from '@deepseek-ai/dsh-experimental-content-surface'
// Type-only: resolves ctx.commands for the optional /component-action child.
import type {} from '@deepseek-ai/dsh-commands'
import { installComponentAction } from './command.ts'
import { componentExtractor } from './surface.ts'
import { showComponentTool } from './tool.ts'

/** Stable Cordis plugin name. */
export const name = 'show-component'

/**
 * Service required before the offer exists at all. The extractor is an optional
 * child instead: a deployment with no content column still gets the tool, and
 * the calls it records are still in the log for a composition that later grows
 * one.
 */
export const inject = ['tools']

/*
 * No `Config`.
 *
 * The numbers a deployment might want to move — the spec byte ceiling, the node
 * ceiling, the nesting ceiling, the action byte ceiling — are enforced twice:
 * here, and again by the browser seat over the value that arrives on the wire.
 * The seat receives no Cordis configuration (`content-frame`'s `route.ts`
 * records why), so a per-deployment ceiling would be a ceiling the two halves
 * disagree on: a block silently missing from the column instead of a refusal the
 * model can act on. They stay protocol constants in `component-call.ts` until
 * the seat can read a deployment's settings, at which point the ceilings and the
 * route that serves them arrive together.
 *
 * An action's report grade is not a ceiling and is not configuration either. It
 * says what a gesture means — a pressed confirmation is the answer the agent
 * stopped for — so it is declared beside the action in the catalog, and a
 * deployment that moved it would be changing what the agent is told happened.
 */

/**
 * Claim the tool, and the content kind and its return channel wherever a column
 * is composed.
 * @param ctx - plugin context carrying the tool runtime.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.tools.register(showComponentTool()), 'show-component: the show_component tool')
  ctx.inject(['contentSurface'], (surfaceCtx) => {
    // `register` scopes its own disposer to the injected child, which is what
    // releases the kind when the fiber goes away.
    surfaceCtx.contentSurface.register(componentExtractor())
  })
  // The return channel needs all three: the registry the command lives in, the
  // router that made the entry, and the projection the entry is read out of.
  // Without a column there is nothing on screen for an action to name, so the
  // command is absent rather than answering every gesture with a refusal.
  ctx.inject(['commands', 'contentSurface', 'sessionProjections'], installComponentAction)
}
