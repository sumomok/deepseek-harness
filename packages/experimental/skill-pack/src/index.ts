/**
 * @deepseek-ai/dsh-experimental-skill-pack — a skill that is also a directory
 * of interface.
 *
 * A skill pack is an ordinary skill directory: a `SKILL.md` with YAML
 * frontmatter, and view files beside it. What makes it a pack is its
 * frontmatter `metadata`, which states the pack's own version and the
 * component plugin parts its views place. A pack carries no code.
 *
 * This plugin is the skill provider for one pack root. It reads the root,
 * judges every pack against the parts a component plugin has registered, and
 * offers the skill registry only the packs whose every requirement is met. A
 * pack with one unmet requirement is offered to nobody: the model is never
 * told it exists and no command lists it, because a skill whose page cannot be
 * drawn is worse than a skill that is not there.
 *
 * Being the provider is what makes that possible. `ctx.skills` merges what its
 * providers report and exposes no filter, veto or waterfall over another
 * provider's catalog ([`registerProvider`](../../../skill/skill/src/index.ts)
 * is the whole contribution contract), so the only place a pack can be
 * withheld is the provider that would otherwise have reported it. A deployment
 * therefore points `dsh-skill-filesystem` at its ordinary skill roots and this
 * plugin at the pack root.
 *
 * The state flips without a restart. The parts source notifies this plugin
 * when a component plugin is mounted or withdrawn, and the pack root is
 * watched for packs arriving and leaving; either one invalidates the registry
 * catalog, and the next read sees the new answer.
 *
 * A deployment that configures a delivery directory installs a packed set the
 * same way: ops copies one archive in, this plugin verifies it against the
 * archive's own manifest and makes the pack root equal to what it carries. The
 * directory names the delivery the deployment holds, and nothing here ever
 * writes into it.
 * @module @deepseek-ai/dsh-experimental-skill-pack
 */

import { isAbsolute } from 'node:path'
import chokidar from 'chokidar'
import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import semver from 'semver'
import type {
  SkillCandidate,
  SkillDefinition,
  SkillProvider,
  SkillProviderControl,
} from '@deepseek-ai/dsh-skill'
// Type-only: resolves ctx.webServer for the optional status route.
import type {} from '@deepseek-ai/dsh-host-webserver'
import { installDelivery, type DeliveryDirectory } from './deliveries.ts'
import type { StagedPack, StagedPackRefusal } from './install.ts'
import { describeMissing, reconcilePacks } from './reconcile.ts'
import { packStatusRoute } from './route.ts'
import { readPackRoot, type PackSource } from './scan.ts'
import type { ActivePackView, PackManifest, PackMissing, PackStatus, PartsSource } from './types.ts'

export type * from './types.ts'
export { buildPackArchive, PACK_ARCHIVE_EXTENSION, PACK_ARCHIVE_FORMAT } from './archive.ts'
export { PackInstallError } from './refusal.ts'
export type { PackInstallRefusal } from './refusal.ts'
export { syncPackRoot } from './install.ts'
export type { PackArchiveSyncResult, StagedPack, StagedPackRefusal, SyncPackRootResult, VerifyStagedPacks } from './install.ts'
export { describeMissing, reconcilePacks, type PackObservation } from './reconcile.ts'
export { PACK_ANCHOR_FORMATS, PACK_VIEW_FORMATS, parsePackManifest } from './manifest.ts'
export { parsePackView } from './views.ts'
export { SKILL_PACK_STATUS_ROUTE } from './route.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    skillPacks: SkillPackRegistry
    skillPackParts: PartsSource
  }
}

/** Provider name this plugin claims in `ctx.skills`. */
const PROVIDER_NAME = 'skill-pack'

/**
 * Duplicate-name rank inside the registry's layer. A pack root is a custom
 * root, so packs resolve against project and user skills exactly as the
 * filesystem provider's custom roots do.
 */
const PACK_RANK = 300

/**
 * Directory levels the pack root watcher descends: the pack directory and the
 * `views` directory inside it, which is every level a pack's own files sit at.
 */
const PACK_WATCH_DEPTH = 2

/**
 * How long a dropped archive must stop growing before it is read, and how
 * often that is checked. A copy in progress is a file that is not the delivery
 * yet; waiting for it to settle is what keeps an ordinary `cp` from being read
 * half-written and refused for a digest it was always going to fail.
 */
const DELIVERY_SETTLE_MS = 300
const DELIVERY_POLL_MS = 50

/**
 * Largest delivery archive a deployment reads by default. A set of packs is
 * instructions, view files and pictures; 32 MiB carries a large one, and a
 * file over it is something other than the delivery this root installs.
 */
const DEFAULT_MAX_ARCHIVE_BYTES = 32 * 1024 * 1024

/**
 * Largest single file inside a delivery archive by default: enough for an
 * illustrated instruction page, far below what any view file or manifest is.
 */
const DEFAULT_MAX_FILE_BYTES = 4 * 1024 * 1024

/**
 * Most entries a delivery archive may carry by default. A pack is a `SKILL.md`
 * with its views and pictures beside it, so this is room for dozens of packs
 * and a ceiling on what one archive can make a deployment write.
 */
const DEFAULT_MAX_FILES = 512

/**
 * The unmet requirements a delivery is allowed to arrive carrying.
 *
 * A pack naming a plugin, a part or a platform version this deployment does
 * not have is a delivery that arrived before the row it was written against:
 * it installs, stays inactive, says on the status route what it is waiting
 * for, and activates by itself when that row is composed. A view the composed
 * surface refuses is the opposite case — nothing that arrives later makes it
 * drawable — so it is checked only for a pack whose other requirements this
 * deployment already meets, and it refuses the delivery.
 */
const DEFERRED_REQUIREMENTS: ReadonlySet<PackMissing['kind']> = new Set([
  'platform-version',
  'plugin-absent',
  'plugin-version',
  'part-absent',
])

/** Where a deployment's delivery archives are dropped, and the limits one is read under. */
export interface PackDeliveryDirectory {
  /** Absolute path of the directory a delivery archive is copied into. */
  directory: string
  /** Largest archive that is read at all, in bytes. Raise it for a deployment whose packs carry large pictures. */
  maxArchiveBytes: number
  /** Largest single file an archive may carry, in bytes. */
  maxFileBytes: number
  /** Most entries an archive may carry, its manifest among them. */
  maxFiles: number
}

/** Where the packs are, which platform version they are judged against, whether the root is watched, and where a delivery arrives. */
export interface Config {
  /** Absolute path of the pack root: one directory per pack. */
  root: string
  /** The console platform's own exact version, which a pack's `pack.platform` range is matched against. */
  platformVersion: string
  /** Whether the pack root is watched, so a pack arriving or leaving takes effect without a restart. */
  watch?: boolean
  /** Where a delivery archive is dropped; absent where a deployment installs its packs some other way. */
  deliveries?: PackDeliveryDirectory
}

/**
 * `ctx.skillPacks`: the pack root's skill provider, and the reader of what it
 * decided.
 *
 * Both reads answer from the pack root and the parts source as they stand at
 * the moment of the call rather than from a retained snapshot, so a caller
 * cannot observe a state that the skill catalog has already moved past.
 */
export class SkillPackRegistry extends Service {
  static inject = ['skills']

  static Config: z<Config> = z.object({
    root: z.string().required(),
    platformVersion: z.string().required(),
    watch: z.boolean().default(true),
    // Cleared default, because schemastery gives every object schema `{}`:
    // left alone it would materialize this block for a deployment that
    // configured none and watch a directory nobody named. `undefined` is not a
    // value of the block's own type, which is what the cast says.
    deliveries: z.object({
      directory: z.string().required(),
      maxArchiveBytes: z.natural().min(1).default(DEFAULT_MAX_ARCHIVE_BYTES),
      maxFileBytes: z.natural().min(1).default(DEFAULT_MAX_FILE_BYTES),
      maxFiles: z.natural().min(1).default(DEFAULT_MAX_FILES),
    }).default(undefined as never),
  })

  private readonly root: string
  private readonly platformVersion: string
  /** The delivery directory and the limits one archive in it is read under; absent where none is configured. */
  private readonly deliveries: DeliveryDirectory | undefined
  /** Invalidates the registry's completed catalogs; absent until the provider registration runs. */
  private invalidate: (() => void) | undefined
  /** The parts source while one is mounted; an absent source provides no parts at all. */
  private parts: PartsSource | undefined
  /** The last announced withheld-pack report, so a refresh that changes nothing logs nothing. */
  private announced = ''
  /**
   * The installs this row has started, one after another. Two events about one
   * directory must not stage into the same root at once, and a disposal has to
   * be able to wait for the one that is running.
   */
  private installing: Promise<void> = Promise.resolve()
  /** Whether the delivery watch has been given up, so a queued install does not run after it. */
  private stopped = false

  /** Subscribers, in registration order, which is the order a change reaches them in. */
  private readonly watchers = new Set<() => void>()

  /**
   * Create the registry, claim the pack root's provider seat, and mount the
   * optional parts source, root watcher, delivery watch and status route.
   * @param ctx - Cordis context that owns the service.
   * @param config - the pack root, the platform version, whether to watch, and where a delivery arrives.
   * @throws {Error} when `root` or `deliveries.directory` is not an absolute path, or `platformVersion` is
   *   not an exact semantic version.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'skillPacks')
    if (!isAbsolute(config.root)) {
      throw new Error(`skill-pack: root must be an absolute path, received ${JSON.stringify(config.root)}`)
    }
    if (semver.valid(config.platformVersion) === null) {
      throw new Error(
        `skill-pack: platformVersion must be an exact semantic version, received ${JSON.stringify(config.platformVersion)}`)
    }
    this.root = config.root
    this.platformVersion = config.platformVersion
    this.deliveries = resolveDeliveries(config.deliveries)

    ctx.effect(() => ctx.skills.registerProvider(control => this.provider(control)), 'skill-pack: the pack root skill provider')

    ctx.inject(['skillPackParts'], (partsCtx: Context) => {
      partsCtx.effect(() => {
        this.parts = partsCtx.skillPackParts
        const stop = this.parts.onChange(() => { this.moved() })
        this.moved()
        return () => {
          stop()
          this.parts = undefined
          this.moved()
        }
      }, 'skill-pack: the component parts source')
    })

    if (config.watch !== false) {
      ctx.effect(() => {
        const watcher = chokidar.watch(this.root, { ignoreInitial: true, depth: PACK_WATCH_DEPTH })
        // Invalidated once the watch is armed, and again on every event. A pack
        // that arrived between the watcher's own first listing and the events
        // starting to arrive is in neither, so without this reading it would be
        // offered only after the next unrelated change to the root.
        watcher.on('ready', () => { this.moved() })
        watcher.on('all', () => { this.moved() })
        /* v8 ignore start -- chokidar reports a watch failure only from the platform watcher, which no in-process test can make fail. */
        watcher.on('error', (error: unknown) => {
          this.ctx.logger.warn(`skill-pack: pack root watch failed: ${String(error)}`)
        })
        /* v8 ignore stop */
        return () => { void watcher.close() }
      }, 'skill-pack: the pack root watcher')
    }

    const deliveries = this.deliveries
    if (deliveries !== undefined) {
      ctx.effect(() => {
        const watcher = chokidar.watch(deliveries.directory, {
          depth: 0,
          ignoreInitial: true,
          awaitWriteFinish: { stabilityThreshold: DELIVERY_SETTLE_MS, pollInterval: DELIVERY_POLL_MS },
        })
        // The directory is read once the watch is armed, and again on every
        // event. The first read is what installs an archive that was already
        // there, and what catches one copied in during the moment between the
        // watcher's own first listing and the events starting to arrive.
        watcher.on('ready', () => { this.queueInstall(deliveries) })
        watcher.on('all', () => { this.queueInstall(deliveries) })
        /* v8 ignore start -- chokidar reports a watch failure only from the platform watcher, which no in-process test can make fail. */
        watcher.on('error', (error: unknown) => {
          this.ctx.logger.warn(`skill-pack: delivery watch failed: ${String(error)}`)
        })
        /* v8 ignore stop */
        return async () => {
          this.stopped = true
          await watcher.close()
          await this.installing
        }
      }, 'skill-pack: the delivery directory watcher')
    }

    ctx.inject(['webServer'], (serverCtx: Context) => {
      serverCtx.effect(
        () => serverCtx.webServer.register(packStatusRoute(() => this.statuses())),
        'skill-pack: the pack status route',
      )
    })
  }

  /**
   * Judge every pack in the root as it stands now.
   * @returns one status per pack, active and inactive alike, in skill-name order.
   */
  async statuses(): Promise<PackStatus[]> {
    return (await this.judge()).statuses
  }

  /**
   * Watch for a change in what this root offers, for as long as the calling
   * fiber lives.
   *
   * What a caller placing a pack's views needs: the answer is recomputed on
   * every read rather than cached, so the only way to learn that it moved is to
   * be told. A listener is called after the invalidation, so the read it makes
   * sees the new state.
   * @param listener - called on every change; it reads {@link SkillPackRegistry.activeViews} or
   *   {@link SkillPackRegistry.statuses} for the new answer.
   * @returns the disposer that stops the watch, which the calling fiber also runs.
   */
  onChange(listener: () => void): () => void {
    const dispose = this.ctx.effect(() => {
      this.watchers.add(listener)
      return () => this.watchers.delete(listener)
    }, 'skill-pack: a pack-set watcher')
    return () => void dispose()
  }

  /**
   * The views of every active pack, in pack order and then manifest order.
   * An inactive pack contributes none, including views that read cleanly.
   * @returns each active pack's declared views, carrying the pack that declared them.
   */
  async activeViews(): Promise<ActivePackView[]> {
    const { active } = await this.judge()
    return [...active.values()].flatMap(({ source }) => source.views
      .filter(view => view.ok)
      .map(view => ({ pack: source.skill, ...view.view })))
  }

  /**
   * Put one install behind the installs already queued.
   *
   * Every event about the delivery directory queues one, because what the
   * directory says is read at the moment the install runs rather than carried
   * from the event: a file that arrived while an install was running is the
   * delivery the next one reads.
   */
  private queueInstall(delivery: DeliveryDirectory): void {
    this.installing = this.installing.then(async () => {
      /* v8 ignore next -- only an event dispatched while the watcher was closing reaches a stopped
         row, and no in-process test can make chokidar emit one during close(). */
      if (this.stopped) return
      const changed = await installDelivery(this.root, delivery, (level, text) => {
        this.ctx.logger[level](text)
      }, packs => this.refuseUndrawable(packs))
      if (changed) this.moved()
    })
  }

  /**
   * Judge a delivered set against the surface this deployment composes, so a
   * delivery carrying a view nothing here can draw is refused whole instead of
   * installed and then withheld.
   *
   * Each pack is judged on its own, because what is being asked is about that
   * pack's own views; a view id two delivered packs both claim withholds both
   * of them once they are installed, and is not a reason to refuse the file
   * somebody copied in. With no parts source mounted nothing is refused: the
   * judgement is the composed surface's, and there is none.
   * @param packs - the staged packs, each with a manifest and view files that parsed.
   * @returns the first refusal this deployment can already state, or `undefined`.
   */
  private refuseUndrawable(packs: readonly StagedPack[]): StagedPackRefusal | undefined {
    const parts = this.parts
    if (parts === undefined) return undefined
    const refusals = packs.flatMap((pack) => {
      const judged = reconcilePacks([pack], parts.list(), this.platformVersion, view => parts.judgeView(view))
      return judged.flatMap(status => refusalsOf(pack, status))
    })
    return refusals[0]
  }

  /**
   * Read the root and reconcile it against the parts registered now.
   *
   * `active` holds only packs whose manifest parsed and whose every
   * requirement is met, so the pack identity every active-pack read needs is
   * in hand without re-deciding what reconciliation already decided.
   */
  private async judge(): Promise<{ statuses: PackStatus[]; active: Map<string, ActivePack> }> {
    const sources = await readPackRoot(this.root)
    const parts = this.parts
    const statuses = reconcilePacks(
      sources,
      parts?.list() ?? [],
      this.platformVersion,
      parts === undefined ? undefined : (view => parts.judgeView(view)),
    )
    this.announce(statuses)
    const offered = new Set(statuses.filter(status => status.state === 'active').map(status => status.skill))
    const active = new Map<string, ActivePack>()
    for (const source of sources) {
      if (!offered.has(source.skill) || !source.manifest.ok) continue
      active.set(source.skill, { source, manifest: source.manifest.manifest })
    }
    return { statuses, active }
  }

  /**
   * Invalidate the registry's completed catalogs and tell everyone watching
   * this root.
   *
   * One settlement point for both, so a watcher cannot read a catalog the
   * invalidation has not reached yet.
   */
  private moved(): void {
    this.invalidate?.()
    for (const watcher of this.watchers) watcher()
  }

  /**
   * State every withheld pack and its reasons once, and again only when that
   * report changes.
   *
   * At error level where any of those reasons is a view the component surface
   * will not draw, and at info level otherwise. The two are different events
   * for whoever reads the log: a pack waiting for a plugin or a part is a
   * deployment part-way through installing one, and it activates by itself the
   * moment that row is composed; a pack whose view was judged and refused will
   * never activate, however much of the deployment arrives afterwards, and
   * somebody has to edit the view file or retire the pack.
   * @param statuses - every pack in the root, active and inactive alike.
   */
  private announce(statuses: readonly PackStatus[]): void {
    const inactive = statuses.filter(status => status.state === 'inactive')
    const report = inactive
      .map(status => `${status.skill}: ${status.missing.map(describeMissing).join('; ')}`)
      .join(' | ')
    if (report === this.announced) return
    this.announced = report
    if (report === '') return
    const undrawable = inactive.some(status => status.missing.some(missing => missing.kind === 'view-refused'))
    if (undrawable) this.ctx.logger.error(`skill-pack: withholding ${report}`)
    else this.ctx.logger.info(`skill-pack: withholding ${report}`)
  }

  /** The provider seat: only active packs are reported, and only an active pack loads. */
  private provider(control: SkillProviderControl): SkillProvider {
    this.invalidate = control.invalidate
    return {
      name: PROVIDER_NAME,
      list: async () => [...(await this.judge()).active.values()].map(pack => candidateOf(pack)),
      get: async (candidate) => {
        const pack = (await this.judge()).active.get(candidate.name)
        return pack === undefined ? undefined : definitionOf(pack)
      },
    }
  }
}

export default SkillPackRegistry

/** One pack that is offered, and the manifest reconciliation accepted it on. */
interface ActivePack {
  readonly source: PackSource
  readonly manifest: PackManifest
}

/**
 * The views of one staged pack this deployment can already say it will not
 * draw. A pack still waiting on a plugin, a part or a platform version has
 * none, because its views were judged against a surface that is not finished
 * arriving.
 * @param pack - the staged pack, for the directory name a refusal is reported under.
 * @param status - what reconciliation made of that pack on its own.
 * @returns one refusal per refused view, in the order the pack declares them.
 */
function refusalsOf(pack: StagedPack, status: PackStatus): StagedPackRefusal[] {
  if (status.missing.some(missing => DEFERRED_REQUIREMENTS.has(missing.kind))) return []
  return status.missing
    .filter(missing => missing.kind === 'view-refused')
    .map(missing => ({ pack: pack.name, file: missing.view, reason: missing.reason }))
}

/**
 * Read the delivery directory and the limits it is watched under. Every limit
 * is decided by the configuration schema, which is the one place a number a
 * deployment left out comes from.
 * @param configured - the `deliveries` block, or `undefined` where a deployment configured none.
 * @returns the directory and its limits, or `undefined` where no delivery directory is watched.
 * @throws {Error} when the configured directory is not an absolute path.
 */
function resolveDeliveries(configured: PackDeliveryDirectory | undefined): DeliveryDirectory | undefined {
  if (configured === undefined) return undefined
  if (!isAbsolute(configured.directory)) {
    throw new Error(
      `skill-pack: deliveries.directory must be an absolute path, received ${JSON.stringify(configured.directory)}`)
  }
  return {
    directory: configured.directory,
    limits: {
      maxArchiveBytes: configured.maxArchiveBytes,
      maxFileBytes: configured.maxFileBytes,
      maxFiles: configured.maxFiles,
    },
  }
}

/** One active pack as the registry's merged catalog carries it. */
function candidateOf({ source, manifest }: ActivePack): SkillCandidate {
  return {
    name: source.skill,
    description: source.description,
    ...source.whenToUse !== undefined ? { whenToUse: source.whenToUse } : {},
    invocation: { modelInvocable: true, userInvocable: true },
    provider: PROVIDER_NAME,
    source: 'custom',
    rank: PACK_RANK,
    locator: source.path,
    resourceBase: { kind: 'directory', path: source.directory },
    path: source.path,
    metadata: { pack: manifest.pack },
  }
}

/**
 * One active pack with its instructions. The body comes from the same read
 * that judged the pack, so a load answers the root the catalog was judged
 * against rather than a second, possibly later, read of the file.
 */
function definitionOf(pack: ActivePack): SkillDefinition {
  const { rank: _rank, locator: _locator, ...summary } = candidateOf(pack)
  return { ...summary, content: pack.source.body }
}
