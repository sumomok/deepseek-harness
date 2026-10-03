/**
 * Collapse a derived server payload's third-party trees into the packages that
 * import them.
 *
 * A Windows install spends its time on file count and almost nothing else:
 * moving the payload as 12453 files costs 5.67 s where the same bytes as 10
 * files cost 0.12 s, so 98% of it is per-file overhead, and the installer pays
 * that twice — once decompressing into `%TEMP%`, once copying to the install
 * directory. The measurement and its two failed attempts are in
 * `.agents/notes/implemented/testing/2026-08-19-windows-install-cost.md`.
 *
 * The shape is decided by the plugin model. Cordis resolves plugins by package
 * name from configuration read at boot, so every `@deepseek-ai/*` package stays
 * a resolvable directory with an entry in it: they are external to one another
 * and only their dependencies are inlined. The same holds for the out-of-scope
 * plugin packages the installer ships (`@sumomok/*` and the `@haoran/*`
 * built-ins), which a profile names in `dsh.profile.bundles` and
 * nothing imports: they are recognized by the `dsh.bundle` declaration in their
 * own manifest and kept whole, because they arrive pre-bundled and the browser
 * half of one that has it must stay exactly as its client build left it. What
 * is left of a third-party package after that is deleted, but only if nothing
 * reachable still imports it.
 *
 * This runs on the derived payload rather than in the package build, which is
 * what keeps the 219 publishable npm artifacts exactly as they are: nothing
 * here touches a package's own `lib/` in the workspace, only the copy staged
 * for this installer.
 */

import { build } from 'esbuild'
import { existsSync } from 'node:fs'
import { readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

/** The manifest fields this module reads. */
interface PackageManifest {
  dsh?: { bundle?: { patch?: string } }
  [key: string]: unknown
}

/** The scope whose packages stay resolvable by name, because the loader names them. */
const OURS = '@deepseek-ai'

/**
 * Packages a bundle cannot carry. Each one's JavaScript builds a path to a
 * `.node` or an `.exe` beside itself, so inlining it leaves the loader without
 * the file it goes looking for.
 *
 * `node-addon-require-builtin` is the one that is not obviously native from its
 * name and the one whose absence is hardest to read: the loader reaches Node's
 * own module graph through it to set `loader.internal`, and a payload that
 * inlined it fails one plugin later with `--expose-internals is required`,
 * naming a flag that was never involved.
 *
 * Both platforms' selected variants are named, and the symmetry is load-bearing.
 * A variant reached only by `require.resolve` or by the dynamic library search
 * of a `.node` is invisible to the reachability walk, so an unnamed one is
 * deleted as unreferenced third-party: naming only the Windows side left the
 * darwin payload without `@img/sharp-libvips-darwin-*` (boot fails in
 * `sharp.mjs`), `@vscode/ripgrep-darwin-*` (search finds no binary), and
 * `node-addon-require-builtin-darwin-*`, while the darwin payload still carried
 * the Windows ripgrep it cannot run. `@koromix/koffi-darwin-*` survived only
 * because koffi's JavaScript requires it statically.
 *
 * `sherpa-onnx-node` loads its member by a relative path,
 * `require('../sherpa-onnx-darwin-arm64/sherpa-onnx.node')`, which names no
 * package, and that `.node` finds `libonnxruntime.dylib` beside itself through
 * the dynamic library search; its Windows member is spelled `win-x64`.
 */
const NATIVE = [
  'node-pty',
  'koffi', '@koromix/koffi-win32-x64', `@koromix/koffi-darwin-${process.arch}`,
  'sharp', '@img/sharp-win32-x64', '@img/colour',
  `@img/sharp-darwin-${process.arch}`, `@img/sharp-libvips-darwin-${process.arch}`,
  '@vscode/ripgrep', '@vscode/ripgrep-win32-x64', `@vscode/ripgrep-darwin-${process.arch}`,
  'node-addon-require-builtin', 'node-addon-require-builtin-win32-x64-msvc',
  `node-addon-require-builtin-darwin-${process.arch}`,
  'sherpa-onnx-node', 'sherpa-onnx-win-x64', `sherpa-onnx-darwin-${process.arch}`,
]

/**
 * Gives each ESM bundle a working `require`. A CommonJS dependency bundled into
 * an ESM output still calls it — `ws` reaching for `events` is what takes the
 * boot down — and esbuild's shim for it has nothing to fall back on otherwise.
 */
const BANNER = [
  "import { createRequire as __dshCreateRequire } from 'node:module';",
  'const require = __dshCreateRequire(import.meta.url);',
].join('\n')

/**
 * Whether a package is a profile bundle: its manifest declares `dsh.bundle`,
 * which is what makes a profile able to name it in `dsh.profile.bundles` and
 * what makes the Loader import it by that bare name at boot. Nothing in the
 * payload references such a package by a specifier, so without this it reads
 * as unreachable third-party and is deleted.
 * @param nodeModules - the payload's node_modules directory.
 * @param name - the package name to test.
 * @returns true when the installed manifest declares a bundle patch layer.
 */
async function declaresBundle(nodeModules: string, name: string): Promise<boolean> {
  const manifestPath = join(nodeModules, name, 'package.json')
  if (!existsSync(manifestPath)) return false
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as PackageManifest
  return manifest.dsh?.bundle?.patch !== undefined
}

/** Every package directory under one node_modules, scope-aware. */
async function packagesIn(nodeModules: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(nodeModules, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === '.bin') continue
    if (entry.name.startsWith('@')) {
      for (const scoped of await readdir(join(nodeModules, entry.name), { withFileTypes: true })) {
        if (scoped.isDirectory()) out.push(`${entry.name}/${scoped.name}`)
      }
    } else out.push(entry.name)
  }
  return out
}

/** The JavaScript entry points a package advertises, relative to its directory. */
function entryPointsOf(manifest: Record<string, unknown>): string[] {
  const found = new Set<string>()
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      if (/\.(?:js|mjs|cjs)$/.test(value)) found.add(value.replace(/^\.\//, ''))
      return
    }
    if (value !== null && typeof value === 'object') for (const nested of Object.values(value)) visit(nested)
  }
  visit(manifest['exports'])
  if (typeof manifest['main'] === 'string') found.add(manifest['main'].replace(/^\.\//, ''))
  return [...found]
}

/** Any of the three quote characters a JavaScript string literal opens or closes with. */
const QUOTE = String.raw`['"\`]`

/** The rest of a string literal after its opening quote: everything up to the next quote. */
const UNQUOTED_RUN = String.raw`[^'"\`]*`

/**
 * The text that has to come right before a string literal's opening quote for
 * the literal to count as a package reference, one pattern per form
 * [[specifierFor]] documents. [[specifierFor]] and [[referencedNames]] are both
 * built from this list, so the per-name pattern and the single scan cannot
 * accept different call forms.
 */
const REFERENCE_PREFIXES = [
  String.raw`(?:from|require|import)\s*\(?\s*`,
  String.raw`(?:import\s*\.\s*meta|[\w$]*[Rr]equire[\w$]*|createRequire\s*\([^()]*\))\s*\.\s*resolve\s*\(\s*`,
  // A require built and invoked in one expression — `createRequire(url)('x')`
  // — loads the module at run time without the bundler ever seeing it, and
  // the directory has to be there just as for a resolution call.
  String.raw`createRequire\s*\([^()]*\)\s*\(\s*`,
]

/**
 * Matches a reference to `name` — the specifier itself, not the word appearing
 * anywhere. Two forms count, because both make the package a directory the
 * payload has to keep:
 *
 * - a specifier after `from`, `require` or `import`, which is what a bundler
 *   would follow;
 * - the literal argument of a resolution call — `import.meta.resolve('open')`,
 *   `require.resolve('@img/sharp-libvips-darwin-arm64/binary')` — which
 *   produces a path rather than a module, so nothing is inlined and the
 *   directory has to be there at run time.
 *
 * The third form is a require built and invoked in one expression,
 * `createRequire(import.meta.url)('name')`: the bundler cannot inline what
 * only a run-time call names, so the directory must survive the walk.
 *
 * What none of the forms reaches is a name that does not appear as a literal: a
 * template with a substitution (`@img/sharp-${platform}-${arch}`, how sharp and
 * `@vscode/ripgrep` select their platform package) and the dynamic library
 * search a `.node` performs on its own. Those are what `NATIVE` is for.
 *
 * The reachability walk does not run this pattern; it runs [[referencedNames]],
 * which accepts exactly the texts this pattern accepts for a name without a
 * quote character.
 * @param name - the package name a reference would have to spell out.
 * @returns a pattern matching either reference form for that name.
 */
export function specifierFor(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\/]/g, match => `\\${match}`)
  const literal = QUOTE + escaped + `(?:/${UNQUOTED_RUN})?` + QUOTE
  return new RegExp(REFERENCE_PREFIXES.map(prefix => prefix + literal).join('|'))
}

/**
 * The source of the single-scan pattern: an opening quote preceded by one of
 * [[REFERENCE_PREFIXES]] (a lookbehind ending at that quote), then the run up
 * to the next quote, captured, with the closing quote required but not
 * consumed, so the closing quote of one literal is also tried as the opening
 * quote of the next.
 */
export const REFERENCE_SCAN_SOURCE =
  `${QUOTE}(?<=(?:${REFERENCE_PREFIXES.join('|')})${QUOTE})(${UNQUOTED_RUN})(?=${QUOTE})`

/**
 * The members of `names` that `text` references: for every name `n` that
 * contains none of `'`, `"` and `` ` ``, `n` is returned exactly when
 * `specifierFor(n).test(text)` holds, found in one scan of `text` instead of
 * one regular-expression search per name. A name with a quote character is
 * never returned, because the run the scan reads ends at the first quote,
 * while `specifierFor` matches the quote inside the name as a literal
 * character; [[bundleClosure]] refuses a payload that has such a name.
 *
 * `specifierFor(n)` accepts a text when some opening quote follows one of the
 * reference prefixes and the run after it, up to the next quote, is `n` itself
 * or starts with `n/`. The scan visits every quote that follows a prefix, reads
 * that run once, and looks up the run and each part of it that ends before a
 * `/` in `names`.
 * @param text - the source text to scan.
 * @param names - the package names to look for.
 * @returns the referenced names, a subset of `names`.
 */
export function referencedNames(text: string, names: ReadonlySet<string>): Set<string> {
  const found = new Set<string>()
  for (const match of text.matchAll(new RegExp(REFERENCE_SCAN_SOURCE, 'g'))) {
    const run = match[1] ?? ''
    if (names.has(run)) found.add(run)
    for (let slash = run.indexOf('/'); slash !== -1; slash = run.indexOf('/', slash + 1)) {
      const head = run.slice(0, slash)
      if (names.has(head)) found.add(head)
    }
  }
  return found
}

/** Every JavaScript-ish file one package ships, concatenated. */
async function textOf(nodeModules: string, name: string): Promise<string> {
  const root = join(nodeModules, name)
  if (!existsSync(root)) return ''
  let text = ''
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (/\.(?:js|mjs|cjs|json)$/.test(entry.name)) text += await readFile(path, 'utf8').catch(() => '')
    }
  }
  await walk(root)
  return text
}

/** What bundling one package did: how many entry points it built, or that esbuild refused it. */
interface BuildResult {
  ok: boolean
  entries: number
}

/**
 * How many packages esbuild bundles at once. Builds cannot see one another:
 * each writes only its own package's `lib/`, and every package it could read
 * from another build's output is external. Each `build()` call already spreads
 * its work over every core, so the pool only overlaps one package's file reads
 * and call setup with another's build: on the rc.37 payloads `bundleClosure`
 * took 2.4-2.6 s one package at a time, 1.75-1.89 s with 4, and 1.65-1.68 s
 * with 10, so 4 keeps nearly all of the gain with fewer builds in memory.
 */
const BUILD_CONCURRENCY = 4

/**
 * Bundle one of our packages' Node entry points in place.
 * @param nodeModules - the payload's node_modules directory.
 * @param name - the package to bundle.
 * @param external - the packages every bundle leaves as imports.
 * @returns the outcome, or undefined when the package has no manifest or no Node entry point.
 */
async function bundlePackage(nodeModules: string, name: string, external: string[]): Promise<BuildResult | undefined> {
  const dir = join(nodeModules, name)
  const manifestPath = join(dir, 'package.json')
  if (!existsSync(manifestPath)) return undefined
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
  const declared = entryPointsOf(manifest).filter(entry => existsSync(join(dir, entry)))
  // Browser artifacts are left exactly as the client face built them. They
  // register themselves with `window.__ModuleLoader__.load` when the page
  // evaluates them, and rebundling one for `platform: 'node'` puts an
  // `import ... from 'node:module'` on top of it — the registration is still
  // in the file, and the browser never reaches it. Detected by content
  // rather than by the `./client` export key, because the name of the entry
  // is not what makes it a browser artifact.
  const entries: string[] = []
  for (const entry of declared) {
    const source = await readFile(join(dir, entry), 'utf8').catch(() => '')
    if (source.includes('__ModuleLoader__')) continue
    entries.push(entry)
  }
  if (entries.length === 0) return undefined
  try {
    await build({
      entryPoints: entries.map(entry => join(dir, entry)),
      outdir: join(dir, 'lib'),
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      external,
      allowOverwrite: true,
      logLevel: 'silent',
      banner: { js: BANNER },
    })
    return { ok: true, entries: entries.length }
  } catch {
    // A package that will not bundle keeps every file it had, which costs
    // file count and nothing else. Reported rather than fatal: the boot gate
    // downstream is what decides whether the payload is usable.
    return { ok: false, entries: entries.length }
  }
}

/**
 * Bundle one derived payload in place and drop what nothing imports any more.
 * @param payload - the derived payload directory, mutated in place.
 * @returns what changed, plus the out-of-scope profile bundles kept whole, for
 * the caller to report.
 * @throws before it builds or deletes anything, when the name of a package the
 * reachability walk would look up contains `'`, `"` or `` ` ``.
 */
export async function bundleClosure(
  payload: string,
): Promise<{ bundled: number; unbundled: string[]; removed: number; bundles: string[] }> {
  const nodeModules = join(payload, 'node_modules')
  const all = await packagesIn(nodeModules)
  const ours = all.filter(name => name.startsWith(`${OURS}/`))
  const bundles: string[] = []
  for (const name of all) {
    if (!name.startsWith(`${OURS}/`) && await declaresBundle(nodeModules, name)) bundles.push(name)
  }
  const thirdParty = all.filter(name =>
    !name.startsWith(`${OURS}/`) && !NATIVE.includes(name) && !bundles.includes(name))
  // Only the walk's candidates are checked: every other package is kept
  // without being looked up, so a quote in its name changes nothing.
  const unscannable = thirdParty.filter(name => /['"`]/.test(name))
  if (unscannable.length > 0) {
    throw new Error(`package: the reachability scan cannot read a package name that contains a quote character: ${unscannable.join(', ')}`)
  }
  const external = [...ours, ...bundles, ...NATIVE]

  // Each package's result lands at its index, so the counts and the unbundled
  // list come out in `ours` order however the builds interleave.
  const results: (BuildResult | undefined)[] = new Array(ours.length)
  let next = 0
  const builder = async (): Promise<void> => {
    while (next < ours.length) {
      const index = next++
      results[index] = await bundlePackage(nodeModules, ours[index] as string, external)
    }
  }
  await Promise.all(Array.from({ length: BUILD_CONCURRENCY }, builder))
  let bundled = 0
  const unbundled: string[] = []
  for (const [index, result] of results.entries()) {
    if (result === undefined) continue
    if (result.ok) bundled += result.entries
    else unbundled.push(ours[index] as string)
  }

  // Reachability, not one pass. A surviving third-party package brings its own
  // dependencies with it — `@babel/code-frame` stays because something imports
  // it, and it needs `picocolors`, which nothing else names — so deleting on a
  // single scan leaves a kept package without its own.
  const candidates = new Set(thirdParty)
  const kept = new Set([...ours, ...bundles, ...NATIVE])
  const frontier = [...kept]
  while (frontier.length > 0) {
    const text = await textOf(nodeModules, frontier.pop() as string)
    if (text === '') continue
    for (const name of referencedNames(text, candidates)) {
      if (kept.has(name)) continue
      kept.add(name)
      frontier.push(name)
    }
  }

  const removable = thirdParty.filter(name => !kept.has(name))
  for (const name of removable) await rm(join(nodeModules, name), { recursive: true, force: true })
  return { bundled, unbundled, removed: removable.length, bundles }
}
