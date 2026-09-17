# Agent Note：自动压缩的实时策略位，并用计量自己的那个数

Status: implemented

[English](2026-09-14-auto-compaction-policy-seat.md) | 中文

Related：[投影 token 用量与请求上下文](../architecture/2026-07-29-projected-token-usage-and-request-context.zh.md)（部分取代——其「nothing in the harness makes decisions from it, and compaction reads `measure()` directly instead」一句在用量锚定分支上已不成立）·[路由模型上下文与压缩策略](../architecture/2026-07-20-routed-model-context-and-compaction-policy.zh.md)（部分取代——压力解析仍读路由适配器的容量，但它比较的分子不再在所有状态下都是 `measure()` 的总量）·[自动压缩挪到一轮结束之后](../bug-fix/2026-09-17-auto-compaction-at-turn-end.zh.md)（对随附桌面组合部分取代本文：那里这个位子答 `false`，本文描述的压力路径整条不进入。下文凡是讲压缩**什么时候**发生的句子——「在设置里改完，下一步就按新值走」「下一步会重新评估压力并再试一次」、每步叠一张卡、以及尚未计费的对话按引擎自有口径触发——说的都是没挂提供方时这个位子的行为，那仍然逐字等于上游）。

## Problem

自动压力路径上叠着两个缺陷。

触发与计量对「上下文有多满」的理解不一致。输入框旁的环形计把 `contextPressure.projectedTokens ?? pressureTokens` 除以路由窗口——那是一个 prompt 侧的数字：未命中缓存的 input 加上缓存读写，排除回复的 output，因为下一次请求不会重发它们。`BasicCompactionEngine.compactIfNeeded` 比较的却是 `TokenMeasurement.totalTokens`，其提供方基线是 `inputTokens + cacheRead + cacheWrite + outputTokens`，并且会另行为被锚定的回复定价。两个数字之间没有固定差额——差值随回复而变，方向也不固定——因此用户设定百分比时，对着的是一个谁也没给他看过的数字。

阈值又只在加载期存在。`thresholdRatio` 是一个插件 config 字段，在 `resolveConfig` 中校验并就地冻结；`auto` 在构造期决定 listener 是否注册。一个让用户说「在 60% 处开始压缩」、或为某个会话关掉自动压缩的桌面设置页，没有任何可写入的对象——改动其一都意味着编辑组合并重载插件树。引擎还是每个 agent preset 一实例，因此设置命名空间无法住在它内部。

## Decision

一个可选的 host 平面 Service Definition，引擎每一步重新读取；外加一个取自计量已发布投影的分子。

```ts
/** Live automatic-compaction policy a host-plane plugin provides from user settings. */
export interface CompactionPolicy {
  /** Whether pressure-triggered compaction runs at all; overflow recovery is unaffected. */
  isEnabled(): boolean
  /** Share of the model's context window (0–1) at which the next step compacts first. */
  thresholdRatio(): number
}
```

服务键是 `compactionPolicy`，由 compaction-basic 声明合并到 cordis `Context`，经 `ctx.get('compactionPolicy')` 读取——就是引擎对 `toolResultPruner` 已在使用的可选兄弟服务范式。全程不缓存：读取发生在 `agent/pre-step` listener 内与 `compactIfNeeded` 内，因此用户拖动滑块会在下一步生效。预设 realm 只隔离 `compaction` 与 `toolResultPruner`，别无其他，所以一个 host 平面提供方服务于每个预设的引擎实例，设置命名空间也留在单一持有者手里。

**服务不存在即上游行为**，逐字如此。`isEnabled()` 返回 `false` 只暂停压力路径——溢出恢复仍然运行，因为那时提供方已经拒绝了请求，而关掉自动压缩的用户并没有要求失去最后一道防线。`thresholdRatio()` 在 `resolveTargetPolicy` 合并完精确目标覆盖**之后**替换已配置比例，这意味着 `modelPolicies` 条目的 `thresholdRatio` 被忽略，而该条目的其余部分——首先是保留量——仍然生效。让一份实时用户设置压过按模型调优表，正是这个位存在的意义；保留量刻意不开放，因为它是一个按容量缩放、与阈值之间存在有效性关系的预算，而不是一个用户会有主张的数字。

返回的比例不在 `(0, 1]` 内，或其 `floor(contextWindow × ratio)` 无法越过保留尾部时会被拒绝：引擎对每个 `provider/model` 警告一次，并保留已配置比例。该比较与 `resolveCompactSpec` 执行的是同一个，只是对着已经缩放好的配置 spec 运行，因此回退路径自身不会抛错，容量本身有问题时仍以既有的 `TargetPressureConfigError` 浮现，而不是被报成策略警告。

`config.auto: false` 仍是硬关。它是一条组合声明，不是用户偏好，因此继续在构造期决定是否注册任何 listener；实时开关是它之上的运行期层。

**分子就是计量的那一个——在两者描述同一次请求的场合。** `compactIfNeeded` 现在读取 `ctx.sessionProjections.snapshot(session, ['contextPressure']).values.contextPressure` 并取其已发布的 `projectedTokens`——与浏览器里 `contextOccupancy` 所除的是同一个 wire 值，由同一个投影单元、同一个 `view` 函数产出。不是重新推导：是同一个对象，而这份共享来源就是保证的全部。这里不主张与 `totalTokens` 之间存在任何算术关系：计量按提供方的 `outputTokens` 为被锚定调用计价，投影则对已记录 stream 按启发式计价，因此差值随回复而动（spec fixture 里空 stream 时为 700，同一条回复记成真实 chunk 后为 609），符号也不固定。浏览器回退到 `pressureTokens`，引擎回退到 `measurement.totalTokens`：回退不同源是因为两者回答的问题不同，而引擎这一侧那条分支本就不可达——用量锚定的计量意味着投影折叠过同一份样本，`projectedTokens` 必然存在，该行带 `v8 ignore`。每一处与 `spec.thresholdTokens` 的比较都用它，包括收敛循环的退出判断，因此进入与退出判据保持同一个量。`TokenMeasurement` 仍然是保留量与范围选择的定价来源；移动的只有触发。`sessionProjections` 进入引擎的 `static inject`，声明的是本包本来就间接持有的依赖——`tokenMeter` 没有该注册表就无法加载——同时让这次读取不必带一个任何有效组合都到不了的回退。

该读取以 `measurement.baseline.kind === 'usage'` 为门，而这道门是承重的，不是防御性的。投影是提供方锚定的：它发布最后一次用量样本加上自那以来 surface 的变动，而那部分变动按与路由无关的启发式定价。因此它看不见路由适配器为提供方尚未计费的历史声明的图片定价，其自身类型也写明了后果——这一对值是「面向用户的参考，不是计费或门控输入」。基线不是 `usage` 的测量恰好就是这种状态：没有提供方数字在锚定它，`totalTokens` 此时是对整个 surface 的按路由定价估算——对被锚定的回复只收启发式价而非提供方报价——也是唯一看得见该压力的读数。这个盲点在用量分支内同样存在，只是规模更小：最后一次采样之后新增的图片，在请求为它们计费之前仍走同一套定长启发式。分母全程不受影响——后端除的是 `ctx.llm.resolveModelInfo` 为该路由目标报出的容量，从不是投影记录的 `contextWindow`。仓内已有现成物证：`snapshots/acp/image-compaction` 存在的目的就是展示按路由定价的视觉 token 驱动一次压力压缩，而不加门的投影读取会让该场景彻底不再压缩——六张图片、一份三个 input token 的用量样本，以及一个永远接近不了阈值的分子。因此这道缝是：环形计被锚定时用它的数，未被锚定时用计量自己的数。用不懂这两个词的读者也能看懂的话说：文本会话按环形计百分比触发；尚无供应商用量锚点、或图片未计价的历史，按引擎自有口径触发。

**失败可见性不需要核心新增词汇。** 每一个打开区域标记对之后的失败——摘要调用、稳定性重验证、缩小量拒绝、提交——都已经以携带 `errorChain(error)` 的 `compaction/end` 闭合。该事件是持久的、已经过线，并且已被客户端 `compactionDefinition.match` 认领；只是 `buildViewNode` 因为没有落地替换检查点而返回了 `null`。因此修复完全落在会话视图内，它就是本 overlay 的第二半。

## 失败卡

`compactionDefinition` 在摘要与检查点之外获得第三份证据：`error` 存在的 `compaction/end`。`buildViewNode` 仍然优先采用已落地的检查点——提交了替换的标记对会干净闭合，因此两者不可能描述同一笔事务——否则发出一个 `compaction-failure` Chat 节点，锚在出错那条 end 自己的 seq 上，携带该 seq、时间与原因文本。`error` 缺席与 `error` 存在但为空白分别不是失败与不是原因：前者不产生节点，后者产生一个 `reason` 为 null、卡片回退到 locale 文案的节点。

渲染器沿用 max-tokens 提示的形状——一行 `role="status"`、一个警告圆点、一条 locale 标题、一行详情——因为它就是这种东西：一条持久的、有位置的提示，说明一件用户没有要求过的事没有做成。原因是后端自己的文本，所以它是数据不是文案；它以 `text-overflow: ellipsis` 保持单行，完整字符串放在 `title` 上，让一条很长的收敛失败链仍然可达而不会把转录撑开。

手动 `/compact` 的失败不会走到这张卡，也不应该走。`command-compact` 调用的是同一个标记对，因此标记对内的手动失败写下同样出错的 `compaction/end`——但每一条手动生命周期事件都带 `sourceCommandId`，而 `compactionDefinition.match` 一向排除它，把它交给 `commandDefinition` 与那张已经渲染 `command/done` 失败文本的命令卡。一次失败出两张卡比一张更糟。标记对之前的手动失败（`busy`：agent 不空闲，或已有活动压缩）根本不写事件，同样经命令结果抵达用户。

取消的回合不能产生这张卡。`region.ts` 对任何抛出都以 `compaction/end{error}` 闭合标记对，因此摘要途中按下「停止」会把一次取消记成与失败一模一样，转录就会声称有东西坏了。结构化证据没能留下：摘要器把适配器的 `ABORTED` 失败抛成一个 `Error`，其 code 被 `errorChain` 丢弃；回合级信号也到不了这个 Definition——它的 Context 以 `compactionId` 为键，之后的 `turn/end{aborted}` 没有可匹配的 id，而 `turn-process` 与 `turn-tail` 都不把回合结束原因发布成 turn data。剩下的只有文本，而每一个随产品发布的取消来源都写出了这个词：`DeepSeek request aborted by caller`、`pi-ai request aborted by caller`、`pi-ai stream aborted`，以及裸信号原因的 `This operation was aborted`，或消息为空时的 `AbortError`。Definition 匹配链首段里的 `abort` 并不出卡。接受的代价是：措辞里恰好含该词的真实上游失败也不出卡；这是更安全的方向，且宿主仍会记日志。抛出的非 Error 渲染成 `[object Object]`、带敌意访问器的值渲染成 `<unrenderable value>`，两者都不是原因，因此出卡但只有 locale 文案、没有 `title`。两者都不按取消处理：`AgentCancelCause` 的渲染结果虽然相同，却到不了这条路径——出厂适配器会在传播之前把被中止的请求改写成 `… request aborted by caller`。

卡片不展示后端文本。它提到摘要器、阈值、缩小量检查——产品用户没有这套词汇。行内是一句固定的本地化文案，说明这次没能写出摘要、之后会再试，这既是用户需要知道的，也是全部属实的部分：下一步会重新评估压力并再试一次。它刻意不说「对话内容没有变化」——`compactIfNeeded` 在开标记对之前就会剪枝超大工具结果，因此这里的失败可能发生在一次已落地的缩减之后。原始链条改挂在 `title` 属性上，供排查者读。

**已知限制：摘要模型持续宕机会逐步叠卡**（随附桌面组合里这条路已被插件关掉，改为每次 driver 退出只试一次；引擎侧的限制本身没修）。每次压缩都是以自身 `compactionId` 为键的独立 Context，而一个 Definition 无法压制另一个 Context 的节点，本框架里没有任何东西能把它们合并；引擎步与步之间也没有退避，因此一次长回合中的提供方故障会留下一串相同提示。暂时接受——替代方案是本框架并不提供的跨 Context 状态。

卡上没有 trigger 字段。会话日志不记录一次自动压缩是因步压力还是因溢出恢复而跑——`compaction/start` 只带 `compactionId`、可选命令 id 与所属轮次——因此 trigger 标签只能是编造的。卡片说明的是哪一笔事务失败了、为什么失败；而该 Definition 只认领自动压缩，所以「自动」就是 trigger 本可以补充的全部。

## Alternatives considered

**从 `TokenMeasurement` 里减去锚点的 output token 来推导分子。** 否决：那是在第二个地方重建投影的算术。两者只在无人改动任一份 fold 期间才一致，而「触发恰好落在屏幕上的百分比」这个主张就会建立在这种巧合上，而不是建立在共享代码上。

**无条件读取投影。** 按物证否决：`snapshots/acp/image-compaction` 会从会压缩变成不压缩，因为投影把未计费的图片历史按启发式定价。视觉会话会悄声失去自动压缩——而那正是它存在的意义。

**新增 `compaction/auto-failure` 会话事件。** 两条理由否决。其一是不必要——最主要的失败即摘要调用失败，已经写下带 `error` 的 `compaction/end`。其二是按规格不可实现：`Session.append()` 没有任何途径设置 envelope 的 `ignorable: true` 标记，全仓也没有任何生产代码设置过它。一个仅存在于 fork 的必需事件会让每一个不认识该类型的构建拒绝该日志，这正是 fork 常设纪律所禁止的会话变砖。要标成 ignorable 就得改 `packages/core/session` 的持久 append API、重新生成 `known-event-types`、并重录两个 SDK 的期望输出——为一个已被覆盖的情形付出大得多的核心补丁。

**`ctx.emit('compaction/auto-failed', …)` 转发到既有客户端通道。** 否决，因为不存在这样的通道。`packages/api/remotes` 里的转发器是一张插件在运行期无法扩展的 20 条封闭白名单，其中唯一的自由文本成员 `api-session/error` 落在 `lastAgentError` 上，而 `packages/client` 里没有任何地方渲染它。全仓每一个 `Toast` 都是客户端本地 React state，host 无从寻址；`packages/interaction` 只暴露阻塞式的 `ask`／`request` 方法。

**失败时注入 `form: 'notice'` 上下文。** 否决：那是一条追加到 surface 的 `user/message`，会消耗上下文 token 且模型会读到它——恰好发生在压缩刚刚没能释放任何空间的那一刻。

**把 `thresholdRatio` 做成由设置插件改写的插件 config 字段。** 否决：config 是加载期的，并在 `resolveConfig` 中被 `deepFreeze` 冻结，因此一次改动意味着编辑组合并重载插件树，而引擎的每预设实例还会各持一份副本。

**通过同一个位开放保留量。** 因范围否决：`retainRatio` 必须低于有效阈值，因此第二个面向用户的数字引入了一对可以被设成无效状态的取值。唯一开放的那个数字改为对着已配置尾部校验。

## Consequences

host 平面插件可以把自动压缩变成用户设置——一个百分比与一个开关——无需 fork 引擎、无需改动组合，也不需要第二份「上下文有多满」的定义。随附组合不挂载任何提供方，因此 `dsh` 的行为与上游逐字相同：`thresholdRatio: 0.8`、`auto: true`、listener 在加载期注册。

触发点对每一个提供方用量锚定了计量的既有部署都移动了。它现在落在环形计显示的百分比上；相对旧触发点是提前还是推后，取决于计量与投影各自如何为被锚定的回复定价，因此并非一致地更晚或更早。任何曾对着旧数字调过 `thresholdRatio` 的部署都应重新核一遍。提供方尚未锚定的会话，尤其是图片密集的会话，触发点逐字维持原样。

**留给插件一半的陷阱。** 被引擎拒绝的 `thresholdRatio()`——不在 `(0, 1]` 内，或保留尾部越不过的预算——只会对每条路由目标记一次日志，随后被已配置比例悄悄顶替。设置卡会继续显示 20%，而压缩实际按 80% 触发，屏幕上没有任何提示。引擎单方面修不了这件事：它对一个只读取的服务没有回话的途径。提供方必须在发布取值前按同一条规则自校验，并在某个已存设置未生效时告知用户。

**退役条件。** 两个 overlay 分别退役。失败卡在上游以任何形式在会话里渲染自动压缩失败时退役。策略位与分子对齐是 fork 对上游包的 overlay。上游以任何形式让自动压缩获得运行期策略输入——服务、由设置驱动的 config 重载、阈值回调——即退役该 overlay，fork 的插件去适配上游形式。分子对齐同样退役，只要上游把自己的触发改到 context-pressure 投影上；机械判据是 `git grep -n "contextPressure" upstream/master -- packages/compaction`，任何命中都意味着移植前先复核。三者每轮滚动同步都重新移植。移植面并不安静：直到 0.1.5-rc.2 上游没动 `packages/compaction` 的源码，但改写了它的散文——`compaction-basic/README.md` 与 `README.zh.md`（14 行）以及 `compaction/README.md`（8 行）——而本 overlay 改的正是 compaction-basic 这两个文件里的 36 行，因此活跃冲突面是 README 而不是代码。失败卡是第二片，且是 client-UI 补丁：`packages/client/ui-chat/src/client/` 下六个文件，每轮必须重新移植与重新核实，因为上游一直在改那个包；`git grep -n compaction-failure upstream/master` 零命中即未退役。

包内测试承载证据。ui-chat 侧：出错的自动 `compaction/end` 产生带原因的失败节点，已落地的检查点仍产生成功标记且不产生失败节点，干净的 end 两者都不产生，空白 error 报告为原因缺席，从未载入标记对起点的窗口仍能构建该节点，手动失败不产生节点，三种取消渲染完全不出卡，无法渲染的取消原因报告为「有失败但无可用原因」，卡片在两种语言下都渲染 locale 文案而后端文本只留在 `title` 上。compaction-basic 侧：在一份 assistant stream 为真实记录的 fixture 上，等于已发布 `projectedTokens` 的预算会触发、比它高一个 token 的不触发——把引擎的分子夹到了那个精确值，而计量总量既不等于它也不等于它加 output token；空 stream 的用例保留并改名，说明它只是差值恰好等于已报告 output 的特例；小到无法锚定的用量样本保留按路由定价的总量，且压缩仍会在那里触发；把阈值预算严格放在两个候选之间时不触发，证明被比较的是显示的那个数字；挂载的策略按它自己的比例压缩，压过 `modelPolicies` 里为 `1` 的阈值，而该条目的保留量仍然决定被遮蔽的范围；禁用的策略跳过压力路径，却仍然从提供方确认的溢出中恢复；三个不可用比例各自对每条路由目标警告一次，并让已配置比例继续主政；自动摘要失败留下一条携带错误文本、供会话渲染的 `compaction/end`。

本次改动不附带快照变体。压力路径变体既需要一次带密钥的录制，也需要一个已挂载的 `compactionPolicy` 提供方，而仓内尚不存在这样的提供方——它是本项工作的插件一半。两个现有无密钥回放因此作为回归证据，其中 `snapshots/acp/image-compaction` 正是上文那道基线门的判依：它逐字节回放通过，这就是未计费图片压力仍会触发的断言。
