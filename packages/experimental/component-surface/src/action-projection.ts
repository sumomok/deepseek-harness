/**
 * The `componentActions` projection unit: one session's per-block gesture
 * table, folded from the command records a press writes.
 *
 * The split mirrors the content surface's own unit — the fold and its
 * vocabulary live in `action-state.ts`, which the browser seat reads too, and
 * this module adds only what a host needs to register it: the schemas that
 * validate a persisted checkpoint and the wire payload, and the version that
 * discards a checkpoint written by a different fold.
 * @module @deepseek-ai/dsh-experimental-component-surface/src/action-projection
 */

import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import {
  applyComponentAction,
  componentActionsView,
  type ComponentActionCell,
  type ComponentActionsView,
} from './action-state.ts'

/** The unit as the registry's client-visible overload takes it: `wire` is required, not optional. */
type ComponentActionsProjectionDefinition =
  & Omit<ProjectionDefinition<'componentActions', ComponentActionCell[]>, 'wire'>
  & { wire: NonNullable<ProjectionDefinition<'componentActions', ComponentActionCell[]>['wire']> }

/** The four answers a gesture settles into, as both schemas spell them. */
const outcomeSchema = zod.enum(['sending', 'sent', 'queued', 'refused'])

/** Fold state: one cell per block that has reported a gesture. */
const stateSchema: ZodType<ComponentActionCell[]> = zod.array(zod.object({
  entryId: zod.string(),
  nodeId: zod.string(),
  seq: zod.number(),
  commandId: zod.string(),
  outcome: outcomeSchema,
}))

/** Wire payload: the same cells without the pairing id, which is the fold's business alone. */
const viewSchema: ZodType<ComponentActionsView> = zod.object({
  actions: zod.array(zod.object({
    entryId: zod.string(),
    nodeId: zod.string(),
    seq: zod.number(),
    outcome: outcomeSchema,
  })),
})

/**
 * Persisted-cache invalidation version of this fold. Bump it whenever the
 * stored cell fields or the pairing semantics change, so checkpoints written
 * by an older fold are discarded rather than forward-applied.
 */
const STATE_VERSION = 1

/**
 * Build the `componentActions` unit.
 * @returns the definition to hand to `ctx.sessionProjections.register`.
 */
export function componentActionsProjection(): ComponentActionsProjectionDefinition {
  return {
    key: 'componentActions',
    stateSchema,
    init: () => [],
    apply: applyComponentAction,
    wire: { viewSchema, view: componentActionsView },
    stateVersion: STATE_VERSION,
  }
}
