# Agent Note: An open automatic compaction bracket owns a row

Status: implemented

[English](2026-09-18-auto-compaction-running-card.md) | 中文

## Problem

自动压缩把一段历史摘要后替换掉，而写出摘要的那次模型调用要花上数秒。替换落地之前，对话里什么都不显示：标记对打开期间 `compactionDefinition.buildViewNode` 返回 null，看着对话的人只看到一段没有缘由的停顿。同一笔事务由人手动发起时，从敲下 `/compact` 那一刻起就一直显示 `正在压缩…`，于是同一件事在人主动要求时清晰可读、在引擎自己发起时不可见。

本 fork 让这个缺口成为常态。[自动压缩策略位](2026-09-14-auto-compaction-policy-seat.zh.md)允许部署方调低触发阈值，随附插件正是这么做的，因此一次长会话里自动标记对会打开好几次。

## Decision

`compactionDefinition` 发出第三种节点类别。一个 Context 只要有自己的 `compaction/start` Match、没有 `compaction/end` Match、也既无已落地检查点又无已记录失败，就产出锚在 start 事件 seq 上、可见的 `compaction-running` 行。该类别不带载荷：文案是固定的，渲染位置就是节点的 `anchorSeq`，`data` 已无内容可携带。

替换落地后，同一个 Context 改为在检查点的 seq 上发布既有的 `compaction` 标记。该标记本就按 `compaction/summary` 事件携带的 `shadowedSeqs` 与 `shadowedTokenCount` 写出「已压缩 N 条历史记录（约 X tokens）」，并仍可展开后端写下的摘要。已落地那条路径零改动，因此历史标记对的渲染与改动前完全一致。落地的同时节点的 `anchorSeq` 也从 start 事件的 seq 变为检查点的 seq，而这两者之间的事务不追加任何由别的 Definition 渲染的事件，中间排不进任何东西，所以这一行不会移位。

这一行是 node 为 null 的 `CompactionItem`——与已落地标记同一个元素、同一组图标、同一份样式表，只是换成运行态标题、旁边不带摘要段。文案取手动卡自己的 `message.compaction.running`，视觉隐藏的状态播报取共用的 `row.running`；本次改动不新增任何 locale 键。

这一行需要的两个事实都在 Match 而不在 State 上。打开那一个是引擎持有的 `context.start`，因此 `bracketClosed` 就在它旁边从 `context.matches` 读闭合的 `compaction/end`。State 仍旧承载它原本承载的摘要、检查点与失败证据。

**取消与被抛下。** Stop 会用一条带 abort 措辞的 `compaction/end` 闭合标记对。`failureReason` 把这种措辞读作取消、不记为失败，于是这一行不再显示——但它是靠「用同一个 key 发布 `visibility: 'hidden'` 的节点」停止显示的，不是靠返回 null。实时尾部按 key 构造 upsert，会拒绝一个撤回自己已物化目标的 Definition，而这次拒绝抛在 `flush` 清空脏集合之前，此后每一条新事件都会被挡在视图之外。标记对还开着而它自己的 step 或 turn 先关闭时，走同一个隐藏出口：`bracketAbandoned` 读的正是工具卡 `interruption()` 读的那个位置状态。因真实错误闭合的标记对显示失败提示，该提示优先于运行行。

**窗口与未闭合的标记对。** 从未加载 `compaction/start` 的窗口没有 State，`fallbackState` 只从 Match 推导证据；没有 start Match 就没有任何证据表明标记对是打开的，而处于这种状态的 Context 也从未发布过节点，所以返回 null 撤不掉任何东西，这种窗口一如既往只显示已落地标记或失败。日志停在打开的标记对里——宿主被杀、机器断电——这一行在所在轮次关闭的那一刻消失，用的正是未完成工具调用读的同一个闭合信号：agent-loop 续跑会为「最后一轮从未结束」的存档日志补写带 `interrupted` 原因的 `turn/end`，session-query 冷读时也会合成一条。

**已知限制。** 记录在任何轮次之外的标记对——`compaction/start` 的 `turn: null`，由 idle 路径写出，且只有在调用方不指名来源命令时才会到达本 Definition——落到 `session` 位置，而横跨整个会话的位置永不关闭。宿主在这种标记对进行中被杀时，该会话重开后会保留一行「正在压缩…」，直到该标记对在日志里得到闭合。另一条路是让 Definition 为引擎并不记录的生命周期编造一个闭合信号。

`compaction-running` 不向 `chat-snapshot-builder.ts` 里的旧版对话节点流贡献任何东西。它在那里与 `turn-tail`、`system-prompt` 并列登记为「已知但不贡献」的行，于是那个 switch 的默认分支保住了它自己的含义：本次构建不认识的类别。

**退役条件。** 上游以任何形式为打开中的自动压缩标记对渲染出任何东西即退役。机械判据是 `git grep -n compaction-running upstream/master`，零命中即未退役。直到 0.1.6-alpha.2，上游的 `buildViewNode` 在没有已落地检查点时仍返回 null，其 `CompactionItem` 仍只接受非 null 的 node。移植面就是失败卡每轮滚动同步都要重新移植的那一片客户端 UI：`compaction.ts`、`CompactionItem.tsx`、`MessageItem.tsx`、`register-node-renderers.ts`、生成物 `slot-catalog.ts` 与该包的 README 双语对。

## Alternatives considered

**把 `compaction` 类别的载荷放宽成 `CompactionSummaryNode | null`。** 否决：`chat-snapshot-builder.ts` 的 `legacyContribution` 会把 `compaction` 节点的 `data` 原样推进旧版对话节点流，null 载荷会在那里放进一个 null 节点。单独一个类别在该 switch 里登记为「已知但不贡献」的行。

**给运行类别一份载荷。** 否决：两个候选字段节点上都已经有了——`id` 就是 `compactionId`，`anchorSeq` 就是 start 的 seq——而卡片两个都不显示。

**把闭合的 `compaction/end` 记在 State 里、挨着失败 Match。** 否决：同一个事实的另一半是引擎持有的 start Match，这样会把一对事实拆到 State 与 Context 两处，而且窗口路径会背上一个它永不读取的字段。

**像手动卡那样用 `GenericCommandCard` 渲染打开中的标记对。** 否决：这里没有命令，卡片的标题没有名字可取、摘要没有结算文本可取，而且这一行不会变成替换它的那个已落地标记。

**让自动压缩写一条 `command/run`、整个复用手动路径。** 否决：command 事件断言有人运行了一条命令，会话日志会因此记下一件没人做过的事。

**在这一行上显示触发原因或上下文占比。** 否决：这一行陈述正在发生什么。引擎为何发起是一条策略事实，与人能对此做什么无关。

## Consequences

一次自动压缩在整个生命周期里都可读：运行中，然后是带计数的已压缩，或者被失败提示取代，或者在 Stop 取消后消失。标记对打开期间 transcript 多出一行；已收束的标记对为自己的 key 留下一个隐藏节点，代价是节点表里一个条目、零次渲染。每次压缩各自成一个 Context，因此摘要器连续几步都不可用时会留下好几行，这一点失败卡的 Note 已经记作已知限制。

## Testing

`packages/client/ui-chat/tests/conversation-node-definitions.client.spec.ts` 钉住 Definition：标记对打开时出一行、摘要写出后到检查点落地前这一行仍在、已落地标记带计数取代它、取消后这一行转为隐藏、出错后无行、轮次还开着时这一行可见、该轮次不带闭合标记对就关闭后这一行转为隐藏、没有 start 的窗口不出行、手动标记对交给命令卡。`live` helper 逐条走 `append` 再 `flush`——整窗重放从不走的那条路径——把取消、落地、失败三条都钉在实时尾部上；取消那一条还断言其后的用户消息仍能渲染。`packages/client/ui-chat/tests/compaction-running-row.client.spec.tsx` 钉住这一行本身：中英两种文案、不可展开的禁用按钮、隐藏的运行态播报，以及已落地标记未变的计数与展开。
