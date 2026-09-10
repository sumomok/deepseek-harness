/**
 * What `show_component` decides about a call before anything is drawn: the
 * entry it names, the ceilings its spec is measured against, the components the
 * catalog admits, every property those components declare, the layout tree over
 * those blocks, and the properties one block reads from another.
 *
 * The whole judgement is synchronous and reaches no browser, no session, and no
 * network: a refusal costs one round trip and changes nothing. Every refusal is
 * model-facing text that names the offending parameter path, because the model
 * has no other way to learn which of twelve nodes it got wrong.
 *
 * Shapes and ceilings, and nothing about meaning. What a stack looks like on a
 * screen, and what a bound property actually holds, are the seat's — the second
 * of those out of the user's own gestures, which is what keeps it out of the log
 * entirely. What this module can decide from the catalog alone is that the
 * arrangement covers the call's blocks exactly once and that a bound property
 * could hold what the block it reads reports.
 *
 * An accepted node leaves here with its properties already tightened: the
 * schema says which properties exist and what kind of value each is, and
 * {@link module:@deepseek-ai/dsh-experimental-component-surface/src/sanitize}
 * says how to read the ones a component declared as narrower than text. Both
 * are on the way in, so no later reader has to remember to run the second.
 *
 * The module imports nothing but that pass and
 * {@link module:@deepseek-ai/dsh-experimental-component-surface/src/component-call},
 * so the browser seat can run the identical judgement over a payload arriving on
 * the wire, where a value's declared type is a claim rather than a guarantee.
 * @module @deepseek-ai/dsh-experimental-component-surface/src/validate
 */

import {
  BINDING_HINT,
  BINDING_KEY,
  BLOCK_KEYS,
  catalogEntry,
  catalogOutput,
  COMPONENT_CATALOG,
  describeCatalog,
  describeSchema,
  isBindingValue,
  LAYOUT_DIRECTIONS,
  LAYOUT_GAPS,
  MAX_ENTRY_ID_LENGTH,
  MAX_FLEX,
  MAX_LAYOUT_CHILDREN,
  MAX_LAYOUT_DEPTH,
  MAX_NODE_ID_LENGTH,
  MAX_NODES,
  MAX_SPEC_BYTES,
  MAX_SPEC_DEPTH,
  MAX_TITLE_LENGTH,
  readBinding,
  STACK_KEYS,
  TOKEN_CHARSET,
  TOKEN_HINT,
  type ComponentBinding,
  type ComponentCall,
  type ComponentCallArguments,
  type ComponentCatalogEntry,
  type ComponentNode,
  type ComponentSpec,
  type LayoutBlock,
  type LayoutChild,
  type LayoutDirection,
  type LayoutGap,
  type LayoutNode,
  type LayoutStack,
  type PropsField,
  type PropsFieldSchema,
  type PropsSchema,
  type SanitizeRules,
  type StringCharset,
} from './component-call.ts'
import { sanitizeNodeProps } from './sanitize.ts'

/** One refusal: where in the arguments it happened, and what the model is told. */
export interface ComponentCallFailure {
  /** Parameter path of the offending value, such as `spec.nodes[0].props.buttons`. */
  readonly path: string
  /** The model-facing sentence, which always names {@link path}. */
  readonly text: string
  /**
   * Whether the value crossed a declared ceiling on how much it carries — a
   * list's item count, a string's length, a record's field count — rather than
   * being the wrong thing altogether.
   *
   * The distinction exists for the return channel, where the refusal is read by
   * whoever made the gesture: "there is too much here" names something they can
   * act on, and "this was not recorded" is what everything else honestly is.
   */
  readonly oversize: boolean
}

/** Outcome of validating one whole call. */
export type ComponentCallResult =
  | { readonly ok: true; readonly call: ComponentCall }
  | { readonly ok: false; readonly failure: ComponentCallFailure }

/** Outcome of validating one spec document on its own. */
export type ComponentSpecResult =
  | { readonly ok: true; readonly spec: ComponentSpec }
  | { readonly ok: false; readonly failure: ComponentCallFailure }

/** The property names a node object may carry. */
const NODE_KEYS: readonly string[] = ['id', 'component', 'props']

/** The property names a spec document may carry. */
const SPEC_KEYS: readonly string[] = ['nodes', 'layout']

/**
 * Build one refusal.
 *
 * Every refusal in this module goes through here, so the path is in the text by
 * construction rather than by each call site remembering to put it there.
 * Exported for the host-only `dataSource` pass, which refuses a parameter of
 * the same call in the same sentence shape.
 * @param path - parameter path of the offending value.
 * @param message - what is wrong with it and what to send instead.
 * @returns the refusal.
 */
export function refuse(path: string, message: string): ComponentCallFailure {
  return { path, text: `show_component: ${path} — ${message}`, oversize: false }
}

/**
 * Build one refusal for a value past a declared ceiling on how much it carries.
 *
 * Same sentence as {@link refuse} builds; what it adds is the one bit a reported
 * gesture is answered differently for.
 * @param path - parameter path of the offending value.
 * @param message - what is wrong with it and what to send instead.
 * @returns the refusal, marked oversize.
 */
function refuseSize(path: string, message: string): ComponentCallFailure {
  return { ...refuse(path, message), oversize: true }
}

/**
 * Read one non-blank bounded string argument.
 * @param value - the argument, however malformed.
 * @param path - parameter path used in the refusal.
 * @param maxLength - largest accepted length, in characters.
 * @param purpose - what the argument is for, stated in the refusal for a missing or blank value.
 * @param charset - alphabet the whole value must match; absent when any character is accepted.
 * @returns the trimmed value, or the refusal.
 */
function readBoundedString(
  value: unknown,
  path: string,
  maxLength: number,
  purpose: string,
  charset?: StringCharset,
): { readonly ok: true; readonly value: string } | { readonly ok: false; readonly failure: ComponentCallFailure } {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return { ok: false, failure: refuse(path, `must be a non-blank string: ${purpose}`) }
  }
  const trimmed = value.trim()
  if (trimmed.length > maxLength) {
    return {
      ok: false,
      failure: refuseSize(path, `is ${trimmed.length} characters; at most ${maxLength} are accepted.`),
    }
  }
  if (charset !== undefined && !charset.allowed.test(trimmed)) {
    return { ok: false, failure: refuse(path, `may use only ${charset.hint}.`) }
  }
  return { ok: true, value: trimmed }
}

/**
 * Decide whether one value nests deeper than the protocol accepts.
 *
 * Bounded recursion by construction: the walk stops at the ceiling rather than
 * at the bottom of the value, so measuring a hostile document costs at most
 * {@link MAX_SPEC_DEPTH} frames.
 * @param value - the value to measure.
 * @param remaining - levels still available at this value.
 * @returns true when the value is deeper than `remaining` levels.
 */
function exceedsDepth(value: unknown, remaining: number): boolean {
  if (value === null || typeof value !== 'object') return false
  if (remaining <= 0) return true
  return Object.values(value).some(child => exceedsDepth(child, remaining - 1))
}

/**
 * Validate one string property against its declared bounds and alphabet.
 * @param value - the property value, however malformed.
 * @param schema - the declared string property.
 * @param path - parameter path used in the refusal.
 * @returns the refusal, or `undefined` when the value is accepted.
 */
function validateString(
  value: unknown,
  schema: Extract<PropsFieldSchema, { kind: 'string' }>,
  path: string,
): ComponentCallFailure | undefined {
  if (typeof value !== 'string') return refuse(path, 'must be a string.')
  if (value.length > schema.maxLength) {
    return refuseSize(path, `is ${value.length} characters; at most ${schema.maxLength} are accepted.`)
  }
  if (schema.charset !== undefined && !schema.charset.allowed.test(value)) {
    return refuse(path, `may use only ${schema.charset.hint}.`)
  }
  return undefined
}

/**
 * Validate one numeric property against its declared bounds, and against
 * wholeness where the declaration asks for it.
 * @param value - the property value, however malformed.
 * @param schema - the declared numeric property.
 * @param path - parameter path used in the refusal.
 * @returns the refusal, or `undefined` when the value is accepted.
 */
function validateNumber(
  value: unknown,
  schema: Extract<PropsFieldSchema, { kind: 'number' }>,
  path: string,
): ComponentCallFailure | undefined {
  // `Number.isFinite` rather than `typeof` alone: a persisted checkpoint is
  // plain JSON, but the browser seat repeats this pass over a value another
  // build wrote, and a non-finite number is not a measurement anything can draw.
  if (typeof value !== 'number' || !Number.isFinite(value)) return refuse(path, 'must be a number.')
  if (value < schema.min || value > schema.max) {
    return refuse(path, `is ${value}; between ${schema.min} and ${schema.max} is accepted.`)
  }
  if (schema.integer === true && !Number.isInteger(value)) {
    return refuse(path, `is ${value}; a whole number is accepted.`)
  }
  return undefined
}

/**
 * Validate one boolean property.
 * @param value - the property value, however malformed.
 * @param path - parameter path used in the refusal.
 * @returns the refusal, or `undefined` when the value is accepted.
 */
function validateBoolean(value: unknown, path: string): ComponentCallFailure | undefined {
  if (typeof value !== 'boolean') return refuse(path, 'must be true or false.')
  return undefined
}

/**
 * Validate one record whose keys are the caller's own: the key count, every
 * key's name, and every value.
 *
 * The keys are judged rather than listed, because the schema declares an
 * alphabet and a count instead of the names — a row of a table is keyed by
 * whatever the columns read. A key past the length ceiling is refused without
 * being quoted back, and one that is merely outside the alphabet is quoted,
 * because by then it is short enough to name.
 * @param value - the property value, however malformed.
 * @param schema - the declared record.
 * @param path - parameter path used in the refusal.
 * @returns the refusal, or `undefined` when the record is accepted.
 */
function validateRecord(
  value: unknown,
  schema: Extract<PropsFieldSchema, { kind: 'record' }>,
  path: string,
): ComponentCallFailure | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return refuse(path, 'must be an object of your own field names.')
  }
  const entries = Object.entries(value)
  if (entries.length > schema.maxKeys) {
    return refuseSize(path, `carries ${entries.length} fields; at most ${schema.maxKeys} are accepted.`)
  }
  for (const [key, entry] of entries) {
    if (key.length > schema.key.maxLength) {
      return refuseSize(path, `carries a field name of ${key.length} characters; at most ${schema.key.maxLength} are accepted.`)
    }
    if (schema.key.charset !== undefined && !schema.key.charset.allowed.test(key)) {
      return refuse(path, `carries the field name ${JSON.stringify(key)}, which may use only ${schema.key.charset.hint}.`)
    }
    const failure = validateRecordValue(entry, schema, `${path}.${key}`)
    if (failure !== undefined) return failure
  }
  return undefined
}

/**
 * Validate one value inside a caller-keyed record.
 * @param value - the value, however malformed.
 * @param schema - the declared record.
 * @param path - parameter path used in the refusal.
 * @returns the refusal, or `undefined` when the value is accepted.
 */
function validateRecordValue(
  value: unknown,
  schema: Extract<PropsFieldSchema, { kind: 'record' }>,
  path: string,
): ComponentCallFailure | undefined {
  if (typeof value === 'boolean') return undefined
  if (typeof value === 'string') {
    if (value.length > schema.maxValueLength) {
      return refuseSize(path, `is ${value.length} characters; at most ${schema.maxValueLength} are accepted.`)
    }
    return undefined
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value < schema.minValue || value > schema.maxValue) {
      return refuse(path, `is ${value}; between ${schema.minValue} and ${schema.maxValue} is accepted.`)
    }
    return undefined
  }
  return refuse(path, 'must be text, a number, or true or false.')
}

/** What a scalar property accepts, as every refusal of one states it. */
const SCALAR_ACCEPTED = 'must be text, a number, true or false, or a list of text and numbers.'

/**
 * Validate one scalar property: text, a number, a yes-or-no, or a list of
 * text and numbers.
 *
 * The `dataSource` parameter's condition values are read by a pass of their
 * own, against the same two ceilings and in different words; only the ceilings
 * are shared.
 * @param value - the property value, however malformed.
 * @param schema - the declared scalar.
 * @param path - parameter path used in the refusal.
 * @returns the refusal, or `undefined` when the value is accepted.
 */
function validateScalar(
  value: unknown,
  schema: Extract<PropsFieldSchema, { kind: 'scalar' }>,
  path: string,
): ComponentCallFailure | undefined {
  if (Array.isArray(value)) {
    const bounds = `lists ${value.length} values; between 1 and ${schema.maxItems} are accepted.`
    if (value.length > schema.maxItems) return refuseSize(path, bounds)
    if (value.length === 0) return refuse(path, bounds)
    for (const [index, item] of value.entries()) {
      const itemPath = `${path}[${index}]`
      if (typeof item === 'string') {
        if (item.length > schema.maxLength) {
          return refuseSize(itemPath, `is ${item.length} characters; at most ${schema.maxLength} are accepted.`)
        }
        continue
      }
      if (typeof item === 'number' && Number.isFinite(item)) continue
      return refuse(itemPath, 'must be text or a number; a list carries neither true nor false.')
    }
    return undefined
  }
  if (typeof value === 'boolean') return undefined
  if (typeof value === 'string') {
    if (value.length > schema.maxLength) {
      return refuseSize(path, `is ${value.length} characters; at most ${schema.maxLength} are accepted.`)
    }
    return undefined
  }
  if (typeof value === 'number' && Number.isFinite(value)) return undefined
  return refuse(path, SCALAR_ACCEPTED)
}

/**
 * Validate one enumerated property.
 * @param value - the property value, however malformed.
 * @param schema - the declared enumeration.
 * @param path - parameter path used in the refusal.
 * @returns the refusal, or `undefined` when the value is accepted.
 */
function validateEnum(
  value: unknown,
  schema: Extract<PropsFieldSchema, { kind: 'enum' }>,
  path: string,
): ComponentCallFailure | undefined {
  if ((typeof value === 'string' || typeof value === 'number') && schema.values.includes(value)) return undefined
  const accepted = schema.values.map(one => JSON.stringify(one)).join(', ')
  return refuse(path, `must be one of ${accepted}.`)
}

/**
 * Validate one list property: its length, every item, and the item property
 * that identifies each entry.
 * @param value - the property value, however malformed.
 * @param schema - the declared list.
 * @param path - parameter path used in the refusal.
 * @returns the refusal, or `undefined` when the value is accepted.
 */
function validateArray(
  value: unknown,
  schema: Extract<PropsFieldSchema, { kind: 'array' }>,
  path: string,
): ComponentCallFailure | undefined {
  if (!Array.isArray(value)) return refuse(path, 'must be an array.')
  // One sentence for both bounds, because the model is told what the list
  // accepts either way; the two are built apart only so that a list carrying
  // too much is answered as too much where a reported gesture reads it.
  const bounds = `lists ${value.length} items; between ${schema.minItems} and ${schema.maxItems} are accepted.`
  if (value.length > schema.maxItems) return refuseSize(path, bounds)
  if (value.length < schema.minItems) return refuse(path, bounds)
  const seen = new Set<unknown>()
  for (const [index, item] of value.entries()) {
    const itemPath = `${path}[${index}]`
    const failure = validateField(item, schema.item, itemPath)
    if (failure !== undefined) return failure
    if (schema.uniqueBy === undefined) continue
    const identity = (item as Record<string, unknown>)[schema.uniqueBy]
    if (seen.has(identity)) {
      return refuse(
        `${itemPath}.${schema.uniqueBy}`,
        `repeats ${JSON.stringify(identity)}; every item in this list needs its own.`,
      )
    }
    seen.add(identity)
  }
  return undefined
}

/**
 * Validate one declared property value against its schema.
 * @param value - the property value, however malformed.
 * @param schema - the declared property.
 * @param path - parameter path used in the refusal.
 * @returns the refusal, or `undefined` when the value is accepted.
 */
function validateField(
  value: unknown,
  schema: PropsFieldSchema,
  path: string,
): ComponentCallFailure | undefined {
  switch (schema.kind) {
    case 'string': return validateString(value, schema, path)
    case 'number': return validateNumber(value, schema, path)
    case 'boolean': return validateBoolean(value, path)
    case 'scalar': return validateScalar(value, schema, path)
    case 'enum': return validateEnum(value, schema, path)
    case 'record': return validateRecord(value, schema, path)
    case 'object': return validateProps(value, schema.fields, path)
    case 'array': return validateArray(value, schema, path)
    /* v8 ignore start -- PropsFieldSchema is closed and every variant returns above. */
    default: {
      // Not `assertNever` from dsh-llm: this module is shared with the browser
      // bundle, and the seam it re-validates on must not pull the LLM package
      // into a page.
      const unhandled: never = schema
      throw new Error(`component-surface: unhandled props schema ${JSON.stringify(unhandled)}`)
    }
    /* v8 ignore stop */
  }
}

/** Properties bound to another block, for a record with none: every nested record. */
const NOTHING_BOUND: ReadonlySet<string> = new Set()

/**
 * Validate one property record against a declared schema: no undeclared
 * property, every required property present, and every value in range.
 * @param value - the record, however malformed.
 * @param schema - the declared properties.
 * @param path - parameter path of the record itself.
 * @param bound - properties this record reads from another block, which carry a reference rather than a value.
 * @returns the refusal, or `undefined` when the record is accepted.
 */
function validateProps(
  value: unknown,
  schema: PropsSchema,
  path: string,
  bound: ReadonlySet<string> = NOTHING_BOUND,
): ComponentCallFailure | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return refuse(path, 'must be an object.')
  }
  const record = value as Record<string, unknown>
  const declared = Object.keys(schema)
  // Undeclared keys first: a misspelled property is also a missing required
  // one, and naming the spelling is what lets the next call be right. A binding
  // on a property nothing declares is refused here too, by the same sentence.
  for (const key of Object.keys(record)) {
    if (!declared.includes(key)) {
      return refuse(`${path}.${key}`, `is not accepted here. Accepted properties: ${declared.join(', ')}.`)
    }
  }
  for (const [key, field] of Object.entries(schema)) {
    // A bound property is present and carries no value of its own; what it will
    // stand for is judged against this schema where the binding is resolved.
    if (bound.has(key)) continue
    const present = record[key]
    if (present === undefined) {
      if (field.required) return refuse(`${path}.${key}`, 'is required.')
      continue
    }
    const failure = validateField(present, field.schema, `${path}.${key}`)
    if (failure !== undefined) return failure
  }
  return undefined
}

/**
 * Whether one declared property is read as something narrower than text
 * anywhere inside it.
 *
 * What it decides is whether that property may be bound at all. The tightening
 * pass runs on the way in, over the value a call wrote; a bound property has no
 * such value — what it stands for is assembled in the seat out of the user's
 * own work — so a reading declared anywhere below it would be a reading nothing
 * performs.
 * @param schema - the declared property.
 * @param rules - the component's tightened readings, matched by property name at every level.
 * @returns true when this property, or anything nested in it, is read as something narrower than text.
 */
function carriesReading(schema: PropsFieldSchema, rules: SanitizeRules | undefined): boolean {
  switch (schema.kind) {
    case 'string':
    case 'number':
    case 'boolean':
    case 'scalar':
    case 'enum': return false
    case 'record': return schema.sanitize !== undefined
    case 'array': return carriesReading(schema.item, rules)
    case 'object': return Object.entries(schema.fields)
      .some(([name, field]) => rules?.[name] !== undefined || carriesReading(field.schema, rules))
    /* v8 ignore start -- PropsFieldSchema is closed and every variant returns above. */
    default: {
      const unhandled: never = schema
      throw new Error(`component-surface: unhandled props schema ${JSON.stringify(unhandled)}`)
    }
    /* v8 ignore stop */
  }
}

/**
 * Whether one alphabet restriction is at least as tight as another's.
 * @param source - the alphabet the value comes with, where it declares one.
 * @param target - the alphabet the property requires, where it declares one.
 * @returns true when a value matching `source` also matches `target`.
 */
function acceptsCharset(source: StringCharset | undefined, target: StringCharset | undefined): boolean {
  if (target === undefined) return true
  return source !== undefined && source.allowed.source === target.allowed.source
}

/**
 * Whether one set of declared properties can be the value of another.
 * @param source - the properties the value carries.
 * @param target - the properties the receiving schema declares.
 * @returns true when every value of `source` is one `target` accepts, and nothing `target` requires is missing or optional in `source`.
 */
function acceptsFields(source: PropsSchema, target: PropsSchema): boolean {
  for (const [name, field] of Object.entries(target)) {
    const from = source[name]
    if (from === undefined) {
      if (field.required) return false
      continue
    }
    // A field the value may leave out is judged the way an absent one is: the
    // resolved value can arrive without it, and the receiving property requires
    // it.
    if (!from.required && field.required) return false
    if (!acceptsOutput(from.schema, field.schema)) return false
  }
  // A value carrying more than the property declares is a value the component
  // would be handed properties it never asked for.
  return Object.keys(source).every(name => name in target)
}

/**
 * Whether one block's output can be the value of the property a call bound it
 * to.
 *
 * Same kind, and nothing the value may carry past what the property accepts:
 * a longer string, a wider number, a value outside the fixed set, more items,
 * more keys. Two of a property's requirements are deliberately left out of the
 * comparison, `minItems` and `uniqueBy`, because neither is a ceiling: an
 * output is what the user has done so far, so how many items it lists and
 * whether two of them repeat are facts about a moment rather than promises a
 * static check can make. The seat judges both when it substitutes the value it
 * actually resolved, and a value failing either draws its block's waiting line
 * instead.
 *
 * The tightened readings are not compared here either: a property read as
 * something narrower than text cannot be bound at all, which
 * {@link carriesReading} decides one step earlier and for the whole property.
 * @param source - the output's declared shape, or its item's where the reference took one.
 * @param target - the property as the receiving component declares it.
 * @returns true when the value is one that property accepts.
 */
export function acceptsOutput(source: PropsFieldSchema, target: PropsFieldSchema): boolean {
  switch (source.kind) {
    case 'string': return target.kind === 'string'
      && source.maxLength <= target.maxLength
      && acceptsCharset(source.charset, target.charset)
    case 'number': return target.kind === 'number' && source.min >= target.min && source.max <= target.max
    case 'boolean': return target.kind === 'boolean'
    case 'scalar': return target.kind === 'scalar'
      && source.maxLength <= target.maxLength
      && source.maxItems <= target.maxItems
    case 'enum': return target.kind === 'enum' && source.values.every(one => target.values.includes(one))
    case 'record': return target.kind === 'record'
      && source.maxKeys <= target.maxKeys
      && source.maxValueLength <= target.maxValueLength
      && source.minValue >= target.minValue
      && source.maxValue <= target.maxValue
      && acceptsOutput(source.key, target.key)
    case 'object': return target.kind === 'object' && acceptsFields(source.fields, target.fields)
    case 'array': return target.kind === 'array'
      && source.maxItems <= target.maxItems
      && acceptsOutput(source.item, target.item)
    /* v8 ignore start -- PropsFieldSchema is closed and every variant returns above. */
    default: {
      const unhandled: never = source
      throw new Error(`component-surface: unhandled props schema ${JSON.stringify(unhandled)}`)
    }
    /* v8 ignore stop */
  }
}

/** One property of one node read from another block, as the node's own pass collected it. */
interface NodeBinding {
  /** Parameter path of the reference, which every refusal about it names. */
  readonly path: string
  /** The property the value is read into. */
  readonly prop: string
  /** That property as the component declares it. */
  readonly field: PropsField
  /** What the property reads. */
  readonly binding: ComponentBinding
}

/** One collected binding, together with the node whose property it is. */
interface PlacedBinding extends NodeBinding {
  /** Node id of the block carrying the bound property. */
  readonly nodeId: string
}

/**
 * Find where a value nests a binding.
 *
 * A binding is a whole property's value or nothing: `{"$from": …}` inside a
 * list item or a nested object is a value the seat would have to walk looking
 * for references, which is the walk this rule exists to not have.
 * @param value - the property value, however malformed.
 * @param path - parameter path of that value.
 * @returns the path of the first nested binding, or `undefined` when the value nests none.
 */
function nestedBinding(value: unknown, path: string): string | undefined {
  if (isBindingValue(value)) return path
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = nestedBinding(item, `${path}[${index}]`)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (value === null || typeof value !== 'object') return undefined
  for (const [key, entry] of Object.entries(value)) {
    const found = nestedBinding(entry, `${path}.${key}`)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * Collect one node's bound properties, and refuse the ways a binding can be
 * written where it is not one.
 *
 * What it does not decide is anything about the other block: which nodes exist
 * and what they report is a fact about the whole spec, so a source id and an
 * output name are judged once every node is in. What it does decide is whether
 * the receiving property may be read from another block at all, which is a fact
 * about this node's own component.
 * @param props - the node's properties, as the call wrote them.
 * @param entry - the catalog entry the node names.
 * @param path - parameter path of the properties record.
 * @returns the bound properties, or the refusal.
 */
function collectBindings(
  props: Readonly<Record<string, unknown>>,
  entry: ComponentCatalogEntry,
  path: string,
): { readonly ok: true; readonly bindings: readonly NodeBinding[] } | { readonly ok: false; readonly failure: ComponentCallFailure } {
  const bindings: NodeBinding[] = []
  for (const [key, value] of Object.entries(props)) {
    const propPath = `${path}.${key}`
    if (!isBindingValue(value)) {
      const nested = nestedBinding(value, propPath)
      if (nested === undefined) continue
      return {
        ok: false,
        failure: refuse(
          `${nested}.${BINDING_KEY}`,
          'reads another block, which is accepted only as the whole value of one of this component\'s own properties.',
        ),
      }
    }
    const binding = readBinding(value)
    if (binding === undefined) {
      return {
        ok: false,
        failure: refuse(
          `${propPath}.${BINDING_KEY}`,
          `must be a string reading ${BINDING_HINT}, and a bound property carries ${BINDING_KEY} and nothing else.`,
        ),
      }
    }
    const field = entry.propsSchema[key]
    // A binding on a property this component does not declare is refused by the
    // properties pass right after, which names the spelling and lists what the
    // component accepts.
    if (field === undefined) continue
    // A property that is both read as something narrower than text and declared
    // unbindable is refused with the first, which names what it is read as.
    const unbindable = entry.sanitize?.[key] !== undefined || carriesReading(field.schema, entry.sanitize)
      ? 'this component reads part of it as something narrower than text — a path, a color, or the name of a cell '
        + 'renderer — and that reading is done over the value a call writes out.'
      : field.unbindable
    if (unbindable !== undefined) {
      return { ok: false, failure: refuse(propPath, `cannot be read from another block: ${unbindable}`) }
    }
    bindings.push({ path: `${propPath}.${BINDING_KEY}`, prop: key, field, binding })
  }
  return { ok: true, bindings }
}

/** Outcome of validating one node. */
type NodeResult =
  | {
    readonly ok: true
    /** The node as the seat will draw it. */
    readonly node: ComponentNode
    /** The catalog entry it names, which the spec's binding pass resolves other nodes' references against. */
    readonly component: ComponentCatalogEntry
    /** The properties it reads from other blocks. */
    readonly bindings: readonly NodeBinding[]
  }
  | { readonly ok: false; readonly failure: ComponentCallFailure }

/**
 * Validate one node: its identity, the component it names, and that
 * component's properties.
 * @param value - the node, however malformed.
 * @param path - parameter path of the node itself.
 * @param takenIds - node ids already used by earlier nodes in this spec.
 * @returns the accepted node, the catalog entry it names, and the properties it reads from other blocks; or the refusal.
 */
function validateNode(
  value: unknown,
  path: string,
  takenIds: ReadonlySet<string>,
): NodeResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, failure: refuse(path, 'must be an object with id, component and props.') }
  }
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!NODE_KEYS.includes(key)) {
      return { ok: false, failure: refuse(`${path}.${key}`, `is not part of a node. A node carries ${NODE_KEYS.join(', ')}.`) }
    }
  }
  const id = record['id']
  if (typeof id !== 'string' || !TOKEN_CHARSET.test(id) || id.length > MAX_NODE_ID_LENGTH) {
    return {
      ok: false,
      failure: refuse(
        `${path}.id`,
        `must be a string of at most ${MAX_NODE_ID_LENGTH} ${TOKEN_HINT}.`,
      ),
    }
  }
  if (takenIds.has(id)) {
    return { ok: false, failure: refuse(`${path}.id`, `repeats ${JSON.stringify(id)}; every node in one call needs its own id.`) }
  }
  const entry = catalogEntry(record['component'])
  if (entry === undefined) {
    return {
      ok: false,
      failure: refuse(
        `${path}.component`,
        `names no component of this deployment. Available components:\n${describeCatalog(COMPONENT_CATALOG)}`,
      ),
    }
  }
  const written = record['props']
  // A value that is not a record carries no bindings to collect; the properties
  // pass below is what tells the model what it sent instead.
  const collected = written === null || typeof written !== 'object' || Array.isArray(written)
    ? { ok: true, bindings: [] } as const
    : collectBindings(written as Record<string, unknown>, entry, `${path}.props`)
  if (!collected.ok) return collected
  const bound = new Set(collected.bindings.map(binding => binding.prop))
  const failure = validateProps(written, entry.propsSchema, `${path}.props`, bound)
  if (failure !== undefined) return { ok: false, failure }
  // The one call site of the tightening pass, so the tool, the fold over the
  // log, and the browser seat — all three of which reach a node through here —
  // draw the same properties rather than three readings of them.
  const props = sanitizeNodeProps(entry, written as Record<string, unknown>)
  return { ok: true, node: { id, component: entry.id, props }, component: entry, bindings: collected.bindings }
}

/** Outcome of validating one piece of a layout tree. */
type LayoutResult<T> =
  | { readonly ok: true; readonly node: T }
  | { readonly ok: false; readonly failure: ComponentCallFailure }

/** What every step of the layout walk is judged against: the nodes it may place, and the ones it already has. */
interface LayoutPlacement {
  /** Every node id the spec declares. */
  readonly ids: ReadonlySet<string>
  /** The ids placed so far; the walk adds to it, which is how a node placed twice is caught. */
  readonly placed: Set<string>
}

/**
 * Whether one value is a member of a fixed set of words.
 * @param values - the accepted words.
 * @param value - the value, however malformed.
 * @returns true when the value is one of them.
 */
function readsAs<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value)
}

/**
 * Validate the share of its stack one child asks for.
 *
 * One reading for both kinds of child: a nested stack divides the row it sits
 * in exactly as a block does, so the two would otherwise carry the same number
 * under the same name with two judgements of it.
 * @param value - the `flex` property, however malformed; absent for a child that asks for none.
 * @param path - parameter path of the child.
 * @returns the share, `undefined` where the child asked for none, or the refusal.
 */
function validateFlex(
  value: unknown,
  path: string,
): { readonly ok: true; readonly flex: number | undefined } | { readonly ok: false; readonly failure: ComponentCallFailure } {
  if (value === undefined) return { ok: true, flex: undefined }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_FLEX) {
    return { ok: false, failure: refuse(`${path}.flex`, `must be a whole number between 1 and ${MAX_FLEX}.`) }
  }
  return { ok: true, flex: value }
}

/**
 * Validate one block placed in the layout: the node it names, that it names it
 * once, and the share of its stack it asks for.
 * @param record - the child, already known to be a `component` node.
 * @param path - parameter path of the child.
 * @param placement - the nodes it may place, and the ones already placed.
 * @returns the accepted block, or the refusal.
 */
function validateLayoutBlock(
  record: Readonly<Record<string, unknown>>,
  path: string,
  placement: LayoutPlacement,
): LayoutResult<LayoutBlock> {
  for (const key of Object.keys(record)) {
    if (!BLOCK_KEYS.includes(key)) {
      return { ok: false, failure: refuse(`${path}.${key}`, `is not part of a placed block. A placed block carries ${BLOCK_KEYS.join(', ')}.`) }
    }
  }
  const id = record['id']
  if (typeof id !== 'string' || !placement.ids.has(id)) {
    return {
      ok: false,
      failure: refuse(`${path}.id`, 'names no node of this call. Every id in the layout is one of the ids in spec.nodes.'),
    }
  }
  if (placement.placed.has(id)) {
    return {
      ok: false,
      failure: refuse(`${path}.id`, `places ${JSON.stringify(id)} a second time; the layout places every node exactly once.`),
    }
  }
  const flex = validateFlex(record['flex'], path)
  if (!flex.ok) return flex
  placement.placed.add(id)
  return { ok: true, node: Object.freeze({ node: 'component', id, ...(flex.flex === undefined ? {} : { flex: flex.flex }) }) }
}

/**
 * Validate one child of a stack: a placed block, or a further stack.
 * @param value - the child, however malformed.
 * @param path - parameter path of the child.
 * @param placement - the nodes it may place, and the ones already placed.
 * @param depth - stacks already open above this child, the outermost counting as one.
 * @returns the accepted child, or the refusal.
 */
function validateLayoutChild(
  value: unknown,
  path: string,
  placement: LayoutPlacement,
  depth: number,
): LayoutResult<LayoutChild> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, failure: refuse(path, 'must be {"node": "component", "id": "<a node id>"} or a stack.') }
  }
  const record = value as Record<string, unknown>
  if (record['node'] === 'component') return validateLayoutBlock(record, path, placement)
  if (record['node'] === 'stack') return validateLayoutStack(value, path, placement, depth)
  return { ok: false, failure: refuse(`${path}.node`, 'must be "component" for a block or "stack" for a further row or column.') }
}

/**
 * Validate one stack: its direction, its spacing, and everything it lays out.
 * @param value - the stack, however malformed.
 * @param path - parameter path of the stack.
 * @param placement - the nodes it may place, and the ones already placed.
 * @param depth - stacks already open above this one, this one counting as one.
 * @returns the accepted stack, or the refusal.
 */
function validateLayoutStack(
  value: unknown,
  path: string,
  placement: LayoutPlacement,
  depth: number,
): LayoutResult<LayoutStack> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, failure: refuse(path, 'must be a stack: {"node": "stack", "dir": "row" or "col", "children": [...]}.') }
  }
  const record = value as Record<string, unknown>
  // What kind of thing this is comes before what it may carry, so a block
  // written where a stack belongs is told which of the two it is, rather than
  // which of a stack's properties its own are not.
  if (record['node'] !== 'stack') {
    return { ok: false, failure: refuse(`${path}.node`, 'must be "stack"; a layout starts with a row or a column, and places blocks inside it.') }
  }
  for (const key of Object.keys(record)) {
    if (!STACK_KEYS.includes(key)) {
      return { ok: false, failure: refuse(`${path}.${key}`, `is not part of a stack. A stack carries ${STACK_KEYS.join(', ')}.`) }
    }
  }
  if (depth > MAX_LAYOUT_DEPTH) {
    return {
      ok: false,
      failure: refuse(path, `opens stack ${depth}; at most ${MAX_LAYOUT_DEPTH} stacks may be open at once. Flatten the layout.`),
    }
  }
  const dir = record['dir']
  if (!readsAs<LayoutDirection>(LAYOUT_DIRECTIONS, dir)) {
    return { ok: false, failure: refuse(`${path}.dir`, `must be one of ${LAYOUT_DIRECTIONS.map(one => JSON.stringify(one)).join(', ')}.`) }
  }
  const gap = record['gap']
  if (gap !== undefined && !readsAs<LayoutGap>(LAYOUT_GAPS, gap)) {
    return { ok: false, failure: refuse(`${path}.gap`, `must be one of ${LAYOUT_GAPS.map(one => JSON.stringify(one)).join(', ')}.`) }
  }
  const wrap = record['wrap']
  if (wrap !== undefined && typeof wrap !== 'boolean') {
    return { ok: false, failure: refuse(`${path}.wrap`, 'must be true or false.') }
  }
  // A share of what there is, where there is nobody to share with: the
  // outermost stack fills the entry on its own, so a `flex` on it divides
  // nothing. Refused by name rather than ignored, because a model that wrote it
  // meant something by it and would otherwise never learn it did nothing.
  if (depth === 1 && record['flex'] !== undefined) {
    return {
      ok: false,
      failure: refuse(
        `${path}.flex`,
        'is not accepted on the outermost stack: flex is a share of the stack a child sits in, and the outermost '
        + 'stack sits in nothing. Put the share on the children instead.',
      ),
    }
  }
  const flex = validateFlex(record['flex'], path)
  if (!flex.ok) return flex
  const children = record['children']
  if (!Array.isArray(children)) {
    return { ok: false, failure: refuse(`${path}.children`, 'must be an array of blocks and stacks.') }
  }
  const bounds = `lists ${children.length} children; between 1 and ${MAX_LAYOUT_CHILDREN} are accepted.`
  if (children.length > MAX_LAYOUT_CHILDREN) return { ok: false, failure: refuseSize(`${path}.children`, bounds) }
  if (children.length === 0) return { ok: false, failure: refuse(`${path}.children`, bounds) }
  const accepted: LayoutChild[] = []
  for (const [index, child] of children.entries()) {
    const result = validateLayoutChild(child, `${path}.children[${index}]`, placement, depth + 1)
    if (!result.ok) return result
    accepted.push(result.node)
  }
  return {
    ok: true,
    node: Object.freeze({
      node: 'stack',
      dir,
      ...(gap === undefined ? {} : { gap }),
      ...(wrap === undefined ? {} : { wrap }),
      ...(flex.flex === undefined ? {} : { flex: flex.flex }),
      children: Object.freeze(accepted),
    }),
  }
}

/**
 * Validate one spec's layout: the tree itself, and that it places every node
 * of the call exactly once.
 *
 * Every node placed once is what makes the layout an arrangement of the spec
 * rather than a second spec: a node the tree leaves out would be a block the
 * call paid for and nobody sees, and one placed twice would be two blocks
 * sharing one identity — the identity a reported gesture, and the seat's own
 * memo, are keyed by.
 * @param value - the `layout` argument, however malformed.
 * @param nodes - the accepted nodes, in the order the call wrote them.
 * @returns the accepted layout, or the refusal.
 */
function validateLayout(value: unknown, nodes: readonly ComponentNode[]): LayoutResult<LayoutNode> {
  const placement: LayoutPlacement = { ids: new Set(nodes.map(node => node.id)), placed: new Set() }
  const result = validateLayoutStack(value, 'spec.layout', placement, 1)
  if (!result.ok) return result
  for (const [index, node] of nodes.entries()) {
    if (placement.placed.has(node.id)) continue
    return {
      ok: false,
      failure: refuse(
        `spec.nodes[${index}].id`,
        'is not placed in spec.layout; a layout places every node of the call exactly once.',
      ),
    }
  }
  return result
}

/**
 * Resolve one bound property against the block it reads: that the block is
 * placed by this call, that it reports what the reference names, and that what
 * it reports is a value the property accepts.
 * @param bound - the binding, and the property it is read into.
 * @param placed - the catalog entry of every node of this call, by node id.
 * @returns the refusal, or `undefined` when the binding is accepted.
 */
function resolveBinding(
  bound: PlacedBinding,
  placed: ReadonlyMap<string, ComponentCatalogEntry>,
): ComponentCallFailure | undefined {
  const { sourceId, outputId, index } = bound.binding
  if (sourceId === bound.nodeId) {
    return refuse(bound.path, 'reads the block it is on; a binding reads another block.')
  }
  const source = placed.get(sourceId)
  if (source === undefined) {
    return refuse(bound.path, `reads the block ${JSON.stringify(sourceId)}, which this call does not place. `
      + `The blocks it places are: ${[...placed.keys()].map(id => JSON.stringify(id)).join(', ')}.`)
  }
  const output = catalogOutput(source, outputId)
  if (output === undefined) {
    return refuse(bound.path, `reads ${JSON.stringify(outputId)} from the ${source.label} block ${JSON.stringify(sourceId)}, `
      + `which reports ${source.outputs.length === 0 ? 'nothing' : source.outputs.map(one => one.id).join(', ')}.`)
  }
  let read = output.shape
  if (index !== undefined) {
    // One sentence for the two ways an item can fail to be there — a list that
    // never holds that many, and an output that is not a list at all — because
    // both are answered by naming what the output is.
    if (read.kind !== 'array' || index >= read.maxItems) {
      return refuse(bound.path, `takes item ${index} out of ${outputId}, which is ${describeSchema(read)}.`)
    }
    read = read.item
  }
  if (!acceptsOutput(read, bound.field.schema)) {
    return refuse(bound.path, `reads ${describeSchema(read)}, and ${bound.prop} accepts ${describeSchema(bound.field.schema)}.`)
  }
  return undefined
}

/**
 * Resolve every bound property of one spec.
 *
 * Nothing here looks for a loop, because none can be written: every property a
 * component reads back — to name what the user did in the block it drew — is
 * {@link PropsField.unbindable}, so a block that reports anything is a block no
 * other block may feed, and a chain of bindings runs one way by construction.
 * `layout-binding.client.spec.ts` holds the catalog to that.
 * @param bindings - every bound property of the spec, in node order.
 * @param placed - the catalog entry of every node of this call, by node id.
 * @returns the refusal, or `undefined` when every binding is accepted.
 */
function resolveBindings(
  bindings: readonly PlacedBinding[],
  placed: ReadonlyMap<string, ComponentCatalogEntry>,
): ComponentCallFailure | undefined {
  for (const bound of bindings) {
    const failure = resolveBinding(bound, placed)
    if (failure !== undefined) return failure
  }
  return undefined
}

/**
 * Validate one spec document: the protocol ceilings, every node, the layout
 * over those nodes, and the properties one node reads from another.
 *
 * Depth is measured before size because both walk the document and only the
 * depth walk is bounded by construction. The layout and the bindings come last
 * because both are about the whole spec: which nodes exist and what each of
 * them reports is not settled until every node is in.
 * @param value - the `spec` argument, however malformed.
 * @returns the accepted spec, or the refusal.
 */
export function validateComponentSpec(value: unknown): ComponentSpecResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, failure: refuse('spec', 'must be an object carrying a nodes array.') }
  }
  if (exceedsDepth(value, MAX_SPEC_DEPTH)) {
    return {
      ok: false,
      failure: refuse(
        'spec',
        `nests deeper than ${MAX_SPEC_DEPTH} levels. Send the properties the components declare, arranged in at most `
        + `${MAX_LAYOUT_DEPTH} stacks, and nothing around them.`,
      ),
    }
  }
  const bytes = new TextEncoder().encode(JSON.stringify(value)).length
  if (bytes > MAX_SPEC_BYTES) {
    return {
      ok: false,
      failure: refuse('spec', `is ${bytes} bytes of JSON; at most ${MAX_SPEC_BYTES} are accepted. Send fewer nodes or shorter text.`),
    }
  }
  for (const key of Object.keys(value)) {
    if (!SPEC_KEYS.includes(key)) {
      return { ok: false, failure: refuse(`spec.${key}`, `is not part of a spec. A spec carries ${SPEC_KEYS.join(', ')}.`) }
    }
  }
  const nodes = (value as { nodes?: unknown }).nodes
  if (!Array.isArray(nodes)) return { ok: false, failure: refuse('spec.nodes', 'must be an array of nodes.') }
  if (nodes.length === 0 || nodes.length > MAX_NODES) {
    return {
      ok: false,
      failure: refuse('spec.nodes', `lists ${nodes.length} nodes; between 1 and ${MAX_NODES} are accepted.`),
    }
  }
  const accepted: ComponentNode[] = []
  const takenIds = new Set<string>()
  const placed = new Map<string, ComponentCatalogEntry>()
  const bindings: PlacedBinding[] = []
  for (const [index, node] of nodes.entries()) {
    const result = validateNode(node, `spec.nodes[${index}]`, takenIds)
    if (!result.ok) return result
    takenIds.add(result.node.id)
    accepted.push(result.node)
    placed.set(result.node.id, result.component)
    bindings.push(...result.bindings.map(binding => ({ ...binding, nodeId: result.node.id })))
  }
  const layout = (value as { layout?: unknown }).layout
  let arrangement: LayoutNode | undefined
  if (layout !== undefined) {
    const result = validateLayout(layout, accepted)
    if (!result.ok) return result
    arrangement = result.node
  }
  const failure = resolveBindings(bindings, placed)
  if (failure !== undefined) return { ok: false, failure }
  return { ok: true, spec: { nodes: accepted, ...(arrangement === undefined ? {} : { layout: arrangement }) } }
}

/**
 * What one reported action's payload was judged to be.
 *
 * Two ways of not being accepted, because the person who clicked is told them
 * apart: one names something they can do about it, and the other is everything
 * else.
 */
export type ActionPayloadVerdict =
  /** Exactly what the action declares. */
  | 'accepted'
  /** Past a declared ceiling on how much a value carries — too many rows ticked, too much typed. */
  | 'too-large'
  /** Not what the action declares, in a way sending less would not fix. */
  | 'refused'

/**
 * Judge one reported action's payload against what its catalog action declares:
 * no undeclared property, every required property present, and every value in
 * range — the same pass a component's props go through.
 *
 * No parameter path is returned. An action's refusal is read by the person who
 * clicked rather than by a model, and a path is not something that person can
 * act on; the half that has to send a declared payload is the seat, which ships
 * in this package and reads the same declaration. What the verdict does carry
 * is whether the payload was merely too big, which is the one refusal a user
 * can answer by ticking or typing less.
 * @param payload - the payload as the action document carried it.
 * @param schema - the properties the action declares.
 * @returns the verdict.
 */
export function acceptsActionPayload(payload: unknown, schema: PropsSchema): ActionPayloadVerdict {
  const failure = validateProps(payload, schema, 'payload')
  if (failure === undefined) return 'accepted'
  return failure.oversize ? 'too-large' : 'refused'
}

/**
 * Validate one whole `show_component` call.
 *
 * Also the reader the content-surface extractor uses over the log: a call the
 * tool refused is still recorded, and running the same judgement over the
 * recorded arguments is what keeps a refused call from becoming an entry the
 * seat cannot draw.
 * @param args - the call's arguments, however malformed.
 * @returns the accepted call, or the refusal.
 */
export function validateComponentCall(args: ComponentCallArguments): ComponentCallResult {
  const id = readBoundedString(
    args.id,
    'id',
    MAX_ENTRY_ID_LENGTH,
    'reuse an id to replace what it shows, and use a new one to add a second block',
    { allowed: TOKEN_CHARSET, hint: TOKEN_HINT },
  )
  if (!id.ok) return id
  const title = readBoundedString(
    args.title,
    'title',
    MAX_TITLE_LENGTH,
    'the short phrase the user reads on this block, in the language the user is writing in',
  )
  if (!title.ok) return title
  const spec = validateComponentSpec(args.spec)
  if (!spec.ok) return spec
  return { ok: true, call: { id: id.value, title: title.value, spec: spec.spec } }
}
