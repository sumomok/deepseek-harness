# Agent Note: 一栏 content，多个生产者——用 entry 流取代独占座位

Status: implemented

[English](2026-08-24-content-surface-router.md) | 中文

## Problem

服务形态外壳把 `content` 声明为 `single`、`root` 的槽：任何时刻只有一个注册占据它。而已经有两个包想要它。[`content-frame`](../../../../packages/experimental/content-frame/README.zh.md) 为一个托管应用认领了它，已退役的 `vue2-echarts-content-poc` 为一块图表面板认领了它；组合它们的那两个 overlay 在注释里明说过——「两个摆放是互斥选项」——部署方只能二选一。

「二选一」不是这一栏该有的形状。现场证据来自图表工具：一个会话画了好几张图，又重绘了其中一张，而会话记录早就懂得说出「较早那次调用被取代了」。这一栏对这一切毫无表达力。它能展示**某**一张图，由谁先注册决定，既够不着其余的图，也没法同时够着一个页面。

## Decision

这一栏是每会话一条**按类型分列的内容 entry 流**，那个座位则是一个路由器。

[`content-surface`](../../../../packages/experimental/content-surface/README.zh.md) 是宿主半边。`ctx.contentSurface.register(extractor)` 接收某个 kind 的全部贡献——它认得哪些已提交事件、每条事件所记录的 entry 由什么标识、以及一条已存记录如何解析成标题与载荷——路由器再把每个已注册的 extractor 折叠进同一个会话 projection `contentSurface`，为每条存活 entry 发布 `{ kind, entryId, seq, title, payload }`，最新在前。[`content-column`](../../../../packages/experimental/content-column/README.zh.md) 是浏览器半边：它认领 `content`，并在其中声明一个子槽 `content.surface.kind`，以 entry 的 kind 为 key，root 作用域，owner 份额为 `{ sessionId, entry }`。两者总是一起组合；这一拆分是下文记录的工具链约束，不是一道缝。

**没有新的会话事件。** 每条 entry 都派生自别的包已经记录的事实——页面来自 `content/shown`，图表来自一次 `show_chart` 调用——因此整栏都能从 agent 真正写下的日志里重放，而新增一个 kind 不新增任何持久化格式。

**每个 `(kind, entryId)` 只留一条记录。** 后来的记录若指名同一组合，就在 fold 里替换掉先前那条，于是重绘的图表与重新展示的页面各占一行而非两行。这就是会话记录早已采用的取代规则，读自同样的事件、经由同样的读取器。

**最新者上台，另配切换条。** 在用户另选之前，这一栏展示 `entries[0]`；切换条按最新在前列出该会话的 entry。选择是纯 UI 行为：按会话 id 索引的组件状态，默认落在最新一条，所指 entry 被替换时回落到最新一条，且从不入日志。

### 注册时机，对照 projection registry 的真实行为

projection registry（`packages/session/session-projection`）在注册那一刻固定一个 unit 的 `apply`、`view` 与 `stateVersion`，在 `WeakMap` 里为每个 `Session` 缓存一份折叠单元，并且永不回头重算已建好的单元。因此，若路由器持有一个长期存在的 unit，而它的 fold 读取「活的」extractor 表，结果会是静默错误：任何已有缓存单元的会话都会永久缺失此后注册的 kind 的历史，而在一组 kind 下写出的持久化 checkpoint 会被在另一组 kind 下向前套用。

所以本 registry 在表每次变化时都注册**一个新 unit**。丢弃旧注册会连同它的缓存单元一起丢弃（`refs` 归零，条目离开表），每个会话下一次被触及时便以新表从 `init` 重新折叠它完整的内存日志——这正是 registry 自己写明的惰性构建通路。`stateVersion` 从表派生，是为了解决同一问题的持久侧：把排序后的 `kind@dataVersion` 列表哈希进 31 位，于是组合变化会丢弃 checkpoint 行，而不是向前套用它们。

残留的代价是推送延迟而非正确性：registry 只在驱动事件时发布变更值，因此在某个 kind 行被热加载时已经连着的浏览器，会一直读到旧的流，直到该会话的下一条事件。启动期的组合根本触不到这一点。

### 一条 surface，两个包

Typert 的 host face 为每一批被发现的包各建一个程序，根文件取自每个成员完整的 tsconfig 文件清单。宿主入口声明了 Cordis 服务的包会在 host face 被发现；这个包若同时有一个触及客户端运行时的 `src/client`，两个 face 的 `TypertContextMap` 合并就会落进同一个程序，生成器随即因重复 key 失败（`agent`，由 `packages/core/agent` 与 `packages/client/runtime/src/client` 各声明一次）。树内每一个双 face 包都靠「没有宿主 surface」（`content-frame`、`server-layout`、各 `ui-*` 行）或「够不着客户端运行时」（`client-modules`）躲开这一点；而一个既有服务又有栏位的 content 路由器两样都占。

`packages/AGENTS.md` 禁止把一个包的 tsconfig 拆成两个 face，因此改为按包拆分：服务、extractor 契约、projection 与共享类型留在 `content-surface`；栏位、它的槽声明与它的文案放进 `content-column`，后者类型导入 `@deepseek-ai/dsh-experimental-content-surface/types`。设计本身没有任何变化——每个 overlay 都组合这两行，某个 kind 的包也同时依赖两者。

### kind 渲染器保持挂载

`content.surface.kind` 是 root 作用域，且这一栏把它见过的**每一个**座位都保持挂载，未选中的以 `visibility` 隐藏。渲染器可能持有这一栏不得销毁的 DOM——content-frame 那些活的 iframe 正是本设计针对的场景——在图表被选中时卸载 page 座位会让每一个 iframe 重新加载。座位列表只追加，理由与 frame 列表相同：React 会移动位置发生变化的 keyed 子节点，而移动一个 iframe 会让它重新加载。

### 图表面板包已删除

`vue2-echarts-content-poc` 存在的唯一目的，是把一块静态演示面板摆进这一栏。它的全部理由是这一栏只容一位占用者；当这一栏改由 kind 路由之后，同样的组件经 `vue2-echarts-tool-poc` 的 `chart` kind 抵达那里，画的是本会话真实的图表而非种子演示数据。该包、它的 overlay 与它的 e2e 被删除而非弃用（发布前立场）。`ChartPanel` 与 `EChartsBar` 连同各自的 spec 留在组件行里，不再有任何摆放。

## Alternatives considered

**给 content-frame 一个 `page` kind 但不要路由器——由一个包持有 `content` 并在其中开一个 `component` 子槽。** 否决：这会让这一栏的路由成为 content-frame 的职责，于是想在栏里放图表的部署不得不组合一个它并不想要的托管应用包，而图表包也必须知道 content-frame 的槽 key。这道缝属于座位的所有者，而不属于第一位占用者。

**带钉住的多标签，两条 entry 并排。** 暂且否决：那是在一个尚未验证的机制之上再叠一层机制。现场证据要的是「最新者上台加一条切换条」；而钉住是每用户的持久偏好，属于这一栏刻意尚未具备的被记录事实。

**做成全局 surface 而非每会话。** 否决：每个生产者的数据都是每会话的（某会话展示过的页面、某会话画出的图表），而这一栏本就紧挨着一个每会话的会话区。全局 surface 不得不发明一套跨会话的归并规则，还会让切换会话什么都不改变——那与这一栏的意义正好相反。

**一个包同时持有两半。** 因分析器而非设计被否决：见上文「一条 surface，两个包」。留在一个包里的备选是把它的 tsconfig 拆成 host 与 client 两个工程，而 `packages/AGENTS.md` 把这条路留给 `api/remotes`，何况那还会让共享的 `src/types.ts` 落进两个程序。

**在一个长期存在的 projection unit 里读取活的 extractor 表。** 依据上文 registry 的语义否决：它会静默丢弃历史，而这正是值得为之付出一次重新注册的那一种失败。

**不要宿主 registry，改在浏览器里从各个 kind 自己的 projection 派生 entry。** 否决：客户端将需要一张「哪个 projection key 意味着什么」的表，那就是同一个 registry 只是晚了一层；而且它会把每个 kind 的 wire 值变成这一栏的公开依赖，而那本该是各 kind 自己的事。

**由路由器持有客户端保活（每条 entry 一个座位，而非每个 kind 一个）。** 否决：那会把 content-frame 来之不易的 frame 缓存规则——LRU 上限、正在展示者永不被逐、只追加的顺序——搬进一个根本不知道一个 frame 值多少钱的包；而且它会为每条 entry 挂一个渲染器，可某个 kind 也许想用一个引擎画完全部。

## Consequences

这一栏的占用方式变了，一项用户可见行为也随之改变：**content-frame 的 `defaultPage` 不再出现在这一栏里。** 这一栏列出的是某个会话产生了什么，而默认页面并非任何会话产生的东西，因此什么都没展示过的会话得到的是空状态提示。`defaultPage` 作为 content-frame `content` projection 的一个值存活下来——那个 projection 如今在树内没有消费者，也是「已解析的当前页面」唯一还被发布的地方。

content-frame 的 frame 缓存如今以 `(会话, 页面)` 为键而非以会话为键：一个会话的两个页面就是两个活着的 frame，`cacheSize` 计的是组合数。settings 文档去掉了 `defaultPage` 字段，因为浏览器半边不再有「无会话」这一状态要填。

一条 chart entry 携带完整的 option 文档，因为一次图表调用是自足的，而这一栏必须能在不伸手进它所在会话的前提下把它画出来。那份 option 会随 projection 状态、wire 值与持久化 checkpoint 一同流动；约束它的是 `maxOptionBytes`。

切换条在每个标题旁标出 kind 的原始 key（`page`、`chart`）。路由器无法为它并不认识的 kind 本地化名称，也不存在按 kind 提供标签的贡献点；周围的产品文案是中文，这个角标不是。

如今有三个 overlay 组合这一栏：content-frame 的 `content-column.patch.yml`（外壳 + 路由器 + 托管应用）、工具包的 `show-chart-three-column.patch.yml`（外壳 + 路由器 + 图表，无托管应用，因此 `page` kind 永不出现），以及 content-surface 自己的 `full-surface.patch.yml`（全都要）。

## Testing

`packages/experimental/content-surface/tests/registry.spec.ts` 在真实会话与真实 projection registry 之上驱动这个 registry：一张表发布什么、每个 id 一条 entry、后到的 extractor 拿回它本应发现的历史、被释放的 extractor 带走自己的 entry、整个 projection 随插件离开、没有 projection registry 的装配，以及 kind 加入、离开或改变存储形状时会移动的 `stateVersion`。`projection.spec.ts` 直接针对该 unit 覆盖「kind 已离开表的记录」——那正是一份陈旧 checkpoint 万一真的抵达 fold 时的样子。`content-column` 的 `surface-seats.client.spec.ts` 覆盖只追加的座位列表与选择回落；`content-surface.client.spec.tsx` 覆盖切换条、每会话的选择、跨 kind 切换仍保持挂载的座位，以及未注册 kind 的提示；`browser-plugin.client.spec.ts` 在真实 `SlotRegistry` 上驱动这一栏的注册。

两个 kind 在各自的包里、也在真实组合里得到证明：`page-extractor.client.spec.ts` 与 `chart-extractor.client.spec.ts` 覆盖各自认得什么，而两个包由 Loader 启动的路由 spec 如今都挂上了路由器，于是 extractor 子节点真的会激活，发布出来的 entry 也被断言。

`apps/web/tests/content-surface.e2e.ts` 以 full-surface overlay 启动一个携带「一个被展示的页面、一张被重绘的图表、以及第二张图表」的会话。它断言四次已记录调用对应三条切换条 entry、最新那张图表画出了有尺寸的 canvas，以及单测给不出的那条保活证据：图表接管这一栏又交还之后，托管 iframe 仍是**同一个**元素；第二个会话自己的流来了又走之后同样如此。`content-frame.e2e.ts` 与 `content-show.e2e.ts` 覆盖 page kind 的几何、它的文档与它的每会话 frame；`show-chart.e2e.ts` 覆盖两种外壳下的 chart kind。
