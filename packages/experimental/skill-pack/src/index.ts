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
import { describeMissing, reconcilePacks } from './reconcile.ts'
import { packStatusRoute } from './route.ts'
import { readPackRoot, type PackSource } from './scan.ts'
import type { ActivePackView, PackManifest, PackStatus, PartsSource } from './types.ts'

export type * from './types.ts'
export { PackInstallError, syncPackRoot } from './install.ts'
export type {
  DeliveredFile,
  DeliveredPack,
  PackDelivery,
  PackInstallRefusal,
  SyncPackRootResult,
} from './install.ts'
export { describeMissing, reconcilePacks, type PackObservation } from './reconcile.ts'
export { parsePackManifest } from './manifest.ts'
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

/** Where the packs are, which platform version they are judged against, and whether the root is watched. */
export interface Config {
  /** Absolute path of the pack root: one directory per pack. */
  root: string
  /** The console platform's own exact version, which a pack's `pack.platform` range is matched against. */
  platformVersion: string
  /** Whether the pack root is watched, so a pack arriving or leaving takes effect without a restart. */
  watch?: boolean
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
  })

  private readonly root: string
  private readonly platformVersion: string
  /** Invalidates the registry's completed catalogs; absent until the provider registration runs. */
  private invalidate: (() => void) | undefined
  /** The parts source while one is mounted; an absent source provides no parts at all. */
  private parts: PartsSource | undefined
  /** The last announced withheld-pack report, so a refresh that changes nothing logs nothing. */
  private announced = ''

  /**
   * Create the registry, claim the pack root's provider seat, and mount the
   * optional parts source, root watcher and status route.
   * @param ctx - Cordis context that owns the service.
   * @param config - the pack root, the platform version, and whether to watch.
   * @throws {Error} when `root` is not an absolute path or `platformVersion` is not an exact semantic version.
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

    ctx.effect(() => ctx.skills.registerProvider(control => this.provider(control)), 'skill-pack: the pack root skill provider')

    ctx.inject(['skillPackParts'], (partsCtx: Context) => {
      partsCtx.effect(() => {
        this.parts = partsCtx.skillPackParts
        const stop = this.parts.onChange(() => { this.invalidate?.() })
        this.invalidate?.()
        return () => {
          stop()
          this.parts = undefined
          this.invalidate?.()
        }
      }, 'skill-pack: the component parts source')
    })

    if (config.watch !== false) {
      ctx.effect(() => {
        const watcher = chokidar.watch(this.root, { ignoreInitial: true, depth: PACK_WATCH_DEPTH })
        watcher.on('all', () => { this.invalidate?.() })
        /* v8 ignore start -- chokidar reports a watch failure only from the platform watcher, which no in-process test can make fail. */
        watcher.on('error', (error: unknown) => {
          this.ctx.logger.warn(`skill-pack: pack root watch failed: ${String(error)}`)
        })
        /* v8 ignore stop */
        return () => { void watcher.close() }
      }, 'skill-pack: the pack root watcher')
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
   * Read the root and reconcile it against the parts registered now.
   *
   * `active` holds only packs whose manifest parsed and whose every
   * requirement is met, so the pack identity every active-pack read needs is
   * in hand without re-deciding what reconciliation already decided.
   */
  private async judge(): Promise<{ statuses: PackStatus[]; active: Map<string, ActivePack> }> {
    const sources = await readPackRoot(this.root)
    const statuses = reconcilePacks(sources, this.parts?.list() ?? [], this.platformVersion)
    this.announce(statuses)
    const offered = new Set(statuses.filter(status => status.state === 'active').map(status => status.skill))
    const active = new Map<string, ActivePack>()
    for (const source of sources) {
      if (!offered.has(source.skill) || !source.manifest.ok) continue
      active.set(source.skill, { source, manifest: source.manifest.manifest })
    }
    return { statuses, active }
  }

  /** State every withheld pack and its reasons once, and again only when that report changes. */
  private announce(statuses: readonly PackStatus[]): void {
    const report = statuses
      .filter(status => status.state === 'inactive')
      .map(status => `${status.skill}: ${status.missing.map(describeMissing).join('; ')}`)
      .join(' | ')
    if (report === this.announced) return
    this.announced = report
    if (report !== '') this.ctx.logger.info(`skill-pack: withholding ${report}`)
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
