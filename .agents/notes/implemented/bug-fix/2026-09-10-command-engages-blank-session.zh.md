# Agent Note: 独立命令让它运行所在的会话转正

Status: implemented

[English](2026-09-10-command-engages-blank-session.md) | 中文

## Problem

在全新会话里把 `/btw <问题>` 作为第一条消息发出去,窗口看起来什么也没发生。host 执行了命令也记了日志——验收会话的日志里 `command/run` 在 seq 3、`command/done` 在 seq 4——但中栏仍停在欢迎页,不渲染任何命令卡片,侧栏也从头到尾没有列出这个会话。想看到命令跑过的唯一办法,是随后再发一条普通消息。

每一处界面读的都是同一个位。[`packages/api/session-controller/src/list.ts`](../../../../packages/api/session-controller/src/list.ts) 的 `applySessionListMetadata` 只在 `turn/start` 上把 `blank` 折下来,别的一律不折,因此只跑过命令的会话在 host 摘要里仍是 `blank: true`。客户端这边,只有 `Session.prompt()` 会降低本地镜像,而 [`packages/client/ui-commands/src/client/service.ts`](../../../../packages/client/ui-commands/src/client/service.ts) 的 `CommandUiRuntime.execute` 调用 `ctx.remote.commands.execute` 时,从不触碰这条命令所寻址的那个 `Session` 对象。

其余后果都由这一个位派生:`conversationPhase` 停在 `'blank'`,于是 `ConversationRoot` 保留欢迎页、`ConversationSession` 对视图返回 `null`;[`packages/client/ui-workspace/src/client/tree.ts`](../../../../packages/client/ui-workspace/src/client/tree.ts) 的 `sessionVisible` 只在 blank 会话正是当前会话时显示它,切走一次行就没了;`connectWorkspace` 的复用扫描仍把这个会话当成该工作区的临时 New Session,下一次点 `+` 又会把同一个会话交回来。

## Decision

`blank` 的含义是「该会话没有可展示的内容、也没有可寻址的东西」,而一次落盘的命令运行就是可展示的内容。这个位在首个 `turn/start` **或**首个 `command/run` 上落下,系统两侧对此取同一判据。

**host 侧的折叠。** `applySessionListMetadata` 除 `turn/start` 外,也在 `command/run` 上清除 `blank`。取 `command/run` 而非 `command/done` 作为翻转点,是因为执行器在 handler 运行之前就追加了它:受理才是落盘事实,转录把该事件渲染成命令节点的前半段,而一个失败或永不返回的 handler 同样已经产出了一张卡片。新会话还能积累的其余独立事件——`plan/mode`、`session/title`、`permission/preset`、`sandbox/mode`——仍让该位保持竖起:它们记录的是一项设置而不是内容,而且都不自带节点。该单元的 `stateVersion` 由 1 改为 2,因为按旧折叠写下的 checkpoint 行对同一份日志持有旧判决;版本 2 丢弃这些行并重折,这正是让只跑过命令的会话重新打开时不回到欢迎页的那一步。

**客户端的镜像。** blank→false 的翻转从 `prompt()` 里搬进 `Session.markEngaged()`,并发布到对外的 `ISession` 面。它的契约就是 `prompt()` 本来依赖的那一条:镜像只降不升,所以调用方必须已经握有 host 的受理。`prompt()` 在受理分支上照旧调用它;`CommandUiRuntime.execute` 在 execute RPC 返回已匹配结果后,经 `ctx.sessions.binding(sessionId)?.session` 调用它。handler 报错的结果同样转正,与 host 一致;而未匹配的行——它从未进入 handler、也没记任何日志——让会话保持 blank、隐藏且可复用。没有本地绑定的会话直接跳过:下一次列表拉取时,host 摘要携带同一判决。

`markEngaged()` 不设置发送标记、也不欠下首个 turn,因此只跑过命令的会话报告 `blank: false, promptAttempted: false, awaitingFirstTurn: false`,而 `conversationPhase` 在 RPC 落定后的第一帧就把它解析为 `'active'`。

## Testing

[`session-list-blank.host.spec.ts`](../../../../packages/api/session-controller/tests/session-list-blank.host.spec.ts) 用真实 `Session` 驱动该投影:配置事件族让摘要保持 blank,一次命令生命周期清除它,首个 turn 也清除它;另有两组直接折叠钉住 `command/run` 是翻转点而 `command/done` 不是,以及已清除的位保持落下。[`session.client.spec.ts`](../../../../packages/api/session-controller/tests/session.client.spec.ts) 钉住 `markEngaged()` 本身——降下的位不带发送标记、不带待办首 turn,以及两次调用只触发一次 `onEngaged`。[`service.client.spec.ts`](../../../../packages/client/ui-commands/tests/service.client.spec.ts) 钉住调用方:已受理的行让被寻址会话转正,handler 报错同样转正,未匹配的行与失败的调用都不转正,未绑定的会话被跳过。[`skeleton.client.spec.tsx`](../../../../packages/client/ui-conversation/tests/skeleton.client.spec.tsx) 钉住相位与渲染出的外壳——只以一次已执行命令为内容的会话是 `'active'`,且不显示欢迎页。

没有任何录制会话快照记录该投影版本或摘要的 blank 位;`pnpm run test:snapshot` 不因本修复而变化。

## Alternatives considered

**只翻转客户端镜像,不动 host 折叠。** 这是更小的改动,而且能修好发送方那一端。它也只能修好发送方那一端:侧栏的行、其他每一个端、以及明天重新打开的同一个会话,读的都是在 host 上算出来的 `SessionSummary.blank`。只跑过 `/btw` 的会话会离开欢迎页,直到页面刷新后又回去。

**改在 `command/done` 上清除 `blank`。** 它按「已完成的命令」而非「已开始的命令」翻转,看起来是更保守的选择。就该位的含义而言这是错的事件:转录已经显示了那次运行,而失败、被取消、或把 `command/done` 落在后面的命令,会让欢迎页盖在一张已经在屏幕上的卡片之上。

**在 `blank` 之外给摘要加第二列——「有东西可展示」——并让 `blank` 继续以 turn 为准。** 这样能原样保留 `connectWorkspace` 复用与列表可见性,同时让对话外壳离开欢迎页。三个消费方对只跑过命令的会话想要的是同一个答案:它应当被列出、应当打开在自己的转录上、且不应当被当作 New Session 交回。加第二列会逼每一个消费方各自选读哪一位,而两位从此必须永远保持一致。

**把 `stateVersion` 留在 1。** 状态的形状没变,schema 仍然校验得过。变的是折叠,而这恰恰是版本所守护的:按版本 1 checkpoint 过的会话会从缓存行拿到旧的 `blank: true`,重新打开在欢迎页上。

**复用 `promptAttempted` 作为转正闩。** 它本就能扛住列表拉取带回的陈旧 `blank: true`,在 `markEngaged()` 里顺手设上就能白得一层加固。它的含义是「尝试过一次发送」,并驱动 composer 的 `engaging` 相位;而命令不尝试任何发送。manager 的 `engaged` 列表变更本就会在飞行中的 `session.list` 基线上重放,那正是这层闩本来要覆盖的情形。

**点名哪些命令算数——在折叠里放一份名单。** `/btw` 产出可见回答,而 `/plan` 与 `/permission` 翻转的是一项 header 上已经显示的设置。把一份命令名单放进投影里,等于在唯一必须保持纯折叠的地方引入随部署而变的可调项,而且它会与转录唱反调——转录为其中每一个都渲染了节点。

## Consequences

只以命令为内容的会话现在是一个普通会话:它占一行侧栏、打开在自己的转录上、也不再是工作区连接会复用的那个临时 New Session。这对每一个 host 命令都成立,`/plan` 与 `/permission` 也在内——在首条消息之前翻转 plan 模式,现在会让该会话浮现出来,并让下一次 `+` 多花一个新会话。这是转录自己的判决:那些运行本就渲染了一个命令节点。

`command-feedback` 失去了它记录在案的那条限制。在全新会话上执行 `/feedback` 现在会渲染确认行,因为会话在记下该命令的同一次受理上离开了欢迎页。

预设切换在 host 侧不受影响:`agentPresets.select` 以 `turnBoundary` 投影为闸,而任何命令都不触碰它,所以只跑过命令的会话仍可重新组合。客户端待用预设的施加者确实会在它看作非 blank 的会话上丢弃暂存,但可交互的 chip 占的是 `conversation.hero.agentPreset` 位,欢迎页一走它也就没了,因此人无法在一个刚跑过命令的会话上走到那条路径。

每一行已缓存的 `sessionListMetadata` 都会被丢弃一次,发生在升级后的首次列表读取。受影响的会话从各自的日志重折,下一次 checkpoint 按版本 2 重写这些行。
