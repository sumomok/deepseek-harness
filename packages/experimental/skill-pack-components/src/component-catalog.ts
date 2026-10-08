/**
 * The component catalog file: what someone writing a skill pack away from any
 * deployment reads to compose its views — every component the component kit
 * registers, the rules a view file is judged by, and the rules a pack and its
 * delivery archive are read under.
 *
 * Every number, list and key in the file is read from the module that enforces
 * it: the components from `COMPONENT_KIT_ENTRIES`, the limits and the two
 * reference keys from the component surface's exports, the field lists, the
 * file extensions and the archive limits from the pack root's. The few rules
 * no export states as data — how a `$from` or `$param` reference is read — are
 * written here as sentences restating the component surface's judgement.
 *
 * The file is versioned by {@link COMPONENT_CATALOG_FORMAT} and carries the
 * versions of the two packages its components come from. It carries no commit
 * and no time, so generating it twice from one tree gives the same bytes.
 * @module @deepseek-ai/dsh-experimental-skill-pack-components/src/component-catalog
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import {
  BINDING_HINT,
  BINDING_KEY,
  BLOCK_KEYS,
  COMPONENT_KIT_ENTRIES,
  describeSchema,
  LAYOUT_DIRECTIONS,
  LAYOUT_GAPS,
  MAX_ENTRY_ID_LENGTH,
  MAX_FLEX,
  MAX_LAYOUT_CHILDREN,
  MAX_LAYOUT_DEPTH,
  MAX_NODE_ID_LENGTH,
  MAX_NODES,
  MAX_OUTPUT_ID_LENGTH,
  MAX_SPEC_BYTES,
  MAX_TITLE_LENGTH,
  PARAM_KEY,
  STACK_KEYS,
  TOKEN_CHARSET,
  TOKEN_HINT,
  withheldComponents,
  type ComponentCatalogEntry,
} from '@deepseek-ai/dsh-experimental-component-surface'
import {
  DEFAULT_PACK_ARCHIVE_LIMITS,
  PACK_ANCHOR_FORMATS,
  PACK_ARCHIVE_EXTENSION,
  PACK_ARCHIVE_FORMAT,
  PACK_FILE_EXTENSIONS,
  PACK_MANIFEST_FIELDS,
  PACK_VIEW_FIELDS,
  PACK_VIEW_FORMATS,
} from '@deepseek-ai/dsh-experimental-skill-pack'

/**
 * The format of the file this module writes. A reader that does not know the
 * number does not read the file; the number changes whenever a key is renamed,
 * removed or given a different meaning.
 */
export const COMPONENT_CATALOG_FORMAT = 1

/** npm name of the package that registers the catalog's components. */
const COMPONENT_KIT_PACKAGE = '@deepseek-ai/dsh-experimental-component-kit'

/** npm name of the kit the component kit vendors to draw its data page. */
const TOY_CRUD_KIT_PACKAGE = '@sumomok/toy-crud-kit'

/** One value the file can hold. */
export type CatalogJson = string | number | boolean | null | readonly CatalogJson[] | { readonly [key: string]: CatalogJson }

/** One object of the file. */
type CatalogObject = { readonly [key: string]: CatalogJson }

/** The declared properties of one component, as the catalog types them. */
type PropsSchema = ComponentCatalogEntry['propsSchema']

/** What one declared property may be, as the catalog types it. */
type PropsFieldSchema = PropsSchema[string]['schema']

/** One package, named and versioned the way its own `package.json` states it. */
export interface CatalogPackage {
  /** Its npm name. */
  readonly package: string
  /** Its version. */
  readonly version: string
}

/** The two packages whose versions the file's header states. */
export interface ComponentCatalogVersions {
  /** The component kit, whose version a pack's `requires.components` range is matched against. */
  readonly componentKit: CatalogPackage
  /** The kit the component kit vendors to draw its data page. */
  readonly toyCrudKit: CatalogPackage
}

/** The file's header: its format, the package versions, and the digests of what it carries. */
export interface ComponentCatalogHeader extends ComponentCatalogVersions {
  /** {@link COMPONENT_CATALOG_FORMAT}. */
  readonly catalogFormat: number
  /** SHA-256, in lowercase hexadecimal, of the UTF-8 bytes of `JSON.stringify(body)`: no whitespace, keys in file order. */
  readonly bodySha256: string
  /** SHA-256 of the example view's bytes; `null` while the file ships no example view. */
  readonly exampleViewSha256: string | null
}

/** The whole file. */
export interface ComponentCatalogDocument {
  /** The format, the package versions and the digests. */
  readonly header: ComponentCatalogHeader
  /** The components and the rules, which {@link ComponentCatalogHeader.bodySha256} covers. */
  readonly body: CatalogObject
}

/**
 * The `show_component` switches a component may need before a deployment
 * offers it. Each is a `Config` field of the component surface's row and off
 * by default, so the file names which switch a component needs and never
 * whether a deployment has turned it on.
 */
const DEPLOYMENT_SWITCHES = ['dataPage', 'dataSource'] as const

/**
 * Name the switches one component needs, by asking the component surface's
 * own rule which components a composition withholds with each switch off and
 * every other on.
 * @param id - the component's catalog id.
 * @returns the switches it needs, in {@link DEPLOYMENT_SWITCHES} order; empty for a component every deployment offers.
 */
function requiredSwitches(id: string): string[] {
  return DEPLOYMENT_SWITCHES.filter(name => withheldComponents({
    dataPage: true,
    dataSource: true,
    // Neither number decides which components are offered.
    defaultPageSize: 1,
    dataPageLoadTimeoutMs: 1,
    [name]: false,
  }).includes(id))
}

/**
 * State one alphabet restriction: the expression the value must match,
 * written with its flags, and the wording a refusal states it in.
 * @param allowed - the expression.
 * @param hint - its model-facing wording.
 * @returns the restriction as the file states it.
 */
function charsetFacts(allowed: RegExp, hint: string): CatalogObject {
  return { pattern: String(allowed), hint }
}

/**
 * State one declared value: its kind, and every bound and list the schema carries.
 * @param schema - the declared value.
 * @returns the value's rules as the file states them.
 */
function schemaFacts(schema: PropsFieldSchema): CatalogObject {
  switch (schema.kind) {
    case 'string': return {
      kind: schema.kind,
      maxLength: schema.maxLength,
      ...schema.charset === undefined ? {} : { charset: charsetFacts(schema.charset.allowed, schema.charset.hint) },
    }
    case 'number': return {
      kind: schema.kind,
      min: schema.min,
      max: schema.max,
      ...schema.integer === undefined ? {} : { integer: schema.integer },
    }
    case 'boolean': return { kind: schema.kind }
    case 'scalar': return { kind: schema.kind, maxLength: schema.maxLength, maxItems: schema.maxItems }
    case 'enum': return {
      kind: schema.kind,
      values: [...schema.values],
      ...schema.hint === undefined ? {} : { hint: schema.hint },
    }
    case 'object': return { kind: schema.kind, fields: propsFacts(schema.fields) }
    case 'record': return {
      kind: schema.kind,
      key: schemaFacts(schema.key),
      maxKeys: schema.maxKeys,
      maxValueLength: schema.maxValueLength,
      minValue: schema.minValue,
      maxValue: schema.maxValue,
      ...schema.sanitize === undefined ? {} : { sanitize: { ...schema.sanitize } },
    }
    case 'array': return {
      kind: schema.kind,
      item: schemaFacts(schema.item),
      minItems: schema.minItems,
      maxItems: schema.maxItems,
      ...schema.uniqueBy === undefined ? {} : { uniqueBy: schema.uniqueBy },
    }
    /* v8 ignore start -- PropsFieldSchema is closed and every variant returns above. */
    default: {
      const unhandled: never = schema
      throw new Error(`skill-pack-components: unhandled props schema ${JSON.stringify(unhandled)}`)
    }
    /* v8 ignore stop */
  }
}

/**
 * State one set of declared properties, a component's or a nested object's.
 *
 * `viewOnly` and `unbindable` are stated as yes or no; the reasons the schema
 * carries for them are the sentences a refused call is told.
 * @param schema - the declared properties.
 * @returns one entry per property, in declaration order.
 */
function propsFacts(schema: PropsSchema): CatalogObject {
  return Object.fromEntries(Object.entries(schema).map(([name, field]) => [name, {
    summary: describeSchema(field.schema),
    required: field.required,
    viewOnly: field.viewOnly !== undefined,
    unbindable: field.unbindable !== undefined,
    schema: schemaFacts(field.schema),
  }]))
}

/**
 * State one component.
 * @param entry - the catalog entry the component kit registers.
 * @returns the component as the file states it.
 */
function componentFacts(entry: ComponentCatalogEntry): CatalogObject {
  return {
    id: entry.id,
    label: entry.label,
    purpose: entry.purpose,
    // TODO: read the entry's own placement once ComponentCatalogEntry declares
    // one. No entry can be restricted to views yet, so a call places every one.
    placement: 'call',
    deploymentSwitches: requiredSwitches(entry.id),
    props: propsFacts(entry.propsSchema),
    outputs: entry.outputs.map(output => ({
      id: output.id,
      summary: describeSchema(output.shape),
      shape: schemaFacts(output.shape),
    })),
    actions: entry.actions.map(action => ({ id: action.id, report: action.report })),
    ...entry.sanitize === undefined ? {} : { sanitize: { ...entry.sanitize } },
  }
}

/**
 * State the rules a view file, a pack and a delivery archive are read under.
 * @returns the rules as the file states them.
 */
function catalogRules(): CatalogObject {
  const token = charsetFacts(TOKEN_CHARSET, TOKEN_HINT)
  return {
    view: {
      id: { maxLength: MAX_ENTRY_ID_LENGTH, charset: token },
      title: { maxLength: MAX_TITLE_LENGTH },
      maxSpecBytes: MAX_SPEC_BYTES,
      nodes: { min: 1, max: MAX_NODES, id: { maxLength: MAX_NODE_ID_LENGTH, charset: token } },
    },
    layout: {
      root: 'stack',
      directions: [...LAYOUT_DIRECTIONS],
      gaps: [...LAYOUT_GAPS],
      maxDepth: MAX_LAYOUT_DEPTH,
      maxChildren: MAX_LAYOUT_CHILDREN,
      flex: { min: 1, max: MAX_FLEX },
      stackKeys: [...STACK_KEYS],
      blockKeys: [...BLOCK_KEYS],
    },
    binding: {
      key: BINDING_KEY,
      reference: BINDING_HINT,
      maxNodeIdLength: MAX_NODE_ID_LENGTH,
      maxOutputIdLength: MAX_OUTPUT_ID_LENGTH,
      rules: [
        `A bound property is an object whose only key is ${BINDING_KEY}, written as the whole value of the property; one inside a list item or a nested object is refused.`,
        'The node is another node of the same view, the output is one that node\'s component declares, and an index takes one item of a list output.',
        'A property marked unbindable cannot be bound, and a bound property must accept the output\'s shape: the same kind, and nothing past its limits.',
        'The value is resolved in the page from what the other block reports; the view file carries only the reference.',
      ],
    },
    param: {
      key: PARAM_KEY,
      rules: [
        `A parameter reference is an object whose only key is ${PARAM_KEY}, written as the whole value of a property; one standing for an item of a list is refused.`,
        'It names one entry of the view file\'s params, and that entry is text, a number, true or false.',
        `It is replaced when the view is read, before the view is judged; ${BINDING_KEY} references are left as written.`,
      ],
    },
    viewFile: {
      fields: PACK_VIEW_FIELDS.map(field => ({ ...field })),
      otherKeys: 'ignored',
      viewFormats: [...PACK_VIEW_FORMATS],
    },
    manifest: {
      key: 'metadata',
      fields: PACK_MANIFEST_FIELDS.map(field => ({ ...field })),
      otherKeys: 'refused',
      viewFormats: [...PACK_VIEW_FORMATS],
      anchorFormats: [...PACK_ANCHOR_FORMATS],
    },
    packFiles: {
      extensions: [...PACK_FILE_EXTENSIONS],
    },
    archive: {
      extension: PACK_ARCHIVE_EXTENSION,
      format: PACK_ARCHIVE_FORMAT,
      defaultLimits: { ...DEFAULT_PACK_ARCHIVE_LIMITS },
    },
  }
}

/**
 * Hash one text the way the header states its digests.
 * @param text - the text, hashed as UTF-8.
 * @returns the SHA-256 digest in lowercase hexadecimal.
 */
function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Build the whole file from the catalog this tree registers.
 * @param versions - the two package versions the header states.
 * @returns the document, its header digests filled in.
 */
export function buildComponentCatalog(versions: ComponentCatalogVersions): ComponentCatalogDocument {
  const body: CatalogObject = {
    components: COMPONENT_KIT_ENTRIES.map(componentFacts),
    rules: catalogRules(),
  }
  return {
    header: {
      catalogFormat: COMPONENT_CATALOG_FORMAT,
      componentKit: versions.componentKit,
      toyCrudKit: versions.toyCrudKit,
      bodySha256: sha256(JSON.stringify(body)),
      exampleViewSha256: null,
    },
    body,
  }
}

/**
 * Write the file's text: two-space indentation and one trailing newline.
 * @param versions - the two package versions the header states.
 * @returns the complete file.
 */
export function componentCatalogText(versions: ComponentCatalogVersions): string {
  return `${JSON.stringify(buildComponentCatalog(versions), null, 2)}\n`
}

/**
 * Read one package's name and version off its parsed `package.json`.
 * @param manifest - the parsed manifest.
 * @param expected - the npm name the manifest must carry.
 * @returns the package.
 * @throws {Error} when the manifest names another package or carries no version.
 */
export function readCatalogPackage(manifest: unknown, expected: string): CatalogPackage {
  const { name, version } = (manifest ?? {}) as { name?: unknown; version?: unknown }
  if (name !== expected) {
    throw new Error(`skill-pack-components: the package.json read for ${expected} names ${JSON.stringify(name)}`)
  }
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error(`skill-pack-components: the package.json of ${expected} carries no version`)
  }
  return { package: expected, version }
}

/**
 * Read the installed versions of the component kit and of the kit it vendors.
 *
 * Each is read off the manifest Node resolves: the component kit's from this
 * package, and the vendored kit's from the component kit, which is the only
 * package that depends on it.
 * @returns the two versions.
 * @throws {Error} when either manifest cannot be resolved, is not JSON, or {@link readCatalogPackage} refuses it.
 */
export function readComponentCatalogVersions(): ComponentCatalogVersions {
  const kitManifest = createRequire(import.meta.url).resolve(`${COMPONENT_KIT_PACKAGE}/package.json`)
  const crudManifest = createRequire(kitManifest).resolve(`${TOY_CRUD_KIT_PACKAGE}/package.json`)
  return {
    componentKit: readCatalogPackage(JSON.parse(readFileSync(kitManifest, 'utf8')), COMPONENT_KIT_PACKAGE),
    toyCrudKit: readCatalogPackage(JSON.parse(readFileSync(crudManifest, 'utf8')), TOY_CRUD_KIT_PACKAGE),
  }
}
