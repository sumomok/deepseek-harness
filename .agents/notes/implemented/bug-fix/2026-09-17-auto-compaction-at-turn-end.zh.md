# Agent Note: 自动压缩挪到答完之后

Status: implemented

[English](2026-09-17-auto-compaction-at-turn-end.md) | 中文

Related：[自动压缩的实时策略位](../feature/2026-09-14-auto-compaction-policy-seat.zh.md) —— 那个位子的代码没动；本文对它关于随附桌面组合**什么时候**压缩的那部分陈述构成部分取代。

## Problem

`BasicCompactionEngine` 把自动压力压缩注册在 `agent/pre-step` 上，而那个 listener 跨步没有记忆。每一种失败——摘要调用失败、稳定性重验证拒绝、缩小量不够——都被接住、写一条 `ctx.logger.warn(… continuing the turn)`、然后丢掉；下一步又对着同一段对话、同一个阈值、同一个正在坏掉的摘要模型再调一次 `compactIfNeeded`。`warnedPressureConfigTargets` 压住的是配置错误目标的重复**消息**，不是重复的尝试。于是负责摘要的模型一旦宕机，这一轮跑多久就付出多少次全前缀请求；而自 rc.33 的失败卡起，每一步还在对话里叠一张通知。客户端 `compactionDefinition` 已经把这种叠加写成自己压不掉的限制：每次压缩都是以 `compactionId` 为键的独立 Context，引擎侧也没有任何退避可供 Definition 观察。

即使不失败，这个时机对终端用户也是错的。压缩是对着对话前缀的一次完整模型调用，所以正在被读的那段回答会停住，停多久就是那次调用多久，而且停在用户正看着的工作中间。

## Decision

桌面组合里的 `@haoran/dsh-auto-compact`（0.2.4，以 tarball 形式进仓）把触发挪出了一轮之内。harness 的包一个都没改。

它的 `compactionPolicy.isEnabled()` 答 `false`，这正是这个位子被文档化的含义——`compaction-basic` 只用它门控压力路径，溢出恢复被刻意排除在外，因为那里提供方已经拒过请求。插件随后从一个 `agent/status` listener 在 running→idle 的转换上触发：读 `contextPressure`，在服务这个 agent 的那台引擎上调 `compactNow(agent, signal)`——`ctx.get('agentPresets')?.serviceFor(agent, 'compaction') ?? ctx.get('compaction')`，原因见下一节。

`compactNow` 是已发布的空闲入口。它经 `runMaintenance` 占住 agent 的空闲相位，所以后到的唤醒输入是排在压缩后面而不是与它抢；它的 `sourceCommandId` 是可选参数。不带这个参数的调用写下的是普通的 `compaction/start` / `summary` / `end` 标记对，`turn: null` 且不带 `sourceCommandId`，而这恰好就是 `compactionDefinition.match` 认领的东西——于是成功的一次渲染既有的检查点卡、失败的一次渲染既有的失败卡，不需要新会话事件、不需要新的客户端节点 kind，插件自己也不画任何卡。这个组合的检查点一侧在 `conversation-node-definitions.client.spec.ts` 里本来就有用例；本次补上失败一侧，因为「`turn: null` 的标记对带错误闭合」是此前任何发行版都没产生过的事件形状。

每次 driver 退出只试一次，同一个 agent 上同时只有一次，下一次读数要等它下一次退出。这段间隔就是 pre-step 那条路缺的退避。是「每次 driver 退出」而不是「每轮」：`kick` 跑的是 `while (await this.turn())`，所以排队的几条消息会作为连续的几轮在同一段运行里跑完，共用结尾的那一次压缩。

## 引擎在哪个平面上

触发装不到 inject 上，而装错比什么都不做更糟。

`packages/bundle/web-app/cordis.patch.yml` 把 `compaction-basic`、`command-compact`、`tool-result-pruner` 在 host 平面上 `disabled: true`；每个 preset 在自己带 `isolate: { compaction: true, toolResultPruner: true }` 的 group 里各装一份。realm 对声明它的 group 之外一律不可见——包括 bundle patch 的裸 `- insert:` 行所落的那个 host 平面——而 `agent-presets` 自己的散文把后果写了两遍：「a host row that `inject`s a service cannot use this, because injection resolves before any session exists and has no agent to key by; such a service belongs on the host plane instead.」

所以引擎是按 agent 解析的：

```ts
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-compaction'
declare const ctx: import('@deepseek-ai/cordis').Context
declare const agent: import('@deepseek-ai/dsh-agent').Agent
const engine = ctx.get('agentPresets')?.serviceFor(agent, 'compaction') ?? ctx.get('compaction')
```

开头那两行 type-only import 是这个块真正检查到东西的前提：`serviceFor` 的签名是 `<K extends string & keyof Context>(agent, name) => Context[K] | undefined`，程序里没有把 `agentPresets` 与 `compaction` 并进 `Context` 的那两个模块时，`engine` 就是 `any`，这个块什么也证明不了。带上它们之后 `engine` 是 `CompactionEngine | undefined`，在同一个块里故意写错一个赋值即可实证（`TS2322: Type 'CompactionEngine | undefined' is not assignable to type 'number'`）。

位子与这次查找绑定：`isEnabled()` 只有在某个 agent 上查找成功之后才答 `false`，还没成功时答 `true`——上游行为，逐字不变。这条绑定保证的是「新进程不会在插件能接手之前就把 harness 的路关掉」：在这个 profile 里 host 平面的 `inject(['compaction'])` 永远不触发，而 host 提供的 policy **确实**能穿进 realm，所以一个不带绑定的常量 `false` 会让桌面完全没有自动压缩，开关和滑块变成摆设。

**这条绑定是进程级的，不是按会话的。** 位子没有 agent 参数，一个答案管住引擎服务的所有 agent；在某个会话上找到引擎，就把 harness 的路对所有会话一起关了。某个会话自己的组合两条查找都答不上来时，它在宿主日志里被记一次、谁也不压它——反正那里本来也没有引擎可以压它。

**不缓存。** 空白会话可以被改挂到别的 preset（`agentPresets.recompose`，桌面经 preset 选择器就能到），缓存会让插件继续用会话已经离开的那个 realm 的引擎，甚至包括一个根本不装 compaction 的 preset。`serviceForAgent` 只是遍历服务 store 自己的符号，所以改成每次 driver 退出解析一次。`agent/created` 上的探测包了 try/catch，并且只在挂着的 roster 确实有 `serviceFor` 时才调：`AgentRegistry.announce` 不接住创建 listener 的同步失败，在那里抛会否决会话的发布，而不是退化。

token 计量器被刻意留在 realm 之外——preset 自己写了原因，它拥有进程级的投影单元——所以 `ctx.get('tokenMeter')` 从 host 平面直接够得着，不需要任何寻址。

## 哪些结束不触发

**用户按了停止的一次，和会话被 dispose 的一次。** 两者都以带 `reason.kind === 'aborted'` 的 `turn/end` 收尾，随后都会发布 idle 状态。在那里压缩，等于用一段没人要的全对话摘要来回应「停止」，而且输入框没有任何办法打断它——`ReactLoopAgent.status` 把维护相位报告为 `idle`，所以 session controller 广播 `running: false`，停止按钮那时已经不在了。dispose 更糟：`agent-loop` 的销毁是 `cancel({kind:'disposed'})` 之后 `await whenIdle()`，而从那次 idle 转换启动的压缩，正是一次在唯一能停下它的取消之后才开始、然后被销毁等着的摘要。

没有任何 Context 事件报告取消，也没有任何投影发布结束原因，所以信号就是那条闭合事件本身，经 `ctx.on('session/event')` 在它提交时观察，而不是回头扫日志。第一版还在 `agent/disposed` 上中止每次尝试；那个 listener 已删掉：销毁顺序是 `cancel` → `whenIdle` → scope 销毁 → detach，而 `cancel()` 对维护相位同样 abort、`compactNow` 内部本来就把它并进操作 signal——所以 `agent/disposed` 永远晚于它能停下的那次尝试。

**被委派出去的子代理的那次退出。** 判据是持久表头——`agent.session.header.origin === 'subagent'`，`childSessionMeta` 给每个进程内子会话都盖，因此 resume 之后依然成立。不用 `parentSession` 作判据：`SessionStore.fork()` 也会给用户 fork 出来的顶层会话盖上它，而那种会话是根会话、必须照压。

被委派的这次运行到达那个 idle 转换只有两条路，哪一条都不值得压一次。

**前台**（`run_in_background: false`）：父代理的工具调用在进程内 driver 里以 `await child.whenIdle()` 结算（`packages/subagent/subagent-in-process-driver/src/index.ts:178-182`），而从子代理 idle 转换起跑的压缩会同步占住维护相位、替换 `activityDone`——于是那次工具调用要等整段摘要跑完才返回，而那正是用户正在看的那段回答中间；子代理随后就被 dispose，摘要没人读。对着真的 `AgentLoop` 实测（800ms 替身摘要器，三次）：被跳过的委派会话 3ms 安静，真的压缩的那个会话 803/804/804ms、一次 `compactNow`。

**后台**，也就是随附出厂的那种：standard preset 把两个进程内委派工具都配成 `backgroundMode: continuable`（`packages/preset/agent-presets/presets/standard/agent.cordis.yml:187` 与 `:198`；`:210`/`:219` 那两行 `one-shot` 是 `disabled: true` 的 codex 与 claude-code 提供方，在本进程里根本不起 agent），而 `runInBackground` 于是默认取 `options.continuable`（`packages/subagent/tool-subagent/src/index.ts:303`），工具在收件箱受理时就返回一个子代理 id，不等任何东西。在那里压缩不拖住任何回答，但子代理的结果同样要等摘要跑完才给出来，之后的 `send_message` 排在摘要后面，而一个再也没人跟它说话的子会话，留着的那份摘要没人会读。

**代价是：被委派的子会话，在内核的溢出兜底前面什么都没有。** 位子没有 agent 参数，所以那个关掉 `compaction-basic` 压力路径的 `false` 是对进程里所有 agent 一起关的，子代理也在内——它在自己那一轮里同样不再按压力压缩，剩下的只有提供方拒绝之后的溢出恢复，默认预算一次重试（`maxOverflowRetries`，`packages/compaction/compaction-basic/src/config.ts:93`，随附的任何 preset 都没覆盖它）。要按 agent 分别作答就得把 `isEnabled(): boolean` 改成带 agent 参数，那是核心补丁，本 fork 不为这件事动它。长到需要压缩的子任务，就是要盯着看的那一类。

## 随附行为付出的代价

**保留的尾巴更短。** `compactNow` 以 `retainTokens: 0` 选范围：`selectCompactableRange` 的累加循环第一轮就 break，所以最后一个 surface 节点——通常就是刚答完的那段——原样保留，它之前的一切回溯到一个平衡的工具边界为止，压成一条摘要。pre-step 那条路会留一截由 `retainRatio`/`retainTokens` 定长的尾巴，因为它是在给一个马上要发出去的请求腾地方；这一次不是。所以设在 60% 的用户现在拿到的是更彻底、更靠后的一次压缩，而不是更早、更局部的一次。设置卡自己的说明行现在也写了这一点，不再只有两份 README 和内置插件表——因为滑块最低能拖到 20%。

**界面上没有任何显示。** 维护相位对外报告为 `idle`，所以 session controller 广播 `running: false`，输入框的停止按钮消失，这期间发出的消息被扣在它后面、要到那一轮真正开始才进转录。只有 `compaction/start` 时 `compactionDefinition.buildViewNode` 什么都不画，所以对话里也看不到。一次全前缀摘要可能要几十秒。浏览器那半边加一行进度是做得到的，这里刻意没做：位子有（`conversation.composer.dock`，输入框下方的会话级 list 槽，不遮蔽任何随附 UI），缺的是信号——没有任何已注册投影发布「压缩标记对是开着的」，所以插件得自己注册一个折叠 `compaction/start`→`end` 的 conversation-node definition、自带一个客户端 store、加 locale 键与客户端测试。按这个成本推迟；用户看到的是什么，写在发行说明里。

**一轮之内的保护整个没有了。** pre-step 那条路买到的东西是本文 Problem 一节没提的：一段工具密集的长回答自己就可能撑爆窗口。关掉它，这种情况只剩溢出恢复兜底，默认预算是一次重试（`compaction-basic` config 里的 `maxOverflowRetries ?? 1`；随附的任何 preset 都没有覆盖它）。这是刻意接受的——答到一半去压缩正是被移除的行为——并在两份 README 里点名，好让预期会有很长的工具密集回答的部署知道该调哪个旋钮。

**`thresholdRatio()` 在随附组合里没有读者**：`isEnabled()` 答 false 时，读它的只有压力路径。位子的两个方法都留着：它是一个已发布的键，想要这个比例的后端仍然读得到实时值。

## 按成本推迟：`/compact` 撞 busy 后排队

一轮正在跑时打的 `/compact` 当场失败——`compactNow` 调 `runMaintenance`，agent 非空闲时它同步抛——而且不会在 agent 空下来时重跑。

这是**做得到的**。做不到的是从日志里推断**内置**命令的结果：`command/done` 只带 `kind: 'error'` 和 handler 渲染出来的英文文本，commands 服务对命令结束不发任何 Context 事件，而结构性代理——该 `commandId` 没有对应的 `compaction/start`——同样匹配早期取消。

自己接管这个动作就没有歧义了。`ManualCompactionError.code` 是 `@deepseek-ai/dsh-compaction` 的普通公开导出，所以自己发起调用的插件直接读得到 `busy`；commands 注册表也文档化了 agent 作用域遮蔽——挂在某个 agent 自己上下文下面的同名命令，只对那个 agent 遮蔽全局定义——而从普通插件够到 `agent.ctx` 的第一方先例就在 `schedule` 插件里。推迟是成本判断，不是不可能：它会把桌面线的 `/compact` 接管过来，上游对那条命令的改动就不再自动到达；它得为另外五个 code 复刻 `expectedFailure()` 的文案；排队跑的那一次还需要一条「用户改主意了」的规则。

## Alternatives considered

**从空闲路径调 `compactIfNeeded(agent, 'pressure', signal)`。** 这本可以保住尾巴和按模型的策略合并。否决，因为它是为一轮之内写的：`compactRegion` 传的是 `owner: 'current-turn'`，而会话没有打开的轮次时 `compactSurfaceRegion` 直接抛。它也不占维护相位，所以一条唤醒消息可以在摘要跑着的时候把一轮开起来。

**用 `ctx.inject(['compaction'], …)` 装触发。** 最自然的形状，也是第一版发出去的那个。按实证否决：对着真实的随附 cordis 做的探针显示，provider 在 `isolate` realm 后面时 host 平面的 inject 永不触发（同一个 provider 不加 realm 则触发），而 policy 仍然穿得进 realm——于是那个形状把 harness 的路关了、自己什么也没装上。

**常量 `false` 的位子。** 与上条一并否决：一个不依赖「是否找到引擎」的常量，正是把够不着的引擎变成永不压缩的对话的那个东西。

**在 `compaction-basic` 里加退避。** 按 fork 的铁律否决。这是插件层的问题、有插件层的答案，而压缩族本来就是上游冲突面最活跃的那套补丁；给 `compactIfNeeded` 加跨步状态，意味着每一轮滚动同步都要重新移植一遍。

**新增一个会话事件承载自动触发的结果。** 与失败卡当初否决它的理由相同：`Session.append()` 没有任何途径把 envelope 标成 `ignorable: true`，所以一个只有 fork 才有的必需事件会让不认识该类型的构建把日志读成砖。

## Consequences

桌面线现在在用户让它答完之后压一次，按用量环显示的那个数字判断；对于提供方尚未计费的对话，回落到 token 计量器自己的总数——正是这一条让图片密集的会话仍然会被压。摘要模型坏掉时，代价是每次 driver 退出一次尝试、一张卡，而不是每步一次。harness 自己的溢出恢复没动，harness 的包也一个没动：这里的改动是那个进仓的 tarball、它的依赖行、生成的第三方声明、内置插件表里的一行、一条针对 `turn: null` 失败标记对新增的客户端用例，以及本文。插件仓的 `packages/auto-compact/tests/{idle-compaction,realm}.spec.ts` 钉住了转换规则、每次退出重新解析、没有 `serviceFor` 的 roster 与会抛的 roster、阈值边界、开关、单飞门、逐次失败的日志，以及——对着真实 cordis 运行时——本决定所依赖的 realm 可见性。
