# 技能包

[English](skill-pack.md) | 中文

技能包就是一个普通的技能目录，只是它的 frontmatter `metadata` 同时写明了它的视图要摆放哪些组件插件部件。`ctx.skillPacks` 是这样一整个目录的技能提供方，`ctx.skillPackParts` 是它读那些已注册部件所走的那个可选服务，`ctx.skillPackIntake` 则安装并判断组织插件交来的技能包。[包 README](../../packages/experimental/skill-pack/README.zh.md) 拥有清单格式、配置、状态文档、安装器的各条规矩和组织条目的字段；这一页记的是消费者从签名上读不出来的那四个决定。

来源：[`packages/experimental/skill-pack/src/index.ts`](../../packages/experimental/skill-pack/src/index.ts)。

## 「扣下」只能住在提供方里

[`ctx.skills`](skills.zh.md) 把各提供方报上来的东西合并起来，对别的提供方的目录既没有过滤、也没有否决、也没有瀑布钩子，所以能把一个技能包扣下来的地方，只有本来会报出它的那个提供方。把被扣下的技能包以两个调用标志都为 false 报上去，确实对模型和命令都藏住了它，可它仍然在合并目录里占住那个名字，并在那里盖掉另一个提供方的同名技能；因此被扣下的技能包干脆一个也不报。挂了这一行的部署，把通用文件系统提供方指向它其它的技能根目录。

扣下这件事在加载时和在列举时同样生效。注册表会把一份完成的目录缓存到有人让它失效为止，于是一次选择可能活得比它当初所处的状态更久；一次加载会重新读技能包根目录，除非这个技能包仍然激活，否则答 `undefined`。

## 激活是整包的

每条要求都满足的技能包整包交出去；只要有一条没满足，这个技能包就谁也拿不到——模型拿不到，面向用户的命令拿不到，它的视图一个也不交，包括那些本身读得干干净净的视图。另一条路是一个带窟窿的页面：模型照着技能走进一个画不出来的视图。`statuses()` 把两种都报出来，每一条没满足的要求都是一个封闭联合里的一项，`GET /skill-pack/status` 把这份文档公布出去，因为被扣下的技能包按设计在别的地方一律不可见。

## 部件来源不在，是一个答案，不是降级

`ctx.skillPackParts` 由这个包声明、在别处实现。在有人挂上它的提供方之前，部件表是空的，于是每个点名了部件的技能包都未激活。这是 fail-closed 的答案，而不是一项缺失的能力：一个部件谁也没注册的技能包，横竖都画不出自己的页面；而提供方一到场状态就翻，因为部件来源的 `onChange` 和被监视的技能包根目录都会让技能目录失效。

## 组织集由交出它的 fiber 持有

只有这一行配置了 `organizationRoot` 时才有 `ctx.skillPackIntake`。组织插件仍是它交来的技能包唯一的技能提供方；这一行把它们装在 `<name>@<version>` 下，按根目录里技能包的判法逐条判断，并把激活条目的视图交给组件表面，所以关于它们的任何东西都不从这里进 `ctx.skills`。最后写下的那份集合，在调用方读接收接缝时所在 context 的 fiber 加载中或已加载期间提供，`inject` 回调自己的 fiber 也算，那个 fiber 一停下就撤下；文件留在盘上，之后交来同样文件的调用不写盘。一份比它的插件活得更久的集合，会在插件被停用、热重载或出错之后，仍把那个插件的视图挂在侧栏里。激活的组织条目对技能包根目录保有它的视图 id，根目录里声明这个 id 的技能包被扣下。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxskillpackintake--skillpackintake"></a>

### `ctx.skillPackIntake` — `SkillPackIntake`

`ctx.skillPackIntake`: installs the skill packs an organization hands over, and answers which of them may be offered now. The skill-pack row provides it only where `organizationRoot` is configured.

The plugin handing the packs over is their only skill provider: this package reports none of them to `ctx.skills`, and only installs them, judges them, and hands their views to the component surface.

```ts cordis-catalog
/**
 * Replace the organization root with `packs`.
 *
 * Each entry is judged on its own: an entry breaking a rule is refused and
 * not written. The accepted entries are staged and swapped in together, so
 * the root holds all of them or is left as it was. An entry waiting for a
 * plugin, a part or a platform version installs and stays inactive until
 * that arrives, without a restart. `replace([])` withdraws the set and
 * empties the root.
 *
 * The calling fiber — the fiber of the context the caller read
 * `skillPackIntake` from, an `inject` callback's own fiber included — holds
 * the set it hands over: once written, the set is offered through
 * {@link SkillPackIntake.isActive}, `ctx.skillPacks.activeViews()` and the
 * status route for as long as that fiber is active, and withdrawn when it
 * stops, its files staying on disk. Nothing is offered after a process
 * starts until the first `replace`. A set already on disk byte for byte is
 * offered without being written again.
 *
 * When the promise resolves with `ok`, `isActive` already answers from the
 * new set, and every `onChange` listener has been called after it was
 * offered. Calls run one at a time in the order they arrive, and the last
 * one offered is the set offered. A call that reaches its turn after this
 * row has stopped, whose calling fiber is no longer active when its turn
 * comes or when its write finishes, whose row stops while its set is
 * written, or whose read or write of the organization root fails, answers
 * `failed` and offers nothing new.
 * @param packs - every entry to offer, keyed by name and version.
 * @param options - `signal` rejects the call with its `reason`, changing
 *   nothing, while the call waits for its turn or before it writes; once the
 *   write starts the call no longer reads it.
 * @returns which entries were refused and why, or why the new set is not offered.
 */
replace(packs: readonly OrgPackInput[], options?: { readonly signal?: AbortSignal }): Promise<IntakeResult>

/**
 * Whether one entry may be offered now, judged synchronously against the
 * offered set and the parts registered at the moment of the call.
 * @param name - the entry's skill name.
 * @param version - the entry's organization manifest version.
 * @returns `true` when the offered set holds the entry and its parts, plugins,
 *   platform range, anchor format and views are all met.
 */
isActive(name: string, version: string): boolean

/**
 * Watch for a change in what {@link SkillPackIntake.isActive} answers: a set
 * offered or withdrawn, or the registered parts changing. The listener is
 * called after the change, so the read it makes sees it. The watch lasts as
 * long as the calling fiber.
 * @param listener - called after each change; it reads `isActive` again.
 * @returns the disposer that stops the watch.
 */
onChange(listener: () => void): () => void
```

Source: [`packages/experimental/skill-pack/src/types.ts`](../../packages/experimental/skill-pack/src/types.ts)

<a id="ctxskillpackparts--partssource"></a>

### `ctx.skillPackParts` — `PartsSource`

The component surface, as a pack's requirements read it: `ctx.skillPackParts`.

Both questions come from one catalog and change together, so they are one key: a deployment that could mount the part list without the judgement would have a state where a pack's parts are known and its views are unjudged, and the pack would be offered with a view nobody can draw — which is the state this package exists to prevent.

This package declares the key and consumes it; the row that implements it over the real component catalog is separate wiring. Until a provider of the key is mounted every pack sees an empty part list, so a pack that requires any part stays inactive.

```ts cordis-catalog
/**
 * The parts registered right now.
 * @returns every registered part, in no guaranteed order.
 */
list(): readonly ProvidedPart[]

/**
 * Observe registrations and withdrawals.
 * @param listener - called after the registered set changes; it reads {@link PartsSource.list} for the new set.
 * @returns the disposer that stops the notifications.
 */
onChange(listener: () => void): () => void

/**
 * Judge one view file against the surface that would draw it.
 *
 * The judgement is the component surface's own, so a view a pack ships and a
 * block the model places are accepted on identical terms. This package reads
 * neither the spec nor the params it hands over.
 *
 * A view id the deployment's own configuration already claims is refused
 * here, because the deployment's views own their ids. Two packs claiming one
 * id is settled by this package instead: two packs of the pack root are both
 * withheld, and an offered organization pack keeps the id against the pack
 * root.
 * @param view - the parsed view file.
 * @returns the refusal, or `undefined` when the view can be drawn here.
 */
judgeView(view: PackView): PackViewRefusal | undefined
```

Source: [`packages/experimental/skill-pack/src/types.ts`](../../packages/experimental/skill-pack/src/types.ts)

<a id="ctxskillpacks--skillpackregistry"></a>

### `ctx.skillPacks` — `SkillPackRegistry`

`ctx.skillPacks`: the pack root's skill provider, and the reader of what it decided.

Both reads answer from the pack root, the offered organization set and the parts source as they stand at the moment of the call rather than from a retained snapshot, so a caller cannot observe a state that the skill catalog has already moved past.

```ts cordis-catalog
/**
 * Judge every pack in the root, and every entry of the offered organization
 * set, as they stand now.
 * @returns one status per pack, active and inactive alike: the root's in skill-name order, then the
 *   organization set's in `name@version` order.
 */
async statuses(): Promise<PackStatus[]>

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
onChange(listener: () => void): () => void

/**
 * The views of every active pack, in pack order and then manifest order:
 * the root's packs, then the offered organization set's entries. An inactive
 * pack contributes none, including views that read cleanly, and an id two
 * active organization entries declare with one file is listed once.
 * @returns each active pack's declared views, carrying the pack that declared them.
 */
async activeViews(): Promise<ActivePackView[]>
```

Source: [`packages/experimental/skill-pack/src/index.ts`](../../packages/experimental/skill-pack/src/index.ts)
<!-- END GENERATED cordis-surface -->
