---
description: "一个技能，同时也是一整目录的界面：技能包根目录的技能提供方。它只在某个技能包的视图所摆放的每一个组件插件部件都已注册之后才把这个技能包交出去，并在一条路由上公布每个技能包的状态与原因；面向发放技能包的部署方，以及这条缝的维护者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-skill-pack

[English](README.md) | 中文

## 概述

技能包就是一个普通的技能目录——一份带 YAML frontmatter 的 `SKILL.md`，旁边放着视图文件——只是它的 frontmatter `metadata` 同时写明了它的视图要摆放哪些组件插件部件。这个包就是这样一整个目录的技能提供方。它读这个根目录，拿每个技能包去对组件插件真正注册了的部件做判定，只把每一条要求都满足了的技能包交给 `ctx.skills`。配置了组织包根的部署还提供 `ctx.skillPackIntake`：它安装并判断组织插件交来的技能包，这些技能由那个插件自己报告。

## 目录

- [挂载与配置](#mount-and-configure)
- [一个技能包怎么描述自己](#what-a-pack-says-about-itself)
- [为什么由这个包来当提供方](#why-this-package-is-the-provider)
- [部件从哪里来](#where-the-parts-come-from)
- [读一套部署手里有什么](#reading-what-a-deployment-holds)
- [整体替换技能包根目录](#replacing-a-pack-root)
  - [一份发放要过哪些检查](#what-a-delivery-is-checked-for)
- [用一个打好的包来安装](#installing-from-a-packed-file)
- [组织技能包](#organization-packs)
  - [组织插件交来什么](#what-the-organization-plugin-hands-over)
  - [一份集合怎么判](#how-a-set-is-judged)
  - [一份集合提供多久](#how-long-a-set-is-offered)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="mount-and-configure"></a>
## 挂载与配置

激活是整包的。只要有一条要求没满足，这个技能包就谁也拿不到：模型不会被告知这个技能存在，面向用户的命令不会列出它，它的视图一个也不交出去。一个画到一半的页面比一个根本不在那里的技能包更糟。

状态不用重启就会翻转。组件插件挂上或撤走时，部件来源会通知这个包；被监视的技能包根目录里有技能包进出时，也会通知它；两者任一都会让技能目录失效，下一次读取就看到新的答案。

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
| `deliveries.directory` | 不填 | 发放包被拷进来的那个目录的绝对路径。这套部署用别的办法装技能包时就不填。 |
| `deliveries.maxArchiveBytes` | `33554432` | 最大到多大的发放包才会被读。 |
| `deliveries.maxFileBytes` | `4194304` | 一个发放包里单个文件最大多大。 |
| `deliveries.maxFiles` | `512` | 一个发放包最多带多少个条目，清单本身也算在内。 |
| `organizationRoot` | 不填 | 组织包根的绝对路径，每个[组织条目](#organization-packs)一个 `<name>@<version>` 目录。配置了，这一行就提供 `ctx.skillPackIntake`；不填，就不安装也不提供任何组织技能包。给它一个专用的父目录：一次替换会在它旁边写暂存目录和退役目录。 |
| `perMember` | `false` | `GET /skill-pack/status` 是否只答 `ctx.consoleMembers` 认得出成员的请求。 |

`deliveries` 的三个默认值是包根导出的 `DEFAULT_PACK_ARCHIVE_LIMITS`，发放侧可以用它按部署不配置上限时用的那三个数检查一个集合。

被监视的根目录会在监视装好时读一遍，此后每收到一个事件再读一遍。一个落在监视器自己第一次列举与它的原生流开始供事件之间的技能包，两边都不在；没有那第一次读，它要等到根目录下一次发生别的变化才会被交出去。

相对路径的 `root`、相对路径的 `deliveries.directory`，以及不是精确语义化版本的 `platformVersion`，都在这一行加载时就被拒绝，否则这两件事都会变成一个技能包一个技能包地被发现：相对路径读的是进程恰好待着的那个目录，而读不出来的平台版本满足不了任何区间，于是每个写了区间的技能包都会悄悄变成未激活。相对路径的 `organizationRoot` 也在加载时被拒绝；`root`、`deliveries.directory`、`organizationRoot` 三者中任意两个是同一个目录，或者一个在另一个里面，同样在加载时被拒绝：技能包根目录和组织包根都是整个被替换的，替换其中一个就会写进另一个。这三个目录在这一行加载时都被规范化——去掉末尾的分隔符，并把 `.` 和 `..` 段按路径规则解析——之后每一次写盘、每一句拒绝说的都是规范化后的路径，所以在目录旁边暂存的替换不会落进目录里面。两个目录按文件系统读它们的方式比较：每个路径里已存在的最长前段换成它的真实路径，沿途的符号链接因此都被跟随；在 macOS 和 Windows 上，名字还会按[比较两个技能包名的方式](#replacing-a-pack-root)折叠，因为 APFS 和 NTFS 不区分大小写，APFS 也不区分规范化形式。两个平台用同一种折叠，而且它比哪个文件系统自己的折叠都宽：只差规范化形式的一对目录在 Windows 上也被拒绝，尽管 NTFS 会把它们当成两个目录；`ı` 和 `I` 这样被折成同一个名字、而 APFS 分得开的一对，同样被拒绝。一个目录路径里已存在的最长前段如果是一个目标不存在的符号链接（成环的链接也算），这一行加载时就报错拒绝，报错写出配置项名、规范化后的路径和那个链接：目录会建在链接指向的地方，按链接自己的路径比较，就看不出它的目标落在另外两个目录里面。

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
    viewFormat: 1
  requires:
    components:
      "@deepseek-ai/dsh-experimental-component-kit": ">=0.3.0"
    parts: [toy.data-page]
  views: [views/space-layer.yml]
---
```

`pack.version` 是这个技能包自己的精确版本，`pack.platform` 是对平台版本的可选区间。`requires.components` 把组件插件的包名映射到那个包必须满足的区间，`requires.parts` 写明必须存在于组件目录里的部件 id。`views` 列出这个技能包自己的视图文件，每份声明一个 `id`、一个 `title`、一份 `spec` 和一块 `params`；走出技能包目录的路径会被拒绝，而不是被跟着走。包根导出这两张清单：`PACK_MANIFEST_FIELDS` 列出清单能写的每个键，从解析清单用的 schema 上读出；`PACK_VIEW_FIELDS` 列出视图文件被读的四个键。每一项都标明是否必填，并用 `summary` 写明值必须是什么；清单字段的 summary 就是它的 schema 带的描述。包根还导出 `PACK_MANIFEST_KEY`，即读清单用的 frontmatter 键 `metadata`；清单字段被拒时，报出的字段名也以它开头。清单里写了清单外的键，整份清单被拒；视图文件里写了清单外的键，这个键被忽略。

`pack.viewFormat` 是这些视图文件所用的视图文件格式版本，整个技能包只写一次。声明了视图的技能包要写它，没声明视图的技能包没有东西归它管，可以不写。这套构建读格式 `1`；写了别的数字的技能包，以及声明了视图却什么都没写的技能包，会被扣下并由 `view-format` 点出两边的数字，带着这种技能包的发放会被拒。版本按技能包而不是按文件，因为一个技能包的每份视图文件都是一起发放的，而技能包是整体交出去的。

`pack.anchorFormat` 是带元素锚点导出的技能包所用的锚点文件格式版本。没写它的技能包不带锚点，每个构建都读。这套构建读格式 `1`，也就是 `PACK_ANCHOR_FORMATS` 里放的那个；写了别的数字的技能包会被扣下并由 `anchor-format` 点出两边的数字，带着这种技能包的发放会被拒。这里不读锚点文件本身——怎么读它，写在技能包自己的说明里，由模型照着做——所以写下的这个数字就是全部的检查，之后到来的部件、插件或哪一行都改变不了答案。这张表是常量而不是配置字段，因为它说的是与这套构建配套的 point-anchor 包写出哪种锚点行，而不是各部署之间会不一样的选择。格式号只往里加；删掉一个，对每个写了它的技能包都是破坏性变更。

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
}
```

一套没有这个键的提供方的组合看到的是空的部件表，而这是正确答案，不是降级答案：一个点名了谁也没注册的部件的技能包画不出自己的页面，所以它保持未激活。在真实组件目录之上实现这个接口的那一行是 [`skill-pack-components`](../skill-pack-components/README.zh.md)；这里没有任何代码伸进那个包里。

<a id="reading-what-a-deployment-holds"></a>
## 读一套部署手里有什么

`ctx.skillPacks` 回答两个问题，`GET /skill-pack/status` 把其中第一个以 `{ "packs": [...] }` 的形式答在 HTTP 上；配了发放目录、而且本次启动以来有一次读取找到过发放包时，还多一项 [`lastDelivery`](#the-directory-a-delivery-arrives-in)。

| 读法 | 回答 |
|---|---|
| `statuses()` | 先是根目录里的每个技能包，按技能名排序，再是已提供的组织集里的每个条目，按 `name@version` 排序，激活的和未激活的都在，各自带着版本和每一条没满足的要求。 |
| `activeViews()` | 每个激活技能包所声明的视图，先根目录的、后组织集的，带上声明它的那个技能包。未激活的技能包一个也不贡献，包括那些本身读得干干净净的视图。 |

每条状态都带 `origin`：`pack-root`，或者是已提供的组织集里的条目时为 `organization`；组织条目还带 `entryVersion`——组织清单条目的版本，它和技能名一起作这个条目的键——以及 `channel`，`stable` 或 `trial`。`version` 一律是技能包自己的 `metadata.pack.version`，这里不拿它和 `entryVersion` 比对。不公布试装标识：哪位成员在哪次试装里，归组织插件知道。

一条没满足的要求会点名那个被拒的值：`manifest-invalid` 带字段，`platform-version` 和 `plugin-version` 带两个版本，`plugin-absent` 和 `part-absent` 带名字，`anchor-format` 和 `view-format` 带这个技能包写的版本和这套构建读的版本，`view-unreadable` 带文件，`view-refused` 带文件、文件里的那个值，以及组件表面自己对那个值说的那句话，`view-id-conflict` 带这个 id、另一个占着它的技能包，以及那个技能包装在哪里。这个联合是封闭的，消费者按 tag 分支并以 `assertNever` 收尾。

这个根目录本来会交出去的两个技能包，如果声明了同一个视图 id，**两个都**被扣下，各自点出这个 id 和对方。一条菜单项不能有两个归属者，而把这个 id 留给排在前面那个，就等于让一套部署交出什么取决于它的技能包碰巧是按什么顺序读进来的。因为别的原因未激活的技能包不占任何 id，所以一个谁也没被交出去的技能包扣不住一个本来会被交出去的；部署自己配置占下的 id 更早就被组件表面拒掉了，因为部署自己的视图拥有自己的 id。

激活的组织条目对技能包根目录保有它的视图 id：根目录里声明了这个 id 的技能包被扣下，`view-id-conflict` 点出那个组织技能包，无论什么东西以什么顺序读进来都一样，因为同一个包走两个出口时，组织集是部署选定的来源。未激活的组织条目不占任何 id。

顺序按码元，不按 `localeCompare`：`statuses()` 的技能名顺序、扫描技能包根目录的目录名顺序、写一个归档文件时的路径顺序，在每台主机上都一样，无论它带的是哪套 ICU 数据和默认区域设置。

这条路由存在，是因为被扣下的技能包按设计在别的地方一律不可见，否则一套装了技能包却找不到它的部署将无处可读。它只带名字、版本、每个技能包装在哪里、组织条目的通道、被拒原因和上次发放——不带文件内容、不带技能包内部路径、不带配置——并且不做任何缓存，因为技能包的状态会随它周围的插件翻转。发放被拒的原因会点名被拒的发放包条目，技能包根目录、它上面的目录和发放目录都写成占位符，见[它的 `reason` 字段](#the-directory-a-delivery-arrives-in)。

开了 `perMember` 时，这条路由只答 `ctx.consoleMembers` 认得出成员的请求：这个服务没在跑时答 503，它认不出请求属于谁时答 401。认得出的每位成员读到的是同一份文档。组合加载完以后，`perMember` 的设置和成员目录是否在跑对不上时，记一条 error 日志：开了按成员却没有目录的行，对每个请求都答 503；没开 `perMember` 而旁边有目录在跑的行，谁访问这条路由都答。

每一个被扣下的技能包也会在进程日志里说一次，此后只在这份报告本身变了时再说。级别说明的是要不要有人动手：报告里点到被拒视图的写在 **error**，其余一律写在 **info**。等插件、等部件、等版本的技能包，在那一行被组合进来的瞬间自己就激活了，一套正装到一半的部署没有什么要修；而视图被判过并被拒的技能包，无论之后还来什么都不会激活，除非有人去改那个视图文件或把这个技能包退役。

<a id="replacing-a-pack-root"></a>
## 整体替换技能包根目录

`syncPackRoot(targetRoot, delivery)` 让技能包根目录里恰好只放着发放过来的那些技能包。一份发放可以是一个源目录、技能包本身，或者[一个打好的包文件](#installing-from-a-packed-file)；三者只差在这套集合是怎么读进来的。它是替换而不是合并：上游退役的技能包没了，别人手工塞进根目录的也没了，于是根目录永远说的是发放方说的那句话。同一份发放跑第二遍不会写任何东西——这次调用会先把根目录和发放集对一遍，每个技能包、每条路径、每个字节都已经对上时就答「没变」。

活的根目录里不写任何东西。发放集先落到一个同级目录里暂存，在那里核对完，再用 rename 换进来，所以中途失败留下的根目录和原来一模一样。根目录不存在，就是第一次安装；根目录是一个指向不存在路径的符号链接时同样算第一次安装，写盘的那次调用会把这个链接换成一个真实目录。这一行配置的 `root` 是这样的链接时，加载时就被拒绝，见[挂载与配置](#mount-and-configure)；所以根目录走到这种情况，是它被直接交给 `syncPackRoot`，或者链接目标在这一行加载之后被删掉。根目录因为别的任何原因读不了，这次调用在暂存任何东西之前就以那个错误拒绝：它里面放着什么不得而知，把它当成空根目录来替换，会把里面的技能包全部退役。

技能包带 `.md`、`.yml`、`.yaml`，以及 `.png`、`.jpg`、`.jpeg`、`.gif`、`.webp` 这些图片，包根把这张名单导出为 `PACK_FILE_EXTENSIONS`。其它扩展名一律点名拒绝，抛 `PackInstallError`，符号链接和任何走出自己技能包目录的路径同样。技能包根目录是发放方往里写的一个目录；一个能带可执行文件的技能包就是一条装代码的路。`.svg` 和其它一起被拒，因为 SVG 文档里可以带脚本。一份发放里的两个技能包名、或者一个技能包里的两个路径，经过 Unicode NFC、小写、大写、再小写、再 NFC 之后相等，就算同一个名字，其中第二个以 `duplicate-entry` 被拒。这种折叠把 APFS 当成同一个名字的每一对都折成同一个，`ß` 和 `ss`、`σ` 和 `ς`、`µ` 和 `μ` 都在其中；少数文件系统分得开的对，比如 `ı` 和 `I`，也被折成同一个，因为拒掉这样一对，比把两个名字写进同一个目录代价小。一个技能包把一个路径既当文件、又按同样的折叠当另一个路径的目录用时，比如 `notes/x.md` 和 `notes/X.md/y.md`，两者中后出现的那个也以 `duplicate-entry` 被拒。技能包名和技能包文件路径的每一段，在两种情况下还会以 `path-escape` 被拒：含孤立的 UTF-16 代理项时，Node 会把代理项写成 U+FFFD，两个这样的名字就会落到同一个条目上；超过 255 个 UTF-8 字节时，255 字节是 ext4 一个名字最多能存的字节数，APFS 和 NTFS 则按 UTF-16 码元计数，能存更长的名字。文件系统能不能存下一个名字，本包只查这两项。文件系统因别的原因拒收的名字，比如含有 Unicode 没有分配字符的码位的名字（APFS 以 `EILSEQ` 或 `ENOENT` 拒收），或者长过平台 `PATH_MAX` 的路径，会让写盘本身失败：这次发放以文件系统的那个错误被拒，而不是 `PackInstallError`，根目录保持原样。

没有命令行入口。这是发放侧自己调用的一个库函数，而下面那个发放目录是这一行唯一会自己调用它的地方。

<a id="what-a-delivery-is-checked-for"></a>
### 一份发放要过哪些检查

暂存出来的那棵树在成为技能包根目录之前，先按技能包根目录读一遍；任何一项没过，这份发放**整份**被拒——什么都不写，旧的根目录逐字节保持原样。一套装进了坏视图的技能包根目录只会在状态路由上说这件事，而那时候把文件拷进来的运维早就走了。

| 拒绝 | 拒的是什么 |
|---|---|
| `pack-manifest` | 发放过来的技能包，它的 `metadata` 对象不是一份清单 |
| `pack-anchor-format` | 发放过来的技能包写的锚点格式这套构建不读 |
| `pack-view-format` | 发放过来的技能包声明的视图用了这套构建不读的视图格式，或者什么都没写 |
| `pack-view` | 发放过来的技能包声明了却没带的视图文件，或者带了却不是视图的那一份 |
| `pack-view-refused` | 这套部署所组合的组件表面画不出来的视图 |

**这套部署眼下还满足不了的要求不算拒绝。** 一个点名了这里没有的插件、部件或平台版本的技能包会被装进去、判为未激活、在状态路由上说清楚它在等什么，并在那一行被组合进来的瞬间自己激活——这正是一份比它的插件先到的发放存在的意义。只有写坏了的视图，或者在一个其它要求**已经满足**的技能包上被组合好的表面拒掉的视图，才会让这次安装被拒。

组件目录的判定是一个参数，不是一条 import。`syncPackRoot(root, delivery, verify)` 收下调用方自己的表面；[`SkillPackRegistry`](#the-directory-a-delivery-arrives-in) 传的是它通过 `ctx.skillPackParts` 读到的那个，而一个没有组合任何表面的发放侧调用方什么也不传。没有它的时候，上面那些检查照样跑，组件目录的判定推迟到判定环节——和别人手工写进根目录的技能包走的是同一条路。

`buildPackArchive` 只按技能包**文件**的规矩收一套集合——名字、路径、扩展名。它不读这些文件说了什么：清单、视图格式和视图文件由装它的那套部署判，因为那一侧才有画这些视图的表面。

<a id="installing-from-a-packed-file"></a>
## 用一个打好的包来安装

发放控制台把一个文件交给一套部署，部署一步就把它装上。`buildPackArchive(source, set)` 从一个源目录、或者从技能包本身写出这个文件，`syncPackRoot(root, { kind: 'archive', name, bytes, limits })` 把它装上。

发放包是一个名字以 `*.dshpack` 结尾的 ZIP。它根部放着 `pack-delivery.json`，每个技能包文件放在 `packs/<pack>/` 下面，而读这个包靠的就是这份清单。

```json
{
  "format": 1,
  "set": { "id": "space-console", "version": "2026.9.19" },
  "files": [
    { "path": "space-data-page/SKILL.md", "sha256": "e3b0c442…" },
    { "path": "space-data-page/views/space-layer.yml", "sha256": "9f86d081…" }
  ]
}
```

这些全部在第一个字节落到暂存目录之前就核对完；任何一项对不上的发放包一个技能包也装不进去。每一次拒绝都是一个 `PackInstallError`，点名它说的那个条目。

| 拒绝 | 拒的是什么 |
|---|---|
| `archive-unreadable` | 这堆字节不是这套部署读得了的发放包 |
| `archive-format` | 清单写的格式版本这个构建不认识 |
| `archive-manifest` | 发放包里没有清单，或者清单里那个不成其为清单的字段 |
| `archive-entry` | 清单没声明的条目，或者清单声明了而发放包里没有的文件 |
| `archive-digest` | 字节和清单写的对不上的那个文件 |
| `archive-oversize` | 发放包本身、其中某个文件，或者条目数，超过了它被读时的上限 |
| `duplicate-entry` | 被发放了两遍的技能包、技能包内路径，或者条目名；[折成同一个名字](#replacing-a-pack-root)的两个技能包名、或者一个技能包里的两个路径，算同一个，一个技能包里既当文件、又当另一个路径的目录用的路径也算 |

技能包规则对发放包的要求和对目录一模一样：`code-file`、`path-escape`、`symlink` 和 `not-a-pack` 按同样的名字拒同样的东西，一份发放自己那些技能包要过的[五项检查](#what-a-delivery-is-checked-for)也一样。

装什么由清单说了算，条目自己在容器里的元数据什么也决定不了。每个被声明的文件都按普通文件写下去，所以别的工具标成符号链接、硬链接或设备的条目，要么没被声明、按「清单没声明的条目」被拒，要么就当作一个装着那堆字节的普通文件写下去。

写出来是确定的：条目按路径排序、一个固定的修改时间、一个固定的压缩级别，所以同一批技能包在同一个身份下产出同样的字节。换了压缩器之后还能认出这套集合的，是清单里那些摘要，不是发放包自己的字节。

`set.id` 和 `set.version` 只是被带着、被记到日志里，这里不拿两个去比：降级就是一次普通的发放，装完之后这套部署手里有的就是这个发放包带来的东西。

<a id="the-directory-a-delivery-arrives-in"></a>
### 发放包落进来的那个目录

配了 `deliveries` 的部署，靠别人往里拷一个发放包来完成安装。

```yaml
- name: '@deepseek-ai/dsh-experimental-skill-pack'
  config:
    root: /var/lib/dsh/packs
    platformVersion: 0.5.2
    deliveries:
      directory: /var/lib/dsh/pack-deliveries
```

这个目录说的就是这份发放。恰好一个 `.dshpack` 文件，就是这套部署手里的那套集合；一个也没有，就是还没人给这套部署发过东西，技能包根目录原样不动；超过一个则直接拒绝而不去裁决，否则一套部署手里到底是哪个发放包，就取决于目录恰好按什么顺序列出来。名字不以 `.dshpack` 结尾的、以 `.` 开头的，以及目录，都不是发放包，所以拷贝工具的临时文件和运维自己的说明可以就放在旁边。

这里不往那个目录里写任何东西。目录属于往里拷东西的人，所以一套部署绝不消费、改名或删掉别人交给它的那个文件，也不需要那个卷上的写权限。换一份发放就是把旧文件删掉、把新文件拷进来；安装是幂等的，所以这两步无论谁先谁后，最后落到的根目录都一样。

监视装好的那一刻读一次这个目录，此后每来一个事件再读一次，而一个文件要等它不再变大才会被读。万一还是读到了拷了一半的发放包，它会因为本来就对不上的那个摘要被拒，等拷完再装上。

`GET /skill-pack/status` 带 `lastDelivery`，写的是最近一次读到发放包的那次读取做了什么：

| 字段 | 值 |
|---|---|
| `result` | `installed`：技能包根目录现在放着这套集合，这次读取之前没有。`unchanged`：根目录本来就放着它的每个技能包、每条路径、每个字节，这次什么都没写。`refused`：因为别的原因什么都没写。 |
| `archives` | 这次读取时目录里的每个发放包，按名字排序。只有因为放了不止一个而被拒时才多于一个。 |
| `set` | 发放包清单里写的 `id` 和 `version`，发放包和自己的清单核对通过以后才有。在那之前被拒的——发放包超过大小、和清单对不上、目录里不止一个——没有这一项。 |
| `reason` | 只在 `refused` 时有：进程日志里记这次拒绝的那一行，点名发放包和拒绝它的规则。行里的路径以技能包根目录、技能包根目录上面除文件系统根目录以外的某一层目录，或发放目录开头的（按配置的路径或真实路径），开头这一段写成 `<pack root>`、`<pack root>/..`、`<pack root>/../..`（依次往上），或 `<delivery directory>`，分隔符用主机自己的。进程日志里仍是完整路径。 |
| `at` | 这次读取结束的时间，ISO 8601 格式，UTC。 |

读到目录里没有发放包时，记录不变。读到的发放包和记录里已安装或未变化的那个同名、同集合，而结果是 `unchanged` 时，记录也不变：目录里每来一个事件都会再读一次，在发放包旁边写一个说明文件也算，否则安装之后的下一次读取会把这次安装报成未变化。其他读取都替换记录。记录只在内存里：启动以后到第一次读到发放包之前没有它，没配发放目录时也没有它。

没有上传路由，而这不是漏掉的。`dsh` 自己没有鉴权，前面隔着一层反向代理，它的 15 个特权方法在那层答 403；一条收发放包的路由，等于往这套部署装技能包的那个目录里开一个不鉴权的写入口。发放目录不新增任何权限：宿主本来就允许谁写这个目录，谁就决定这套部署交出什么。

装上或退役一个技能包，改的是这套部署**交出**什么，绝不是一个用户被**允许**做什么。这个包把技能包根目录和组织集交给整个进程；哪位成员拿到组织技能的哪一版，由组织插件在交出集合之前决定。用户能不能借技能包的页面动手，是客户自己的后端和它前面那张审批卡说了算。

<a id="organization-packs"></a>
## 组织技能包

配置了 `organizationRoot` 的行提供 `ctx.skillPackIntake`。组织插件负责校验一个组织签发的技能，把其中的技能包交过来；这一行安装它们，按根目录里技能包所守的规则逐个判断，并把激活条目的视图交给组件表面。组织插件仍是这些技能唯一的技能提供方：这里不把它们报给 `ctx.skills`，组织插件问 `isActive` 哪些版本可以报。

| 方法 | 回答 |
|---|---|
| `replace(packs, { signal })` | 用通过判断的条目替换组织包根，并答出哪些被拒。 |
| `isActive(name, version)` | 同步回答：已提供的组织集里有没有这一条，以及它的部件、插件、平台区间、锚点格式和视图此刻是否都满足。 |
| `onChange(listener)` | 一份集合被提供或撤下、或者已注册的部件变化之后，调用 listener；只在调用方 fiber 存活期间有效。 |

部署在自己的 overlay 里写这两行，连同这两个字段。overlay 写一行的 `config` 会整块替换，所以 `organizationRoot` 和 `perMember` 跟 `root` 写在同一个条目里，而不是单独一层。

```yaml
- name: '@deepseek-ai/dsh-experimental-skill-pack'
  config:
    root: /var/lib/dsh/packs
    platformVersion: 0.5.2
    organizationRoot: /var/lib/dsh/skill-pack-org/packs
    perMember: true
- name: '@deepseek-ai/dsh-experimental-skill-pack-components'
```

只有 `replace` 写组织包根，所以不监视它。

<a id="what-the-organization-plugin-hands-over"></a>
### 组织插件交来什么

一个条目已验签的 `SKILL.md` frontmatter `metadata` 里有 `pack`、`requires` 或 `views`，或者它的组织清单条目带 `requires` 或 `anchorFormat` 时，组织插件把它交给接收接缝。交进来的每个条目都写有 `metadata.pack.version`，否则被拒成 `pack-invalid`。

| `OrgPackInput` 字段 | 含义 |
|---|---|
| `name` | 技能名；条目 `SKILL.md` frontmatter 的 `name` 必须与它相同。 |
| `version` | 组织清单条目的 `version`，它作这个条目的键，并把目录命名为 `<name>@<version>`，所以同一技能的 stable 版和 trial 版可以并排放着。它必须在 Linux、macOS 和 Windows 上都能作一个目录名：不含 `/`、`\`、`:`、`*`、`?`、`"`、`<`、`>`、`\|` 和 U+0000 到 U+001F 的控制字符，不以 `.` 或空格结尾，也不是 Windows 的设备名——`CON`、`PRN`、`AUX`、`NUL`、`COM0` 到 `COM9`、`LPT0` 到 `LPT9`，以及 `COM` 或 `LPT` 后接上标 `¹`、`²`、`³`——不论大小写、带不带扩展名。它不含孤立的 UTF-16 代理项，`<name>@<version>` 还要守[技能包名的规则](#replacing-a-pack-root)，按这条规则最多 255 个 UTF-8 字节。违反这些的版本被拒成 `pack-invalid`，集合里其余的照样写下。它不必等于 `metadata.pack.version`，后者只用于显示和追溯，这里不比对两者。组织契约到 0.4.0 为止没有规定版本号格式；计划中的 0.5.0 规定版本号只用 ASCII，格式为 `^[A-Za-z0-9](?:[A-Za-z0-9._+-]{0,62}[A-Za-z0-9])?$`，同一技能名下忽略大小写唯一，其余的版本号在组织发布时就被拒收。这个格式允许 `CON` 这样的 Windows 设备名，这条规则照样拒它。它只管版本号：条目里的路径不受这个格式约束，可以含中文，由技能包规则判断。 |
| `channel` | `stable` 或 `trial`，显示在状态路由上；这里不按它选版本。 |
| `files` | 技能目录里的全部文件，路径相对这个目录，用 `/` 分隔。内容可以是字节，也可以是按 UTF-8 写入的字符串；组织插件交的是它按组织摘要核对过的原始字节。判断的字节就是写下的字节，字节顺序标记也在内，所以一个条目在内存里的判断，和同一份文件从盘上读出来时完全一样。 |

组织包根是这个包内部的布局，不进入任何模型可见的路径。组织插件把这些技能的 `resourceBase` 指向它自己的技能缓存 `orgSkillsCacheRoot`，而不是组织包根，所以目录名里的版本号永远不会进 `<skill_resources>`。

组织插件在另一个仓库编译，用它自己的结构类型读这个接收接缝，走 `ctx.get('skillPackIntake')` 或者 `inject` 它。它不再声明一次 `Context.skillPackIntake`：同一个属性两份类型不同的声明，会让同时含有两者的程序类型检查失败。

<a id="how-a-set-is-judged"></a>
### 一份集合怎么判

每个条目单独判断。违反一条规则的条目被拒，不写盘；通过的条目一起暂存、一起换入，所以组织包根要么全部装上，要么保持原样。等插件、等部件、等平台版本的条目照样安装，保持未激活，等那样东西到了就激活，不用重启。

| `IntakeRefusalCode` | 拒的是什么 |
|---|---|
| `pack-invalid` | 文件、路径、扩展名、frontmatter、清单或视图文件违反技能包规则，[折成同一个名字](#replacing-a-pack-root)的两个路径、既当文件又当另一个路径的目录用的路径、以及含孤立 UTF-16 代理项或超过 255 个 UTF-8 字节的路径段或 `<name>@<version>` 也在其中；frontmatter 的 `name` 不是这个条目的；版本不能作一个目录名。文件系统因别的原因拒收的名字，比如含 APFS 拒收的码位的名字，或者长过 `PATH_MAX` 的路径，不在这里拒：写它会失败，于是这次 `replace` 整体答 `failed`，组织包根和已在提供的集合都保持原样 |
| `anchor-format` | 写了这套构建读不了的锚点格式的条目 |
| `view-format` | 用这套构建读不了的视图格式声明视图、或者没写视图格式的条目 |
| `view-refused` | 其他要求都满足、而组合好的组件表面拒绝画它的某个视图的条目 |
| `view-id-conflict` | 声明了一个视图 id、而集合里另一个条目用字节不同的文件声明了同一个 id 的条目 |
| `duplicate` | 集合里出现不止一次的 `name@version` 的每一次出现，[折成同一个名字](#replacing-a-pack-root)的两个算同一个：只差大小写的两个在 macOS 和 Windows 上是同一个目录，只差 Unicode 规范化形式的两个在 macOS 上是同一个目录，两种在每个平台上都被拒，好让一条规则在哪里写盘都成立；这种折叠比哪个文件系统自己的都宽，所以也会拒掉少数文件系统分得开的对，比如 `ı` 和 `I`；没有办法判断哪一份是想要的 |

拒收码会随技能包规则增加，所以消费方遇到不认识的码时显示一句通用文案。每条拒收还带 `detail`，一句给运维看的英文，点出被拒的值；它进诊断日志，不进界面，也不进模型请求。

集合里用字节相同的文件声明的同一个视图 id 是一个视图，只在 `name@version` 排序最前的那个条目下列一次。字节不同时，结果不取决于条目的顺序：已经被持有的 id，保留它持有的字节，用别的字节声明它的每个条目都被拒；没有被持有的 id，声明它的每个条目都被拒。有组织集在提供时，持有 id 的就是这份集合。没有时——进程刚启动，或者交出上一份集合的 fiber 已经停下——持有 id 的是上一次写盘留在组织包根里的条目，按读技能包根目录的读法读出。只有条目通过了这些规则的 `replace` 才写这个根目录。一个调用写盘途中，它的调用方或这一行停下了，根目录里就留下一份从未提供过的集合；没有组织集在提供时，之后的调用按这份集合判断。新集合里只有一种内容的 id，会接过原来被持有的那个，所以新的 stable 版能换掉集合里已不再点名的旧版。部署自己配置占下的 id 被拒成 `view-refused`，和根目录里的技能包一样。

<a id="how-long-a-set-is-offered"></a>
### 一份集合提供多久

`replace` 答 `{ kind: 'ok', refused }` 或 `{ kind: 'failed', detail }`，没有别的种类。答 `ok` 时，`isActive` 已经按新集合回答，每个 `onChange` listener 都已在集合被提供之后调用过。调用按到达顺序一个一个执行，最后一个被提供的集合就是提供着的集合。

集合由调用方 fiber 持有——调用方读 `skillPackIntake` 时所在 context 的 fiber，`inject` 回调自己的 fiber 也算——只要那个 fiber 在加载中或已加载。它一停下，比如组织插件被停用、热重载或出错，或者这一行撤走，集合就被撤下：视图离开侧栏，条目离开状态路由，文件留在盘上。由组织插件自己决定的撤下，比如清单过期、成员登出，是 `replace([])`：它撤下集合并清空组织包根。进程启动以后，第一次 `replace` 之前什么都不提供；组织包根已经逐字节放着的集合，不再写一遍就被提供。

为视图 id 读组织包根失败、写盘失败、这一行在轮到这次调用之前已经停下或在写盘期间停下，或者调用方 fiber 在轮到它时、判断完条目时、写完盘时已经不活跃，这次调用都答 `failed`，不提供新东西。这一行或调用方 fiber 在写盘期间停下时，组织包根已经放着新集合，下一次交来同样文件的调用不写盘。调用之前或排队期间被中止的 `signal`，以它的 `reason` 拒绝这次调用，什么都不改；开始写盘以后，这次调用不再读它。

<a id="model-experience"></a>
## 模型体验

间接，经由 `dsh-tool-skill`：一个激活的技能包以普通技能的身份出现在合并技能目录里，加载它拿回它的 `SKILL.md` 正文。未激活的技能包对任何目录和任何结果都不贡献，所以模型永远不会被告知有一个它根本用不了的技能存在。组织接收接缝不新增任何模型可见的输入。一个组织条目只经组织插件为它报告的目录条目到达模型，它的视图和根目录里技能包的视图一样，经 `activeViews()` 到达侧栏。`metadata.pack.anchorFormat` 带在候选条目的 `metadata` 里，`dsh-tool-skill` 不渲染它。

#### KV 缓存影响

技能注册表的消费者拥有那条持久目录消息以及它只追加的替换件。技能包状态一变就让那份目录失效，于是消费者追加一条替换件，而不是重写前缀。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与暂缓事项

- **缺插件只报告，绝不安装。** 一个需要某组件插件而这套部署没有的技能包，会一直未激活到有人把它装上为止。这里没有任何代码去取或挂一个插件：一条从技能包数据跑起来的安装路，正是技能包规则要堵死的那条装代码的路。重新考虑的触发条件，是发放侧能把插件和技能包打成一个包一起发。
- **一套部署一个技能包根目录、一份组织集。** `root` 是单个目录，`syncPackRoot` 把它整个替换，组织集交给整个进程，所以每位成员看到的根目录技能包和组织视图都一样。哪位成员拿到哪个组织技能由组织插件决定；这个包没有成员名单，不按成员过滤任何东西。
- **trial 版的视图对整个进程可见，它的文件每位成员的 agent 都读得到。** trial 条目的视图进入每位成员的侧栏共用的那份视图索引，而成员的 agent 读资源所走的组织插件技能缓存里也放着 trial 版。这一点已接受：试装管的是推出范围，不是保密，而且成员都属于同一个客户组织。重新考虑的触发条件是 `ctx.componentViews` 支持按成员提供视图。
- **从启动到第一次 `replace` 之间什么都不提供。** 组织集由交出它的 fiber 持有在内存里，所以重启以后，组织插件在接收接缝到达时用它缓存的集合调一次 `replace`；在这段窗口里开始的会话看不到组织的任何视图。
- **组织包根不被监视。** 提供的是 `replace` 在内存里判断过的那份集合；手工改组织包根里的文件不改变提供的任何东西，下一次写盘的 `replace` 会把它改回来。没有组织集在提供时，下一次 `replace` 拿组织包根盘上现有的条目来判断视图 id，所以在那里手工改动会改变这次判断。
- **读不了的发放目录或技能包根目录按空目录处理。** 读发放目录找发放包、读技能包根目录找技能包时，任何失败都当作空目录，而不只是目录不存在，并且什么都不报告。所以拷进一个这套部署读不了的发放目录里的发放包不会被安装，也没有哪一行点名它；读不了的技能包根目录交不出任何技能包，`statuses()` 里也没有它的任何技能包。监视器自己也监视不了那个目录时，会写一行 `delivery watch failed` 或 `pack root watch failed`，点名的是目录，不是发放包。安装时读技能包根目录的方式不同，见[整体替换技能包根目录](#replacing-a-pack-root)。
- **发放包只能靠拷进来，没有别的路。** 没有路由、没有命令、也不去拉取：把发放包放进那个目录的，是这套部署之外的某个人或某个流程。重新考虑的触发条件，是发放控制台有了一个可鉴权的身份，到那时这条路由就鉴权在别的特权方法本来就鉴权的那个地方。
- **一个发放包是整个读进内存的。** 把这件事框住的是 `maxArchiveBytes`，比它大的集合会是一次响亮的拒绝，而不是一次慢慢来的安装。没有流式安装，也没有断点续传。
- **发放包里条目自己的元数据从来不读。** 链接、硬链接或设备条目装不成它本身——每个被声明的文件都按普通文件写下去——但点名它的那次拒绝是 `archive-entry`，说的是「清单没声明的条目」，而不是一句说清它自称是什么的话。
- **同一批技能包在这个包的同一个构建下产出同样的字节。** 条目顺序、修改时间和压缩级别都固定在这里；压缩器是 `fflate`，版本由 lockfile 钉住。跨版本认出一套集合靠的是它清单里的那些摘要。
- **根目录里的两个技能包可能占同一个技能名。** 两个都会被 `statuses()` 报出来，而技能注册表按它自己的 rank 与顺序规则悄悄解决这个重名。既没有拒绝，也没有哪份报告点名被盖掉的那个技能包。组织条目由组织插件报给注册表，它每个技能名只报一版；组织技能与根目录里的技能包同名时，同样由注册表按它的规则解决。
- **技能包的视图由提供部件的那一方来判，没人提供时就不判。** 没有 `ctx.skillPackParts` 的提供方时，解析通过的视图会被原样带过去，因为反正谁也画不出来；这时技能包会带着没有任何表面看过的视图被交出去，一份发放也只凭那些结构检查就装进去了。这与部件表所处的 fail-closed 位置相同，只是再往前一步。
- **一个技能包把同一个视图 id 声明两次时，留下的是排在前面那个。** 整根目录那条规则说的是两个技能包。在一个技能包内部，顺序就是这个技能包作者自己写的那张 `views` 表，于是第二个会在任何第二次占用一个 id 的地方被丢掉——由 `ctx.componentViews` 丢掉，并写一行点了这个来源两次的 error。
- **根目录里已经放着的那份发放靠什么都不做来安装，也就什么都不检查。** `syncPackRoot` 先对一遍，所以一套逐字节对上根目录的集合会答「没变」，既不读清单也不读视图。因此一个放着这套构建会拒的技能包的根目录，会一直留着它，直到另一套集合到来。状态路由把这样的读取写成 `unchanged`，进程日志里没有对应的行。
- **只报最近一次发放，而且只报本次启动以来的。** `lastDelivery` 只在内存里，只留一次读取。重启会清空它；监视装好时的那次读取会记下目录里还放着的发放包，根目录已经放着它的集合时记为 `unchanged`。更早的发放只在进程日志里。
- **发放控制台没法预先检查一套部署会怎么看它的视图。** `buildPackArchive` 只按技能包文件的规矩收一套集合，一份也不读；清单、视图格式和每份视图文件都在画它们的那个表面所在的地方判。要重新考虑这件事的触发条件，是一个自己也组合了一份目录的发放控制台。
- **把这个包和 point-anchor 绑在一起的测试，在 vendor 它的那个包里。** [`dsh-experimental-content-point`](../content-point/README.zh.md) 的 `tests/equivalence.spec.ts` 让 `PACK_ANCHOR_FORMATS` 与 point-anchor 的 `ANCHOR_FORMATS_READ` 相同、按 point-anchor 写的元数据路径读出，并把 point-anchor 写出的发放包完整读回，包括 255 字节边缘的名字；这里的改动破坏其中任何一项，失败的是那个包的测试，不是这个包自己的。
- **每次读都重新读根目录。** `statuses()`、`activeViews()` 以及每次提供方调用都会扫一遍技能包根目录、重新解析每份清单。这让答案始终跟得上现状、没有会过期的缓存，也正因如此这条状态路由不适合按交互频率轮询。
- **没挂部件提供方的技能包根目录交不出任何带视图的技能包。** 在有人挂上 `ctx.skillPackParts` 的提供方之前，每个点名了部件的技能包都是未激活。这是正确的 fail-closed 状态，也是很容易被当成 bug 的一种状态——状态路由就是为它存在的。部署方组合的那个提供方是 [`skill-pack-components`](../skill-pack-components/README.zh.md)。
- **没有被组装快照覆盖** —— 这个包由它自己的用例覆盖，其中包括一次跑在真实技能包根目录上的真实 Loader 组合；快照泳道重放的是发行组合，而那里不组合任何 experimental 行。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

`examples/space-data-page` 目录是一个按发放方会发的样子做出来的技能包。它的 `SKILL.md` 正文是占位：技能包的正文由拥有这个技能包的人来写，不由这个包来写。

</details>
