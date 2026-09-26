/**
 * Checks the packaging pipeline runs on the staged server tree, on what a
 * boot of it printed, and on the profile composition it resolved.
 *
 * A server that prints its URL line has not proved its profile composed: a
 * `dsh.profile.bundles` name the Loader cannot resolve, or whose DSH peers the
 * runtime refuses, is skipped with one stderr line and the boot goes on without
 * that bundle's layer. A refused plugin row is disabled the same way, and an
 * entry that fails to start is reported in a warning while its siblings keep
 * running. These functions turn those lines, and the composed tree
 * `--dump-config` prints, into build failures. The tree check finds packages
 * the payload withholds wherever a hoisting change put them.
 * @module
 */

import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import yaml from 'js-yaml'

/**
 * The stderr fragments a profile boot writes when it leaves part of the
 * composition out while still starting: a skipped bundle
 * (`<bin>: skipping profile bundle "<name>": <reason>`), a refused plugin row
 * (`<bin>: disabling profile plugin …`), and entries that did not start
 * (`<bin>: warning: <n> entries did not activate`).
 */
export const LOAD_FAILURE_MARKERS = ['skipping profile bundle', 'disabling profile plugin', 'did not activate'] as const

/**
 * Packages the desktop payload leaves out although the server closure brings
 * them in. `@deepseek-ai/dsh-experimental-auto-review` is a runtime dependency
 * of `@deepseek-ai/dsh` so that upstream's plugin page can offer it; its review
 * runs beside this deployment's own permission gateway rather than in place of
 * it. The desktop profile names it in one row only, the one the shell seeds to
 * keep it off should the plugin page install it (`seedAutoReviewGuard` in
 * `src/profile-seed.ts`).
 */
export const WITHHELD_PACKAGES = ['@deepseek-ai/dsh-experimental-auto-review'] as const

/** The row the desktop composition layer opens full-text search on, and the value it sets. */
const DESKTOP_LAYER_PROBE = { id: 'session-query-sqlite', openAt: 'first-search' } as const

/** One entry the activation warning names on the lines after it: `<id> (<package>): <reason>`. */
const INACTIVE_ENTRY = /^\S+ \([^)]+\): /

/**
 * The lines of a boot's stderr that report a bundle, row, or entry the boot
 * went on without. The activation warning states only a count, and names each
 * entry and its reason on a line of its own after it; those lines are kept
 * with it, so the build failure says which entries did not start.
 * @param stderr - everything the server wrote to stderr.
 * @returns the offending lines, in order; empty when the composition loaded whole.
 */
export function loadFailureLines(stderr: string): string[] {
  const lines = stderr.split(/\r?\n/)
  const found: string[] = []
  for (const [index, line] of lines.entries()) {
    if (!LOAD_FAILURE_MARKERS.some(marker => line.includes(marker))) continue
    found.push(line)
    const count = /(\d+) entr(?:y|ies) did not activate/.exec(line)?.[1]
    if (count === undefined) continue
    for (const entry of lines.slice(index + 1, index + 1 + Number(count))) {
      if (!INACTIVE_ENTRY.test(entry)) break
      found.push(entry)
    }
  }
  return found
}

/** Variables the package managers inject into a script's environment, matched case-insensitively. */
const PACKAGE_MANAGER_ENV = /^(?:NODE_PATH|npm_.*|PNPM_.*)$/i

/**
 * The environment a staged server is booted with: the build's own, without
 * what pnpm and npm injected into it.
 *
 * pnpm's `.bin` shims export `NODE_PATH` naming the workspace's
 * `node_modules/.pnpm/node_modules`, and `createRequire().resolve.paths()`
 * searches `NODE_PATH`. A server inheriting it resolves every package the
 * payload lacks from the build checkout, so a boot that passes proves nothing
 * about the payload an installed shell runs, which has no such variable.
 * @param env - the build process's environment.
 * @returns a copy without `NODE_PATH`, `npm_*`, and `PNPM_*`; every other variable as given.
 */
export function stagedBootEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !PACKAGE_MANAGER_ENV.test(name)))
}

/** The installation package whose production closure a payload must carry. */
export const INSTALLATION_PACKAGE = '@deepseek-ai/dsh'

/**
 * The directory Node would load a dependency from, searching the dependent's
 * own `node_modules` and each ancestor's up to the tree root.
 * @param root - the tree root, whose `node_modules` is searched last.
 * @param from - the dependent package's directory.
 * @param name - the dependency's package name.
 * @returns the dependency's directory, or undefined when no `package.json` is found for it.
 */
function dependencyDir(root: string, from: string, name: string): string | undefined {
  for (let dir = from; dir.startsWith(root); dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
    if (dir === root) break
  }
  return undefined
}

/**
 * The production dependencies of the installation package that a tree lacks,
 * followed through each found dependency's own production dependencies.
 *
 * Only `dependencies` count: an optional dependency is a platform member a
 * target may leave out, and a peer is supplied by whatever depends on it. A
 * withheld package is neither required nor followed.
 * @param root - a staged server tree or a finished payload.
 * @param withheld - package names the payload leaves out on purpose.
 * @param follows - which dependency names count; the finished payload inlines third-party packages, so its check follows one scope.
 * @returns `<dependent> -> <dependency>` for every dependency no `package.json` answers, sorted.
 */
export async function missingProductionDependencies(
  root: string, withheld: readonly string[], follows: (name: string) => boolean = () => true,
): Promise<string[]> {
  const missing = new Set<string>()
  const start = join(root, 'node_modules', INSTALLATION_PACKAGE)
  if (!existsSync(join(start, 'package.json'))) return [`(tree) -> ${INSTALLATION_PACKAGE}`]
  const visited = new Set<string>()
  const queue: { name: string; dir: string }[] = [{ name: INSTALLATION_PACKAGE, dir: start }]
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    if (visited.has(next.dir)) continue
    visited.add(next.dir)
    const manifest = JSON.parse(await readFile(join(next.dir, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      if (withheld.includes(name) || !follows(name)) continue
      const dir = dependencyDir(root, next.dir, name)
      if (dir === undefined) missing.add(`${next.name} -> ${name}`)
      else queue.push({ name, dir })
    }
  }
  return [...missing].sort()
}

/**
 * The directories under `root` that carry a withheld package, at any depth.
 *
 * A directory counts when its name is the package's unscoped name, wherever it
 * sits: a hoisting change can nest a copy under another package's own
 * `node_modules`, where a removal addressed at the top-level path misses it.
 * Files of that name do not count, and symbolic links are not followed.
 * @param root - the staged tree to search.
 * @param names - the package names to look for, scoped or not.
 * @returns each matching directory relative to `root`, with `/` separators, sorted.
 */
export async function findWithheldDirectories(root: string, names: readonly string[]): Promise<string[]> {
  const wanted = new Set(names.map(name => name.slice(name.lastIndexOf('/') + 1)))
  const found: string[] = []
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const path = join(dir, entry.name)
      if (wanted.has(entry.name)) found.push(relative(root, path).split(sep).join('/'))
      await walk(path)
    }
  }
  await walk(root)
  return found.sort()
}

/** The `!!js` dialect a config dump prints, read back as an opaque expression. */
const DUMP_SCHEMA = yaml.DEFAULT_SCHEMA.extend([
  new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: (source: string) => ({ __jsExpr: source }) }),
])

/**
 * Whether one parsed YAML value is a mapping.
 * @param value - one parsed YAML node.
 * @returns true for a mapping, false for a scalar, a sequence, or null.
 */
function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Find a row by id, descending into group rows the way the Loader's patch
 * index does: a row is a group when `group` is true and its `config` is an
 * entry list.
 * @param rows - one parsed entry list.
 * @param id - the row id.
 * @returns the row, or undefined when no row at any depth has that id.
 */
function findRow(rows: readonly unknown[], id: string): Record<string, unknown> | undefined {
  for (const row of rows) {
    if (!isMapping(row)) continue
    if (row['id'] === id) return row
    const children = row['config']
    if (row['group'] === true && Array.isArray(children)) {
      const nested = findRow(children, id)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

/**
 * Check that a desktop profile's composed tree carries the desktop composition
 * layer.
 *
 * `@deepseek-ai/dsh-desktop-app` is the last bundle the profile names, and the
 * one row every layer below leaves at `openAt: never` is the full-text search
 * row it opens at `first-search`. The row is looked up in what
 * `dsh --profile <name> --dump-config` printed, which composes the same bundle
 * list the boot resolved.
 * @param dump - the stdout of `--dump-config`.
 * @throws when the dump is not an entry list, has no such row, or the row is disabled or not opened at the first search.
 */
export function verifyDesktopLayer(dump: string): void {
  const parsed: unknown = yaml.load(dump, { schema: DUMP_SCHEMA })
  if (!Array.isArray(parsed)) throw new Error('package: --dump-config printed no entry list.')
  const { id, openAt } = DESKTOP_LAYER_PROBE
  const row = findRow(parsed, id)
  if (row === undefined) throw new Error(`package: the composed desktop profile has no ${id} row.`)
  const config = row['config']
  const composed = isMapping(config) ? config['openAt'] : undefined
  if (row['disabled'] !== undefined || composed !== openAt) {
    throw new Error(
      `package: the composed ${id} row is not the desktop layer's (openAt ${JSON.stringify(composed)}, disabled ${JSON.stringify(row['disabled'])}); `
      + '@deepseek-ai/dsh-desktop-app did not reach the profile.',
    )
  }
}
