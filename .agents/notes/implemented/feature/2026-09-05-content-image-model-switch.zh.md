# Agent Note: 问用户换不换那张图需要的模型

Status: implemented

[English](2026-09-05-content-image-model-switch.md) | 中文

## Problem

[读图那篇](2026-09-04-content-read-image.zh.md)在 `content_read_image` 前面立了一道闸：路由不声明图片输入的会话，在导出任何东西之前就被拒绝，因为存下来的图是长期保留的，而纯文字路由会在像素已经落盘之后把图片块从请求里丢掉。这道闸是对的，它挡住的失败也是真的。

它同时也把用户挡在外面。控制台用户问 agent 页面上那张图是什么；这次会话恰好在 `deepseek-v4-flash` 上；模型用自己的一句话回答说这条路由不收图片。用户要的东西离得只有一次模型选择，而那句话里一个字都没说——拒绝文案是刻意不点补救的，点了就违反[文案自足那篇](2026-09-04-self-contained-tool-copy.zh.md)。

会话停在纯文字路由上是常态而不是意外。种子会话从自己日志所在的位置起步，部署默认是部署方设成什么就是什么，为一场对话余下部分换到强文字模型的会话就留在那里。上述任何一条成立、而页面恰好画了点什么，这道闸就会响。

有两件事让这次拒绝比它本该的更糟。这道闸读了会话已落日志的请求头与 agent 的选项，却没读控制台已经做出的模型选择——于是用户在选择器里换了模型再问一次，仍然被拒，直到某次请求消费掉那个选择为止。而且 `content_read_image` 声明自己可以与同侪并行，因此同一步里的两次读图会同时撞上这道闸。

## Decision

闸的位置不变，多出一个出口。现在由 `access/model-switch.ts` 拥有它，共三个结局：

1. 路由声明了图片输入——照旧执行读取。
2. 路由没声明，而部署里另有路由声明了——在控制台竖起一张卡，问要不要换掉这次会话的模型，把每一条能看图的路由都列出来。用户选中哪一条，会话就换到那一条，读取随即执行。
3. 其余任何情况——拒绝这次调用，什么都不改。

卡问在原先做模态检查的那个位置：`execute` 里，`awaitRead` 注册等待之前、任何浏览器被要求作画之前。这个位置正是「这里能问一张卡」的全部理由——被拒掉的切换不得留下任何已存的图，而这次读取自己的认领截止时间是三秒，卡却可能竖上好几分钟。

**路由判三级。** `effectiveRoute` 读的正是 [`selectionFor`](../../../../packages/api/session-controller/src/agent.ts) 所读的，顺序也相同：还没有任何请求消费掉的 `model/selection`，其次是会话已落日志的 `request/header`，最后是 agent 的选项。每一级上，`inputModalities` 缺失一律当否定。

**每会话一次决定，每会话一张卡。** 同一会话的路由决定经一个 `WeakMap` 串行，于是并行两次读取的第二次跑在第一次换完模型之后，并把那次变更当作自己的第一级读到——它不弹第二张卡就直接放行。用户以「不是某条路由」的方式作答，就被记进一个 `WeakSet`，该会话之后的读取不再问、直接拒；这个记号只压卡片，永不压放行。

**换模型只经 `ctx.sessionController.selectModel`，别无他途。** 它 append `model/selection`、把选择装到活着的 agent 上，并让控制台的选择器与 `modelSelection` projection 跟上。这次调用还会把选择存成部署默认（`agentDefaultModel.saveSelection`），这是本包管不着的一个后果，见下文 Consequences。

**工具结果回程的那一次请求就已生效。** `installModelSelection` 挂在 `system-prompt/assemble` 与 `agent/request` 上，而这两者都是每步一次而不是每轮一次（[`agent-loop`](../../../../packages/core/agent-loop/src/agent.ts)）。把这条工具结果送回模型的那一步因此已经跑在新路由上，它的系统提示词里也已经是新模型名——这正是工具结果对这次切换只字不提的原因。

**卡上列的是部署自己的宣称。** `imageCapableRoutes` 走 `ctx.llm.listProviders()` 与 `listModels(provider)`；控制台选择器渲染的 `modelCatalog` projection 不带模态，答不了这个问题。某个供应商的目录抛错就把它整个略过，卡上其余的照常。目录成员资格只是宣称——路由是否接受请求由 `selectModel` 里的 `resolveCallConfig` 裁定，它的拒绝以 `routeSwitchRefusal` 到达模型。

**告诉模型的话里从不出现这张卡。** 被拒掉的切换、无人可问的组合、被用户关掉的卡，答的都是这次读取原本就有的那句拒绝：`The session's model "X" does not declare image input.` 它仍然是真话，也不给模型任何可以把卡再弹起来的把手。新增两条拒绝：一条给「没有任何已配置模型收图」的部署，一条给「主机不肯做的切换」。

### 这次跨过的分层

`@deepseek-ai/dsh-api-session-controller` 是 BFF 层的包，在此之前，除了 `packages/api/remotes`、`packages/bundle/web-app` 与 `packages/client/ui-*` 那一排，没有任何东西依赖它。本包是第一个消费它的服务的主机插件。守住的线是：只调 `selectModel`，只经公开服务，且唯一的 import 是从浏览器安全的 `/types` 面拿的 type-only import——只为模型选择词汇与 `modelSelection` projection 键。

主机那一面够不着，也就一直够不着。本包自己的程序是 Client 面，而 `scripts/project-reference-faces.ts` 要求 Client 面进入拆分包时只能进它的 client 半边——那半边带的是 `/types`，不带 `ctx.sessionController` 的声明。因此这个服务经由 cordis 为「不在类型化 Context 面上的名字」声明的 `get(name: string): any` 重载取到，而 `RouteSwitcher` 负责把类型还回来。`scripts/package-dependency-policy.ts` 把 `packages/experimental/` 排除在分层检查外，因此机械上拦不住下一个这样的依赖；这一节就是「这是一次决定」的记录。

### 决策闸

五个机制，各对着同样五个空。挡不住任何具名失败的边界是噪音，不列；凡列出的，要么标 permanent，要么标 deferred 并写明重开它的触发器。

#### M1 — 这道闸会问、会换，而不只是拒

- **0 — 已定原则里哪条替你说了。**「Plugins, not loop changes」对动 `agent-loop` 说了不：这只是一个工具体加两个被消费的服务。「Misconfiguration fails loud at the earliest resolvable point」把卡放在拒绝原本所在的位置，即等待注册之前。本包自己那条「读免审批」的规则对审批闸说了不——而且 `ApprovalOutcome` 只有 allowed-once/rejected/cancelled/unavailable，装不下 N 选一。「A capability seam is three roles」对新开一条缝说了不：本次改动是 `userQuestions`、`sessionController`、`llm`、`sessionProjections` 的 Consumer，仅此而已。
- **1 — 新面：9。** 两个模块（[`model-switch.ts`](../../../../packages/experimental/content-frame/src/access/model-switch.ts)、[`switch-text.ts`](../../../../packages/experimental/content-frame/src/access/switch-text.ts)）；以 `ModelRouteServices` 与四个窄服务面取代 `ModelRoutes`；路由第一级；每会话决定链；拒绝记号；两条拒绝文案；两个 type-only 依赖。零 `Config` 字段、零审批注册、零会话事件类型、零 locale 键、零 toolview、零路由。
- **2 — v0。** 不写代码的那一版：用户在控制台自己的选择器里换模型，再问 agent 一次。它是先跑的，也正是它找出了缺的那一级——闸只读已落日志的请求头时，那条手动路径同样被拒。补上那一级就是本次改动的 v0，且严格小于本次改动；卡是后半部分买到的东西。
- **3 — 缝还是写死。** 写死。无 `Config` 字段、无开关、无超时旋钮、无候选数上限、无「问几次」策略。点不出两个会把其中任何一项设成不同值的部署：只有一条部署线、一条问答缝、一个装模型选择的落点。第二个部署想要 `content_read_image` 但不要这张卡时再重开。
- **4 — 边界。**

| 方向 | 线 | 挡住的具名失败 | 期限 |
| --- | --- | --- | --- |
| 邻居 | 模型选择归 `sessionController`。本包不 append `model/selection`、不装第二个选择引用、不挂自己的 `agent/request`。 | 与 session controller 已装的那对监听器抢先后，并让控制台的选择器与 projection 落后于真实路由。 | permanent |
| 契约 | 闸跑在 `pending.open` 之前，`awaitRead` 一行不改。 | 卡竖着好几分钟，而三秒的认领截止时间已经跑完，调用以 `unclaimed` 收尾。 | permanent |
| 诱惑 | 把它长成「工具遇事就问用户」的通用口子。它只问一个问题，且只在路由不收图时问。 | 每个 content 工具都开始弹卡，审批与问答两条流混成一锅。 | permanent |
| 红线 | 用户选定路由之前，不采集、不导出、不上传、不存储任何东西。 | 一张被用户拒掉的图长期留在从不回收的 `$DSH_HOME/attachments/` 里。 | permanent |
| 天花板 | 不承诺换过去的模型读得懂这张图，不承诺卡片跟随控制台语言，不承诺任何东西会换回来。 | 「换了还是认不出」被当成本次改动的缺陷。 | permanent |
| 假设 | 组合里挂了 `llm`、`userQuestions` 的应答者、`sessionController` 与 `modelSelection` projection，且调用者是活着的根 agent。任一不成立就是那句旧拒绝，不做变通。 | 一张没人看得见的卡，以及一件挂在无人应答的 waterfall 上的工具。 | permanent |

#### M2 — 卡本身

- **0 — 已定原则里哪条替你说了。**「Prefer maintained dependencies over hand-rolling」对「在这里自己画卡」说了不：`ask` 已经把 waterfall、agent 作用域、取消和控制台接管全办了。「Trust TypeScript at typed same-process boundaries」**够不着**答案——选中的 label 从浏览器经远程 waterfall 回来，因此不是这张卡提供过的 label，就一律当成「没选路由」，而不是断言成某条路由。本分叉的「上游零改动」规则对新增 `AskUserQuestionIntent` 成员说了不。「终端用户零术语」这条产品规则定了措辞。
- **1 — 新面：3。** 卡的文案、`switchQuestion`、以及答案回读所经的 label→路由映射。
- **2 — v0。** 一道题、每条路由一项、外加一项「什么都不改」。更小的做法考虑过——不给拒绝项，靠 composer 自带的跳过控件——并被否决：拒绝是这道题的一个答案，而跳过是每道题都带的控件。
- **3 — 缝还是写死。** 写死：不做 intent、不做多选、不做自定义渲染、不加第二道题。
- **4 — 边界。**

| 方向 | 线 | 挡住的具名失败 | 期限 |
| --- | --- | --- | --- |
| 契约 | label 就是答案的身份，且同一张卡上每个 label 唯一：`厂商：模型`，凡两项会读起来一样的再加模型 id。 | 点了一个模型，却被换到另一个。 | permanent |
| 诱惑 | 往同一张卡里塞第二道题——分辨率、格式、「记住这个选择」。 | 一次工具调用变成一份问卷。 | permanent |
| 红线 | 卡片自己的文案里不出现 attachmentId、provider id、model id 或模态词汇。只有显示名，而模型 id 只在两项会读起来一样时才出现。 | 终端用户读到本包的内部词。 | permanent |
| 天花板 | 主机侧中文字面量，与 `content_act` 的审批请求相同；卡不跟随控制台 locale。 | 英文控制台里的中文文案被当成缺陷。 | deferred — 触发器：主机侧出现真正的 locale 服务，或出现非中文客户 |
| 假设 | 卡在 server-layout 组合下确实渲染。落笔之前已实测：在种子好的 content-column 会话上经 `ctx.userQuestions` 问一道题，`[data-question-key]` 会出现、点击可作答、并原样回传 label。 | 把卡竖进一个什么都不显示的控制台，让工具一路等到自己被取消。 | permanent |

#### M3 — 换模型的落点

- **0 — 已定原则里哪条替你说了。**「Explicit > implicit at package boundaries」要求调公开的 `selectModel`，而不是够进控制器自己的 agent 注册表。「Misconfiguration fails loud；never silently skip a missing referent」定了：`sessionController` 不在就是拒绝，而不是假装换了。「Opaque cross-boundary ids are branded」让 session id 取自 `agent.session.header.id` 而不是拼出来的字符串。本分叉的「上游零改动」规则对「在上游开一条更低层的选择缝」说了不。
- **1 — 新面：2。** `RouteSwitcher`，以及对 session controller 的 type-only 依赖。
- **2 — v0。** 就是这一次调用。三个更小的版本在纸上试过，全部不成立：见 Alternatives。
- **3 — 缝还是写死。** 写死：一个落点、一个方法、不重试、不回滚。
- **4 — 边界。**

| 方向 | 线 | 挡住的具名失败 | 期限 |
| --- | --- | --- | --- |
| 邻居 | 只调 `selectModel`，只经服务，且不对 BFF 包做任何运行时 import。 | 实验性插件把 BFF 层当成通用工具箱，把分层永久反转。 | permanent |
| 契约 | 这次切换对本会话是持久的，而 `selectModel` 还会把它存成部署默认，于是之后新开的会话也从它起步。 | 用户以为只影响这一次，结果明天新开的会话在另一个模型上。 | permanent |
| 诱惑 | 读取结束时把模型换回去。 | 一次读取两次静默选择，用户和模型都不知道自己在哪条路由上。 | permanent |
| 红线 | 绝不以任何其他方式改路由。 | projection、选择器与日志三者与真实路由不一致。 | permanent |
| 天花板 | 只带 provider 与 model。`reasoningEffort` 交给新路由上 `resolveCallConfig` 自己的默认。 | 「一换过去推理等级就没了」被当成缺陷。 | deferred — 触发器：某条视觉路由的默认 effort 明显不合用 |
| 假设 | `sessionController` 与 `agents`、`sessionProjections`、`agentDefaultModel` 同在，正如它自己的 inject 表所要求的。headless 或 ACP 组合三者皆无，得到的是那句旧拒绝。 | 在没有控制台的部署里竖起一张卡。 | permanent |

#### M4 — 数出能看图的路由

- **0 — 已定原则里哪条替你说了。** session controller 自己的目录对单个供应商的失败做隔离而不是清空整表，这里照抄这个姿态。「No hardcoded tunables in plugins」对候选数上限说了不：上限是会随部署变的数，那就要么是 `Config` 字段、要么不存在，而它不存在。「An empty `catch` names what it swallows」给这一处点了名：某个供应商的目录读不出来。
- **1 — 新面：2。** `imageCapableRoutes` 与 `optionLabels`。
- **2 — v0。** 就是这两个函数。更小的做法——复用控制台选择器已经渲染的 `session/modelCatalog` RPC——不成立：那份投影带的是 `{id, name, description?, reasoning?}`，没有模态。
- **3 — 缝还是写死。** 写死：不排序、不打分、不推荐、不记住上次选的那个、不设上限。
- **4 — 边界。**

| 方向 | 线 | 挡住的具名失败 | 期限 |
| --- | --- | --- | --- |
| 契约 | 判据只有一条：`inputModalities` 含 `image`。缺失即否。 | 靠猜提供一条路由，然后图在请求里被换成占位符。 | permanent |
| 邻居 | 目录是 `llm` 的。本包不缓存、不补齐、不硬编码，包里不出现任何模型名。 | 部署换了目录，卡还在提供一个它已经没有的模型。 | permanent |
| 诱惑 | 把这份统计发布成通用的「谁能看图」API 或 projection。 | 在 `modelCatalog` 旁边长出第二套目录。 | permanent |
| 天花板 | 能看图的路由有多少列多少。配了几十条视觉路由的部署会得到一张几十项的卡。 | 一张没法用的卡被当成枚举的缺陷，而不是部署的。 | deferred — 触发器：真实部署里候选数超过八 |
| 假设 | `listModels` 是部署的宣称而不是路由校验；校验是 `selectModel` 的。 | 卡上提供了一条换不过去的路由，且没人说为什么。 | permanent |

#### M5 — 第一级、决定链与拒绝记号

- **0 — 已定原则里哪条替你说了。**「Prefer symmetry for parallel values；unexplained asymmetry usually signals a missed extraction」正是它把缺的那一级判成缺陷而不是选择——`selectionFor` 读三级而这次读取读两级，没有给出任何理由。「Runtime invariants assert owned relationships」把链和记号挡在日志之外、也挡在所有 projection 之外：它们是本包自己的运行时状态。defensive-patterns 里关于生命周期的规则让两者都用以 `Session` 为键的弱集合。
- **1 — 新面：3。** 经 `RouteSelectionState` 的第一级、`serializeDecision`、拒绝记号。
- **2 — v0。** 只补那一级，也正是手动探针所需要的。链和记号在发布版本里不能省：没有链，同一步里并行两次读取就是两张卡；没有记号，模型重试一次被拒的读取就多一张卡。三件齐了，「只问一次」才成为可核查的性质。
- **3 — 缝还是写死。** 写死为每会话一张卡。按轮次更好，而 `ToolExecution` 不带轮或步的身份可作键；加一个是改动工具运行时。
- **4 — 边界。**

| 方向 | 线 | 挡住的具名失败 | 期限 |
| --- | --- | --- | --- |
| 契约 | 第一级只读 `pending`，从不读 `lastUsed`——那是已被某次请求消费掉的选择，等价于第二级。 | 把一个选择数两遍，把会话已经离开的路由当成当前的。 | permanent |
| 诱惑 | 拿这条决定链去串别的东西——导出、上传、报告。 | 一条锁把本来可并行的通道串成单线程。 | permanent |
| 红线 | 记号只压卡片，永不压放行。 | 已经在控制台里换过模型的用户仍然被拒。 | permanent |
| 天花板 | 记号在内存里：重载会话或重启主机之后会再问一次。 | 「我说了不换怎么又问」被当成缺陷，而不是一张卡的代价。 | deferred — 触发器：用户报怨重启后被再问 |
| 假设 | `stateOf` 同步反映刚 append 的选择，因为它折的是会话自己的日志。 | 并行两次读取的第二次为第一次已经做完的切换再弹一张卡。 | permanent |

## Alternatives considered

- **不问，直接换成第一个能看图的模型。** 否决：一场对话跑在哪个模型上是用户的选择——base bundle 自己的系统提示词规则正是把 `ask_user_question` 留给这类选择的——而这次切换是持久的，还会连带改动部署默认。
- **在拒绝文案里让模型去请用户换模型。** 否决：失败文案只说为什么被拒，从不点名补救办法或另一件工具（[文案自足那篇](2026-09-04-self-contained-tool-copy.zh.md)）。
- **做在 `user-approval` 上。** 否决：`ApprovalOutcome` 只有 allowed-once、rejected、cancelled、unavailable，装不下 N 选一。
- **加一个 `AskUserQuestionIntent` 成员，让控制台画一张模型切换专用卡。** 否决：那要改两个上游包，违反本分叉的上游零改动规则，而通用选项列表已经够用。
- **在本包自己的 browser 半边画卡。** 否决：会与 `ui-user-questions` 抢 composer 接管，还要自造一条回程把答案送回主机。
- **只 append `model/selection` 就收手。** 否决：活着的 agent 的选择在装载时从 projection 读一次，之后就是内存值；事件不会改动它。
- **调 `installModelSelection`，或在这里挂 `agent/request`。** 否决：两者都不落事件，于是 projection 与控制台选择器落后于真实路由，而且都会与 session controller 已装的那对监听器同时在场。
- **经 `session/modelCatalog` RPC 枚举。** 否决：那份投影不带 `inputModalities`，答不了「谁能看图」。
- **让切换到下一轮才生效。** 作为不必要而否决：`system-prompt/assemble` 与 `agent/request` 都是每步一次，因此送回这条工具结果的那一步已经在新路由上。既不需要「延后生效」的设计，也没有这样的设计。
- **不做每会话串行。** 否决：`isConcurrencySafe` 为真，同一步里两次读图会弹两张卡、做两次选择。
- **不做拒绝记号。** 否决：被拒的读取是模型会重试的读取，每次重试都会再弹一张卡。
- **把图解出来——在本包里放二维码或条码解码器。** 按读图那篇画的同一条红线否决：图在经过时不被读出任何东西。

## Consequences

**这次切换是持久的，而且不止影响本会话。** `selectModel` append `model/selection` 之后，还会把这个选择存成部署默认，于是之后新开的会话也从选中的模型起步。卡上说了这场对话会一直用它；没说部署默认也动了。这两件事在 README 和这里各写一遍。

**这次会话余下的轮次跑在用户并非为它们挑选的模型上。** 视觉模型可能弱于这场对话原本所在的那个。没有任何东西把它换回来；那是用户在选择器里做的事。

**每次接受的切换多两条事件，且不新增事件类型。** 先 `model/selection`，然后是消费它的那条 `reason: 'change'` 的 `request/header`。`SESSION_FORMAT_VERSION` 不动，没有任何 projection 的 `stateVersion` 变化，`contentAccess` 一个字不改。

**问答本身不进任何日志。** `user-questions` 没有 `SessionEventMap` 成员，因此重放看不到卡曾竖起、也看不到用户拒过。录制的场景靠点击来复现那个答案。

**现在有一个主机插件依赖 BFF 层。** 第一个；它守住的线写在上面的 Decision 里。

**卡是单语的。** 主机侧中文，与 `content_act` 的审批请求相同，控制台设成任何语言都一样。

**没有控制台的组合行为完全照旧。** headless、ACP 与被委派的子 agent 得到的都是本次改动之前那句拒绝，因为 `ask` 对子调用者直接拒绝，而那两个服务在这些组合里根本不在。

## Testing

`tests/content-model-switch.client.spec.ts` 用替身服务驱动这道闸：三级各自命中与相互压制、放行时既不读目录也不问任何人、候选为空、缺 asker 或缺 switcher 的组合、逐字比对本篇记录的卡片文案、带确切请求的模型切换、每一种「不是所提供路由」的答案（跳过、自由文本、拒绝项、未知 label、两个 label、另一道题的 id、以及没人应答的卡）、被取消的调用、切换被拒的两条臂、一个供应商失败时的目录枚举、三种 label 情形，以及机制所依赖的两条运行时事实——并行两道闸只产生一张卡与一次切换，以及无论模型重试多少次每会话只问一次。

`tests/content-read-image-tool.client.spec.ts` 守住整套设计所依赖的次序：用一张没人应答的卡，断言 `PendingCalls.open` 在取消前后都从未被调用。`tests/self-contained-copy.client.spec.ts` 把 `switch-text.ts` 与另外两个面向模型的文案模块一起走查，于是卡片文案受同一条规则约束。`src/` 保持逐文件 100% 覆盖。

一个 Web 场景为它兜底：`apps/web/tests/content-read-image-switch.e2e.ts`，组合、应用与 preset 都与[读图场景](2026-09-04-content-read-image.zh.md)相同，只差一件事——它不在种子会话上选路由，于是会话留在种子日志记下的 `deepseek-v4-flash` 上。spec 在驱动任何东西之前先断言两条路由各自声明了什么，随后等卡，并把路由断言放在那里而不是放在最前面：没有任何东西打开过的会话在主机侧不是活的——其余 content 场景之所以是活的，只因为选路由那一步把它们的 agent 解析了出来——而卡竖着时，抵达这道闸的那次请求已经落日志，于是断言的是那次请求确实跑在 `deepseek-v4-flash` 上、且当时没有待生效的选择。接着把卡的可访问性快照钉成 `card.expected.md`、点视觉选项并提交，然后断言答案描述了那张图、有一条 `model/selection` 被 append、其后跟着一条模型为视觉模型的 `reason: 'change'` 请求头。点击在录制与重放两种模式下都是测试自己的动作，与审批场景的做法相同。本场景的请求头从第一条起就与读图场景不同，因此它自带 `header.class` 与自己的 pin，并长出两份带 `<!-- request/header change 1 -->` 段的 sidecar。带钥录制：

```sh
DSH_SNAPSHOT=record pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/content-read-image-switch.e2e.ts
DSH_SNAPSHOT=refresh pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/content-read-image-switch.e2e.ts
```

refresh 无需钥匙且不可省：`record` 只写 `session.jsonl`，两份 sidecar 与 `card.expected.md` 由 refresh 写出。只要 `snapshots/web/content-read-image-switch/session.jsonl` 还不在盘上，spec 就自行跳过，因此场景与它的录制可以落在不同的改动里，而不会让无钥车道变红。
