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
 * and only their dependencies are inlined. What is left of a third-party
 * package after that is deleted, but only if nothing reachable still imports
 * it.
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
 */
const NATIVE = [
  'node-pty',
  'koffi', '@koromix/koffi-win32-x64', `@koromix/koffi-darwin-${process.arch}`,
  'sharp', '@img/sharp-win32-x64', '@img/colour',
  `@img/sharp-darwin-${process.arch}`, `@img/sharp-libvips-darwin-${process.arch}`,
  '@vscode/ripgrep', '@vscode/ripgrep-win32-x64', `@vscode/ripgrep-darwin-${process.arch}`,
  'node-addon-require-builtin', 'node-addon-require-builtin-win32-x64-msvc',
  `node-addon-require-builtin-darwin-${process.arch}`,
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
 * What neither form reaches is a name that does not appear as a literal: a
 * template with a substitution (`@img/sharp-${platform}-${arch}`, how sharp and
 * `@vscode/ripgrep` select their platform package) and the dynamic library
 * search a `.node` performs on its own. Those are what `NATIVE` is for.
 */
function specifierFor(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\/]/g, match => `\\${match}`)
  const literal = String.raw`['"\`]` + escaped + String.raw`(?:/[^'"\`]*)?['"\`]`
  return new RegExp([
    String.raw`(?:from|require|import)\s*\(?\s*` + literal,
    String.raw`(?:import\s*\.\s*meta|[\w$]*[Rr]equire[\w$]*|createRequire\s*\([^()]*\))\s*\.\s*resolve\s*\(\s*` + literal,
  ].join('|'))
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

/**
 * Bundle one derived payload in place and drop what nothing imports any more.
 * @param payload - the derived payload directory, mutated in place.
 * @returns what changed, for the caller to report.
 */
export async function bundleClosure(payload: string): Promise<{ bundled: number; unbundled: string[]; removed: number }> {
  const nodeModules = join(payload, 'node_modules')
  const all = await packagesIn(nodeModules)
  const ours = all.filter(name => name.startsWith(`${OURS}/`))
  const external = [...ours, ...NATIVE]

  let bundled = 0
  const unbundled: string[] = []
  for (const name of ours) {
    const dir = join(nodeModules, name)
    const manifestPath = join(dir, 'package.json')
    if (!existsSync(manifestPath)) continue
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
    if (entries.length === 0) continue
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
      bundled += entries.length
    } catch {
      // A package that will not bundle keeps every file it had, which costs
      // file count and nothing else. Reported rather than fatal: the boot gate
      // downstream is what decides whether the payload is usable.
      unbundled.push(name)
    }
  }

  // Reachability, not one pass. A surviving third-party package brings its own
  // dependencies with it — `@babel/code-frame` stays because something imports
  // it, and it needs `picocolors`, which nothing else names — so deleting on a
  // single scan leaves a kept package without its own.
  const thirdParty = all.filter(name => !name.startsWith(`${OURS}/`) && !NATIVE.includes(name))
  const kept = new Set([...ours, ...NATIVE])
  const frontier = [...kept]
  while (frontier.length > 0) {
    const text = await textOf(nodeModules, frontier.pop() as string)
    if (text === '') continue
    for (const name of thirdParty) {
      if (kept.has(name)) continue
      if (specifierFor(name).test(text)) { kept.add(name); frontier.push(name) }
    }
  }

  const removable = thirdParty.filter(name => !kept.has(name))
  for (const name of removable) await rm(join(nodeModules, name), { recursive: true, force: true })
  return { bundled, unbundled, removed: removable.length }
}
