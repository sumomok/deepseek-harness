# Agent Note：组件目录改成由组件插件填的注册表

Status: implemented

[English](2026-09-18-component-catalog-registry.md) | 中文

## 问题

`show_component` 从 `COMPONENT_CATALOG` 里挑组件，那是 `component-surface` 的 `component-call.ts` 里的一张静态表。那张表自己的注释已经写明了它错在哪：「不是注册式服务而是静态表，因为每一项都归同一个包所有……当一个不归本包维护的包需要贡献组件时，再把它换成注册式的缝。」这样的包已经看得见两个——`vue2-echarts-tool-poc` 之所以自带 `show_chart` 和一个 `chart` 内容种类，正是因为它没有地方可以贡献组件；按客户定制的组件库本来就是这个面存在的理由——第三个是 `component-kit`：六项的渲染器全在它那里，而准入它们的定义却住在落位它们的那个包里。

那张表还把「有哪些组件」变成了编译期事实：`CatalogId` 从它派生，浏览器座位再拿那个联合类型去钉 `component-kit` 的渲染器表。正是这一钉，逼着依赖从落位包指向组件包——与一次贡献流动的方向正好相反。

## 决定

**目录就是 `ctx.componentCatalog`，一个由 `component-surface` 持有的 Service Definition，出厂是空的。** 组件插件把一批定义连同写出它们的那个包一起注册进来；`register` 返回 disposer、走 `ctx.effect`，遇到别的包已注册过的 id 就点名两个包和两个版本后拒绝。贡献方的包名与版本在注册时从它自己的 `package.json` 里读，写在调用旁边的版本号不可能过期。服务对外给出当前目录，并发出 `component-catalog/change`。

**每个读者拿到的是一个 `ComponentCatalog` 值，而不是去读模块级全局量。** `readCatalog(entries)` 每次变化派生一次 id 索引与嵌套上限；`validate.ts`、`tool.ts`、`crud.ts`、`views.ts`、`surface.ts`、`command.ts`、`action-state.ts` 以及浏览器的 `spec.ts` 都把它当参数收。`trackCatalog(ctx, install, label)` 按目录版本重建一处注册，这正是工具描述、内容抽取器和手势折叠不会拿着一份已经变了的目录继续作答的原因。

**空的提供等于不提供。** 只有目录里存在这个组合能兑现的组件时才注册工具，所以一个组件插件都不组合的部署根本拿不到 `show_component`，而不是拿到一份组件清单为空的描述。

**浏览器有一张对应的注册表 `ctx.componentRenderers`，** 收的是同一批定义、画它们的渲染器，以及贡献那一行自己的翻译函数。这把包依赖翻了过来：`component-surface` 运行时不再引用 `component-kit` 的任何东西，而 `component-kit` 依赖 `component-surface`。渲染器的 props 契约随注册表一起搬家，因为它本来就是落位包对每个组件插件的承诺；座位在一块内容位置上画的那三句文案搬进座位自己的 `contentComponent` 词典，因为「有哪些组件」现在是座位查表的结果，而不是某一个包的表。

**`CatalogId` 改成 branded。** 已经没有封闭的 id 集合可供派生联合类型，于是适用本仓对跨边界不透明 id 的规矩：用 `dsh-brand` 的 `Branded<'ComponentCatalogId'>`，由 `catalogId(id)` 铸造。`component-call.ts` 为此放弃了「什么都不 import」这一条，只放行这一个零依赖的辅助模块。

**条目定义仍留在 `component-surface` 里，作为导出的库 `COMPONENT_KIT_ENTRIES`，由 `component-kit` 在两个半边各注册一次。** 把它们搬进 `component-kit` 才是诚实的终态，也是后续那一片：那六份定义与大约 1200 行的通知构造和 schema 常量交织在 `component-call.ts` 里，而那个模块正是两个半边和会话折叠共同读的那一份，所以这次搬家该是自带风险的另一次改动。

### 决策闸

| # | 问题 | 回答 |
|---|---|---|
| 0 | 哪条既有原则已经把它定了 | **一条能力缝由 Service Definition / Service Provider / Consumer 三个角色构成；它是完整的，从来不是单独一个角色**（`AGENTS.md`）。条目来自别的包的目录就是一个有提供方的 Service Definition，而那张静态表是一个替提供方保管数据的 Consumer。触发条件表自己的注释早就写明了。 |
| 1 | 新增长期表面的数量与清单 | **六个。** `ctx.componentCatalog`（宿主 Service Definition：`catalog`、`components`、`register`）；`component-catalog/change` 这个 Cordis 事件；`trackCatalog()`；`ctx.componentRenderers`（浏览器 Service Definition：`catalog`、`rendererFor`、`register`）；搬进 `component-surface/client` 的 `ComponentRendererProps` / `ComponentRenderer` / `ComponentRendererTable`；`contentComponent` 这个 locale 命名空间。 |
| 2 | 能证明它的最小版本 | `component-kit` 在两个半边各注册自己的六项，外加一个不组合它、因而拿不到工具的组合（`composition.client.spec.ts` 的 “offers no tool where no component plugin is composed”）。再小——只有一个包能填的注册表，或只有宿主侧的注册表——就等于让浏览器那一端继续决定有哪些组件，包依赖也继续反着走。 |
| 3 | 做缝还是写死，点名 ≥2 个近期真实变体 | **做缝。** 三个真实贡献方：`component-kit`（本次已迁移）；`vue2-echarts-tool-poc`，它之所以自带 `show_chart` 和一个 `chart` 内容种类，就是因为没有目录可以让它贡献一个 `toy.chart`——它的定义会是一项、一个动作、一个渲染器；以及按客户定制的组件库，那正是内容面存在的理由，而它们根本不可能写进本仓的某张表里。 |
| 4 | 六向边界表 | 见下 |

| 方向 | 定死的是什么 | 它拦住的那个具名失败 | 期限 |
|---|---|---|---|
| 谁可以贡献 | 任何拿得到 Cordis context 的包；没有白名单 | 一个不改本仓就没法组合进来的客户组件库 | 永久 |
| 一次贡献带什么 | 定义，加上贡献方的包名与版本，从它自己的清单里读 | 「id 重复」既不点名该删的那一行、也不点名先到的那一行；写在调用旁边的版本号在下一次发版后变成错的 | 永久 |
| id 归属 | 一个 id 一个包，先注册者得，第二个在注册时被拒 | 两个包在同一个 id 下画不同的东西，由加载顺序决定谁赢 | 永久 |
| 宿主 ⇄ 浏览器 | 两个半边收同一批定义；浏览器那份不带包身份 | 页面拿自己画不出来的组件去判定载荷；或者要求浏览器做它根本做不到的清单读取 | 永久 |
| 读者何时看到变化 | 每一处依赖目录的注册都经 `trackCatalog` 按目录版本重建，绝不实时读 | 描述、折叠或抽取器拿着「第一个调用者到达时恰好在位的那份目录」继续作答 | 永久 |
| 部署自写视图在哪里判定 | 在第一份带组件的目录上判定，失败则让「把目录补齐的那一笔贡献」失败 | 一条谁都画不出来、且哪里都没说为什么的菜单行 | 暂缓 —— 复查触发器：插件系统提供一种加载屏障，让这一行能等齐所有已组合的贡献方；届时拒绝就能落回配置写错的那一行 |

## 考虑过的其他做法

**保留静态表，让 `component-kit` 继续只做渲染器库。** 否决：这正是它自己注释里请求被替换掉的那个安排，而且它根本容不下图表插件或客户组件库。

**把注册表放进一个两行都依赖的第三个包。** 否决：那会多出一个内容只有一条 Service Definition 的包，而目录本来就是落位包的事实——它就是 `show_component` 所提供的东西。

**保留 `component-surface → component-kit`，只让宿主半边注册。** 做不到：这两个包各自只有一个 TypeScript 工程，所以无论哪个方向的贡献，叠上现有的渲染器导入都是一次工程引用环。不管由哪一半注册，客户端那条边都必须去掉。

**让 `component-kit` 持有定义并导出其 id，从而保住派生式的 `CatalogId`。** 否决：那又把联合类型钉回了单个包，而这正是要拆掉的东西；何况任何第二个贡献方在运行时照样会把它撑宽。

## 后果

`snapshots/console/cordis.yml` 现在组合了 `component-kit` 的 node 半边；不组合它时，那条泳道的 `show_component` 调用答的是 `UNKNOWN_TOOL`。固件没有变，这正是六项及其顺序在这次搬家中原样存活的证据。

一个 spec 被目录拒掉的部署自写视图，不再从本行自己的 `apply` 里让启动失败。失败的是「把目录补齐的那一笔贡献」，那笔贡献被撤回，部署起来时既没有组件、也没有视图、也没有工具。两份 README 都把它记在 Known Limitations 里，连同能让它挪回去的那个条件。

`block.unsupported` 现在只有「页面持有某个组件的定义却没有画它的渲染器」时才到得了，而注册接口不会造出这种页面；载荷点名一个未注册组件时，实际会发生的是整条条目被拒——因为座位拿的是它手上真有的那份目录，跑的是宿主那套判定。

`component-kit` 把 `component-surface` 留作 devDependency，供那几个画真渲染器的座位用例使用，这是一条只存在于开发期的环；运行时那条边是单向的。
