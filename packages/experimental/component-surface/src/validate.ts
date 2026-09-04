/**
 * What `show_component` decides about a call before anything is drawn: the
 * entry it names, the ceilings its spec is measured against, the components the
 * catalog admits, and every property those components declare.
 *
 * The whole judgement is synchronous and reaches no browser, no session, and no
 * network: a refusal costs one round trip and changes nothing. Every refusal is
 * model-facing text that names the offending parameter path, because the model
 * has no other way to learn which of eight nodes it got wrong.
 *
 * The module imports nothing but {@link module:@deepseek-ai/dsh-experimental-component-surface/src/component-call},
 * so the browser seat can run the identical pass over a payload arriving on the
 * wire, where a value's declared type is a claim rather than a guarantee.
 * @module @deepseek-ai/dsh-experimental-component-surface/src/validate
 */

import {
  catalogEntry,
  describeCatalog,
  MAX_ENTRY_ID_LENGTH,
  MAX_NODE_ID_LENGTH,
  MAX_NODES,
  MAX_SPEC_BYTES,
  MAX_SPEC_DEPTH,
  MAX_TITLE_LENGTH,
  TOKEN_CHARSET,
  TOKEN_HINT,
  type ComponentCall,
  type ComponentCallArguments,
  type ComponentNode,
  type ComponentSpec,
  type PropsFieldSchema,
  type PropsSchema,
  type StringCharset,
} from './component-call.ts'

/** One refusal: where in the arguments it happened, and what the model is told. */
export interface ComponentCallFailure {
  /** Parameter path of the offending value, such as `spec.nodes[0].props.buttons`. */
  readonly path: string
  /** The model-facing sentence, which always names {@link path}. */
  readonly text: string
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
const SPEC_KEYS: readonly string[] = ['nodes']

/**
 * Build one refusal.
 *
 * Every refusal in this module goes through here, so the path is in the text by
 * construction rather than by each call site remembering to put it there.
 * @param path - parameter path of the offending value.
 * @param message - what is wrong with it and what to send instead.
 * @returns the refusal.
 */
function refuse(path: string, message: string): ComponentCallFailure {
  return { path, text: `show_component: ${path} — ${message}` }
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
      failure: refuse(path, `is ${trimmed.length} characters; at most ${maxLength} are accepted.`),
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
    return refuse(path, `is ${value.length} characters; at most ${schema.maxLength} are accepted.`)
  }
  if (schema.charset !== undefined && !schema.charset.allowed.test(value)) {
    return refuse(path, `may use only ${schema.charset.hint}.`)
  }
  return undefined
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
  if (typeof value === 'string' && schema.values.includes(value)) return undefined
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
  if (value.length < schema.minItems || value.length > schema.maxItems) {
    return refuse(
      path,
      `lists ${value.length} items; between ${schema.minItems} and ${schema.maxItems} are accepted.`,
    )
  }
  const seen = new Set<unknown>()
  for (const [index, item] of value.entries()) {
    const itemPath = `${path}[${index}]`
    const failure = validateField(item, schema.item, itemPath)
    if (failure !== undefined) return failure
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
    case 'enum': return validateEnum(value, schema, path)
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

/**
 * Validate one property record against a declared schema: no undeclared
 * property, every required property present, and every value in range.
 * @param value - the record, however malformed.
 * @param schema - the declared properties.
 * @param path - parameter path of the record itself.
 * @returns the refusal, or `undefined` when the record is accepted.
 */
function validateProps(
  value: unknown,
  schema: PropsSchema,
  path: string,
): ComponentCallFailure | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return refuse(path, 'must be an object.')
  }
  const record = value as Record<string, unknown>
  const declared = Object.keys(schema)
  // Undeclared keys first: a misspelled property is also a missing required
  // one, and naming the spelling is what lets the next call be right.
  for (const key of Object.keys(record)) {
    if (!declared.includes(key)) {
      return refuse(`${path}.${key}`, `is not accepted here. Accepted properties: ${declared.join(', ')}.`)
    }
  }
  for (const [key, field] of Object.entries(schema)) {
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
 * Validate one node: its identity, the component it names, and that
 * component's properties.
 * @param value - the node, however malformed.
 * @param path - parameter path of the node itself.
 * @param takenIds - node ids already used by earlier nodes in this spec.
 * @returns the accepted node, or the refusal.
 */
function validateNode(
  value: unknown,
  path: string,
  takenIds: ReadonlySet<string>,
): { readonly ok: true; readonly node: ComponentNode } | { readonly ok: false; readonly failure: ComponentCallFailure } {
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
        `names no component of this deployment. Available components:\n${describeCatalog()}`,
      ),
    }
  }
  const failure = validateProps(record['props'], entry.propsSchema, `${path}.props`)
  if (failure !== undefined) return { ok: false, failure }
  return { ok: true, node: { id, component: entry.id, props: record['props'] as Record<string, unknown> } }
}

/**
 * Validate one spec document: the protocol ceilings, then every node.
 *
 * Depth is measured before size because both walk the document and only the
 * depth walk is bounded by construction.
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
      failure: refuse('spec', `nests deeper than ${MAX_SPEC_DEPTH} levels. Send the properties the components declare and nothing around them.`),
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
  for (const [index, node] of nodes.entries()) {
    const result = validateNode(node, `spec.nodes[${index}]`, takenIds)
    if (!result.ok) return result
    takenIds.add(result.node.id)
    accepted.push(result.node)
  }
  return { ok: true, spec: { nodes: accepted } }
}

/**
 * Decide whether one reported action's payload is what its catalog action
 * declares: no undeclared property, every required property present, and every
 * value in range — the same pass a component's props go through.
 *
 * Only the verdict is returned. An action's refusal is read by the person who
 * clicked rather than by a model, and a parameter path is not something that
 * person can act on; the half that has to send a declared payload is the seat,
 * which ships in this package and reads the same declaration.
 * @param payload - the payload as the action document carried it.
 * @param schema - the properties the action declares.
 * @returns whether the payload is accepted.
 */
export function acceptsActionPayload(payload: unknown, schema: PropsSchema): boolean {
  return validateProps(payload, schema, 'payload') === undefined
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
