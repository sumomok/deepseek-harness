/**
 * The second pass over one block's properties: what the schema admitted, read
 * once more as the narrower thing the component declared it to be.
 *
 * Validation decides whether a call is legal — which properties exist, and
 * whether each value is a string of the right length, a number in range, one of
 * a fixed set, a record, or a list. It cannot decide what a string *means*,
 * because the schema union deliberately has no member for a path, a color, or a
 * renderer name. That reading is declared beside the schema as a
 * {@link SanitizeClass} and enforced here: a value outside its class is dropped,
 * except a renderer name, which falls back to the plain one rather than leaving
 * a cell with nothing to draw it.
 *
 * The pass is total and silent. It answers with properties, never with a
 * refusal, because it runs where a refusal has nowhere to go: after validation
 * has already accepted the call on the host, and again on the wire in the
 * browser, where the value arrived from a persisted checkpoint no model is
 * waiting on. Dropping the one value is what leaves the rest of the block drawn.
 *
 * Undeclared properties are dropped whole. Nothing reaches here through
 * validation carrying one — validation refuses the call outright, which is what
 * tells the model it misspelled something — so that arm is the second line
 * under a caller that judged nothing, and the one place the two readings differ:
 * a model is told, a stored record is trimmed.
 *
 * What the pass answers with is frozen. Every record and list it returns was
 * built here — the walk rebuilds the tree rather than editing it — so freezing
 * each one as it is returned costs no second walk and takes nothing away from a
 * caller. It is what a Vue 2 renderer needs: Vue makes a component's props
 * reactive by rewriting them, own property by own property, and a frozen value
 * is the one thing it walks past. A React renderer gains the same guarantee,
 * that what it was lent it may read and may not write.
 *
 * No catalog entry declares a {@link SanitizeClass} yet, so the readings below
 * are exercised only by a probe component in the tests; the tightening layer is
 * scheduled ahead of the first component that needs one. Review trigger: the
 * entry that declares the first reading — a reading nothing declares by then
 * leaves with that change rather than waiting for a later component.
 *
 * The module imports nothing but the catalog vocabulary, so the browser half
 * runs the identical pass.
 * @module @deepseek-ai/dsh-experimental-component-surface/src/sanitize
 */

import type {
  ComponentCatalogEntry,
  PropsFieldSchema,
  PropsSchema,
  SanitizeClass,
  SanitizeRules,
} from './component-call.ts'

/**
 * The renderers a `related-component` property may name.
 *
 * A whitelist rather than a check for a legal identifier: the value chooses code
 * that draws a cell, so a name outside this list is not a renderer this build
 * has, whatever it is spelled like.
 */
const RELATED_COMPONENTS: readonly string[] = [
  'display_default',
  'display_yesno',
  'display_progress',
  'display_circle',
  'display_tag',
]

/** The renderer a `related-component` outside {@link RELATED_COMPONENTS} is drawn with. */
const RELATED_COMPONENT_FALLBACK = 'display_default'

/**
 * One same-origin path: exactly one leading slash, then nothing that ends an
 * attribute or starts another origin.
 *
 * The second character is excluded rather than merely unmatched because `//host`
 * and `/\host` are read as protocol-relative addresses by browsers, so a value
 * this rule let through would leave the origin the block is drawn in.
 */
const SAME_ORIGIN_PATH = /^\/(?![/\\])[^\s"'<>\\]*$/

/**
 * The color notations a `color` property may use: `#RGB`, `#RRGGBB`, `rgb()`
 * and `rgba()`.
 *
 * Named colors, `hsl()`, `var()`, and everything else are outside it, so a
 * declared color cannot become a reference to something else on the page.
 */
const COLOR = /^(?:#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6}|rgba?\(\s*\d{1,3}(?:\.\d+)?%?\s*(?:,\s*\d{1,3}(?:\.\d+)?%?\s*){2,3}\))$/

/**
 * Decide whether one value is a property record at all.
 * @param value - the value, however malformed.
 * @returns true when it is a non-null object that is not a list.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Read one value as its declared class.
 * @param value - the value, however malformed.
 * @param sanitizeClass - the reading the component declared for this property.
 * @returns the accepted value, the fallback renderer, or `undefined` when the property is dropped.
 */
function sanitizeClassValue(value: unknown, sanitizeClass: SanitizeClass): unknown {
  // A class is a reading of a string. A property declaring one and carrying
  // anything else is not a value this build can tighten, so it is dropped.
  if (typeof value !== 'string') return undefined
  switch (sanitizeClass) {
    case 'path': return SAME_ORIGIN_PATH.test(value) ? value : undefined
    case 'color': return COLOR.test(value) ? value : undefined
    case 'related-component': return RELATED_COMPONENTS.includes(value) ? value : RELATED_COMPONENT_FALLBACK
    /* v8 ignore start -- SanitizeClass is closed and every member returns above. */
    default: {
      // Not `assertNever` from dsh-llm, for the reason `validate.ts` states at
      // its own exhaustiveness check: this module is loaded by the browser seat.
      const unhandled: never = sanitizeClass
      throw new Error(`component-surface: unhandled sanitize class ${JSON.stringify(unhandled)}`)
    }
    /* v8 ignore stop */
  }
}

/**
 * Read one value as the shape its schema declares, descending into records and
 * lists so a property nested inside them is read the same way a top-level one is.
 * @param value - the value, however malformed.
 * @param schema - the declared property.
 * @param rules - the component's tightened readings, applied at every level.
 * @returns the accepted value, or `undefined` when the property is dropped.
 */
function sanitizeShape(value: unknown, schema: PropsFieldSchema, rules: SanitizeRules | undefined): unknown {
  switch (schema.kind) {
    case 'string':
    case 'number':
    case 'enum': return value
    case 'object': return isRecord(value) ? sanitizeRecord(value, schema.fields, rules) : undefined
    case 'array': return Array.isArray(value)
      ? Object.freeze(value.map(item => sanitizeShape(item, schema.item, rules)).filter(item => item !== undefined))
      : undefined
    /* v8 ignore start -- PropsFieldSchema is closed and every variant returns above. */
    default: {
      const unhandled: never = schema
      throw new Error(`component-surface: unhandled props schema ${JSON.stringify(unhandled)}`)
    }
    /* v8 ignore stop */
  }
}

/**
 * Read one property record against a declared schema.
 *
 * The walk is over the schema rather than over the record, so a property the
 * schema does not declare is never copied — dropping it is the absence of a
 * step rather than a filter that has to recognize it.
 * @param value - the record.
 * @param schema - the declared properties.
 * @param rules - the component's tightened readings.
 * @returns a new frozen record carrying the declared properties this pass accepted.
 */
function sanitizeRecord(
  value: Readonly<Record<string, unknown>>,
  schema: PropsSchema,
  rules: SanitizeRules | undefined,
): Record<string, unknown> {
  const kept: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(schema)) {
    if (!(key in value)) continue
    const sanitizeClass = rules?.[key]
    const cleaned = sanitizeClass === undefined
      ? sanitizeShape(value[key], field.schema, rules)
      : sanitizeClassValue(value[key], sanitizeClass)
    if (cleaned !== undefined) kept[key] = cleaned
  }
  // Frozen on the way out, so a record is frozen only after every nested record
  // and list it holds already is.
  return Object.freeze(kept)
}

/**
 * Read one block's properties as the component declares them.
 * @param component - the catalog entry the node names.
 * @param props - the node's properties, as validation accepted them or as the wire carried them.
 * @returns a new frozen record carrying the declared properties this pass accepted, in the schema's own order.
 */
export function sanitizeNodeProps(
  component: ComponentCatalogEntry,
  props: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return sanitizeRecord(props, component.propsSchema, component.sanitize)
}
