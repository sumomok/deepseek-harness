/**
 * The organization intake, `ctx.skillPackIntake`: installs the skill packs an
 * organization hands over into a root of their own, holds each entry to the
 * rules a pack root is held to, and offers the set it wrote for as long as the
 * fiber that handed the set over is active.
 *
 * The organization root is no skill provider's root. The plugin handing the
 * packs over reports their skills itself and asks
 * {@link OrganizationPackIntake.isActive} which entries it may report; this
 * module installs the files, judges them, and hands the active entries' views
 * to the component surface through `ctx.skillPacks.activeViews()`.
 *
 * The set written last is held in memory, already read: every answer comes
 * from it and from the parts registered at the moment of the call, so
 * `isActive` is synchronous and never older than its caller. Nothing but
 * `replace` writes the organization root, which is why it is not watched.
 * While no set is offered, the entries the root holds on disk are what a set's
 * view ids are judged against.
 * @module @deepseek-ai/dsh-experimental-skill-pack/src/intake
 */

import { join, resolve } from 'node:path'
import { FiberState, Service, type Context, type Fiber } from '@deepseek-ai/cordis'
import { isSkillName } from '@deepseek-ai/dsh-skill'
import { validatePacks } from './delivery.ts'
import { readInstalledPacks, syncPackRoot } from './install.ts'
import { anchorFormatMissing, readsDeclaredViews, viewFormatMissing } from './manifest.ts'
import { compareCodeUnits } from './order.ts'
import { describeMissing, undrawableViews, type PackObservation } from './reconcile.ts'
import { observePack, type PackSource } from './scan.ts'
import type {
  ActivePackView,
  DeliveredFile,
  IntakeRefusal,
  IntakeRefusalCode,
  IntakeResult,
  OrgPackInput,
  PackStatus,
  PackView,
  SkillPackIntake,
} from './types.ts'

/** A version that is one directory name: not empty, not `.` or `..`, and free of `/`, `\` and NUL. */
const DIRECTORY_NAME = /^(?!\.{1,2}$)[^/\\\0]+$/u

/** What the intake reads from the row that provides it. */
export interface IntakeHost {
  /** Absolute path of the organization root. */
  readonly root: string
  /**
   * Judge one entry on its own against the parts registered now.
   * @param observation - the entry as it was read.
   * @returns its status, which the intake restates as an organization entry's.
   */
  judge(observation: PackObservation): PackStatus
  /**
   * Add a listener to the row's one change notification.
   * @param listener - called after every change the row announces.
   * @returns the disposer that removes the listener.
   */
  subscribe(listener: () => void): () => void
  /** Invalidate the skill catalog and call every listener. */
  moved(): void
}

/** What the offered organization set contributes to one reading of the row. */
export interface OrganizationReading {
  /** One status per offered entry, in `name@version` order by code unit. */
  readonly statuses: readonly PackStatus[]
  /** View id to the skill name of the first active entry, in that order, declaring it. */
  readonly held: ReadonlyMap<string, string>
  /** The active entries' views; an id an earlier active entry declares is listed once, under that entry. */
  readonly views: readonly ActivePackView[]
}

/** The reading of a row offering no organization set. */
export const NO_ORGANIZATION_SET: OrganizationReading = { statuses: [], held: new Map(), views: [] }

/** One entry, read once before it was written. */
interface HeldEntry {
  readonly name: string
  readonly version: string
  readonly channel: 'stable' | 'trial'
  /** What the entry is judged from. */
  readonly observation: PackObservation
  /** The entry's views, every one of which parsed. */
  readonly views: readonly PackView[]
  /** Each view id the entry declares, to the bytes of the first file declaring it. */
  readonly viewBytes: ReadonlyMap<string, Buffer>
  /** The files to write. */
  readonly files: readonly DeliveredFile[]
}

/** The view ids a set is judged against, and what holds them. */
interface HeldViewIds {
  /** Each view id held, to the bytes of the first file declaring it in `name@version` order. */
  readonly bytes: ReadonlyMap<string, Buffer>
  /** What holds them, as a refusal names it. */
  readonly holder: string
}

/** One entry judged on its own: accepted, or refused with its reason. */
type EntryJudgement =
  | { readonly kind: 'accepted'; readonly entry: HeldEntry }
  | { readonly kind: 'refused'; readonly refusal: IntakeRefusal }

/** What the intake changes over its life, kept in one object every method reads and writes. */
interface IntakeState {
  /** The calls still running or waiting, settled in arrival order. */
  queue: Promise<void>
  /** The offered set, in `name@version` order; empty before the first write and after a withdrawal. */
  offered: readonly HeldEntry[]
  /** Identifies the hold that offers the set now; a hold released after another replaced it leaves the set alone. */
  holder: object | undefined
  /** Releases the hold that offers the set now. */
  release: () => void
  /** Whether the row has stopped, so a call reaching its turn writes nothing. */
  stopped: boolean
}

/** The answer of a call that reaches its turn after the row stopped. */
const ROW_STOPPED: IntakeResult = { kind: 'failed', detail: 'skill-pack: the row stopped before this replace could write' }

/** The answer of a call that reaches its turn after its caller's fiber stopped. */
const CALLER_STOPPED: IntakeResult = {
  kind: 'failed',
  detail: 'skill-pack: the fiber that called replace stopped before the call could write',
}

/** The answer of a call whose caller's fiber stopped while its set was being written. */
const CALLER_STOPPED_WRITING: IntakeResult = {
  kind: 'failed',
  detail: 'skill-pack: the fiber that called replace stopped while the set was written; the organization root holds it, and it is not offered',
}

/**
 * The fiber states that may hold the offered set: a fiber running its plugin
 * callback, which includes an `apply` awaiting `replace`, and a loaded one. A
 * fiber waiting for a service it injects, failed, unloading or disposed is
 * not running, so a set it held would outlive the plugin that handed it over.
 */
const HOLDING_STATES: ReadonlySet<FiberState> = new Set([FiberState.LOADING, FiberState.ACTIVE])

/**
 * `ctx.skillPackIntake`. A Service so that each method sees the calling
 * fiber's context as `this.ctx`: Cordis hands every reader of a service a
 * proxy bound to the context it was read from, so a hold on the offered set
 * and a watch both belong to the fiber that asked for them.
 */
export class OrganizationPackIntake extends Service implements SkillPackIntake {
  private readonly host: IntakeHost
  private readonly state: IntakeState = {
    queue: Promise.resolve(),
    offered: [],
    holder: undefined,
    release: () => undefined,
    stopped: false,
  }

  /**
   * Provide `ctx.skillPackIntake` on the row's fiber. When that fiber is
   * disposed, a call still waiting answers `failed`, the call writing is
   * waited for, and the offered set is withdrawn.
   * @param ctx - the skill-pack row's context.
   * @param host - the organization root, and the row's judgement and change notification.
   */
  constructor(ctx: Context, host: IntakeHost) {
    super(ctx, 'skillPackIntake')
    this.host = host
    ctx.effect(() => async () => {
      this.state.stopped = true
      await this.state.queue
      this.state.release()
    }, 'skill-pack: the organization intake')
  }

  async replace(packs: readonly OrgPackInput[], options: { readonly signal?: AbortSignal } = {}): Promise<IntakeResult> {
    const caller = this.ctx
    options.signal?.throwIfAborted()
    const turn = this.state.queue.then(async () => await this.run(packs, options.signal, caller))
    const settled = (): undefined => undefined
    this.state.queue = turn.then(settled, settled)
    return await turn
  }

  isActive(name: string, version: string): boolean {
    const entry = this.state.offered.find(held => held.name === name && held.version === version)
    return entry !== undefined && this.host.judge(entry.observation).state === 'active'
  }

  onChange(listener: () => void): () => void {
    const dispose = this.ctx.effect(() => this.host.subscribe(listener), 'skill-pack: an organization intake watcher')
    return () => void dispose()
  }

  /**
   * Judge the offered set against the parts registered now.
   * @returns each entry's status, the view ids the active entries hold, and their views.
   */
  reading(): OrganizationReading {
    const statuses: PackStatus[] = []
    const held = new Map<string, string>()
    const views: ActivePackView[] = []
    for (const entry of this.state.offered) {
      const status: PackStatus = {
        ...this.host.judge(entry.observation),
        origin: 'organization',
        entryVersion: entry.version,
        channel: entry.channel,
      }
      statuses.push(status)
      if (status.state !== 'active') continue
      const fresh = entry.views.filter(view => !held.has(view.id))
      for (const view of fresh) held.set(view.id, entry.name)
      views.push(...fresh.map(view => ({ pack: entry.name, ...view })))
    }
    return { statuses, held, views }
  }

  /** Run one call once every earlier call has settled. */
  private async run(packs: readonly OrgPackInput[], signal: AbortSignal | undefined, caller: Context): Promise<IntakeResult> {
    const stoppedBefore = this.stoppedBeforeWrite(signal, caller)
    if (stoppedBefore !== undefined) return stoppedBefore
    let held: HeldViewIds
    try {
      held = await this.heldViewIds()
    } catch (error) {
      return { kind: 'failed', detail: `skill-pack: the organization root was not read: ${String(error)}` }
    }
    const judged = await this.judgeSet(packs, held)
    // Judging calls the component surface, which can stop either fiber or
    // abort the signal before anything is written.
    const stoppedAfter = this.stoppedBeforeWrite(signal, caller)
    if (stoppedAfter !== undefined) return stoppedAfter
    try {
      await syncPackRoot(this.host.root, {
        kind: 'packs',
        packs: judged.accepted.map(entry => ({ name: keyOf(entry), files: entry.files })),
      })
    } catch (error) {
      return { kind: 'failed', detail: `skill-pack: the organization root was not replaced: ${String(error)}` }
    }
    // The root is written; a caller that stopped meanwhile holds nothing, and
    // the next call handing over the same files finds them already there.
    if (!holdsSets(caller.fiber)) return CALLER_STOPPED_WRITING
    this.commit(judged.accepted, caller)
    return { kind: 'ok', refused: judged.refused }
  }

  /**
   * Whether a call may still write.
   * @throws the signal's reason, when it is aborted.
   */
  private stoppedBeforeWrite(signal: AbortSignal | undefined, caller: Context): IntakeResult | undefined {
    signal?.throwIfAborted()
    if (this.state.stopped) return ROW_STOPPED
    if (!holdsSets(caller.fiber)) return CALLER_STOPPED
    return undefined
  }

  /**
   * The view ids a set is judged against: the offered set's while a set is
   * offered, and otherwise those of the entries the organization root holds on
   * disk. Only a call whose entries passed these rules wrote those entries, so
   * a set handed over again after the holding fiber reloads, or after a
   * restart, is judged as it was while that set was offered.
   * @throws the error reading the organization root failed with.
   */
  private async heldViewIds(): Promise<HeldViewIds> {
    if (this.state.holder !== undefined) return { bytes: firstDeclared(this.state.offered), holder: 'the offered organization set' }
    const installed = await readInstalledPacks(this.host.root)
    const entries: { readonly viewBytes: ReadonlyMap<string, Buffer> }[] = []
    for (const [name, files] of [...installed.packs].sort(([left], [right]) => compareCodeUnits(left, right))) {
      const directory = join(this.host.root, name)
      const { source, bytesAt } = await observeFiles(
        directory,
        new Map([...files].map(([path, content]) => [join(directory, ...path.split('/')), content])),
      )
      if (source !== undefined) entries.push({ viewBytes: declaredViewBytes(source, bytesAt) })
    }
    return { bytes: firstDeclared(entries), holder: 'the organization root' }
  }

  /** Judge every entry of a set, and split it into what is written and what is refused, in the order the set names them. */
  private async judgeSet(packs: readonly OrgPackInput[], held: HeldViewIds): Promise<{ accepted: HeldEntry[]; refused: IntakeRefusal[] }> {
    const keys = packs.map(keyOf)
    const duplicated = new Set(keys.filter((key, index) => keys.indexOf(key) !== index))
    const judgements: EntryJudgement[] = []
    for (const pack of packs) {
      judgements.push(duplicated.has(keyOf(pack))
        ? refusedAs(pack, 'duplicate', `${keyOf(pack)} is named more than once in this set`)
        : await this.judgeEntry(pack))
    }
    const candidates = judgements.flatMap(judgement => judgement.kind === 'accepted' ? [judgement.entry] : [])
    const clashes = viewIdClashes(candidates, held)
    const accepted: HeldEntry[] = []
    const refused: IntakeRefusal[] = []
    for (const judgement of judgements) {
      if (judgement.kind === 'refused') {
        refused.push(judgement.refusal)
        continue
      }
      const clash = clashes.get(judgement.entry)
      if (clash === undefined) accepted.push(judgement.entry)
      else refused.push(refusedAs(judgement.entry, 'view-id-conflict', clash).refusal)
    }
    return { accepted, refused }
  }

  /**
   * Read one entry from its files in memory, by the reader the pack root is
   * read with, and hold it to the rules a delivered pack is held to.
   */
  private async judgeEntry(pack: OrgPackInput): Promise<EntryJudgement> {
    if (!isSkillName(pack.name)) return refusedAs(pack, 'pack-invalid', `the name ${JSON.stringify(pack.name)} is not a skill name`)
    if (!DIRECTORY_NAME.test(pack.version)) {
      return refusedAs(pack, 'pack-invalid', `the version ${JSON.stringify(pack.version)} is not one directory name`)
    }
    const directoryName = keyOf(pack)
    const broken = packRuleBreach(directoryName, pack.files)
    if (broken !== undefined) return refusedAs(pack, 'pack-invalid', broken)
    const directory = join(this.host.root, directoryName)
    const { source, bytesAt } = await observeFiles(
      directory,
      new Map(pack.files.map(file => [join(directory, ...file.path.split('/')), Buffer.from(file.content)])),
    )
    if (source === undefined) {
      return refusedAs(pack, 'pack-invalid', 'SKILL.md is missing, or its frontmatter states no skill name and description')
    }
    if (source.skill !== pack.name) return refusedAs(pack, 'pack-invalid', `SKILL.md names the skill ${JSON.stringify(source.skill)}`)
    if (!source.manifest.ok) {
      const { field, reason } = source.manifest
      return refusedAs(pack, 'pack-invalid', describeMissing({ kind: 'manifest-invalid', field, reason }))
    }
    const manifest = source.manifest.manifest
    const anchorFormat = anchorFormatMissing(manifest)
    if (anchorFormat !== undefined) return refusedAs(pack, 'anchor-format', describeMissing(anchorFormat))
    if (!readsDeclaredViews(manifest)) return refusedAs(pack, 'view-format', describeMissing(viewFormatMissing(manifest)))
    const views: PackView[] = []
    for (const view of source.views) {
      if (!view.ok) return refusedAs(pack, 'pack-invalid', `view ${view.path} is unreadable: ${view.reason}`)
      views.push(view.view)
    }
    const observation: PackObservation = { skill: source.skill, manifest: source.manifest, views: source.views }
    const [undrawable] = undrawableViews(this.host.judge(observation))
    if (undrawable !== undefined) return refusedAs(pack, 'view-refused', describeMissing(undrawable))
    return {
      kind: 'accepted',
      entry: {
        name: pack.name,
        version: pack.version,
        channel: pack.channel,
        observation,
        views,
        viewBytes: declaredViewBytes(source, bytesAt),
        files: pack.files,
      },
    }
  }

  /**
   * Offer a written set, hold it on the caller's fiber, and release the hold
   * that offered the set before. Listeners are told once the set is offered.
   */
  private commit(entries: readonly HeldEntry[], caller: Context): void {
    const holder = {}
    const previous = this.state.release
    this.state.offered = [...entries].sort((left, right) => compareCodeUnits(keyOf(left), keyOf(right)))
    this.state.holder = holder
    previous()
    const dispose = caller.effect(() => () => {
      // A hold another call has since replaced leaves the newer set alone.
      if (this.state.holder !== holder) return
      this.state.offered = []
      this.state.holder = undefined
      this.host.moved()
    }, 'skill-pack: the organization set this fiber handed over')
    this.state.release = () => void dispose()
    this.host.moved()
  }
}

/**
 * Whether a fiber may hold the offered set now.
 * @param fiber - the calling fiber.
 * @returns `true` while the fiber is loading or loaded.
 */
function holdsSets(fiber: Fiber): boolean {
  return HOLDING_STATES.has(fiber.state)
}

/**
 * The entries of a set refused for a view id, with the sentence naming it.
 *
 * Only an id the set itself declares with files of different bytes is
 * contested. An id already held keeps the bytes it holds, and every entry
 * declaring it with other bytes is refused; an id not held is refused to every
 * entry declaring it. Neither rule reads the order the entries are named in.
 * An id the set declares with one content is no conflict, whatever is held, so
 * a new version replaces an old one that the set no longer names.
 * @param candidates - the entries no other rule refused.
 * @param held - the view ids held now, which are uncontested, and what holds them.
 * @returns each refused entry and the sentence naming its id.
 */
function viewIdClashes(candidates: readonly HeldEntry[], held: HeldViewIds): Map<HeldEntry, string> {
  const first = new Map<string, Buffer>()
  const contested = new Set<string>()
  for (const entry of candidates) {
    for (const [id, bytes] of entry.viewBytes) {
      const seen = first.get(id)
      if (seen === undefined) first.set(id, bytes)
      else if (!seen.equals(bytes)) contested.add(id)
    }
  }
  const clashes = new Map<HeldEntry, string>()
  for (const entry of candidates) {
    const clash = clashOf(entry, contested, held)
    if (clash !== undefined) clashes.set(entry, clash)
  }
  return clashes
}

/** The sentence refusing one entry for a contested view id, or `undefined` when it keeps every id it declares. */
function clashOf(entry: HeldEntry, contested: ReadonlySet<string>, held: HeldViewIds): string | undefined {
  for (const [id, bytes] of entry.viewBytes) {
    if (!contested.has(id)) continue
    const kept = held.bytes.get(id)
    if (kept === undefined) return `another entry of this set declares the view id ${id} with a different file`
    if (!kept.equals(bytes)) return `the view id ${id} is held by ${held.holder} with a different file`
  }
  return undefined
}

/**
 * Read one entry from its files in memory, by the reader the pack root is
 * read with.
 * @param directory - absolute path of the entry's directory in the organization root.
 * @param files - each of the entry's files, by absolute path under `directory`, to its bytes.
 * @returns what that reader makes of the entry, and how one of its files' bytes are looked up.
 */
async function observeFiles(
  directory: string,
  files: ReadonlyMap<string, Buffer>,
): Promise<{ source: PackSource | undefined; bytesAt: (path: string) => Buffer }> {
  const bytesAt = (path: string): Buffer => {
    const content = files.get(path)
    if (content === undefined) throw new Error(`${path} is not among the entry's files`)
    return content
  }
  // Decoded as `readFile(path, 'utf8')` decodes, which keeps a byte-order
  // mark; a missing file rejects, as it does on disk.
  const source = await observePack(directory, path => new Promise((resolve) => { resolve(bytesAt(path).toString('utf8')) }))
  return { source, bytesAt }
}

/**
 * Each view id an entry declares in a view file that reads, to the bytes of
 * the first file declaring it.
 * @param source - the entry, as {@link observeFiles} read it.
 * @param bytesAt - how one of its files' bytes are looked up.
 * @returns the view ids and their bytes.
 */
function declaredViewBytes(source: PackSource, bytesAt: (path: string) => Buffer): Map<string, Buffer> {
  const declaring = source.views.flatMap(view => view.ok ? [[view.view.id, bytesAt(resolve(source.directory, view.path))] as const] : [])
  // Reversed so the first file declaring an id is the one a Map keeps.
  return new Map(declaring.reverse())
}

/**
 * Each view id some entry declares, to the bytes of the first entry declaring it.
 * @param entries - the entries, in `name@version` order.
 * @returns the view ids and their bytes.
 */
function firstDeclared(entries: readonly { readonly viewBytes: ReadonlyMap<string, Buffer> }[]): Map<string, Buffer> {
  return new Map(entries.flatMap(entry => [...entry.viewBytes]).reverse())
}

/**
 * Hold an entry's files to the rules a delivered pack is held to.
 * @returns the sentence naming the rule broken, or `undefined` when none is.
 */
function packRuleBreach(name: string, files: readonly DeliveredFile[]): string | undefined {
  try {
    validatePacks([{ name, files }])
  } catch (refusal) {
    return String(refusal)
  }
  return undefined
}

/** An entry's key and directory name, `<name>@<version>`. */
function keyOf(entry: { readonly name: string; readonly version: string }): string {
  return `${entry.name}@${entry.version}`
}

/** Refuse one entry. */
function refusedAs(
  entry: { readonly name: string; readonly version: string },
  code: IntakeRefusalCode,
  detail: string,
): { readonly kind: 'refused'; readonly refusal: IntakeRefusal } {
  return { kind: 'refused', refusal: { name: entry.name, version: entry.version, code, detail } }
}
