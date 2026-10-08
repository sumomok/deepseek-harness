/**
 * The root registry: which member, or no member, each registered root
 * directory belongs to, kept in `roots.json` under the Harness home.
 *
 * A root is one of three kinds. A member root is the directory
 * `<membersRoot>/<directory id>` created the first time a member is admitted;
 * the directory id is a random UUID, so neither the path nor the per-member
 * storage directory carries the principal key. A seed root and an unowned root
 * come from the `rootSeeds` Config, merged in at load. No two roots are one
 * directory or lie one inside the other, and no root other than a member root
 * overlaps `membersRoot`, so a new member root never needs a conflict check.
 * Each root is recorded as {@link canonicalPath} reads it and compared by its
 * {@link rootKey}.
 *
 * `roots.json` holds paths, directory ids and principal keys, and no secret.
 * It is replaced whole through a temporary sibling and a rename, synchronously,
 * because the member admitter that records a first sighting is synchronous.
 * Errors about the file or a conflicting seed quote neither its content nor a
 * principal key.
 * @module @deepseek-ai/dsh-experimental-console-members/src/registry
 */

import { randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CheckedRootSeed } from './config.ts'
import { memberStoreAt, requireUnit } from './member-store.ts'
import { canonicalPath, contains, overlaps, rootKey } from './paths.ts'
import type { MemberStore, PrincipalKey } from './types.ts'

/** One registered root, as `roots.json` records it. */
export type RegisteredRoot =
  | { readonly kind: 'member'; readonly path: string; readonly principal: PrincipalKey; readonly directory: string }
  | { readonly kind: 'seed'; readonly path: string; readonly principal: PrincipalKey }
  | { readonly kind: 'none'; readonly path: string }

/** The version of the `roots.json` layout this module reads and writes. */
const ROOTS_FILE_VERSION = 1

/** The form of a directory id: a lower-case random UUID. */
const DIRECTORY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** One registered root with the key it is compared by, and the seed that added it during this load. */
interface KeyedRoot {
  readonly root: RegisteredRoot
  readonly key: string
  readonly seedIndex?: number
}

/** What {@link openRootRegistry} needs. */
export interface RootRegistryOptions {
  /** The registry file, `dshHomePath('console-members', 'roots.json')`. */
  readonly file: string
  /** The absolute `membersRoot` from Config. */
  readonly membersRoot: string
  /** The checked `rootSeeds`, in configuration order. */
  readonly seeds: readonly CheckedRootSeed[]
  /** The platform the row runs on, which decides whether paths are compared case-insensitively. */
  readonly platform: NodeJS.Platform
}

/**
 * The root registry of one loaded row. Every method is synchronous except the
 * reads and writes of a {@link MemberStore} it returns.
 */
export class RootRegistry {
  private readonly roots: KeyedRoot[]
  private readonly members = new Map<PrincipalKey, Extract<RegisteredRoot, { kind: 'member' }>>()

  /**
   * @param options - the registry file, `membersRoot`, and platform.
   * @param roots - the registered roots with their keys.
   */
  constructor(private readonly options: RootRegistryOptions, roots: KeyedRoot[]) {
    this.roots = roots
    for (const { root } of roots) {
      if (root.kind === 'member') this.members.set(root.principal, root)
    }
  }

  /**
   * Register the member's root on their first sighting: create
   * `<membersRoot>/<random UUID>` with mode 0700 and replace `roots.json`
   * before returning. A member already registered gets their root back, and
   * nothing is created or written. When the file cannot be replaced, the
   * member stays unregistered and the empty directory is left behind; a later
   * call creates another.
   * @param principal - the member being admitted.
   * @returns the absolute path of the member's root.
   * @throws {Error} when the directory cannot be created or the file cannot be replaced.
   */
  ensureMember(principal: PrincipalKey): string {
    const known = this.members.get(principal)
    if (known !== undefined) return known.path
    const directory = randomUUID()
    mkdirSync(this.options.membersRoot, { recursive: true, mode: 0o700 })
    const created = join(this.options.membersRoot, directory)
    mkdirSync(created, { mode: 0o700 })
    const root = { kind: 'member', path: realpathSync.native(created), principal, directory } as const
    const keyed = { root, key: rootKey(root.path, this.options.platform) }
    writeRoots(this.options.file, [...this.roots, keyed])
    this.roots.push(keyed)
    this.members.set(principal, root)
    return root.path
  }

  /**
   * The member's default root, `<membersRoot>/<directory id>`.
   * @param principal - a member already registered by {@link ensureMember}.
   * @returns the root's absolute path.
   * @throws {Error} when the member was never registered; the message carries no principal key.
   */
  memberRoot(principal: PrincipalKey): string {
    return this.requireMember(principal).path
  }

  /**
   * Every root registered to the member: the default root, when the member
   * has been admitted, and each seed root.
   * @param principal - the member.
   * @returns those roots' absolute paths, in registration order.
   */
  rootsOf(principal: PrincipalKey): readonly string[] {
    return this.roots.flatMap(({ root }) => root.kind !== 'none' && root.principal === principal ? [root.path] : [])
  }

  /**
   * The member's store for one unit, `dshHomePath('console-members', <directory id>, '<unit>.json')`.
   * @param principal - a member already registered by {@link ensureMember}.
   * @param unit - the caller's name for its data: lower-case letters, digits and `-`.
   * @returns the store.
   * @throws {Error} when the unit name has other characters or the member was never registered.
   */
  memberStore(principal: PrincipalKey, unit: string): MemberStore {
    requireUnit(unit)
    return memberStoreAt(this.requireMember(principal).directory, unit)
  }

  /**
   * The registered member root of one member.
   * @param principal - the member.
   * @returns the member root.
   * @throws {Error} when the member was never registered.
   */
  private requireMember(principal: PrincipalKey): Extract<RegisteredRoot, { kind: 'member' }> {
    const member = this.members.get(principal)
    if (member === undefined) throw new Error('console-members: the member has no registered root; admit the member first')
    return member
  }
}

/**
 * Read `roots.json`, check it, merge the seeds, and write the file back when a
 * seed added a root.
 * @param options - the registry file, `membersRoot`, seeds and platform.
 * @returns the registry.
 * @throws {Error} when the file is not a registry, its roots overlap, or a seed conflicts with a registered root,
 *   another seed, or `membersRoot`. Seed errors name the seed by index.
 */
export function openRootRegistry(options: RootRegistryOptions): RootRegistry {
  const { file, platform } = options
  const membersKey = rootKey(canonicalPath(options.membersRoot), platform)
  const roots: KeyedRoot[] = readRoots(file).map(root => ({ root, key: rootKey(canonicalPath(root.path), platform) }))
  for (const [index, { root, key }] of roots.entries()) {
    const misplaced = root.kind === 'member' ? contains(key, membersKey) : overlaps(key, membersKey)
    if (misplaced) throw new Error(`console-members: root ${index} in ${file} overlaps membersRoot`)
    const clash = roots.findIndex((other, otherIndex) => otherIndex < index && overlaps(other.key, key))
    if (clash !== -1) throw new Error(`console-members: roots ${clash} and ${index} in ${file} overlap`)
  }
  const recorded = roots.length
  for (const [seedIndex, seed] of options.seeds.entries()) {
    const path = canonicalPath(seed.path)
    const root: RegisteredRoot = seed.owner === 'none' ? { kind: 'none', path } : { kind: 'seed', path, principal: seed.principal }
    const key = rootKey(path, platform)
    if (overlaps(key, membersKey)) throw new Error(`console-members: rootSeeds[${seedIndex}] overlaps membersRoot`)
    const match = roots.find(other => overlaps(other.key, key))
    if (match === undefined) {
      roots.push({ root, key, seedIndex })
      continue
    }
    const where = match.seedIndex === undefined ? `a root recorded in ${file}` : `rootSeeds[${match.seedIndex}]`
    if (match.key !== key) throw new Error(`console-members: rootSeeds[${seedIndex}] and ${where} lie one inside the other`)
    if (!sameOwner(match.root, root)) throw new Error(`console-members: rootSeeds[${seedIndex}] names a directory ${where} registers to another owner`)
  }
  if (roots.length > recorded) writeRoots(file, roots)
  return new RootRegistry(options, roots)
}

/**
 * Whether two registrations of one directory give it the same owner.
 * @param left - one registration.
 * @param right - the other.
 * @returns `true` when both are unowned or both belong to the same member.
 */
function sameOwner(left: RegisteredRoot, right: RegisteredRoot): boolean {
  if (left.kind === 'none' || right.kind === 'none') return left.kind === right.kind
  return left.principal === right.principal
}

/**
 * Read and check `roots.json`. A missing file is an empty registry.
 * @param file - the registry file.
 * @returns the recorded roots.
 * @throws {Error} naming the file, not its content, when it is not valid JSON or not a registry.
 */
function readRoots(file: string): RegisteredRoot[] {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (_syntax) {
    // The parser's message quotes the text around the fault, which may hold a principal key.
    throw new Error(`console-members: ${file} is not valid JSON`)
  }
  const fields = recordFields(parsed)
  const entries = fields?.get('roots')
  if (fields?.get('version') !== ROOTS_FILE_VERSION || !Array.isArray(entries)) {
    throw new Error(`console-members: ${file} is not a version ${ROOTS_FILE_VERSION} root registry`)
  }
  const members = new Set<string>()
  return entries.map((entry: unknown, index) => {
    const root = readRoot(entry)
    if (root === undefined) throw new Error(`console-members: entry ${index} in ${file} is not a root record`)
    if (root.kind === 'member') {
      if (members.has(root.principal)) throw new Error(`console-members: entry ${index} in ${file} registers a second root for one member`)
      members.add(root.principal)
    }
    return root
  })
}

/**
 * Read one recorded root.
 * @param entry - one element of the file's `roots` array.
 * @returns the root, or `undefined` when the element is not exactly one of the three record forms.
 */
function readRoot(entry: unknown): RegisteredRoot | undefined {
  const fields = recordFields(entry)
  const path = fields?.get('path')
  if (fields === undefined || typeof path !== 'string' || !isAbsolute(path)) return undefined
  const keys = [...fields.keys()].sort().join(',')
  const principal = fields.get('principal')
  const directory = fields.get('directory')
  switch (fields.get('kind')) {
    case 'none':
      return keys === 'kind,path' ? { kind: 'none', path } : undefined
    case 'seed':
      return keys === 'kind,path,principal' && isPrincipal(principal)
        ? { kind: 'seed', path, principal: brandString<PrincipalKey>(principal) }
        : undefined
    case 'member':
      return keys === 'directory,kind,path,principal' && isPrincipal(principal) && typeof directory === 'string' && DIRECTORY_ID.test(directory)
        ? { kind: 'member', path, principal: brandString<PrincipalKey>(principal), directory }
        : undefined
    default:
      return undefined
  }
}

/**
 * Whether a recorded value can be a principal key.
 * @param value - the recorded value.
 * @returns `true` for a non-empty string.
 */
function isPrincipal(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/**
 * The fields of a plain JSON object.
 * @param value - a parsed JSON value.
 * @returns its fields, or `undefined` when it is not an object.
 */
function recordFields(value: unknown): Map<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? new Map(Object.entries(value)) : undefined
}

/**
 * Replace `roots.json` whole: write a random-suffix sibling with exclusive
 * create and mode 0600, then rename it over the file. The rename replaces a
 * symbolic link at the file's path instead of writing through it. On failure
 * the sibling is removed and the failure rethrown.
 * @param file - the registry file.
 * @param roots - every registered root.
 * @throws {Error} when the directory, the sibling, or the rename fails.
 */
function writeRoots(file: string, roots: readonly KeyedRoot[]): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const text = `${JSON.stringify({ version: ROOTS_FILE_VERSION, roots: roots.map(({ root }) => root) }, null, 2)}\n`
  const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`
  try {
    writeFileSync(temporary, text, { mode: 0o600, flag: 'wx' })
    renameSync(temporary, file)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}
