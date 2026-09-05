/**
 * One-time conversion of a settings document written before a workflow's
 * `navSnapshot` carried a kind alongside each id.
 *
 * The durable format changed from `string[]` (every entry a content-frame
 * page id) to `{kind, entryId}[]`, and this repository's pre-release stance
 * rejects the old form outright rather than reading it through a
 * compatibility shim — see `workflows.ts`'s `legacyNavSnapshotMessage`, whose
 * refusal names the `convert-nav-snapshot` package script, the CLI over this
 * module (`bin.ts`).
 * Every stored entry meant a page, so the conversion is exact: each id
 * becomes `{kind: 'page', entryId: id}`.
 *
 * The same pass writes the empty `groups` list the current format carries, so
 * one run leaves a document that reads as what it now is rather than as one
 * the schema silently defaults two fields into. Only an absent key is written:
 * a `groups` an operator wrote something unusable into is left for the schema
 * to refuse, for the reason a mixed `navSnapshot` is (see {@link legacyEntries}).
 *
 * The YAML path edits through `yaml`'s document model rather than a
 * parse/serialize round trip, so key order and every comment elsewhere in
 * `$DSH_HOME/settings.yaml` survive the rewrite. A comment attached to a
 * `navSnapshot` value this pass replaces does not: it belongs to the node
 * being replaced and goes with it.
 * @module @deepseek-ai/dsh-experimental-server-sidebar/nav-snapshot-migration
 */

import { readFile, writeFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { parseDocument } from 'yaml'
import { SERVER_SIDEBAR_NAMESPACE, type NavSnapshotItem } from './workflows.ts'

/** Storage format of one settings document, derived from its file extension. */
export type SettingsFormat = 'yaml' | 'json'

/** File extensions the settings file provider serves, mapped to their format. */
const FORMATS: Record<string, SettingsFormat> = {
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.json': 'json',
}

/** What one conversion did. */
export interface ConversionOutcome {
  /** How many workflows had a pre-view snapshot rewritten; `0` means every stored snapshot was already current. */
  converted: number
  /** Whether the empty `groups` list was written because the document carried no such key. */
  groupsSeeded: boolean
  /** The document text as it should now stand; byte-identical to the input when nothing changed. */
  text: string
}

/**
 * Whether one conversion changed anything, and therefore whether the document
 * is worth writing back.
 * @param outcome - what the conversion did.
 * @returns whether `outcome.text` differs from the text it was built from.
 */
export function changedAnything(outcome: ConversionOutcome): boolean {
  return outcome.converted > 0 || outcome.groupsSeeded
}

/**
 * Whether one decoded value is a settings document's own section (an object,
 * not an array or a primitive).
 * @param value - the decoded value.
 * @returns whether the value's own keys can be read and written.
 */
function isSection(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read one stored workflow's `navSnapshot` as the pre-view `string[]` form.
 *
 * An empty array is not reported: it carries no entry to reinterpret and is
 * already valid under both formats. A mixed array is not reported either —
 * the format change was atomic, so no document ever wrote one, and leaving it
 * for the schema to refuse by entry is more useful than guessing at it.
 * @param workflow - one stored workflow, of unknown shape.
 * @returns the stored ids when every entry is a string and there is at least
 * one, otherwise `undefined`.
 */
function legacyEntries(workflow: unknown): string[] | undefined {
  const navSnapshot = (workflow as Record<string, unknown> | null)?.navSnapshot
  if (!Array.isArray(navSnapshot) || navSnapshot.length === 0) return undefined
  if (!navSnapshot.every(entry => typeof entry === 'string')) return undefined
  return navSnapshot
}

/** The two edits a conversion makes, applied by whichever of the two document models is in play. */
interface DocumentEdits {
  /**
   * Rewrite one workflow's snapshot.
   * @param workflow - the decoded workflow object (what the JSON path mutates).
   * @param index - its position in the stored `workflows` array (what the YAML path addresses).
   * @param navSnapshot - the snapshot it should now carry.
   */
  setNavSnapshot: (workflow: Record<string, unknown>, index: number, navSnapshot: NavSnapshotItem[]) => void
  /**
   * Write the empty `groups` list.
   * @param section - the decoded section (what the JSON path mutates; the YAML path addresses it by name).
   */
  seedGroups: (section: Record<string, unknown>) => void
}

/**
 * Walk one document's decoded value, reporting each edit to `edits` rather
 * than making it here: the JSON path rewrites the decoded objects themselves,
 * while the YAML path leaves them alone and edits the parsed nodes at the same
 * addresses.
 * @param document - the decoded settings document, of unknown shape.
 * @param edits - how to apply each edit (see {@link DocumentEdits}).
 * @returns what the walk found to change.
 */
function planConversion(
  document: unknown, edits: DocumentEdits,
): { converted: number; groupsSeeded: boolean } {
  const section = isSection(document) ? document[SERVER_SIDEBAR_NAMESPACE] : undefined
  if (!isSection(section)) return { converted: 0, groupsSeeded: false }
  const workflows = section.workflows
  let converted = 0
  if (Array.isArray(workflows)) {
    workflows.forEach((workflow: unknown, index) => {
      const entries = legacyEntries(workflow)
      if (entries === undefined) return
      // `legacyEntries` answered non-`undefined`, which it does only for an
      // object carrying a non-empty array of strings under `navSnapshot`.
      edits.setNavSnapshot(workflow as Record<string, unknown>, index, entries.map(entryId => ({ kind: 'page', entryId })))
      converted += 1
    })
  }
  const groupsSeeded = !('groups' in section)
  if (groupsSeeded) edits.seedGroups(section)
  return { converted, groupsSeeded }
}

/**
 * Convert one settings document's text.
 * @param text - the document as stored.
 * @param format - how to read and write it (see {@link resolveFormat}).
 * @returns the outcome; `text` is the input unchanged when nothing changed, so
 * a caller can skip the write on {@link changedAnything} without comparing.
 * @throws {SyntaxError} when a JSON document does not parse.
 */
export function convertSettingsText(text: string, format: SettingsFormat): ConversionOutcome {
  if (format === 'json') {
    const document = JSON.parse(text) as unknown
    const found = planConversion(document, {
      setNavSnapshot: (workflow, _index, navSnapshot) => { workflow.navSnapshot = navSnapshot },
      seedGroups: (section) => { section.groups = [] },
    })
    const outcome = { ...found, text }
    return changedAnything(outcome) ? { ...found, text: `${JSON.stringify(document, undefined, 2)}\n` } : outcome
  }
  const document = parseDocument(text)
  const found = planConversion(document.toJS() as unknown, {
    setNavSnapshot: (_workflow, index, navSnapshot) => {
      document.setIn([SERVER_SIDEBAR_NAMESPACE, 'workflows', index, 'navSnapshot'], navSnapshot)
    },
    seedGroups: () => { document.setIn([SERVER_SIDEBAR_NAMESPACE, 'groups'], []) },
  })
  const outcome = { ...found, text }
  return changedAnything(outcome) ? { ...found, text: document.toString() } : outcome
}

/**
 * Derive a settings document's format from its file extension, refusing an
 * extension the settings file provider does not serve — the same three the
 * provider's own `resolveSpec` accepts.
 * @param filename - the document's path.
 * @returns its storage format.
 * @throws {Error} when the extension is not one the provider serves.
 */
export function resolveFormat(filename: string): SettingsFormat {
  const format = FORMATS[extname(filename)]
  if (format === undefined) {
    throw new Error(`convert-nav-snapshot: extension "${extname(filename)}" is not a settings document (use .yaml, .yml, or .json)`)
  }
  return format
}

/**
 * Convert one settings document on disk.
 * @param filename - the document's path.
 * @param options - `dryRun` reports what would change and writes nothing.
 * @returns the outcome; nothing is written when nothing changed, whatever
 * `dryRun` says.
 * @throws {Error} when the extension is unsupported, the file cannot be read,
 * or its text does not parse.
 */
export async function convertSettingsFile(
  filename: string, options: { dryRun: boolean },
): Promise<ConversionOutcome> {
  const format = resolveFormat(filename)
  const outcome = convertSettingsText(await readFile(filename, 'utf8'), format)
  if (changedAnything(outcome) && !options.dryRun) await writeFile(filename, outcome.text, 'utf8')
  return outcome
}
