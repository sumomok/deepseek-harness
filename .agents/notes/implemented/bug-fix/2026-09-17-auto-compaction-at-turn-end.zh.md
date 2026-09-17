# Agent Note: 自动压缩挪到一轮结束之后

Status: implemented

[English](2026-09-17-auto-compaction-at-turn-end.md) | 中文

Related: [自动压缩的实时策略位](../feature/2026-09-14-auto-compaction-policy-seat.zh.md) —— 用的就是那个位子，位子本身没动；改的是随附桌面组合现在经它答 `false`。

## Problem

`BasicCompactionEngine` 把自动压力压缩注册在 `agent/pre-step` 上，而那个 listener 跨步没有记忆。每一种失败——摘要调用失败、稳定性重验证拒绝、缩小量不够——都被接住、写一条 `ctx.logger.warn(… continuing the turn)`、然后丢掉；下一步又对着同一段对话、同一个阈值、同一个正在坏掉的摘要模型再调一次 `compactIfNeeded`。`warnedPressureConfigTargets` 压住的是配置错误目标的重复**消息**，不是重复的尝试。于是负责摘要的模型一旦宕机，这一轮跑多久就付出多少次全前缀请求；而自 rc.33 的失败卡起，每一步还在对话里叠一张通知。客户端 `compactionDefinition` 已经把这种叠加写成自己压不掉的限制：每次压缩都是以 `compactionId` 为键的独立 Context，引擎侧也没有任何退避可供 Definition 观察。

即使不失败，这个时机对终端用户也是错的。压缩是对着对话前缀的一次完整模型调用，所以正在被读的那段回答会停住，停多久就是那次调用多久，而且停在用户正看着的工作中间。

## Decision

桌面组合里的 `@haoran/dsh-auto-compact`（0.2.0，以 tarball 形式进仓）把触发挪出了一轮之内。harness 的包一个都没改。

它的 `compactionPolicy.isEnabled()` 现在恒答 `false`。这正是这个位子被文档化的含义——`compaction-basic` 只用它门控压力路径，溢出恢复被刻意排除在外，因为那里提供方已经拒过请求——所以一个常量就关掉了两步之间那条路，零核心补丁。

插件随后从一个 `agent/status` listener 触发自己的压缩，并且只在 running→idle 的转换上动作：读 `ctx.sessionProjections.snapshot(session, ['contextPressure']).values.contextPressure`，拿 `projectedTokens ?? pressureTokens` 除以 `contextWindow`，与用户设的比例相比，然后调 `ctx.compaction.compactNow(agent, signal)`。读数就是用量环自己那个 wire 值，也是 `occupancyTokens` 取的那一个；没有用量样本、或者路由容量未知的会话没有读数，也就不触发——环在那里同样什么都不画。

`compactNow` 是已发布的空闲入口。它经 `runMaintenance` 占住 agent 的空闲相位，所以后到的唤醒输入是排在压缩后面而不是与它抢；它的 `sourceCommandId` 是可选参数。不带这个参数的调用写下的是普通的 `compaction/start` / `summary` / `end` 标记对、不带 `sourceCommandId`，而这恰好就是 `compactionDefinition.match` 认领的东西——于是成功的一次渲染既有的检查点卡、失败的一次渲染既有的失败卡，不需要新会话事件、不需要新的客户端节点 kind，插件自己也不画任何卡。

每轮结束只试一次，同一个 agent 上同时只有一次，而且下一次读数要等下一轮结束才取。这段间隔就是 pre-step 那条路缺的退避：失败的那一次、或者压完仍然超过比例的那一次，都等新工作来，而不是立刻重来。

## 随附行为付出的代价

`compactNow` 以 `retainTokens: 0` 选范围，所以它不留原样的尾巴——到最后一个可切分边界为止的对话变成一条摘要，幅度就是 `/compact` 的幅度。pre-step 那条路会留一截由 `retainRatio`/`retainTokens` 定长的尾巴，因为它是在给一个马上要发出去的请求腾地方；这一次不是。所以设在 60% 的用户现在拿到的是更彻底、更靠后的一次压缩，而不是更早、更局部的一次。插件 README 双语两侧都写了，desktop-shell 的内置插件表也写了。

`isEnabled()` 恒答 false 时，随附组合里没有任何读者会读 `thresholdRatio()`，因为读它的只有压力路径。位子的两个方法都留着：它是一个已发布的键，想要这个比例的后端仍然读得到实时值。

一轮正在跑时打的 `/compact` 仍然当场失败，也不会在 agent 空下来时重跑。`ManualCompactionErrorCode` 从不离开进程——`command/done` 只带 `kind: 'error'` 和 handler 渲染出来的英文文本，而且没有任何针对命令结束的 Context 事件——所以 `busy` 没有任何持久证据能与早期取消区分开。结构性代理（该 `commandId` 没有对应的 `compaction/start`）同样匹配取消，而把用户取消掉的压缩重跑一遍，比不重跑一次被拒的压缩更糟。

## Alternatives considered

**从空闲路径调 `compactIfNeeded(agent, 'pressure', signal)`。** 这本可以保住尾巴和按模型的策略合并。否决，因为它是为一轮之内写的：`compactRegion` 传的是 `owner: 'current-turn'`，而会话没有打开的轮次时 `compactSurfaceRegion` 直接抛。它也不占维护相位，所以一条唤醒消息可以在摘要跑着的时候把一轮开起来。

**在 `compaction-basic` 里加退避。** 按 fork 的铁律否决。这是插件层的问题、有插件层的答案，而压缩族本来就是上游冲突面最活跃的那套补丁；给 `compactIfNeeded` 加跨步状态，意味着每一轮滚动同步都要重新移植一遍。

**触发留在两步之间，由插件去压制尝试。** 做不到：`isEnabled()` 对整条压力路径只有开和关，而且没有任何信号告诉插件某个 agent 上的某次尝试失败了。靠 `compaction/end` 的文本去猜、再去翻一个全局开关，是拿用户可见的代价做猜测。

**新增一个会话事件承载自动触发的结果。** 与失败卡当初否决它的理由相同：`Session.append()` 没有任何途径把 envelope 标成 `ignorable: true`，所以一个只有 fork 才有的必需事件会让不认识该类型的构建把日志读成砖。

## Consequences

桌面线现在在回答写完之后压一次，按用量环显示的那个数字判断；摘要模型坏掉时，代价是每轮一次尝试、一张卡，而不是每步一次。harness 自己的溢出恢复没动，harness 的包也一个没动：改动是那个进仓的 tarball、它的依赖行、生成的第三方声明，以及内置插件表里的一行。插件仓的 `packages/auto-compact/tests/idle-compaction.spec.ts` 用 19 条用例钉住了转换规则、阈值边界、开关、单飞门，以及每次失败只记一行日志。
