# Agent Note: 命令自己声明它是否让所在会话转正

Status: implemented

[English](2026-09-10-command-engages-blank-session.md) | 中文

## Problem

在全新会话里把 `/btw <问题>` 作为第一条消息发出去,窗口看起来什么也没发生。host 执行了命令也记了日志——验收会话的日志里 `command/run` 在 seq 3、`command/done` 在 seq 4——但中栏仍停在 Intent 欢迎页,不渲染任何命令卡片,侧栏也从头到尾没有列出这个会话。想看到回答的唯一办法,是随后再发一条普通消息。

每一处界面读的都是同一个位。[`packages/api/session-controller/src/list.ts`](../../../../packages/api/session-controller/src/list.ts) 的 `applySessionListMetadata` 只在 `turn/start` 上把 `blank` 折下来,别的一律不折,因此只跑过命令的会话在 host 摘要里仍是 `blank: true`。由此:`conversationPhase` 停在 `'blank'`,于是 `ConversationRoot` 保留欢迎页、`ConversationSession` 对视图返回 `null`;[`packages/client/ui-workspace/src/client/tree.ts`](../../../../packages/client/ui-workspace/src/client/tree.ts) 的 `sessionVisible` 只在 blank 会话正是当前会话时显示它,切走一次行就没了;`connectWorkspace` 的复用扫描仍把这个会话当成该工作区的临时 New Session。

而对每一次命令运行都清除该位,错在另一个方向,并且错处正落在 Intent 欢迎页上。欢迎页自己的访问模式 chip 运行的就是 `/permission`（[`PermissionSelect.tsx`](../../../../packages/client/ui-permission-presets/src/client/PermissionSelect.tsx) 经 `ISession.command`）,`/plan` 同样是在配置 agent。会话若因这些命令转正,人在为一个尚未开始的会话设置访问模式的那一刻就失去欢迎页——而欢迎页是工作区选择器与 agent 预设 chip 唯一存在的地方（[`ConversationRoot.tsx`](../../../../packages/client/ui-conversation/src/client/skeleton/ConversationRoot.tsx);会话一旦非 blank,[`seat-store.ts`](../../../../packages/client/ui-agent-preset/src/client/seat-store.ts) 就直接丢弃待用预设）。让这些命令只在 host 侧清除该位、而没有任何客户端降低自己的镜像,则更糟:标签页保留欢迎页、host 却列出该会话,于是每启动一次就多一条孤儿行——文件夹名作标题、转录里只有一张权限卡片——而 `+` 又在它旁边新建一个。

## Decision

命令自己声明运行它是否让会话转正。[`packages/interaction/commands/src/index.ts`](../../../../packages/interaction/commands/src/index.ts) 的 `CommandDefinition` 新增 `engages?: boolean`,默认 true;`false` 标记的是配置会话、而非为对话贡献内容的命令。注册表只在定义声明过时才把 `engages: false` 写进 `command/run` 载荷,因此该成员在每一次普通运行、以及该声明存在之前写下的每一份日志里都缺席——与 `recordInput` 为自己的退出选项所用的形状相同。

声明写进 `command/run`,是因为它必须活过日志。下面两个读者折叠的都是事件而非注册:一份下周才重新打开的会话,只凭自己日志里写着的内容判定,不需要任何注册表可查。

**分类结果。** 仓内每一处注册及其落点:

| 命令 | 所属包 | `engages` | 理由 |
|---|---|---|---|
| `/permission` | `permission-presets` | `false` | 设置沙箱模式与审批策略。Intent 欢迎页的访问模式 chip 运行的就是它。 |
| `/plan` | `plan-mode` | `false` | 为即将运行对话的 agent 开关 plan 模式。 |
| `/btw` 及其他仓外命令 | — | 默认 | 在转录里回答一个问题。 |
| `/goal` | `command-goal` | 默认 | 渲染一张对话据以展开的富命令输入卡片。 |
| `/feedback` | `command-feedback` | 默认 | 它的确认行就是全部可见结果。 |
| `/compact` | `command-compact` | 默认 | 重写对话;只有已有对话时才够得着。 |
| `/export` | `session-log-export` | 默认 | 为一个已经持有日志的会话给出一行导出结果。 |

**host 侧的折叠。** `applySessionListMetadata` 在 `turn/start` 上、以及载荷未写 `engages: false` 的 `command/run` 上清除 `blank`。取 `command/run` 而非 `command/done` 作为翻转点:执行器在 handler 运行之前就追加了它,转录把该事件渲染成命令节点的前半段,而一个失败或永不返回的 handler 同样已经产出了一张卡片。

**投影版本保持 1。** 折叠变了而版本没变,是有意为之。该单元的状态是同一个行版本下的 `{blank, lastPromptAt}`;`viewCheckpoint` 会丢弃 `ver` 不匹配的行,而冷列表路径从不重折——`summarizeCold` 只从缓存供行,绝不打开会话正文。因此递增版本会让每一个再也不会被打开的会话永久丢掉 `lastPromptAt`,把整个侧栏按创建时间排序与标注,换来的只是订正那些在旧构建下跑过命令的会话的 `blank` 判决。那些会话保留 checkpoint 时的判决——即它们本来就有的现状——而从现在起折叠出来的一切都是对的。

**客户端镜像在事件上转正,不在调用点。** [`session.ts`](../../../../packages/api/session-controller/src/client/sessions/session.ts) 的 `Session.observeEngagement` 跑在本会话自己的窗口上——实时尾部与安装的历史页都算——并在未声明 `engages: false` 的 `command/run` 上降低 blank 位。那是每一个入口共享的唯一信号:经 `ui-commands` 的 composer 键入行、经 `ISession.command` 的欢迎页访问模式 chip 与 `/permission` 弹层、以及自己调用 `remote.commands.execute` 的 `ui-plan`,到达客户端时都只是这一个事件。`markEngaged` 重新变回私有,没有任何命令调用点触碰镜像。

`markEngaged` 同时落下 `engaged` 闩,由 `handleBlank` 查询。没有它,一条在命令落地之前铸出的 `api-session/added` 帧、或一次与之竞速的列表拉取,就会把该位重新抬起:`handleSessionAdded` 是把帧自己的 `blank` 直接透传下去的。`handleRunning` 在首个运行 turn 上降低该位的同一处也落闩,理由相同——那个 turn 会结束,而与之竞速的摘要可以在它结束之后到达。

## Testing

[`commands.spec.ts`](../../../../packages/interaction/commands/tests/commands.spec.ts) 钉住记录下来的声明:声明过的命令记 `engages: false`,普通命令根本不记该成员。[`validation.spec.ts`](../../../../packages/session/session-format-v0-to-v1/tests/validation.spec.ts) 钉住格式边——缺席、`false` 与 `true` 都接受,非布尔值被拒——[`migration.spec.ts`](../../../../packages/session/session-format-v1-to-v2/tests/migration.spec.ts) 钉住该成员活着进入 v2。

[`session-list-blank.host.spec.ts`](../../../../packages/api/session-controller/tests/session-list-blank.host.spec.ts) 用真实 `Session` 驱动该投影:配置事件让摘要保持 blank,已声明的配置命令保持 blank,转正命令清除它,首个 turn 也清除它;另有三组直接折叠把 `engages: false` 与缺席、`true` 对照钉住。

[`session.client.spec.ts`](../../../../packages/api/session-controller/tests/session.client.spec.ts) 在退化过的那条边界上钉住镜像:观察到的转正 `command/run` 只转正一次、不带发送标记、不欠首个 turn;观察到的 `/permission` 运行让它保持 blank;携带该命令的历史页与实时尾部同样让它转正;`ISession.command` 经 Commands 命名空间受理一行、只报告是否有命令匹配,而该位等的是观察到的那次运行（chip 的路径,Commands 的失败原样交回）;`handleBlank(true)` 无法重新抬起已转正的会话。[`service.client.spec.ts`](../../../../packages/client/ui-commands/tests/service.client.spec.ts) 为键入路径钉住反面:一行被受理的命令经该包不到达镜像。[`skeleton.client.spec.tsx`](../../../../packages/client/ui-conversation/tests/skeleton.client.spec.tsx) 本就钉住失去欢迎页的代价——工作区 chip 与 agent 预设座位——现在说明了配置命令为何不得夺走它。

## Alternatives considered

**对每一次 `command/run` 都清除 `blank`。** 该规则不需要声明、不需要载荷成员、也不需要一轮分类。它会在访问模式 chip 与 `/permission` 弹层上关掉 Intent 欢迎页,而那里是工作区选择器与 agent 预设 chip 所在、也是它们唯一所在的地方;人在键入任何内容之前设置访问模式,就会同时失去两者,并且那个尚未开始的会话被列出、也不再可复用。

**在命令调用点转正,而不在事件上。** `CommandUiRuntime.execute` 距离会话只有一行,本修复的第一版正是把翻转放在那里。它只覆盖 composer 的键入行。欢迎页 chip 与 `/permission` 弹层走 `ISession.command`,`ui-plan` 自己调 `remote.commands.execute`——三个入口、三处翻转要与一个 host 折叠保持一致,而任何插件新增的第四个入口都会悄悄与 host 唱反调。

**保留该标志但不写进日志,折叠时读注册表。** 那样投影会去问命令注册表当前这条命令是否转正。折叠必须是纯的、且能在没有注册表的情况下对已存日志重放——冷列表读取没有 agent,而一份在命令改名或卸载之后重新打开的会话,会折出与其转录所示不同的答案。

**把 `stateVersion` 提到 2,让旧行重折。** 这是折叠改变后的常规做法,本修复的第一版也是这么做的。`viewCheckpoint` 丢弃不匹配的行,而只有被打开的会话才重折;`summarizeCold` 从不打开。每一个再也不会被打开的会话都会永久丢掉 `lastPromptAt`,按创建时间排序与标注——整个侧栏可见且永久的退化,换来的只是订正那些在本次构建之前跑过命令的会话的陈旧 `blank` 判决。

**改在 `command/done` 上清除 `blank`。** 它按「已完成的命令」而非「已开始的命令」翻转。转录已经显示了那次运行,因此失败、被取消、或把 `command/done` 落在后面的命令,会让欢迎页盖在一张已经在屏幕上的卡片之上。

**给摘要加第二列——「有东西可展示」——并让 `blank` 继续以 turn 为准。** 这样能让对话外壳离开欢迎页,同时列表可见性与复用保持原样。三个消费方对只跑过命令的会话想要的是同一个答案:被列出、打开在自己的转录上、不被当作 New Session 交回。加第二列会逼每一个消费方各自选读哪一位,而两位从此必须永远保持一致。

## Consequences

只以一条转正命令为内容的会话现在是一个普通会话:它占一行侧栏、打开在自己的转录上、也不再是工作区连接会复用的那个临时 New Session。只跑过 `/permission` 或 `/plan` 的会话则一切照旧——隐藏、可复用、欢迎页完好。

`command-feedback` 失去了它记录在案的那条限制。在全新会话上执行 `/feedback` 会渲染确认行,因为会话在记下该命令的那一次运行上离开了欢迎页。

仓外写的命令按默认转正。这是安全的方向——用户看不见输出的命令正是本次修复的缺陷——但一条只做配置的第三方命令,在其作者声明 `engages: false` 之前会让会话浮现出来。

随桌面壳一起 vendored 的两个 fork 插件保持默认:`@haoran/dsh-llm-permission-gateway` 0.3.1 的 `/review` 与 `@haoran/dsh-screenshot` 0.5.1 的 `/screenshot-logout` 都是配置而非贡献内容。把其中任何一条作为全新会话的第一行键入,该会话就转正——欢迎页关闭、会话带着命令卡片被列出——这正是 `/btw` 的结果:只能由键入到达,host 折叠与客户端镜像结论一致,不产生孤儿行。rc.31 就按现状发布。在这两个插件里声明 `engages: false` 是后续动作,而插件可以安全声明:`normalizeDefinition` 只用它认识的成员组装已注册定义,旧 host 会丢掉该字段而不是拒绝注册。

在本次构建之前跑过命令并已 checkpoint 的会话,其缓存行里的 `blank: true` 会一直留着。[`session-projection`](../../../../packages/session/session-projection/src/index.ts) 的 `viewCheckpoint` 只在行的 `ver` 与单元 `stateVersion` 不匹配时丢弃它,而 `restore` 从可用行播种、只折叠该行 `seq` 之后的事件——所以重新打开不会重折 checkpoint 之前的任何东西,一个唯一的转正事件早于本次构建的会话,会一直对列表隐藏、一直可作为工作区的 New Session 被复用,里面装着那张命令卡片,直到新的转正事件落下为止。这是把 `stateVersion` 保持在 1 所接受的代价——正是保持在 1 才让每个再不打开的会话留住 `lastPromptAt`。

转正命令不开启 turn,因此这次翻转没有任何东西推给列表的其他读者:`api-session/status` 只带运行位,而 `api-session/updated` 这样的事件根本不存在（[`remote-events.ts`](../../../../packages/api/session-controller/src/remote-events.ts)）。第二个标签页或客户端——以及本客户端上那个它从未打开过的会话——的列表行会一直是 `blank: true`,直到它下一次 `session.list` 拉取为止;在那之前,`connectWorkspace` 的复用扫描（[`navigation.ts`](../../../../packages/client/ui-workspace/src/client/navigation.ts)）可能把这个会话连同里面的命令卡片一起当作该工作区的 New Session 交回。这是本补丁跨标签页、跨客户端的已知限制,本次不修。

该规则活在两处折叠而非一处:host 投影按类型读 `event.data.engages`,客户端镜像按结构重读同一个成员,因为窗口条目可能是压缩历史记录。客户端那一读带有注释,点名 host 折叠是另外一半。
