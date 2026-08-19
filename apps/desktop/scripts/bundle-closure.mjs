/**
 * Prototype: collapse the deployed server closure's third-party trees by
 * bundling each of this repo's own packages from its own entry points.
 *
 * The plugin model decides the shape. Cordis resolves plugins by package name
 * from configuration read at boot, so every `@deepseek-ai/*` package has to
 * stay a resolvable directory with an entry in it — they are kept external to
 * one another and only their dependencies are inlined. Native packages stay
 * external too: their JavaScript builds a path to a `.node` or `.exe` that no
 * bundler can carry.
 *
 * Usage: node bundle-closure.mjs <closure> [--apply]
 *   without --apply it reports what it would do and writes nothing.
 */

import { build } from 'esbuild'
import { cp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, relative } from 'node:path'

const source = process.argv[2]
const apply = process.argv.includes('--apply')
if (!source) {
  console.error('usage: bundle-closure.mjs <closure> [--apply]')
  process.exit(2)
}

const target = apply ? `${source}-bundled` : source
const OURS = '@deepseek-ai'

/** Gives each ESM bundle a working `require` for its CommonJS parts. */
const BANNER = [
  "import { createRequire as __dshCreateRequire } from 'node:module';",
  'const require = __dshCreateRequire(import.meta.url);',
].join('\n')

/** Packages whose JavaScript resolves a binary by path; a bundle cannot carry one. */
const NATIVE = [
  'node-pty', 'koffi', '@koromix/koffi-win32-x64', 'sharp', '@img/sharp-win32-x64',
  '@img/colour', '@vscode/ripgrep', '@vscode/ripgrep-win32-x64',
]

async function countFiles(dir) {
  let n = 0
  const walk = async (d) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      if (e.isDirectory()) await walk(join(d, e.name))
      else n += 1
    }
  }
  await walk(dir)
  return n
}

/** Every package directory under node_modules, scope-aware. */
async function packages(nodeModules) {
  const out = []
  for (const e of await readdir(nodeModules, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name === '.bin') continue
    if (e.name.startsWith('@')) {
      for (const s of await readdir(join(nodeModules, e.name), { withFileTypes: true })) {
        if (s.isDirectory()) out.push(`${e.name}/${s.name}`)
      }
    } else out.push(e.name)
  }
  return out
}

/** The JavaScript entry points a package advertises, relative to its directory. */
function entryPoints(manifest) {
  const found = new Set()
  const visit = (value) => {
    if (typeof value === 'string') {
      if (value.endsWith('.js') || value.endsWith('.mjs') || value.endsWith('.cjs')) found.add(value)
      return
    }
    if (value && typeof value === 'object') for (const v of Object.values(value)) visit(v)
  }
  visit(manifest.exports)
  if (typeof manifest.main === 'string') found.add(manifest.main)
  return [...found].map(p => p.replace(/^\.\//, ''))
}

const before = await countFiles(source)
console.log(`closure: ${source}`)
console.log(`  ${before} files before`)

if (apply) {
  await rm(target, { recursive: true, force: true })
  await cp(source, target, { recursive: true })
}

const nodeModules = join(target, 'node_modules')
const all = await packages(nodeModules)
const ours = all.filter(p => p.startsWith(`${OURS}/`))
const external = [...all.filter(p => p.startsWith(`${OURS}/`)), ...NATIVE]

console.log(`  ${all.length} packages, ${ours.length} of them ${OURS}/*`)

let bundled = 0
let skipped = []
const framework = []
for (const name of ours) {
  const dir = join(nodeModules, name)
  const manifestPath = join(dir, 'package.json')
  if (!existsSync(manifestPath)) continue
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const entries = entryPoints(manifest).filter(e => existsSync(join(dir, e)))
  if (entries.length === 0) continue
  // The framework introspects its own module graph — `cordis-plugin-loader`
  // decides `loader.internal` from it, and `cordis-plugin-hmr` throws without
  // that. Bundling a package that reads its own shape is bundling away the
  // thing it reads, so the framework core is left exactly as deployed and only
  // the leaf plugins are collapsed.
  if (name.startsWith(`${OURS}/cordis`)) { framework.push(name); continue }
  if (!apply) { bundled += entries.length; continue }
  try {
    await build({
      entryPoints: entries.map(e => join(dir, e)),
      outdir: join(dir, 'lib'),
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      external,
      allowOverwrite: true,
      logLevel: 'silent',
      // A CommonJS dependency bundled into an ESM output still calls
      // `require`, and esbuild's shim for it has nothing to fall back on:
      // `ws` reaching for `events` is what takes the boot down. Handing the
      // bundle a real `require` built from its own URL is what the shim
      // expects to find.
      banner: { js: BANNER },
    })
    bundled += entries.length
  } catch (error) {
    skipped.push(`${name}: ${String(error).split('\n')[0]}`)
  }
}

console.log(`  ${bundled} entry points ${apply ? 'bundled' : 'would be bundled'}, ${framework.length} framework packages left alone`)
if (skipped.length > 0) {
  console.log(`  ${skipped.length} packages failed to bundle:`)
  for (const s of skipped.slice(0, 10)) console.log(`    ${s}`)
}

if (!apply) {
  console.log('  (dry run — pass --apply to write to ' + `${source}-bundled)`)
  process.exit(0)
}

// Anything third-party that nothing imports any more can go. The test is for an
// import specifier rather than for the name appearing at all: a bundle that
// inlined `openai` carries that word in its own strings, and matching those
// keeps every directory the bundling was supposed to make redundant. Dynamic
// `import()` with a literal still counts, which is the case worth keeping.
const remaining = []
const collect = async (d) => {
  for (const e of await readdir(d, { withFileTypes: true })) {
    const p = join(d, e.name)
    if (e.isDirectory()) await collect(p)
    else if (/\.(?:js|mjs|cjs|json)$/.test(e.name)) remaining.push(p)
  }
}
for (const name of [...ours, ...NATIVE]) {
  const d = join(nodeModules, name)
  if (existsSync(d)) await collect(d)
}
let text = ''
for (const f of remaining) text += await readFile(f, 'utf8').catch(() => '')

const thirdParty = all.filter(p => !p.startsWith(`${OURS}/`) && !NATIVE.includes(p))
const escapeForRegExp = (p) => p.replace(/[.*+?^${}()|[\]\\\/]/g, (m) => `\\${m}`)
const specifier = (p) => new RegExp(
  String.raw`(?:from|require|import)\s*\(?\s*['"]` + escapeForRegExp(p) + String.raw`(?:/[^'"]*)?['"]`)
const referenced = thirdParty.filter(p => specifier(p).test(text))
const removable = thirdParty.filter(p => !referenced.includes(p))

console.log(`  third-party: ${thirdParty.length}, still referenced ${referenced.length}, removable ${removable.length}`)
for (const p of removable) await rm(join(nodeModules, p), { recursive: true, force: true })

const after = await countFiles(target)
console.log(`  ${after} files after  (${Math.round((1 - after / before) * 100)}% fewer)`)
console.log(`written to ${target}`)
