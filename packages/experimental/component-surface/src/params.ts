/**
 * `{"$param": "<name>"}` — the one substitution a view file's `spec` may carry.
 *
 * A view that ships with a skill pack is written once and installed on many
 * deployments, and the values that differ between them are the table it opens
 * and what that table is called. Writing those into the spec would make every
 * deployment a different file; writing them into the pack's own `params` block
 * makes them one line each at the top of the view.
 *
 * Substitution happens when the view is read, not when it is shown: a view
 * file's params are fixed by the file, so the spec that reaches judgement is
 * the spec that will be drawn, and everything downstream — the judgement, the
 * session record, the seat — sees an ordinary spec with no notation left in it.
 *
 * `{"$from": …}` is left exactly as written. That reference is resolved in the
 * page out of what another block currently reports, which is a value no host
 * has; the two notations never meet, because one is settled before anything is
 * drawn and the other cannot be.
 * @module @deepseek-ai/dsh-experimental-component-surface/src/params
 */

/** The key whose presence makes an object a parameter reference rather than a value. */
const PARAM_KEY = '$param'

/** One refused reference: where it sits in the spec, and what is wrong with it. */
export interface ViewParamFailure {
  /** Parameter path of the offending value, such as `spec.nodes[0].props.relatedMeta`. */
  readonly path: string
  /** What is wrong with it and what to write instead. */
  readonly reason: string
}

/** The spec with every reference replaced, or the first reference that could not be. */
export type ViewParamResult =
  | { readonly ok: true; readonly spec: unknown }
  | { readonly ok: false; readonly failure: ViewParamFailure }

/** Whether one value is a plain object, which is the only thing a reference can be written as. */
function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether one value carries the reference key, whatever else is wrong with it. */
function isReference(value: unknown): boolean {
  return isMapping(value) && PARAM_KEY in value
}

/** Refuse one reference. */
function refuse(path: string, reason: string): ViewParamResult {
  return { ok: false, failure: { path, reason } }
}

/**
 * Read one reference against the view's own params.
 * @param reference - the object carrying {@link PARAM_KEY}.
 * @param params - the view file's `params` block.
 * @param path - parameter path the refusal names.
 * @returns the substituted value, or the refusal.
 */
function resolve(reference: Record<string, unknown>, params: Readonly<Record<string, unknown>>, path: string): ViewParamResult {
  const keys = Object.keys(reference)
  if (keys.length > 1) {
    return refuse(path, `carries ${JSON.stringify(PARAM_KEY)} beside ${keys.filter(key => key !== PARAM_KEY).map(key => JSON.stringify(key)).join(', ')}; `
      + 'a parameter reference is the whole value or nothing')
  }
  const name = reference[PARAM_KEY]
  if (typeof name !== 'string' || name.length === 0) {
    return refuse(path, `names no parameter: ${JSON.stringify(PARAM_KEY)} must be the name of one entry of this view's params`)
  }
  if (!Object.hasOwn(params, name)) {
    const known = Object.keys(params)
    return refuse(path, `names the parameter ${JSON.stringify(name)}, which this view's params do not declare. `
      + (known.length === 0 ? 'This view declares no params.' : `Declared params: ${known.join(', ')}.`))
  }
  const value = params[name]
  // A scalar and nothing else: the value stands where a component's property
  // was declared, and every property this catalog admits that a whole value can
  // be written into is a string, a number or a yes-or-no. A list or an object
  // substituted here would reach the judgement as a value the schema refuses,
  // with the path naming the property rather than the parameter behind it.
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    return refuse(path, `names the parameter ${JSON.stringify(name)}, whose value is ${value === null ? 'null' : typeof value}; `
      + 'a param is text, a number or a yes-or-no')
  }
  return { ok: true, spec: value }
}

/**
 * Walk one value, replacing every reference under it.
 * @param value - the value as the view file wrote it.
 * @param params - the view file's `params` block.
 * @param path - parameter path of this value.
 * @returns the value with its references replaced, or the first refusal.
 */
function substitute(value: unknown, params: Readonly<Record<string, unknown>>, path: string): ViewParamResult {
  if (Array.isArray(value)) {
    const items: unknown[] = []
    for (const [position, item] of value.entries()) {
      const at = `${path}[${position}]`
      // Refused where it sits, for the reason a `$from` binding is: an item of a
      // list is one of many values a property carries, and a reference standing
      // for one of them reads as a list whose length depends on a parameter.
      if (isReference(item)) {
        return refuse(at, `is a ${JSON.stringify(PARAM_KEY)} reference, which stands for a whole property's value and not for one item of a list`)
      }
      const done = substitute(item, params, at)
      if (!done.ok) return done
      items.push(done.spec)
    }
    return { ok: true, spec: items }
  }
  if (!isMapping(value)) return { ok: true, spec: value }
  if (PARAM_KEY in value) return resolve(value, params, path)
  const mapping: Record<string, unknown> = {}
  for (const [key, own] of Object.entries(value)) {
    const done = substitute(own, params, `${path}.${key}`)
    if (!done.ok) return done
    mapping[key] = done.spec
  }
  return { ok: true, spec: mapping }
}

/**
 * Replace every parameter reference in one view's spec.
 * @param spec - the spec as the view file wrote it, however malformed.
 * @param params - the view file's `params` block; empty for a view that declares none.
 * @returns the substituted spec, or the first reference that could not be resolved.
 */
export function applyViewParams(spec: unknown, params: Readonly<Record<string, unknown>>): ViewParamResult {
  return substitute(spec, params, 'spec')
}
