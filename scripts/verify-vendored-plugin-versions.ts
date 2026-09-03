/**
 * Verify that every reference to a desktop built-in plugin names the tarball
 * actually committed under `apps/desktop-server/vendor/`.
 *
 * `apps/desktop-server/package.json` is the source of record: each built-in is a
 * `file:./vendor/<flattened-name>-<version>.tgz` dependency, and the filename
 * carries the version. Three other places restate it — the `OVERRIDES` table in
 * `gen-third-party-notices.ts`, whose in-repository paths become links in
 * `THIRD_PARTY_NOTICES.md`, and the built-in plugins table in both
 * `apps/desktop/README.md` and `apps/desktop/README.zh.md` — and none is
 * regenerated when a plugin is re-vendored, so they drift into dead links,
 * wrong version rows, and provenance claims the payload contradicts.
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { OVERRIDES } from './gen-third-party-notices.ts'

const root = resolve(import.meta.dirname, '..')

/** Manifest declaring the desktop server's dependency closure, including the built-ins. */
export const DESKTOP_SERVER_MANIFEST = 'apps/desktop-server/package.json'
/** Repository-relative directory holding the committed plugin tarballs. */
export const VENDOR_DIRECTORY = 'apps/desktop-server/vendor'

/** One document restating the vendored versions in a built-in plugins table. */
export interface BuiltInPluginDocument {
  /** Repository-relative path, used in diagnostics. */
  path: string
  /** The `##` heading opening the built-in plugins section in this document's language. */
  heading: string
  /** Text that must follow the version code span in every row's version cell, in this document's language. */
  provenance: string
  /** Document contents. */
  text: string
}

/**
 * The documents carrying the table, each with its own heading and provenance phrase.
 * Both are checked: the pairing gate's structural signature counts a table's rows
 * and columns but not its cell text, so a version edited on one side alone passes it.
 */
export const BUILT_IN_PLUGIN_DOCUMENTS: readonly Omit<BuiltInPluginDocument, 'text'>[] = [
  { path: 'apps/desktop/README.md', heading: '## Built-in plugins', provenance: ', from a tarball committed in this repository' },
  { path: 'apps/desktop/README.zh.md', heading: '## 内置插件', provenance: ',来自提交进本仓库的 tarball' },
]

/** One built-in plugin, as declared by a `file:` specifier in the desktop-server manifest. */
export interface VendoredPlugin {
  /** npm package name, scope included. */
  name: string
  /** Version carried by the tarball filename, which is the contract. */
  version: string
  /** Repository-relative path to the committed tarball. */
  tarball: string
}

/** The vendored plugins a manifest declares, plus the specifiers that could not be read as one. */
export interface VendoredPluginScan {
  /** One entry per readable `file:` vendor specifier, manifest order preserved. */
  plugins: VendoredPlugin[]
  /** One line per specifier that names a `file:` dependency this gate cannot account for. */
  violations: string[]
}

/** One row of a built-in plugins table. */
export interface BuiltInPluginRow {
  /** The version cell exactly as written. */
  cell: string
  /** Version inside the cell's leading code span; absent when the cell opens with none. */
  version?: string
}

/** The rows of one document's table, plus the structural problems found while reading them. */
export interface BuiltInPluginTable {
  /** Package name to its row; a name repeated in the table keeps its first row. */
  rows: Map<string, BuiltInPluginRow>
  /** One line per structural problem, such as the same package listed twice. */
  violations: string[]
}

/** Flatten a package name the way `pnpm pack` names its tarball: `@a/b` becomes `a-b`. */
function tarballPrefix(name: string): string {
  return `${name.replace(/^@/, '').replace('/', '-')}-`
}

/**
 * Collect the built-in plugins a desktop-server manifest declares as vendored tarballs.
 * @param manifest - contents of `apps/desktop-server/package.json`.
 * @returns the readable vendored plugins and a violation line for every other `file:` specifier.
 */
export function parseVendoredPlugins(manifest: string): VendoredPluginScan {
  const dependencies = (JSON.parse(manifest) as { dependencies?: Record<string, string> }).dependencies ?? {}
  const scan: VendoredPluginScan = { plugins: [], violations: [] }
  for (const [name, specifier] of Object.entries(dependencies)) {
    if (!specifier.startsWith('file:')) continue
    const match = /^file:\.\/vendor\/(?<file>[^/]+\.tgz)$/.exec(specifier)
    if (match?.groups === undefined) {
      scan.violations.push(`${DESKTOP_SERVER_MANIFEST} declares ${name} as ${specifier}; a built-in must be a tarball under ./vendor/.`)
      continue
    }
    const file = match.groups['file'] ?? ''
    const prefix = tarballPrefix(name)
    if (!file.startsWith(prefix)) {
      scan.violations.push(`${DESKTOP_SERVER_MANIFEST} declares ${name} as ${file}, which does not start with ${prefix}; no version can be derived from it.`)
      continue
    }
    scan.plugins.push({ name, version: file.slice(prefix.length, -'.tgz'.length), tarball: `${VENDOR_DIRECTORY}/${file}` })
  }
  return scan
}

/**
 * Read the built-in plugins table out of one document.
 * @param document - the document, its section heading, and its provenance phrase.
 * @returns the rows keyed by package name, and a violation per repeated package.
 */
export function parseBuiltInPluginTable(document: BuiltInPluginDocument): BuiltInPluginTable {
  const table: BuiltInPluginTable = { rows: new Map(), violations: [] }
  const section = document.text.split(`\n${document.heading}\n`)[1]
  if (section === undefined) return table
  for (const line of section.split('\n')) {
    if (line.startsWith('## ')) break
    const cells = /^\|(?<first>[^|]*)\|(?<second>[^|]*)\|/.exec(line)
    if (cells?.groups === undefined) continue
    const name = /^`(?<name>[^`]+)`$/.exec((cells.groups['first'] ?? '').trim())?.groups?.['name']
    if (name === undefined) continue
    const cell = (cells.groups['second'] ?? '').trim()
    if (table.rows.has(name)) {
      table.violations.push(`${document.path} lists ${name} in the built-in plugins table more than once.`)
      continue
    }
    const version = /^`(?<version>[^`]+)`/.exec(cell)?.groups?.['version']
    table.rows.set(name, version === undefined ? { cell } : { cell, version })
  }
  return table
}

/**
 * Collect the in-repository paths the notices generator's metadata overrides name.
 * A `repo` with no URL scheme is a path into this repository, whatever directory or
 * extension it spells, so a typo in either is checked rather than skipped.
 * @param overrides - the `OVERRIDES` table from `gen-third-party-notices.ts`.
 * @returns package name to the repository-relative path it points at, `./` stripped.
 */
export function parseOverrideRepositoryPaths(overrides: Record<string, { repo?: string }>): Map<string, string> {
  const paths = new Map<string, string>()
  for (const [name, entry] of Object.entries(overrides)) {
    const repo = entry.repo
    if (repo === undefined || repo.includes('://')) continue
    paths.set(name, repo.replace(/^\.\//, ''))
  }
  return paths
}

/** Everything the check reads, supplied by the caller so the rules stay filesystem-free. */
export interface VendoredPluginSources {
  /** Contents of `apps/desktop-server/package.json`. */
  manifest: string
  /** Every document restating the vendored versions, each with its own text. */
  documents: readonly BuiltInPluginDocument[]
  /** The `OVERRIDES` table from `gen-third-party-notices.ts`. */
  overrides: Record<string, { repo?: string }>
  /** Whether a repository-relative path exists. */
  exists: (path: string) => boolean
}

/**
 * Check the vendored-plugin references against the committed tarballs.
 * @param sources - the manifest, the restating documents, the override table, and an existence probe.
 * @returns one human-readable line per violation; empty when every reference agrees.
 */
export function findVendoredPluginViolations(sources: VendoredPluginSources): string[] {
  const scan = parseVendoredPlugins(sources.manifest)
  const violations = [...scan.violations]
  if (scan.plugins.length === 0) violations.push(`${DESKTOP_SERVER_MANIFEST} declares no file: vendor dependency; the built-in plugin set cannot be empty.`)

  for (const plugin of scan.plugins) {
    if (!sources.exists(plugin.tarball)) violations.push(`${DESKTOP_SERVER_MANIFEST} declares ${plugin.name} as ${plugin.tarball}, which does not exist.`)
  }

  for (const [name, path] of parseOverrideRepositoryPaths(sources.overrides)) {
    if (!sources.exists(path)) violations.push(`gen-third-party-notices OVERRIDES points ${name} at ${path}, which does not exist.`)
  }

  const declared = new Set(scan.plugins.map(plugin => plugin.name))
  for (const document of sources.documents) {
    const table = parseBuiltInPluginTable(document)
    violations.push(...table.violations)
    if (table.rows.size === 0) {
      violations.push(`${document.path} has no readable built-in plugins table; its ${JSON.stringify(document.heading)} section or table format changed.`)
    }
    for (const name of table.rows.keys()) {
      if (!declared.has(name)) violations.push(`${document.path} has a built-in plugins row for ${name}, which ${DESKTOP_SERVER_MANIFEST} does not declare as a vendored tarball.`)
    }
    for (const plugin of scan.plugins) {
      const row = table.rows.get(plugin.name)
      if (row === undefined) {
        violations.push(`${document.path} lists no built-in plugins row for ${plugin.name}.`)
        continue
      }
      if (row.version === undefined) {
        violations.push(`${document.path} row for ${plugin.name} has no version code span; its version cell reads ${JSON.stringify(row.cell)}.`)
        continue
      }
      if (row.version !== plugin.version) {
        violations.push(`${document.path} lists ${plugin.name} as ${row.version}; ${plugin.tarball} carries ${plugin.version}.`)
        continue
      }
      const expected = `\`${plugin.version}\`${document.provenance}`
      if (row.cell !== expected) {
        violations.push(`${document.path} row for ${plugin.name} reads ${JSON.stringify(row.cell)}; its version cell must read ${JSON.stringify(expected)}.`)
      }
    }
  }
  return violations
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  const manifest = readFileSync(resolve(root, DESKTOP_SERVER_MANIFEST), 'utf8')
  const documents = BUILT_IN_PLUGIN_DOCUMENTS.map(document => ({ ...document, text: readFileSync(resolve(root, document.path), 'utf8') }))
  const violations = findVendoredPluginViolations({
    manifest,
    documents,
    overrides: OVERRIDES,
    exists: path => existsSync(resolve(root, path)),
  })
  if (violations.length === 0) {
    const count = parseVendoredPlugins(manifest).plugins.length
    console.log(`verify-vendored-plugin-versions: ${String(count)} vendored plugin(s) named consistently by the manifest, the notices overrides, and ${String(documents.length)} README table(s).`)
  } else {
    console.error(`verify-vendored-plugin-versions: ${String(violations.length)} stale vendored-plugin reference(s):`)
    for (const violation of violations) console.error(`  - ${violation}`)
    process.exitCode = 1
  }
}
