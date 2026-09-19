---
description: "一个技能，同时也是一整目录的界面：技能包根目录的技能提供方。它只在某个技能包的视图所摆放的每一个组件插件部件都已注册之后才把这个技能包交出去，并在一条路由上公布每个技能包的状态与原因；面向发放技能包的部署方，以及这条缝的维护者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-skill-pack

[English](README.md) | 中文

## 概述

技能包就是一个普通的技能目录——一份带 YAML frontmatter 的 `SKILL.md`，旁边放着视图文件——只是它的 frontmatter `metadata` 同时写明了它的视图要摆放哪些组件插件部件。这个包就是这样一整个目录的技能提供方。它读这个根目录，拿每个技能包去对组件插件真正注册了的部件做判定，只把每一条要求都满足了的技能包交给 `ctx.skills`。

激活是整包的。只要有一条要求没满足，这个技能包就谁也拿不到：模型不会被告知这个技能存在，面向用户的命令不会列出它，它的视图一个也不交出去。一个画到一半的页面比一个根本不在那里的技能包更糟。

状态不用重启就会翻转。组件插件挂上或撤走时，部件来源会通知这个包；被监视的技能包根目录里有技能包进出时，也会通知它；两者任一都会让技能目录失效，下一次读取就看到新的答案。

## 目录

- [挂载与配置](#mount-and-configure)
- [一个技能包怎么描述自己](#what-a-pack-says-about-itself)
- [为什么由这个包来当提供方](#why-this-package-is-the-provider)
- [部件从哪里来](#where-the-parts-come-from)
- [读一套部署手里有什么](#reading-what-a-deployment-holds)
- [整体替换技能包根目录](#replacing-a-pack-root)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="mount-and-configure"></a>
## 挂载与配置

把这一行挂在 `@deepseek-ai/dsh-skill` 旁边，并把通用的文件系统提供方指向这套部署的其它技能根目录，而不是这一个。

```yaml
- name: '@deepseek-ai/dsh-skill'
- name: '@deepseek-ai/dsh-experimental-skill-pack'
  config:
    root: /var/lib/dsh/packs
    platformVersion: 0.5.2
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `root` | 必填 | 技能包根目录的绝对路径：一个技能包一个目录。不存在的根目录就是里面一个技能包也没有。 |
| `platformVersion` | 必填 | 控制台平台自己的精确版本，技能包的 `pack.platform` 区间就是拿它来匹配的。 |
| `watch` | `true` | 是否监视这个根目录，好让技能包的进出不用重启就生效。 |

相对路径的 `root`，以及不是精确语义化版本的 `platformVersion`，都在这一行加载时就被拒绝，否则这两件事都会变成一个技能包一个技能包地被发现：相对路径读的是进程恰好待着的那个目录，而读不出来的平台版本满足不了任何区间，于是每个写了区间的技能包都会悄悄变成未激活。

<a id="what-a-pack-says-about-itself"></a>
## 一个技能包怎么描述自己

技能包的清单就是它自己 frontmatter 里的 `metadata` 对象——技能注册表的文件系统提供方本来就原样透传它——所以一个技能包无论在哪里被读到，都仍然是一个有效的技能。

```yaml
---
name: space-data-page
description: The deployment's layer table, with the questions it answers.
metadata:
  pack:
    version: 1.0.0
    platform: ">=0.5.0"
  requires:
    components:
      "@deepseek-ai/dsh-experimental-component-kit": ">=0.3.0"
    parts: [toy.data-page]
  views: [views/space-layer.yml]
---
```

`pack.version` 是这个技能包自己的精确版本，`pack.platform` 是对平台版本的可选区间。`requires.components` 把组件插件的包名映射到那个包必须满足的区间，`requires.parts` 写明必须存在于组件目录里的部件 id。`views` 列出这个技能包自己的视图文件，每份声明一个 `id`、一个 `title`、一份 `spec` 和一块 `params`；走出技能包目录的路径会被拒绝，而不是被跟着走。

`metadata` 对象是严格读的：这份清单不认识的键会让这个技能包被拒。写错的 `requires` 等于没人提过这条要求，而这个技能包接下来就会在它当初依赖的那些部件都不在的情况下被交出去。

预发布版按它的正式版号来比。这个工作区里每个包都带着预发布号，而普通的 semver 区间会把号段本来落在里面的预发布版排除掉，于是一个写着 `>=0.3.0` 的技能包反而拿不到它当初依赖的那个 `0.4.0-rc.1` 插件。

spec 和它的 params 是原样带过去、不读的。一份 spec 里能放什么由组件目录说了算，在这里再判一次就是第二个答案，而它随时可能和真正判一次调用的那个答案对不上。

<a id="why-this-package-is-the-provider"></a>
## 为什么由这个包来当提供方

`ctx.skills` 会把各提供方报上来的东西合并起来。[`registerProvider`](../../skill/skill/src/index.ts) 就是全部的贡献契约，注册表对别的提供方的目录既没有过滤、也没有否决、也没有瀑布钩子，所以能把一个技能包扣下来的地方，只有本来会报出它的那个提供方。把技能包报上去、但两个调用标志都设成 false，确实能对模型和命令都藏住它，可它仍然在合并目录里占住了那个名字，会把另一个提供方同名的技能盖掉；因此被扣下的技能包干脆一个也不报。

扣下这件事在加载时和在列举时同样生效。注册表会把一份完成的目录缓存到有人让它失效为止，于是一次选择可能活得比它当初所处的状态更久；一次加载会重新读技能包根目录，除非这个技能包仍然激活，否则答 `undefined`。

<a id="where-the-parts-come-from"></a>
## 部件从哪里来

组件表面是通过一个可选服务 `ctx.skillPackParts` 读到的，它的接口由这个包声明。它回答两个问题——有哪些部件，以及某一份视图文件画不画得出来——因为两者都出自同一份目录、同时变化：如果一套部署能只挂上部件表而不挂上判定，就会出现「技能包的部件已知、它的视图没判过」这种状态，而那个技能包会带着一个谁也画不出来的视图被交出去。

```ts type-equiv
/**
 * The component surface, as a pack's requirements read it: `ctx.skillPackParts`.
 *
 * Both questions come from one catalog and change together, so they are one
 * key: a deployment that could mount the part list without the judgement would
 * have a state where a pack's parts are known and its views are unjudged, and
 * the pack would be offered with a view nobody can draw — which is the state
 * this package exists to prevent.
 *
 * This package declares the key and consumes it; the row that implements it
 * over the real component catalog is separate wiring. Until a provider of the
 * key is mounted every pack sees an empty part list, so a pack that requires
 * any part stays inactive.
 */
interface PartsSource {
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
   * @param view - the parsed view file.
   * @param claimed - view ids already taken by the deployment's own
   *   configuration or by a pack judged before this one; a view repeating one
   *   is refused, because two views under one id is one menu row whose owner is
   *   decided by load order.
   * @returns the refusal, or `undefined` when the view can be drawn here.
   */
  judgeView(view: PackView, claimed: readonly string[]): PackViewRefusal | undefined
}
```

一套没有这个键的提供方的组合看到的是空的部件表，而这是正确答案，不是降级答案：一个点名了谁也没注册的部件的技能包画不出自己的页面，所以它保持未激活。在真实组件目录之上实现这个接口的那一行是 [`skill-pack-components`](../skill-pack-components/README.zh.md)；这里没有任何代码伸进那个包里。

<a id="reading-what-a-deployment-holds"></a>
## 读一套部署手里有什么

`ctx.skillPacks` 回答两个问题，`GET /skill-pack/status` 把其中第一个以 `{ "packs": [...] }` 的形式答在 HTTP 上。

| 读法 | 回答 |
|---|---|
| `statuses()` | 根目录里的每个技能包，激活的和未激活的都在，按技能名排序，各自带着版本和每一条没满足的要求。 |
| `activeViews()` | 每个激活技能包所声明的视图，带上声明它的那个技能包。未激活的技能包一个也不贡献，包括那些本身读得干干净净的视图。 |

一条没满足的要求会点名那个被拒的值：`manifest-invalid` 带字段，`platform-version` 和 `plugin-version` 带两个版本，`plugin-absent` 和 `part-absent` 带名字，`view-unreadable` 带文件，`view-refused` 带文件、文件里的那个值，以及组件表面自己对那个值说的那句话。这个联合是封闭的，消费者按 tag 分支并以 `assertNever` 收尾。

技能包按技能名顺序判定，而一个激活的技能包会为排在它之后判定的技能包占下自己的视图 id：两个技能包交出同一个视图 id 就是一条由加载顺序决定归属的菜单项，所以后面那个技能包会被扣下。因为别的原因未激活的技能包不占任何 id。

这条路由存在，是因为被扣下的技能包按设计在别的地方一律不可见，否则一套装了技能包却找不到它的部署将无处可读。它只带名字、版本和被拒原因——不带文件内容、不带技能包内部路径、不带配置——并且不做任何缓存，因为技能包的状态会随它周围的插件翻转。

每一个被扣下的技能包也会在进程日志里说一次，此后只在这份报告本身变了时再说。级别说明的是要不要有人动手：报告里点到被拒视图的写在 **error**，其余一律写在 **info**。等插件、等部件、等版本的技能包，在那一行被组合进来的瞬间自己就激活了，一套正装到一半的部署没有什么要修；而视图被判过并被拒的技能包，无论之后还来什么都不会激活，除非有人去改那个视图文件或把这个技能包退役。

<a id="replacing-a-pack-root"></a>
## 整体替换技能包根目录

`syncPackRoot(targetRoot, delivery)` 让技能包根目录里恰好只放着发放过来的那些技能包。它是替换而不是合并：上游退役的技能包没了，别人手工塞进根目录的也没了，于是根目录永远说的是发放方说的那句话。同一份发放跑第二遍不会写任何东西——这次调用会先把根目录和发放集对一遍，每个技能包、每条路径、每个字节都已经对上时就答「没变」。

活的根目录里不写任何东西。发放集先落到一个同级目录里暂存，在那里核对完，再用 rename 换进来，所以中途失败留下的根目录和原来一模一样。

技能包带 `.md`、`.yml`、`.yaml`，以及 `.png`、`.jpg`、`.jpeg`、`.gif`、`.webp` 这些图片。其它扩展名一律点名拒绝，抛 `PackInstallError`，符号链接和任何走出自己技能包目录的路径同样。技能包根目录是发放方往里写的一个目录；一个能带可执行文件的技能包就是一条装代码的路。`.svg` 和其它一起被拒，因为 SVG 文档里可以带脚本。

没有命令行入口。这是发放侧自己调用的一个库函数。

<a id="model-experience"></a>
## 模型体验

间接，经由 `dsh-tool-skill`：一个激活的技能包以普通技能的身份出现在合并技能目录里，加载它拿回它的 `SKILL.md` 正文。未激活的技能包对任何目录和任何结果都不贡献，所以模型永远不会被告知有一个它根本用不了的技能存在。

#### KV 缓存影响

技能注册表的消费者拥有那条持久目录消息以及它只追加的替换件。技能包状态一变就让那份目录失效，于是消费者追加一条替换件，而不是重写前缀。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与暂缓事项

- **缺插件只报告，绝不安装。** 一个需要某组件插件而这套部署没有的技能包，会一直未激活到有人把它装上为止。这里没有任何代码去取或挂一个插件：一条从技能包数据跑起来的安装路，正是技能包规则要堵死的那条装代码的路。重新考虑的触发条件，是发放侧能把插件和技能包打成一个包一起发。
- **一套部署一份发放集。** `root` 是单个目录，`syncPackRoot` 把它整个替换，所以这套部署的每个用户看到的技能包都一样。按用户分集需要一个这个包没有的身份；触发条件是多用户那个决定。
- **两个技能包可能占同一个技能名。** 两个都会被 `statuses()` 报出来，而技能注册表按它自己的 rank 与顺序规则悄悄解决这个重名。既没有拒绝，也没有哪份报告点名被盖掉的那个技能包。
- **技能包的视图由提供部件的那一方来判，没人提供时就不判。** 没有 `ctx.skillPackParts` 的提供方时，解析通过的视图会被原样带过去，因为反正谁也画不出来；这时技能包会带着没有任何表面看过的视图被交出去。这与部件表所处的 fail-closed 位置相同，只是再往前一步。
- **每次读都重新读根目录。** `statuses()`、`activeViews()` 以及每次提供方调用都会扫一遍技能包根目录、重新解析每份清单。这让答案始终跟得上现状、没有会过期的缓存，也正因如此这条状态路由不适合按交互频率轮询。
- **没挂部件提供方的技能包根目录交不出任何带视图的技能包。** 在有人挂上 `ctx.skillPackParts` 的提供方之前，每个点名了部件的技能包都是未激活。这是正确的 fail-closed 状态，也是很容易被当成 bug 的一种状态——状态路由就是为它存在的。部署方组合的那个提供方是 [`skill-pack-components`](../skill-pack-components/README.zh.md)。
- **没有被组装快照覆盖** —— 这个包由它自己的用例覆盖，其中包括一次跑在真实技能包根目录上的真实 Loader 组合；快照泳道重放的是发行组合，而那里不组合任何 experimental 行。

**运行时不变量：** 不发布伴生件。这个包不保留任何独立观察能与之矛盾的可变状态：每次读都是在调用那一刻从技能包根目录和部件来源算出来的，唯一保留下来的值是上一次扣下技能包的那份报告，它存在只是为了让没变的报告不被记两遍。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

`examples/space-data-page` 目录是一个按发放方会发的样子做出来的技能包。它的 `SKILL.md` 正文是占位：技能包的正文由拥有这个技能包的人来写，不由这个包来写。

</details>
