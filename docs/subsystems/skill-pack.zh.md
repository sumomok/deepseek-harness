# 技能包

[English](skill-pack.md) | 中文

技能包就是一个普通的技能目录，只是它的 frontmatter `metadata` 同时写明了它的视图要摆放哪些组件插件部件。`ctx.skillPacks` 是这样一整个目录的技能提供方，`ctx.skillPackParts` 则是它读那些已注册部件所走的那个可选服务。[包 README](../../packages/experimental/skill-pack/README.zh.md) 拥有清单格式、配置、状态文档和安装器的各条规矩；这一页记的是消费者从签名上读不出来的那三个决定。

来源：[`packages/experimental/skill-pack/src/index.ts`](../../packages/experimental/skill-pack/src/index.ts)。

## 「扣下」只能住在提供方里

[`ctx.skills`](skills.zh.md) 把各提供方报上来的东西合并起来，对别的提供方的目录既没有过滤、也没有否决、也没有瀑布钩子，所以能把一个技能包扣下来的地方，只有本来会报出它的那个提供方。把被扣下的技能包以两个调用标志都为 false 报上去，确实对模型和命令都藏住了它，可它仍然在合并目录里占住那个名字，并在那里盖掉另一个提供方的同名技能；因此被扣下的技能包干脆一个也不报。挂了这一行的部署，把通用文件系统提供方指向它其它的技能根目录。

扣下这件事在加载时和在列举时同样生效。注册表会把一份完成的目录缓存到有人让它失效为止，于是一次选择可能活得比它当初所处的状态更久；一次加载会重新读技能包根目录，除非这个技能包仍然激活，否则答 `undefined`。

## 激活是整包的

每条要求都满足的技能包整包交出去；只要有一条没满足，这个技能包就谁也拿不到——模型拿不到，面向用户的命令拿不到，它的视图一个也不交，包括那些本身读得干干净净的视图。另一条路是一个带窟窿的页面：模型照着技能走进一个画不出来的视图。`statuses()` 把两种都报出来，每一条没满足的要求都是一个封闭联合里的一项，`GET /skill-pack/status` 把这份文档公布出去，因为被扣下的技能包按设计在别的地方一律不可见。

## 部件来源不在，是一个答案，不是降级

`ctx.skillPackParts` 由这个包声明、在别处实现。在有人挂上它的提供方之前，部件表是空的，于是每个点名了部件的技能包都未激活。这是 fail-closed 的答案，而不是一项缺失的能力：一个部件谁也没注册的技能包，横竖都画不出自己的页面；而提供方一到场状态就翻，因为部件来源的 `onChange` 和被监视的技能包根目录都会让技能目录失效。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
 * id is settled by the pack root instead, which withholds both of them.
 * @param view - the parsed view file.
 * @returns the refusal, or `undefined` when the view can be drawn here.
 */
judgeView(view: PackView): PackViewRefusal | undefined
```

Source: [`packages/experimental/skill-pack/src/types.ts`](../../packages/experimental/skill-pack/src/types.ts)

<a id="ctxskillpacks--skillpackregistry"></a>

### `ctx.skillPacks` — `SkillPackRegistry`

`ctx.skillPacks`: the pack root's skill provider, and the reader of what it decided.

Both reads answer from the pack root and the parts source as they stand at the moment of the call rather than from a retained snapshot, so a caller cannot observe a state that the skill catalog has already moved past.

```ts cordis-catalog
/**
 * Judge every pack in the root as it stands now.
 * @returns one status per pack, active and inactive alike, in skill-name order.
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
 * The views of every active pack, in pack order and then manifest order.
 * An inactive pack contributes none, including views that read cleanly.
 * @returns each active pack's declared views, carrying the pack that declared them.
 */
async activeViews(): Promise<ActivePackView[]>
```

Source: [`packages/experimental/skill-pack/src/index.ts`](../../packages/experimental/skill-pack/src/index.ts)
<!-- END GENERATED cordis-surface -->
