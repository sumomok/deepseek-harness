# Agent Note: skill-pack 行经一个接收接缝安装并判断组织的技能包

Status: implemented

[English](2026-10-05-skill-pack-organization-intake.md) | 中文

## Problem

组织插件在本仓库之外，它把一个组织签发的技能送到控制台，也是这些技能的技能提供方：它决定每位成员拿到每个技能的哪一版——stable 版还是某个 trial 版——把那一版报给 `ctx.skills`，并统计它的使用。其中一些技能是技能包。它们的视图摆放组件部件，它们点名插件和平台区间，带元素锚点导出的技能包还写明自己的锚点文件是哪种格式。这样的技能只能在它的部件已注册、视图画得出、锚点格式读得懂的地方提供，而这些答案全都在本仓库里：组件目录、视图判断和技能包规则属于 skill-pack 行和它旁边的组件表面。组织插件问不到它们，也不能把技能包交给技能包根目录：`syncPackRoot` 整个替换一个技能包根目录，于是发放和组织会互相抹掉对方的技能包，而且技能包根目录的提供方会把这些技能再报一遍。另外，严格的清单拒收 `metadata.pack.anchorFormat`，所以锚点导出端写出的每个技能包都被扣成 `manifest-invalid`。

## Decision

**配置了 `organizationRoot` 时，skill-pack 行提供 `ctx.skillPackIntake`。** `replace(packs, { signal })` 安装一个组织的技能包，`isActive(name, version)` 同步回答一个条目此刻能不能提供，`onChange(listener)` 报告这个回答的变化。组织插件仍是这些技能唯一的技能提供方，它问 `isActive` 哪些版本可以报；这一行安装、判断它们，并把激活条目的视图交给 `ctx.skillPacks.activeViews()`，[`skill-pack-components`](../../../../packages/experimental/skill-pack-components/README.zh.md) 再像摆放根目录里的技能包那样摆放它们。没有 `organizationRoot` 就不提供这个键，组织插件也就不提供这些技能。

**组织包根是一个单独的目录，里面的东西都不报给 `ctx.skills`。** 每个条目装在 `<organizationRoot>/<name>@<version>` 下，`version` 是组织清单条目的版本，所以同一技能的 stable 版和 trial 版可以并排放着；它不和只用于显示和追溯的 `metadata.pack.version` 比对。这个根目录是这个包内部的布局，不进入任何模型可见的路径：组织插件把每个技能的 `resourceBase` 指向它自己的技能缓存。`organizationRoot` 是相对路径，或者与 `root`、`deliveries.directory` 在任一方向上重叠时，加载即被拒绝，因为替换其中一个会把另一个的内容一起替换掉。只有 `replace` 写它，所以不监视它。

**逐条判断，一起写盘。** 每个条目从内存里的文件经 `observePack` 读出——这正是读技能包根目录的那个读法，它和 `readFile(path, 'utf8')` 一样保留字节顺序标记——再按技能包规则、frontmatter 名字、能作目录名的版本、清单、锚点格式与视图格式、读得出的视图以及组合好的表面对视图的判断逐项检查。违反其中一项的条目被拒，带一个来自开放列表 `IntakeRefusalCode` 的码和一句给运维看的英文 `detail`；重复出现的 `name@version` 每一次出现都被拒，因为没有办法判断哪一份是想要的。通过的条目一起交给 `syncPackRoot`，所以根目录要么全装上要么一个不装，盘上已经逐字节一致的集合不再写一遍。`replace([])` 撤下集合并清空根目录。`IntakeResult` 是封闭的：带拒收列表的 `ok`，或者 `failed`。

**已提供的集合由调用方 fiber 持有。** Cordis 交给每个服务读取方的是绑在它读取时所在 context 上的代理，Service 的方法把那个 context 看作 `this.ctx`，所以调用方读取接收接缝时所在 context 的 fiber——`inject` 回调自己的 fiber 也算——在加载中或已加载期间持有这份集合。那个 fiber 一停下，集合就撤下，文件留着；之后同样文件的 `replace` 不写盘。写盘之前停下的调用方答 `failed`，写盘期间停下的也答 `failed`，此时根目录已经放着这份集合。调用按到达顺序执行；一次调用答 `ok` 时，`isActive` 已经按新集合回答，每个 `onChange` listener 都已在它之后调用过。从启动到第一次 `replace` 之间什么都不提供。

**组织技能包对技能包根目录保有视图 id。** 激活的组织条目声明的视图 id，会扣下根目录里声明它的技能包，`view-id-conflict` 以 `origin: 'organization'` 点出那个组织技能包；[reconciler 那篇 Note](2026-09-18-skill-pack-reconciler.zh.md) 里「两个根目录技能包占一个 id 就都扣下」的规则，现在只在技能包根目录内部成立。在组织集内部，用字节相同的文件声明的同一个视图 id 是一个视图；字节不同时，已经被持有的 id 保留它的字节，改了它的每个条目都被拒，没有被持有的 id 则拒收声明它的每个条目。两条规则都不看条目的顺序。有组织集在提供时，持有这些 id 的是它；没有时——进程刚启动，或者持有上一份集合的 fiber 已经停下——持有它们的是组织包根盘上现有的条目。只有条目通过了这些规则的 `replace` 才写这个根目录，所以重载或重启之后再交来同一份集合，判断结果和之前一样。

**一个构建读得懂的锚点格式是常量。** 清单把 `metadata.pack.anchorFormat` 读成可选整数。`PACK_ANCHOR_FORMATS` 是 `[1]`，也就是 point-anchor 的 `ANCHOR_FORMATS_READ` 所列的；写了别的号的技能包被扣下，原因 `anchor-format`，在发放里则被拒成 `pack-anchor-format`。这张表只增不改：删掉一个号，对写了这个号的每个技能包都是破坏性变更，需要单独决定并写升级指南。这条要求不延后，因为之后到来的任何东西都改变不了一个构建读得懂哪些格式。

**状态路由列出组织集，并按成员作答。** 每条 `PackStatus` 带 `origin`；组织条目还带 `entryVersion` 和 `channel`，`version` 仍是 `metadata.pack.version`。不公布试装标识。开了 `perMember` 时，路由只答 `ctx.consoleMembers` 认得出成员的请求——没有这个服务答 503，认不出是谁答 401——认得出的每位成员读到同一份文档。

## 这道决策闸

| 关 | 答 |
|---|---|
| 0. 哪条已定原则已经决定了这件事？ | **插件，而不是改循环**：全部改动都在这个 experimental 行里，不动任何核心包。**模型可见 ⟺ 有日志**：这一侧不新增模型可见的输入，因为组织技能只经组织插件报告的目录条目到达模型，`anchorFormat` 带在候选条目的 `metadata` 里，没有工具渲染它。**注册即 effect**：集合经调用方 fiber 上的一个 effect 持有。**显式优于隐式**：组织包根没有默认值，没有就没有接收接缝。**配置错误要响亮地失败**：重叠的组织包根在加载时被拒。**插件里不写死可调项**：读得懂的锚点格式是构建的协议常量，不是部署之间的选择。**跨边界的不透明 id 要加 brand**：`name` 是技能注册表的普通 `string`，`version` 是清单原文，组织插件又按自己的结构类型编译，两边没有能共享的 brand。 |
| 1. 新增多少个永久面？（先数，再列） | **13 个。** 服务键 `ctx.skillPackIntake` 及其三个方法；Config `organizationRoot` 与 `perMember`；盘上布局 `<organizationRoot>/<name>@<version>`；清单键 `metadata.pack.anchorFormat`；常量 `PACK_ANCHOR_FORMATS`；`PackMissing` 的成员 `anchor-format`；`view-id-conflict` 上的 `origin`；拒收 `pack-anchor-format`；`PackStatus` 上的 `origin`、`entryVersion` 与 `channel`；`perMember` 下状态路由的 401 与 503；依赖边 skill-pack → console-members；导出类型 `OrgPackInput`、`IntakeResult`、`IntakeRefusal` 与 `IntakeRefusalCode`。不新增工具、会话事件、路由和审批闸。 |
| 2. 能证明它对的最小版本 | 再开一个根目录，用读技能包根目录的那些代码来读——`validatePacks`、`observePack`、`parsePackManifest`、`parsePackView`、单包判断和 `syncPackRoot`——逐条判断、整份写盘。它满足控制台的要求：带视图、`requires` 或锚点格式的组织技能包画得出来才提供，部件注册后不用重启就出现，锚点格式读不了就一直扣着，视图 id 冲突就被拒。 |
| 3. 缝还是写死？ | **一个服务键**，因为有两样东西会变：组织插件在另一个仓库构建和发版，北冥和官方客户端不组合 skill-pack 行，那里就没有这个键；技能包的部件晚于技能包到达。**读得懂的锚点格式写死**：今天写锚点文件的只有 point-anchor 一家。 |
| 4. 边界 | 见下。 |

### 边界

| 方向 | 那条线 | 它防的具名失败 | 期限 |
|---|---|---|---|
| 邻居 | 同名优先级、保留名、按成员选 trial 版和 `skill.usage` 都留在组织插件里；这个包不把任何组织技能包报给 `ctx.skills`。 | 一个技能在注册表里出现两次，两个 rank 争一个名字。 | 永久 |
| 契约 | 逐条判断、整份写盘；`isActive` 同步，并且按调用那一刻作答；集合只在最后一个调用方 fiber 活跃期间提供；拒收码会增加。 | 组织插件已被停用，它的视图还挂在侧栏里。 | 永久（pre-stable） |
| 诱惑 | 这里不按成员过滤，它没有试装名单；不开上传路由；从不读锚点文件。 | 这个包接手组织插件的选择，以及一条不鉴权的写入口。 | 按成员过滤 暂缓 — 触发条件：`ctx.componentViews` 支持按成员提供视图。 |
| 红线 | 组织包根绝不等于、也不和 `root` 或 `deliveries.directory` 重叠。 | `syncPackRoot` 整个替换 `root` 时把组织包根一起删掉。 | 永久 |
| 天花板 | 除组织契约的上限外不另设字节上限；组织包根不监视；trial 版的视图对整个进程可见。 | — | 暂缓 — 触发条件：契约上限变化，或要求按成员提供视图。 |
| 假设 | 组织插件只交它按组织签名和摘要核对过的文件；`PACK_ANCHOR_FORMATS` 等于 vendor 进来的 point-anchor 的 `ANCHOR_FORMATS_READ`。 | 一个这里读不懂的锚点格式被激活。 | 第二条 暂缓 — 触发条件：point-anchor 被 vendor 进控制台组合，等价测试随它一起来。 |

## Testing

`packages/experimental/skill-pack/tests/intake.spec.ts` 经 vendor 进来的 Loader 启动技能注册表和这一行，由一个替身组织插件从它自己的 `inject` fiber 读取接收接缝。它钉住：没有 `organizationRoot` 时不提供这个键；重叠根目录在加载时被拒；stable 版与 trial 版并排；不报给 `ctx.skills`；部件到达时不用重启就激活，且监听者看得到；resolve 时的 `isActive` 与集合提供之后才调用的 listener；字节与文本按交来的样子写下；字节顺序标记的判断与盘上一致；`replace([])`；每个拒收码；集合内部和对根目录的视图 id 规则；持有集合的 fiber 重载前后、重启前后，同一份集合按盘上的条目得到同样的判断，其中不是技能包的目录和读不出的视图不持有 id；读组织包根失败、写盘失败、调用前、排队中和判断中的中止；到达顺序；调用方在轮到之前、判断期间和写盘期间停下；重启后不提供、未变的集合不重写；随调用方和随这一行撤下；监听随自己的 fiber 结束。失败和闸门经一个模块 mock 拦住真实的 `syncPackRoot` 和 `readInstalledPacks`。`skill-pack.spec.ts` 覆盖状态路由上的组织条目和按成员作答；`reconcile.spec.ts`、`manifest.spec.ts` 和 `install.spec.ts` 覆盖保有 id 的规则和锚点格式；`skill-pack-components/tests/views.client.spec.ts` 跟着一个组织技能包的视图进出侧栏。还没有测试安装由 point-anchor 自己写出的发放包。

## Alternatives considered

**把组织技能包装进技能包根目录。** `syncPackRoot` 整个替换根目录，于是发放和组织会互相抹掉对方的技能包，而且技能包根目录的提供方会在组织插件自己的条目旁边把每个组织技能再报一遍。

**让这一行成为组织技能的第二个提供方。** 组织插件按成员选版本、给同名技能排位；第二个提供方会把同一个技能列两次，把那个选择再做一遍。

**启动时提供从盘上读出的集合。** 组织插件被停用、热重载或出错之后，集合还会继续提供，它的视图会背后什么都没有地挂在侧栏里。把集合挂在调用方 fiber 上，它就随插件撤下，而未变的集合在下一次 `replace` 时不用重写。

**拿技能包根目录的判断去判整份集合。** 它按技能名索引激活的技能包，同一技能的 stable 版和 trial 版会互相覆盖，它的冲突 id 规则也把一个名字当作一个占用方。

**两个条目占一个视图 id 时拒收后来的那一个。** 结果会取决于组织插件列条目的顺序。保留已被持有的那份、没有谁持有这个 id 时拒收所有占用方，就不取决于顺序。

**只拿已提供的集合判断视图 id。** 重载或重启之后什么都没在提供，于是 trial 版改了 stable 版持有的视图时，两个版本都会被拒，stable 版也会从组织包根里删掉，尽管同一份集合片刻之前还保留着 stable 版。盘上的条目就是上一次写盘判断过的那份集合，读它们得到同样的答案。

**组织技能包和根目录技能包占一个 id 时两个都扣下。** 同一份导出走两个出口送到时，部署选定的那一版也会被扣下。组织集就是那个选择，所以它保有这个 id。

**把读得懂的锚点格式做成 Config 字段。** 那样一个部署就能声称读得懂它的构建读不懂的格式，技能包会带着没人能正确读的锚点被提供出去。

**在这一行里按成员过滤 trial 条目。** 它没有试装名单，视图索引也没有按成员的视图；过滤归组织插件，按成员的视图要等视图索引。

## Consequences

控制台可以按对待自己技能包根目录的同样条件接收一个组织的带视图、带要求、带锚点的技能包：画不出来的不提供，等部件的不用重启就激活，状态路由说清哪个是哪个。哪位成员看到哪一版由组织插件决定，这一行只回答那一版到底能不能提供。

代价是一份由另一个插件的 fiber 持有在内存里的集合：从启动到第一次 `replace` 之间、以及组织插件热重载期间，组织的视图都不在。trial 版的视图对整个进程可见，这一点被接受，因为试装管的是推出范围而不是保密。关于视图 id 现在有两条规则并存——根目录技能包互相扣下，组织技能包胜出——状态路由带着 `origin`，读者分得清适用的是哪一条。按政策删掉一个锚点格式号是破坏性变更，所以这个常量只会增加。
