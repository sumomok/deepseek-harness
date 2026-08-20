/**
 * Build-time gate on what the desktop payload's two pruning mechanisms delete.
 *
 * The payload is cut from ~35000 files to a few thousand by two independent
 * passes: the `PLATFORM_DIR_RULES` + suffix filter in `package.ts`, and the
 * reachability convergence in `bundle-closure.ts`. Both decide by static
 * evidence — a rule's predicate, or a specifier following `from`/`require`/
 * `import` — so both delete packages that exist only because something builds
 * their name at run time, and neither reports having done so. Three such
 * deletions shipped or nearly shipped: `@vscode/ripgrep-<platform>-<arch>`,
 * the darwin halves of `@img/sharp-libvips-*`/`@vscode/ripgrep-*`/
 * `node-addon-require-builtin-*`, and `open`.
 *
 * Four checks cover them, because no single one does. The dead-rule check is
 * the primary criterion: it is a property of the rule table against the staged
 * tree and does not move when upstream changes what it depends on. The other
 * three read set differences across the pipeline, which do move.
 *
 * Every check fails the build. Where a deletion is legitimate and still trips a
 * check, `EXEMPTIONS` takes the subject with a written reason; nothing is
 * silenced without one.
 */

import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join, sep } from 'node:path'

/** One platform-split pruning rule: entries directly under `parent` that fail `keep` never reach the payload. */
export interface PlatformDirRule {
  /** Directory the rule addresses, relative to `node_modules`; `.` is `node_modules` itself. */
  parent: string
  /** Whether one entry directly under `parent` belongs in this target's payload. */
  keep: (name: string) => boolean
}

/** The platform and architecture one payload is built to run on. */
export interface PayloadPlatform {
  /** The `process.platform` value of the machine the payload runs on. */
  platform: string
  /** The `process.arch` value of the machine the payload runs on. */
  arch: string
}

/** What one tree held at a point in the pipeline. */
export interface PayloadSnapshot {
  /** Package names under `node_modules`, scope-aware. */
  packages: string[]
  /** Topmost platform-split directories, relative to `node_modules`, `/`-separated. */
  variants: string[]
}

/** The checks this gate runs; an exemption names the one it silences. */
type GateCheck = 'dead-rule' | 'unexplained-removal' | 'platform-variant' | 'runtime-resolved'

/**
 * Findings this gate must not report, each against the reason it is not a bug.
 *
 * Subjects are what the corresponding failure names: `<target>:<rule parent>`
 * for `dead-rule`, a package name for `unexplained-removal` and
 * `runtime-resolved`, and a `node_modules`-relative directory for
 * `platform-variant`. An entry with a blank reason fails at load. Every active
 * entry is printed at the start of each build, so an exemption whose reason has
 * expired stays visible rather than becoming the gate's resting state.
 *
 * All four tables are empty: the shipped pipeline trips no check.
 */
const EXEMPTIONS: Record<GateCheck, Record<string, string>> = {
  'dead-rule': {},
  'unexplained-removal': {},
  'platform-variant': {},
  'runtime-resolved': {},
}

for (const [check, table] of Object.entries(EXEMPTIONS)) {
  for (const [subject, reason] of Object.entries(table)) {
    if (reason.trim() === '') {
      throw new Error(`payload gate: exemption ${check}/${subject} carries no reason; state why the finding is not a bug.`)
    }
  }
}

/** Platform names that can appear as a segment of a platform-split directory name. */
const PLATFORM_SEGMENTS = new Set(['darwin', 'win32', 'linux', 'android', 'freebsd', 'openbsd', 'sunos', 'aix'])

/** Architecture names that can appear as a segment of a platform-split directory name. */
const ARCH_SEGMENTS = new Set(['x64', 'arm64', 'arm', 'ia32', 'x86', 'ppc64', 's390x', 'riscv64', 'loong64', 'mips64el'])

/**
 * Module-resolution call sites whose argument is a literal. `specifierFor` in
 * `bundle-closure.ts` reads `from`/`require`/`import` followed by a specifier
 * and matches none of these, so a name that only ever appears here is invisible
 * to the reachability walk.
 */
const RESOLVER_CALL = new RegExp([
  String.raw`(?:^|[^\w$])`,
  String.raw`(?:import\s*\.\s*meta|[\w$]*[Rr]equire[\w$]*|createRequire\s*\([^()]*\))`,
  String.raw`\s*\.\s*resolve\s*\(\s*(['"\`])([^'"\`\n]*)\1`,
].join(''), 'g')

/** File extensions the resolver scan reads. */
const MODULE_FILE = /\.(?:js|mjs|cjs)$/

/**
 * The platform and architecture a directory name declares.
 * @param name - one directory's basename.
 * @returns the declared pair, or undefined when the name declares fewer than both.
 */
function variantOf(name: string): PayloadPlatform | undefined {
  let platform: string | undefined
  let arch: string | undefined
  for (const segment of name.split(/[-_.]/)) {
    if (PLATFORM_SEGMENTS.has(segment)) platform ??= segment
    else if (ARCH_SEGMENTS.has(segment)) arch ??= segment
  }
  if (platform === undefined || arch === undefined) return undefined
  return { platform, arch }
}

/** Whether a directory name declares exactly the platform and architecture the payload runs on. */
function isNative(name: string, runsOn: PayloadPlatform): boolean {
  const variant = variantOf(name)
  return variant !== undefined && variant.platform === runsOn.platform && variant.arch === runsOn.arch
}

/**
 * The package a specifier names, when it names one at all.
 * @param specifier - the literal argument of a resolution call.
 * @returns the bare package name, or undefined for a path, a URL, or a template with a substitution.
 */
function packageOf(specifier: string): string | undefined {
  if (specifier === '' || specifier.includes('${') || /^[./]/.test(specifier) || /[:\s\\]/.test(specifier)) return undefined
  const segments = specifier.split('/')
  if (specifier.startsWith('@')) return segments.length >= 2 ? `${segments[0]}/${segments[1]}` : undefined
  return segments[0]
}

/** Whether a finding is declared legitimate in `EXEMPTIONS`. */
function exempt(check: GateCheck, subject: string): boolean {
  return Object.hasOwn(EXEMPTIONS[check], subject)
}

/**
 * Record the packages and the topmost platform-split directories one tree holds.
 * @param root - a staged server tree or a derived payload.
 * @returns the snapshot the payload checks compare against.
 */
export async function snapshotPayload(root: string): Promise<PayloadSnapshot> {
  const nodeModules = join(root, 'node_modules')
  const packages: string[] = []
  const variants: string[] = []
  async function walk(dir: string, relative: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === '.bin') continue
      if (relative === '' && entry.name.startsWith('@')) {
        for (const scoped of await readdir(join(dir, entry.name), { withFileTypes: true })) {
          if (scoped.isDirectory()) await visit(join(dir, entry.name, scoped.name), `${entry.name}/${scoped.name}`, scoped.name, true)
        }
        continue
      }
      const child = relative === '' ? entry.name : `${relative}/${entry.name}`
      await visit(join(dir, entry.name), child, entry.name, relative === '')
    }
  }
  async function visit(dir: string, relative: string, name: string, isPackage: boolean): Promise<void> {
    if (isPackage) packages.push(relative)
    // A variant directory's own subtree repeats the platform in its member
    // names (`@koromix/koffi-darwin-arm64/darwin_arm64`); only the topmost is
    // the unit a rule keeps or drops.
    if (variantOf(name) !== undefined) { variants.push(relative); return }
    await walk(dir, relative)
  }
  if (existsSync(nodeModules)) await walk(nodeModules, '')
  return { packages, variants }
}

/**
 * Fail the build for any platform rule that drops nothing.
 *
 * A rule addressed at the wrong directory is silent: it reads as coverage of a
 * package family while every member of that family travels unmanaged. This is
 * checked against the full staged tree for every target, not only the one being
 * built, because whether a rule matches is a property of the rule table and the
 * staged tree — the payload a given run happens to derive does not enter it.
 * @param staged - the verified full staging root, before any payload is derived.
 * @param rules - every target's `PLATFORM_DIR_RULES` list.
 * @throws when a rule's parent is absent, or when its predicate rejects nothing.
 */
export async function verifyPruneRules(staged: string, rules: Record<string, PlatformDirRule[]>): Promise<void> {
  const active = Object.entries(EXEMPTIONS).flatMap(([check, table]) =>
    Object.entries(table).map(([subject, reason]) => `  ${check} ${subject}: ${reason}`))
  if (active.length > 0) console.log(`package: payload gate exemptions in force:\n${active.join('\n')}`)

  const nodeModules = join(staged, 'node_modules')
  const findings: string[] = []
  let live = 0
  for (const [target, list] of Object.entries(rules)) {
    for (const rule of list) {
      const subject = `${target}:${rule.parent}`
      if (exempt('dead-rule', subject)) continue
      const parent = rule.parent === '.' ? nodeModules : join(nodeModules, rule.parent)
      if (!existsSync(parent)) {
        findings.push([
          `[dead-rule] ${target}: PLATFORM_DIR_RULES parent '${rule.parent}' does not exist in the staged tree.`,
          '  the rule drops nothing and hides that whatever it was written for has moved or been renamed',
          '  fix: re-address the rule at the directory that now holds the platform-split members, or delete it',
        ].join('\n'))
        continue
      }
      const entries = (await readdir(parent, { withFileTypes: true })).map(entry => entry.name)
      const dropped = entries.filter(name => !rule.keep(name))
      if (dropped.length === 0) {
        findings.push([
          `[dead-rule] ${target}: PLATFORM_DIR_RULES rule on '${rule.parent}' matched 0 of ${String(entries.length)} entries.`,
          '  it is misaddressed, or what it was written for has been renamed or moved to sibling packages',
          `  '${rule.parent}' holds: ${entries.slice(0, 12).join(', ')}${entries.length > 12 ? ', …' : ''}`,
          '  fix: address the rule at the directory whose entries carry the platform split, or delete it',
        ].join('\n'))
        continue
      }
      live += 1
    }
  }
  if (findings.length > 0) {
    throw new Error(`package: payload gate: ${String(findings.length)} dead prune rule(s).\n\n${findings.join('\n\n')}\n`)
  }
  console.log(`package: payload gate: ${String(live)} platform prune rules live against the staged tree`)
}

/** Everything one derived payload's checks compare. */
export interface PrunedPayloadInput {
  /** The payload target's name, for the build log. */
  target: string
  /** The platform and architecture this payload runs on. */
  runsOn: PayloadPlatform
  /** The full staged tree the payload was copied from. */
  staged: PayloadSnapshot
  /** The payload as the copy filter left it, before `bundleClosure` ran. */
  afterPlatformPrune: PayloadSnapshot
  /** The finished payload's root directory. */
  payload: string
  /** What the copy filter rejected, as `node_modules`-relative `/`-separated paths. */
  droppedByRules: string[]
}

/**
 * Fail the build for a package or platform directory the payload needs and no
 * longer has, and for a foreign platform's binaries riding along.
 * @param input - the three snapshots and the finished payload to check.
 * @throws listing every finding, each with where the evidence is and which list to add to.
 */
export async function verifyPrunedPayload(input: PrunedPayloadInput): Promise<void> {
  const { target, runsOn, staged, afterPlatformPrune, payload } = input
  const final = await snapshotPayload(payload)
  const findings: string[] = []

  const dropped = new Set(input.droppedByRules)
  const survivedCopy = new Set(afterPlatformPrune.packages)
  for (const name of staged.packages) {
    if (survivedCopy.has(name) || dropped.has(name) || exempt('unexplained-removal', name)) continue
    findings.push([
      `[unexplained-removal] ${name} left the payload during the copy and no PLATFORM_DIR_RULES rule rejected it.`,
      '  something other than the platform rules is deleting whole packages, and it reports nothing',
      '  fix: make the mechanism that dropped it declare the drop, or exempt it in payload-gate.ts with a reason',
    ].join('\n'))
  }

  const keptVariants = new Set(final.variants)
  const copiedVariants = new Set(afterPlatformPrune.variants)
  for (const variant of staged.variants) {
    const name = variant.slice(variant.lastIndexOf('/') + 1)
    if (!isNative(name, runsOn) || keptVariants.has(variant) || exempt('platform-variant', variant)) continue
    const byRules = !copiedVariants.has(variant)
    findings.push([
      `[platform-variant] ${variant} names ${runsOn.platform}-${runsOn.arch} and is missing from the ${target} payload.`,
      byRules
        ? `  dropped by the PLATFORM_DIR_RULES copy filter, whose ${target} list rejects the platform it is built for`
        : '  dropped by bundle-closure.ts: nothing imports it by a static specifier, because its name is built at run time',
      byRules
        ? `  fix: correct the ${target} rule in PLATFORM_DIR_RULES (package.ts) so this directory is kept`
        : `  fix: add '${variant}' to NATIVE in bundle-closure.ts, keeping both platforms' variants named`,
    ].join('\n'))
  }
  for (const variant of final.variants) {
    const name = variant.slice(variant.lastIndexOf('/') + 1)
    const declared = variantOf(name)
    if (declared === undefined || isNative(name, runsOn) || exempt('platform-variant', variant)) continue
    findings.push([
      `[platform-variant] ${variant} names ${declared.platform}-${declared.arch} and rode into the ${target} payload.`,
      '  no PLATFORM_DIR_RULES rule covers it, so the payload carries binaries it cannot run',
      `  fix: add a ${target} rule in PLATFORM_DIR_RULES (package.ts) addressed at '${variant.slice(0, variant.lastIndexOf('/')) || '.'}'`,
    ].join('\n'))
  }

  const removed = new Set(staged.packages.filter(name => !final.packages.includes(name)))
  const resolved = await resolverLiterals(payload)
  for (const [name, sites] of resolved) {
    if (!removed.has(name) || exempt('runtime-resolved', name)) continue
    findings.push([
      `[runtime-resolved] ${name} was pruned, and surviving code resolves it by name at run time.`,
      `  ${[...sites].slice(0, 3).join('\n  ')}`,
      survivedCopy.has(name)
        ? `  fix: bundle-closure.ts dropped it as unreachable — teach 'specifierFor' this call form, or add '${name}' to NATIVE`
        : `  fix: the PLATFORM_DIR_RULES copy filter dropped it — correct the ${target} rule in package.ts`,
    ].join('\n'))
  }

  if (findings.length > 0) {
    throw new Error(`package: payload gate (${target}): ${String(findings.length)} finding(s).\n\n${findings.join('\n\n')}\n`)
  }
  console.log(`package: payload gate (${target}): ${String(staged.packages.length - final.packages.length)} packages dropped, ${String(staged.variants.length)} platform dirs accounted for, ${String(resolved.size)} runtime-resolved names checked`)
}

/**
 * Every package named by a literal module-resolution call in a finished payload.
 * @param payload - the finished payload's root directory.
 * @returns each package name against the payload-relative files that resolve it.
 */
async function resolverLiterals(payload: string): Promise<Map<string, Set<string>>> {
  const found = new Map<string, Set<string>>()
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) { await walk(path); continue }
      if (!MODULE_FILE.test(entry.name)) continue
      const text = await readFile(path, 'utf8').catch(() => '')
      RESOLVER_CALL.lastIndex = 0
      for (let match = RESOLVER_CALL.exec(text); match !== null; match = RESOLVER_CALL.exec(text)) {
        const specifier = match[2]
        const name = specifier === undefined ? undefined : packageOf(specifier)
        if (name === undefined) continue
        const sites = found.get(name) ?? new Set<string>()
        sites.add(`${path.slice(payload.length + 1).split(sep).join('/')}: resolves '${String(specifier)}'`)
        found.set(name, sites)
      }
    }
  }
  await walk(payload)
  return found
}
