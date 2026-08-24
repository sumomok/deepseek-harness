# Content Surface

[English](content-surface.md) | 中文

服务形态外壳 content 栏背后那条每会话的分类内容 entry 流。`ctx.contentSurface` 是一张 extractor 表：每个想要这一栏的宿主行注册自己在会话日志里认得什么，由本服务把全部已注册 extractor 折叠进同一个 `contentSurface` [会话 projection](session-projection.zh.md)。[content-surface Agent Note](../../.agents/notes/implemented/feature/2026-08-24-content-surface-router.zh.md) 负责这条路由决策，[包 README](../../packages/experimental/content-surface/README.zh.md) 负责组合方式与限制；本页记录字面契约与 fold 的规则。

这条 surface 不追加任何会话事件。每条 entry 都派生自别的包已经记录的事实，因此整栏都能从 agent 真正写下的日志里重放，而新增一个 kind 不新增任何持久化格式。

## 一个 kind 贡献什么

```ts type-equiv
/**
 * One kind's contribution to the content surface.
 *
 * Both functions MUST be synchronous and pure: `read` runs inside the session
 * projection's fold, and `resolve` runs inside its view, where an async result
 * would tear the carriers' consistency cut.
 */
interface ContentSurfaceExtractor<D> {
  /** The kind this extractor produces; also the `content.surface.kind` key its renderer claims. */
  readonly kind: string
  /**
   * Invalidation anchor for `data`: bump it whenever the stored shape or the
   * reading rules change, so persisted checkpoints written by the previous
   * version are discarded instead of handed to the new `resolve`.
   */
  readonly dataVersion: number
  /**
   * Read the entry one committed event records.
   * @param event - the committed session event.
   * @returns the draft, or `undefined` when the event records nothing for this kind.
   */
  read(event: SessionEvent): ContentSurfaceDraft<D> | undefined
  /**
   * Resolve one stored record against what this kind's host row knows now.
   * @param data - the `data` a previous `read` stored.
   * @returns the entry's title and the payload its renderer receives.
   */
  resolve(data: D): ContentSurfaceResolved
}
```

`read` 说出一条事件记录了哪条 entry、以及要为它存下哪份不透明 JSON；`resolve` 把那份已存值变成切换条要的 `title` 与渲染器要的 `payload`。这一拆分正是历史稳定的原因：只有派生自日志的那一半被折叠与 checkpoint，因此某个部署改掉一个页面的名字、退掉一张图表，改变的是这一栏展示什么，而不是会话记录下了什么。

事件按注册顺序抵达各个 extractor，第一份 draft 胜出，因此两个 kind 不得认领同一条事件。

## fold 存什么，这一栏收到什么

```ts type-equiv
/**
 * One entry as the fold stores it: the log-derived half, kept minimal so the
 * persisted checkpoint replays. One record per live entry survives the fold —
 * a later record naming the same kind and id replaces it — and `data` is
 * resolved into {@link ContentSurfaceEntry}'s `title` and `payload` at view
 * time, against whatever the kind's host row knows now.
 */
interface ContentSurfaceRecord {
  /** The extractor that produced it; also the `content.surface.kind` key its renderer claims. */
  readonly kind: string
  /** Identity within the kind: a later record with the same pair replaces this one. */
  readonly entryId: string
  /** Log sequence number of the recording event, which is also the entry's position in the stream. */
  readonly seq: number
  /** Kind-owned plain JSON, opaque to this package. */
  readonly data: unknown
}
```

```ts type-equiv
/** One resolved entry, as the browser column receives it. */
interface ContentSurfaceEntry {
  /** The extractor that produced it; the `content.surface.kind` key whose renderer draws it. */
  readonly kind: string
  /** Identity within the kind; stable across the calls that replace one another. */
  readonly entryId: string
  /** Log sequence number of the record that currently owns the entry. */
  readonly seq: number
  /** One line naming the entry in the switcher strip. */
  readonly title: string
  /** Kind-owned plain JSON its renderer consumes; opaque to the column. */
  readonly payload: unknown
}
```

替换发生在 fold 里而非 view 里：一个会话把同一张图重绘一百次，携带的仍是一条记录。身份是 `(kind, entryId)`，并以 kind 限定，因此两个 kind 永不会在同一个 id 上相撞。发布出来的 view 按所属 `seq` 降序排列，于是在观看者另选之前，这一栏展示的就是 `entries[0]`。某条记录的 kind 若已离开这张表，它解析为无，而不是解析成一条没有渲染器画得出的半截 entry。

## 注册时机与 fold 版本

projection registry 在注册那一刻固定一个 unit 的 `apply`、`view` 与 `stateVersion`，为每个会话缓存一份折叠单元，并且永不回头重算已建好的单元。因此，若在一个长期存在的 unit 里读取「活的」表，任何单元早于某个迟到 extractor 的会话，都会永久缺失该 kind 的历史。

`ctx.contentSurface` 改为在表每次变化时都注册**一个新 unit**。丢弃旧注册会连同它的缓存单元一起丢弃，每个会话下一次被触及时便以新表从 `init` 重新折叠它完整的内存日志。`stateVersion` 是同一问题的持久侧：它是排序后的 `kind@dataVersion` 列表哈希进 31 位的结果，于是组合变化会丢弃持久化的 checkpoint 行，而不是向前套用它们。残留的代价是推送延迟而非正确性——registry 只在驱动事件时发布变更值，因此在某个 kind 行被热加载时已经连着的浏览器，会一直读到旧的流，直到该会话的下一条事件。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxcontentsurface--contentsurfaceregistry"></a>

### `ctx.contentSurface` — `ContentSurfaceRegistry`

`ctx.contentSurface`: the extractor table behind the content column's entry stream, and the owner of the `contentSurface` projection unit.

**Registration timing is free.** The projection registry fixes a unit's fold and its `stateVersion` at registration and caches one folded cell per session, so a table read live inside one long-lived unit would leave every cell built before a late extractor arrived permanently missing that kind's history. This registry therefore registers a NEW unit for every table change: the registry drops the old unit's cells with it, and each session's next touch refolds `init` over its whole in-memory log through the new table. `stateVersion` is derived from the table for the same reason, so a persisted checkpoint written under a different set of kinds is discarded rather than forward-applied.

The one cost is push latency: the registry publishes a changed value only while driving an event, so a browser already connected when a kind row is hot-loaded reads the previous stream until that session's next event.

```ts cordis-catalog
/**
 * Register one kind's extractor. The registration is an effect on the
 * calling context's fiber: disposing the fiber (or calling the returned
 * disposer) removes the kind, and every session's stream refolds without it.
 * @param extractor - the kind, its data version, and its two pure functions.
 * @returns the exact disposer that unregisters this extractor.
 */
register<D>(extractor: ContentSurfaceExtractor<D>): () => void
```

Source: [`packages/experimental/content-surface/src/index.ts`](../../packages/experimental/content-surface/src/index.ts)
<!-- END GENERATED cordis-surface -->
