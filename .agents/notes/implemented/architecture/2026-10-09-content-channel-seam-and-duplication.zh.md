# Agent Note: the shared content channel's seam and what it costs

Status: implemented

[English](2026-10-09-content-channel-seam-and-duplication.md) | 中文

## Problem

有两个内容域会把调用送到「某个会话正在被展示的那个浏览器标签页」。`content-frame` 的页面工具读写 frame 里的页面；`component-surface` 的 `act_component` 在内容栏里已经画出来的组件条目内部跑步骤，它的 `read_component` 用同一套词汇报告那条条目此刻画着什么。两个域需要同一套装置——宿主上的等待表、认领与上报两条路由、一个为调用出价并作答的座位——但都不需要对方的词汇：工具不同、参数不同、一份报告意味着什么也不同。

客户端 bundle 还带着另一条不相关的约束。`packages/client/tsdown.client.ts` 的 `dsh-client-bundle-purity` 插件拒绝以值的方式引入不在这份 bundle 模块请求表里的包，因为这种引入要么内联出一份重复的运行时（两个 `ContentChannel` 类、两个标签页身份），要么需要一个模块表答不出的说明符。只有类型引入会被擦除，因而是允许的。所以另一个包里的域可以共享这条通道的**类型**，却共享不了它的**值**。

## Decision

**这套装置是一个 Cordis 服务，域通过加入它来使用。** 组合内容栏的那一行把 `ContentChannel` 作为 `ctx.contentChannel` 提供；一个域登记一个 `ChannelMember`——它的名字、它最宽的报告体字节数、以及读一份报告的解析器。两条路由归服务所有，在第一个 member 登记时被认领，所以一个不送任何调用的组合在这两条路径上仍是 404。等待中的调用会记下开出它的那个 member，一份投递只由那个 member 读；针对已经结算的调用的投递不再指名 member，于是每个已登记的 member 依次被问一遍，这正是单域通道当初读这种正文的方式。每个域在自己的键下发布自己的待办投影（`contentAccess`、`componentAccess`），因为这种列表里的每一种分支都是那个域自己的词汇；折叠与视图自检共用 `src/access/channel.ts` 里的实现。

**浏览器半边是同样的切分，以 `ctx.contentTabChannel` 提供。** 通道管标签页身份、隐藏标签页的宽限、出价循环、上报重试，以及被座位放弃的调用的清理；一个域用名字、就绪回答和「如何答一次被认领的调用」加入，作答时要么交出自己称过重的文档，要么交出一个 outcome，由通道把 callId 与标签页组装进去。outcome 这种形式让一个没有东西可称重的域连路由常量都不必知道。每个页面加载只有一个通道实例是重点而不是实现细节：它铸出的标签页 id 正是宿主为某个会话的调用钉住的身份，所以 `ContentFrame` 的页面座位从交给它的实例上读身份，而不是自己铸一个，页面里的每个域也是同一个读者。在这次改动之前，页面座位认领时用服务实例的身份，上报时却用一个模块级标签页 id，宿主读起来就是两个不同的标签页。

**接缝住在 `content-frame`，而后果是写清楚而不是糊过去。** 组合了 `component-surface` 却没有 `content-frame` 的部署没有任何通道，于是它的 `installComponentAccess` 注入不会触发，它的两个通道工具都根本不提供——模型看到的是工具不存在，而不是每次调用都超时的工具。两份 README 都记着这条前提。把接缝搬进它自己的包，或者搬到两个域本来就依赖的 `content-surface` 那一层，都是纯搬运，本轮推迟；这个决定的形状不依赖文件放在哪里。

**有两个纯函数继续各写一份，因为接缝无法以值的形式承载它们。** `component-surface` 的 `act-component-projection.ts` 自己折叠待办列表，`act-component-tool.ts` 用四行函数自己判定结算下来的 outcome，而 `content-frame` 也有同样的两份。以值的形式引入，对宿主半边本身是合法的——宿主 bundle 没有 purity 门——但 `content-frame` 是 peer 依赖，而 tsdown 的宿主规则（`neverBundle` 是生产依赖集合，其余一律 `alwaysBundle`）会内联非生产依赖，于是这次引入会把通道的 wire 层第二份副本装进本包的宿主产物里。客户端半边则完全做不到。接缝内部的替代方案——服务把 `foldCalls` 与 `isActOutcome` 作为方法暴露出来——被权衡过并落选：它会加宽通道的公开面，而它要暴露的其实是通道内部的 wire 词汇，不是一个域要求它做的事。两份副本都带着说明原因的注释，本条 Note 是这件事的记录。

**`act_component` 不进审批闸的只读名单，`read_component` 进。** `act_component` 驱动的是用户眼前的东西，所以 `@haoran/dsh-llm-permission-gateway` 逐次判它；`read_component` 什么都不写、读的是模型自己画出来的东西，所以它和页面五个读、`content_show` 列在一起。本仓库拥有的那份分类文件，即 `content-frame` 的 `overlay/permission-gateway.patch.yml`，同时承载这两项处置，两件 act 工具都留在外面；`component-surface` 的 `tests/act-component-gate.client.spec.ts` 把两项都钉在随附的这份文件上，正如 `content-frame` 自己的 overlay 测试把 `content_act` 挡在外面。

**一个域添第二个工具，添的是它那一个 member 的第二条分支，不是一个新域。** `read_component` 与 `act_component` 共用组件 member、`componentAccess` 待办列表和座位：列表的分支带着工具名和它自己的参数，member 的解析器两种工具的正文都接（两份读取各以判别字段拒绝对方的文档），浏览器域按被交来的是哪一个工具作答。线上真正新增的是读取那条分支 `status: 'read'`，声明在 `content-frame` 的 `access/wire.ts`，和页面文档并列——那个模块是所有跨这两条路由的报告的家，页面 member 会像拒绝一份步骤报告那样拒绝它。读取本身经由步骤执行器同一条寻址解析产出（为此抽出的 `component-surface` 的 `client/targets.ts`），因为一份按自己规则找控件的读取，就是一套会与动手所用寻址漂移的词汇；两份调用词汇共用 `act-component-call.ts` 里的日志形状读取器，出于同样的理由。

## Alternatives considered

**现在就把接缝搬进一个中立的包。** 这是最干净的终局：两条内容行都不拥有两者共用的装置。它落选的原因是代价与次序，而不是形状——这次搬迁要重新安置两个约 300 行的模块及其测试，而接缝拥有的每一条事实都得在一个新包自己的组合测试下重新立起来，第二个域才能被信任。上面的决定是刻意写成让这次搬迁机械化的：member、domain 和两条路由路径就是全部接口。

**把通道挂到 `content-surface`，也就是两行本来就依赖的那一层。** `content-surface` 是宿主侧的条目流；它没有客户端面，也没有 `./client` 导出，所以浏览器半边得先长出一个，而且每个组合了路由器却没有内容栏的部署都会开始背着这条通道。可行，更大，而且并不明显优于一个自己的包。

**把共享的纯函数作为服务方法暴露出来。** `ctx.contentChannel.foldPending(opened, settled)` 能在不新增任何包的情况下消掉重复，登记投影单元时服务本来就在手上。它落选的原因是：它为一个调用者就把通道的 wire 词汇变成 API 的一部分；而且浏览器半边的测试自己那份 `isActOutcome`（客户端 bundle 永远拿不到别的插件的值）无论如何都还是两份，于是接缝为一半的重复而变宽。

**两个域共用一份待办投影。** 那样列表的分支会变成两个域工具名与参数的联合，浏览器座位还得再窄化回来。它用一份通用的分支替换两份小而独立的折叠，而每一个内容工具此后都要依赖这份通用分支，这是拿页面域的行为去冒险，却换不到任何新的触达。

## Consequences

- 页面域的行为一字未改：遮罩、跨源、`isTrusted`、ref 表的规则，它的投影键、schema 与日志句子都和原来逐字相同；它的两份执行器测试与路由测试没有为了给接缝腾地方而改过。
- 加入通道的域免费得到出价循环、隐藏标签页宽限、上报重试和调用记忆；它要写的是「答自己的一次调用」是什么意思。
- 通道现在是标签页身份唯一存在的地方。一个页面里出现第二个实例会让同一批座位互相出价，并让上报以它认领时并未携带的身份去结算，所以每个页面加载的通道是单个实例，页面座位从它读身份。
- 通道工具是否存在是组合的函数：`act_component` 与 `read_component` 都需要 `tools`、`contentChannel` 与 `sessionProjections`，缺任何一个都不提供。这一点在模型自己的记录里是响的——请求里没有这些工具——而不是在调用时才哑掉。
- 部署里每一次内容调用如今都走由同一个服务拥有的两条路由，所以只服务一个域的组合和服务两个域的组合走同一条代码路径。按 `perMember` 的准入、同站栅栏和正文上限随路由一起搬迁，一字未改。
- 将来第三个域的成本是一个 member、一个 domain 和一个投影键，而不是又一份装置。

## Testing

`component-surface/tests/act-component-chain.client.spec.tsx` 启动真实组合——webserver、tools、sessions、projections、content-surface、带 `pageAccess` 的 content-frame、本行——把浏览器半边的 `fetch` 指向被服务出去的 origin，并把任一个工具的调用从日志事件驱动着走完投影、认领、在真实文档里干活、上报，直到模型可见的值。它还钉住那两种拒绝、步骤上限、无人认领的调用、认领后始终不上报的调用，以及页面域的座位与组件域在同一个标签页 id 下出价。`content-frame/tests/content-channel.client.spec.ts` 钉住服务这一侧：一对路由上的两个 member，以及两条路由都要读的会话查询；它的 wire 测试套件钉住页面 member 拒绝组件读取那条分支。两个包 `src` 的逐文件覆盖率都是 100%。
