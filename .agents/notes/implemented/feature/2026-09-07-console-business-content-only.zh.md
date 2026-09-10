# Agent Note: 客户控制台的对话列只呈现业务内容

Status: implemented

[English](2026-09-07-console-business-content-only.md) | 中文

## Problem

客户控制台把这套 harness 完整的开发者流水呈现给了终端客户。

一位来要周报的访客，在自己的问题与答案之间看到的是：一个装着整段系统提示词的「系统提示词」折叠盘；每一次工具调用一行（包括 `content_read` 自己的结果卡片，而它描述的那个页面此刻就摆在旁边的内容列里）；每一段推理一个「思考」折叠盘；每一条斜杠命令一张卡片；轮次一旦结束还会多出一行「N 次工具调用 · M 条消息」的折叠行；以及一个动作行里挂着「用量 33.7K tok · 用时 6 秒」，与复制、点赞/点踩、分支并排的回复页脚。另有两处界面说的是厂商的话，而不是产品的话：输入框的占位文案是 `dsh-client-ui-conversation` 面向开发者的语气（「Describe what you want to build... / commands, @ files or sessions」），运行中的指示器则写着「深度求索中...」——厂商的中文品牌名，还用一层 DeepSeek 色板的渐变绘制——这是本包英雄区那几条规则从未够到的一处厂商身份，因为它根本不是英雄区界面。

这些都不是一台客户控制台该做的事。产品决策（2026-09-07）是：对话列只呈现访客提出的诉求与拿回的结果，不呈现这次运行是怎么走到那里的。

## Decision

本决策已被 [2026-09-10 的推翻](../simplification/2026-09-10-console-process-shown-again.zh.md)取代：产品负责人推翻了它，控制台的对话列重新呈现过程。本 note 描述的已不再是本包当下画出来的东西；它留存下来，作为「每一条规则隐藏了什么、各自选了哪种耦合、备选方案各自的代价」的记录。

**每一处隐藏都只是 `packages/experimental/server-sidebar/src/client/terminology-guard.ts` 里多出的一条规则**——本包早已为轮次/步骤行、权限选择器与英雄区门面注入的那张纯客户端样式表。不动任何上游包，不加新插件，不加组合行，也不动 settings。

**过程行按 Chat Node kind 隐藏。** `ChatNodeSeat.tsx` 会在每一个流式行上打出 `data-chat-flow-kind`，因此 `[data-chat-flow-kind="system-prompt"]`、`"turn-process"`、`"tool-call"`、`"command"`、`"manual-compaction"`、`"compaction"` 都是真正的属性选择器——没有类名子串，也没有 DOM 位置，唯一能打破它们的是上游改掉 kind 名字。推理是例外：它渲染在被保留的 `assistant-step` 席位内部，而不是自成一个 kind，因此它的规则耦合在 `[data-variant="think"]` 上——`ReasoningRow.tsx` 无条件设置它，且 `ToolRowVariant` 的其余成员都不与之相撞。命令行占了三个 kind，是因为 `ui-chat` 按命令的来路把同一个界面拆开了——`manual-compaction` 是 `/compact` 连同它的压缩事务，`compaction` 是自动那一次，`command` 是其余全部——只隐藏 `command` 会把 `/compact` 留在屏幕上。`context` 与 `model-retry` 是同一判断的再两次应用，两者都不在「保留」那一边：`context` 行是一条来源不是用户的 `user/message`（`messageDefinition` 正是据此归类的），因此它是这次运行所需要的机件，而不是访客写下的东西；`model-retry` 行则是内部状态——重试要么成功，那么访客读到的就是答案本身，要么耗尽，那么被保留的 `turn-error` 行会把这件事说出来。`command-input` 与 `workflow-run` 是 `dsh-client-ui-goal` 与 `dsh-client-ui-workflow-run` 对同一张表的贡献——两者都由 `packages/bundle/web-app/cordis.patch.yml` 组合进来，没有任何控制台 overlay 禁用它们，因此 `/goal` 会画出自己的输入行，一次 workflow 工具运行会画出一张生命周期卡片；`unknown` 则是 `ui-chat` 注册的兜底，它会把没有任何 Definition 认领的 append-surface 事件的原始 JSON 渲染出来。**这张表是可合并扩展的，因此这个联合是开放的**：本包的单元用例把每一个被组合进来的 kind 都列为「隐藏」或「保留」，一旦联合多出一个两边都不在的成员就编译不过——正是这一点挡住了一个未经审阅的 kind 出现在客户面前。

**`content_read` 的结果卡片随它所在的行一起隐藏。** 它是挂在 `tool-call` kind 之下的一个 keyed `tool.call.toolview` 条目，因此 `:not(:has([data-tool="content_read"]))` 本可以把它留下；这次的决策是不留。这张卡片说的是 agent 看了某个页面，并报出它的名字——而内容列已经用展示页面本身承载了这个事实，所以在控制台里，这一行只是在流水里复述屏幕上就摆着的东西。

**回复页脚只失去两枚指标药丸，那一行的其余部分保留。** `[data-turn-tail]` 有两个子节点：`dsh-client-ui-deliverables` 的 `ProducedFiles` 链（列出这次运行写了哪些文件），以及 `MessageIconActions`（承载复制、点赞/点踩、分支、两枚统计药丸，以及轮次结束的时钟）。一次运行产出的文件是业务结果，其余控件是访客自己的操作入口；只有「用量」与「用时」属于过程汇报，因此只有它们消失。两枚药丸都没有 `data-*` 属性——`TurnUsagePanel.tsx` 只在展开后的弹窗上放了一个，两个触发器上都没有——因此这条规则耦合在 `TurnUsagePanel.module.css` 的 `.trigger` 上，也就是两个面板都给那个按钮起的局部类名，并通过它够到药丸自己的外层包裹：`[data-turn-tail] :has(> [class*="trigger"])` 选中的是每个面板的 `span.root`，于是药丸既不留下 flex 槽位，也不留下只隐藏按钮时会留下的 `.root + .root` 负边距。

**运行指示器是改写文案，不是隐藏。** 访客必须看见工作正在进行，因此 `[data-chat-flow] > [class*="turnStatus"]` 把上游文字压到 `font-size: 0`，用 `::after` 画上「正在处理…」，并把那层 `--dsw-static-deepseek-500/200` 的背景裁切文字微光中和成主题里普通的 `--dsw-alias-label-primary`。这个直接子元素组合子承重了两次：`ChatView.tsx` 是在每一个 `ChatNodeSeat` 之外渲染 `TurnStatus` 的（这也是没有任何 kind 规则够得到它的原因），而这个组合子又把规则挡在嵌套的 `turnStatusClock` span 之外——那个 span 自设字号与颜色，十五秒后照样显示已用时长。

**输入框占位文案被切成三份，而不是替换一次。** `InputBar.tsx:545-549` 为一条比本次决策起初设想的两种状态长得多的占位文案阶梯（`:467-476`）只渲染同一个 `[data-composer-placeholder]` 元素：先是拥有方传入的 prop——英雄态文案（`ConversationRoot.tsx:343`）、不可用输入框自己的说明（`:334`，`placeholder.workspace`）、被抬起的阻断态的理由（`:342`）——然后是 `parentOffline`，然后是其余任何 disabled 状态，然后是排队引导提示、plan 模式与默认文案。这两条规则透过占位元素紧邻的前一个兄弟节点（输入框本身），按「输入框此刻能做什么」把它切开。**可接受输入**（`:not([data-phase='inert']):not([aria-disabled])`）读作「说说要做什么」。**有会话但拒绝输入**（`[aria-disabled]`）读作「暂时无法输入」：`placeholder.unavailable`——会话不可用 /「Session unavailable」——与 `placeholder.parentOffline` 都落在这一支，它们是决策②的禁用词汇，位于任何插件都无法注册、任何组合都无法改名的命名空间，并且在每一次打开或切换对话、输入 face 还没到达的那个窗口里都会出现。这次替换保留了访客需要知道的事实，去掉了那个词；代价是这几种状态之间的区别没了，而被抬起的阻断态一旦随 `ui-model-selection` 回来，它自己的理由也会被同样地盖住。**没有连接工作区的不可用输入框**则原样不动——它带 `data-phase="inert"` 而不带 `aria-disabled`，因为在工作区选择触发器还活着的时候 `editorDisabled` 会退化成 `removed`——因为它的占位文字是唯一在说明输入框为何不可用的东西。替换后的文案带的是 `var(--dsh-content-font-size, 14px)`，也就是输入框卡片自己设置的那个 token，因此它跟随设置里的字号偏好。这个元素本来就是 `aria-hidden` 的，`[data-composer-input]` 上的 `data-placeholder` 与 `aria-label` 则有意保持不动。

## Alternatives considered

**`ui-chat.transcriptView`，那个看上去就是为此而生的设置。** 它一个目标都够不到。它的取值联合恰好是 `'normal' | 'compact'`（`packages/client/ui-chat/src/chat-settings.ts:12`），而 `'compact'` 已经是默认值，因此控制台今天就已经停在隐藏最多的那一档上。`compact` 是折叠而不是隐藏：成员会拿到 `hidden="until-found"`，浏览器页内查找的 `beforematch` 会把折叠盘重新打开（`searchable-hidden.ts:21-28`）。它也从不作用于运行中的轮次——`ChatNodeSeat.tsx:63-69` 的 `processWindowReady` 要求 `turnClosed` 与完整加载的历史。而且本次改动所触及的行里有三种在 `compact` 下从构造上就是可见的：`system-prompt`、`turn-process` 与 `turn-tail` 属于 `TURN_PROCESS_INDEPENDENT_KINDS`（`contract/turn-process.ts:20-27`），折叠根本不会碰它们。组合层也钉不住它：`SettingsRegisterOptions` 只提供 `base`，而 `base` 输给用户层（`packages/settings/settings/src/index.ts:739-748`），并且 `ui-chat` 注册它的 schema 时没有给 `base`，也没有暴露 `Config`，所以为它写一行 cordis.yml 根本没有键可写。

**为占位文案与指示器文案注册一份控制台词典。** `LocaleRuntime.register` 对重复的 namespace/locale 对会直接抛错（`packages/client/locale/src/client/index.ts:381-400`），而 `dsh-client-ui-conversation` 已经同时占住了 `conversation` 的 `zh` 与 `en`，因此第二个注册方会在 apply 期失败。整套控制台语言（`addLanguage` 加一个 `zh` 回退、只携带被覆盖的那几个键）是合法的，而且连 `aria-label` 也会一起改掉，但它劫持了语言选择：新语言会出现在控制台仍然保留的 Settings → General 语言行里，需要一次持久化的 `setLocale` 写入，需要一个 `en` 同胞，而访客切回普通中文就又拿到上游那句。它还会让 `apps/web/tests/server-sidebar.e2e.ts` 里十一个 `composer(page, …)` 定位器与 `content-perception.e2e.ts` 里的一个全部改键。

**用一个客户端 effect 去改文本。** React 会把两个载体都覆盖掉：占位文案是某个组件的 React 子节点，而该组件在每一次按键触发的 `empty` 翻转、每一次 locale 版本号跳动时都会重渲染；`data-placeholder` 则是每次渲染都被 React 协调的受控属性。这条路要靠一个 MutationObserver 循环才走得通。

**直接改 `packages/client/ui-conversation/src/client/locales.ts`。** 在组合层或插件层有答案的地方，这个 fork 禁止改上游；而且波及面是 `snapshots/**` 下 46 份、`apps/web/tests/expected/**` 下 14 份携带已建立态占位文案的既有 golden，外加多数 web 用例都在用的两个 support 辅助函数。

**取走整个动作行，或者用 `aria-haspopup="dialog"` 够到那两枚药丸。** 整行隐藏是更稳的选择器——`[data-turn-tail] > [class*="actions"]`，一个有属性锚点的直接子元素——但它会把复制、点赞/点踩、分支与时钟连同指标一起取走，而产品要保留这些。`aria-haspopup="dialog"` 看起来像是单独够到药丸的语义把手，其实不是：`dsh-client-ui-message-feedback` 的备注展开按钮（`MessageFeedbackActions.tsx:263-270`）也带着它，一旦存在评分就坐在同一行里，并且属于被保留的点赞/点踩那组操作。于是只剩 CSS module 的类名子串这一个隔离手段，这也正是 e2e 既读隐藏、也读保留的原因。

## Consequences

- 每一条新增的 `display: none` 都会扩大本包那两处整页禁用词筛查的盲区：`workspaceWordsInChat` 与落位页的 `body.innerText()` 扫描读的都是渲染出来的文本，因此只落在某个被隐藏的过程行内部的禁用词汇，两处都不会拦下。这两个辅助函数保持原样——把它们收窄成读原始 DOM 文本，反而会把守卫有意隐藏的那些上游字符串标红，而容忍这些字符串正是它们当初写成这样的原因。
- 无障碍的表现与隐藏完全一致：`display: none` 会把一整棵子树同时从无障碍树、页内查找与 `innerText` 里拿掉，因此屏幕阅读器拿到的与视力正常的访客拿到的是同一列内容。唯一的错位在占位文案：那里的替换只作用于绘制，`[data-composer-input]` 的 `aria-label` 仍然念出上游那句英文，连同其中的禁用词汇。本包 README 的「已知限制」把这两件事都记了下来。
- 在这份组合里，新的命令规则盖过了 `content-frame` 与 `content-column` 自己那两张 `[data-chat-flow-kind="command"]:has([data-slot="conversation.chat.commandview"]:empty)` 样式表。这两个包本身没有变动：它们都能在没有 `server-sidebar` 的情况下被组合（`apps/web/tests/server-layout-content.overlay.yml`），在那里它们那条更窄的规则仍然是唯一的一条。
- 中间态的助手正文依然会出现，这是决策的一部分：它是 `assistant-step`，与最终答案同属一个 kind，而唯一能把两者分开的属性（`data-turn-process-member`）只在轮次已关闭且历史完整加载时才存在。隐藏它就等于隐藏「保留清单」明确要保留的正文。
- 回复页脚保留了复制、点赞/点踩、分支与它的时钟；用户消息自己的复制按钮与时钟（`MessageItem` 的 `MessageIconActions`，与回复页脚是不同的席位）本就不在范围内。两行里消失的都只有那两枚统计药丸。
- **模型可见面没有任何变化。** 这是一个客户端插件里的浏览器 CSS：不涉及系统提示词、工具 schema、会话事件或模型请求。`pnpm run test:snapshot snapshots/console` 无需更新；web 通道的 aria golden 也不受影响，因为每一个携带 golden 的用例跑的都是从不插入 `server-sidebar` 的组合——`apps/web/tests/server-sidebar.e2e.ts` 既没调用 `captureStableAria`，也没调用 `compareOrRefreshGolden`。

## Testing

`packages/experimental/server-sidebar/tests/terminology-guard.client.spec.ts` 按每条新规则所耦合的那个字面选择器逐条断言，这是该文件既定的做法：八个 kind 选择器、`think` 属性、页脚的 `:has(> [class*="trigger"])` 那一对——外加断言直接子元素形式与后代形式的 `actions` 写法都不存在，因为其中任何一种都会取走这次决策要保留的控件——占位文案那一对连同它的文案，以及指示器那一对连同它的文案、中和后的填充色，和「深度求索」的缺席。

`apps/web/tests/server-sidebar.e2e.ts` 新增第四个 describe，在完全不发生模型调用的情况下驱动装配好的控制台。它播种一个封闭轮次，其中带有一条 `request/header`、一条来源为插件的注入上下文 `user/message`、一条已排期的 `llm/retry`、一段推理、一次 `content_read` 调用、一次 `write` 调用、一个中间步骤，以及位于更晚一个步骤里的纯文本答案——正是这一点让轮次变得可折叠——随后在 `turn/end` 之后再播种：一条 `feedback` 命令（它的名字没有任何 `conversation.chat.commandview` 认领，因此 `GenericCommandCard` 会真的画出来）、一次 `/goal` 命令运行、一次 `tool-workflow` 运行，以及两种压缩行：只用一条替换检查点得到 `compaction`，用一条通过 `sourceCommandId` 与 `/compact` 运行相关联的检查点得到 `manual-compaction`；两者各自遮蔽一条一次性的上下文消息，因为 surface 的 `replace` 必须指名一个真实的 surface 节点区间，并在 `sourceEventSeqs` 里把它列出来。十一种被隐藏的 kind 里有十种是这样播种出来的。**`unknown` 是唯一做不到的那一种**：`isAppendSurfaceEvent` 只接受 `user/message`、`assistant/message` 与 `tool/result`（`packages/core/session/src/surface.ts:22-26`），而 `ui-chat` 注册的 Definition 无条件地匹配这三者，因此它自己的兜底在这份组合里永远不会触发；它改由单元用例钉住。随后场景读页面：每一行被隐藏的行都既存在，计算出的 `display` 又是 `none`；`content_read` 那一行在它的席位内部被隐藏；两枚指标药丸消失，而复制、分支与时钟仍在屏幕上；产出文件尾巴与它的文件药丸可见；两种输入框状态下占位文案渲染出的 `::after`，同时 `composer(page, …)` 仍然靠那个未被触及的上游属性解析得到；一张审批卡片可见且内部没有任何 `data-chat-flow-kind`，由一次直接的 `ctx.approval.request` 驱动，针对的是该用例自己开启又关闭的一个轮次；以及指示器可见、已改写文案、已脱离渐变。零工作区那个 describe 钉住的是占位文案作用域的另一半：在那里该元素保留自己的字号，且根本不渲染 `::after`。

其中若干项需要新的 `expectGuardHidesSelector` 辅助函数的第三半——既存在、不可见，**且**计算出的 `display` 是 `none`。`compact` 本来就会把工具行与思考行折进 `hidden="until-found"`，那同样读作不可见，因此只断言「存在且不可见」的话，把本次改动的规则全删掉也照样通过。每一条新规则都对着一次刻意破坏的构建核对过，并且每次都重建了 client face，因为浏览器加载的是 `lib/client.js` 而不是源码：去掉 `[data-chat-flow-kind="tool-call"]` 后，该席位计算出的 display 变回 `block`，而它 `isVisible()` 那一半仍然报 `false`；去掉 `"context"` 或 `"model-retry"` 同样变回 `block`；去掉页脚那条规则后，药丸的外层包裹报可见。把页脚规则重新放宽成整行隐藏，药丸那条断言同样失败——在被隐藏的祖先之下，包裹自身的 display 仍是 `inline-flex`——而在窄规则之外再加一条整行隐藏，则改为让「保留」那半失败，于是两个漂移方向都被覆盖。评审之后新增的那几条规则以同样方式被区分（`command-input`、`workflow-run`、`compaction` 与 `manual-compaction` 各自被移除时，都会让它自己那条 kind 断言失败），而把占位文案规则的作用域退回成裸的 `[data-composer-placeholder]`，会让零工作区那条断言以 `expected '0px' not to be '0px'` 失败。联合本身的穷尽性是编译期检查而非运行期检查：把 `workflow-run` 从用例的两份清单里都删掉，`tsc -b tsconfig.client.json` 会报 `Type 'true' is not assignable to type "workflow-run"`。拒绝输入时的那次替换只在用例层面被钉住：`!live` 是「会话 id 已存在但输入 face 还没到」的那个窗口，`removed` 只持续到外壳重新落位为止，`parentOffline` 需要一个可续的 subagent，而阻断态的生产者已被禁用——没有一种是无密钥场景能让它停住不动的状态，因此改由单元用例钉住这条规则的字面文本，以及两条占位文案规则互补的作用域。

审批卡片无法只靠日志播种出来，运行中的轮次也一样。审批是通过 `ApprovalService.request` 直接发起的，它经由组合好的 `approval/request` 瀑布抵达浏览器，与一次工具发问走的是同一条路。运行位则是绑定在真实 Agent 执行上的 Host 推送（`api-session/status`，由 `agent/status` 在 `packages/api/session-controller/src/index.ts:175` 发出），因此场景自己发出这一个声明过的远端事件；它下游的一切——组件、样式表、绘制——都是真的。
