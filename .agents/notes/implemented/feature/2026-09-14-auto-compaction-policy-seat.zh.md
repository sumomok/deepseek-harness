# Agent Note：自动压缩的实时策略位，并用计量自己的那个数

Status: implemented

[English](2026-09-14-auto-compaction-policy-seat.md) | 中文

## Problem

自动压力路径上叠着两个缺陷。

触发与计量对「上下文有多满」的理解不一致。输入框旁的环形计把 `contextPressure.projectedTokens ?? pressureTokens` 除以路由窗口——那是一个 prompt 侧的数字：未命中缓存的 input 加上缓存读写，排除回复的 output，因为下一次请求不会重发它们。`BasicCompactionEngine.compactIfNeeded` 比较的却是 `TokenMeasurement.totalTokens`，其提供方基线是 `inputTokens + cacheRead + cacheWrite + outputTokens`。两者因此恰好相差上一次调用的 output token，而用户设定百分比时，对着的是一个谁也没给他看过的数字。

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

**分子就是计量的那一个——在两者描述同一次请求的场合。** `compactIfNeeded` 现在读取 `ctx.sessionProjections.snapshot(session, ['contextPressure']).values.contextPressure` 并选取 `projectedTokens ?? pressureTokens`——与浏览器里 `contextOccupancy` 所除的是同一个 wire 值，由同一个投影单元、同一个 `view` 函数产出。不是重新推导：是同一个对象。每一处与 `spec.thresholdTokens` 的比较都用它，包括收敛循环的退出判断，因此进入与退出判据保持同一个量。`TokenMeasurement` 仍然是保留量与范围选择的定价来源；移动的只有触发。`sessionProjections` 进入引擎的 `static inject`，声明的是本包本来就间接持有的依赖——`tokenMeter` 没有该注册表就无法加载——同时让这次读取不必带一个任何有效组合都到不了的回退。

该读取以 `measurement.baseline.kind === 'usage'` 为门，而这道门是承重的，不是防御性的。投影是提供方锚定的：它发布最后一次用量样本加上自那以来 surface 的变动，而那部分变动按与路由无关的启发式定价。因此它看不见路由适配器为提供方尚未计费的历史声明的图片定价，其自身类型也写明了后果——这一对值是「面向用户的参考，不是计费或门控输入」。基线不是 `usage` 的测量恰好就是这种状态：没有提供方数字在锚定它，`totalTokens` 此时是一份按路由定价、不含任何 output token 的估算，也是唯一看得见该压力的读数。仓内已有现成物证：`snapshots/acp/image-compaction` 存在的目的就是展示按路由定价的视觉 token 驱动一次压力压缩，而不加门的投影读取会让该场景彻底不再压缩——六张图片、一份三个 input token 的用量样本，以及一个永远接近不了阈值的分子。因此这道缝是：环形计被锚定时用它的数，未被锚定时用计量自己的数。

**失败可见性不需要核心新增词汇。** 每一个打开区域标记对之后的失败——摘要调用、稳定性重验证、缩小量拒绝、提交——都已经以携带 `errorChain(error)` 的 `compaction/end` 闭合。该事件是持久的、已经过线，并且已被客户端 `compactionDefinition.match` 认领；只是 `buildViewNode` 因为没有落地替换检查点而返回 `null`。因此「用户必须看到失败」的核心一半是一条要守住的保证，而不是一个要新增的事件，插件一半渲染的是已经存在的那条记录。

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

触发点对每一个提供方用量锚定了计量的既有部署都移动了，移动量是上一次回复的 output token：这类会话现在比以前稍晚压缩——落在环形计显示的百分比处，而不是高出它几个点的位置。这是预期中的订正，也是任何曾对着旧数字调过 `thresholdRatio` 的部署需要留意的变化。提供方尚未锚定的会话，尤其是图片密集的会话，触发点逐字维持原样。

**退役条件。** 这是 fork 对上游包的 overlay。上游以任何形式让自动压缩获得运行期策略输入——服务、由设置驱动的 config 重载、阈值回调——即退役该 overlay，fork 的插件去适配上游形式。分子对齐同样退役，只要上游把自己的触发改到 context-pressure 投影上。在此之前两者每轮滚动同步都重新移植；`packages/compaction` 直到 0.1.5-rc.2 未收到任何上游改动，移植面一直稳定。

包内测试承载证据：两个分子在一份已锚定 fixture 上恰好相差已报告的 output token；小到无法锚定的用量样本保留按路由定价的总量，且压缩仍会在那里触发；把阈值预算严格放在两者之间时不触发，证明被比较的是较小的那个显示数字；挂载的策略按它自己的比例压缩，压过 `modelPolicies` 里为 `1` 的阈值，而该条目的保留量仍然决定被遮蔽的范围；禁用的策略跳过压力路径，却仍然从提供方确认的溢出中恢复；三个不可用比例各自对每条路由目标警告一次，并让已配置比例继续主政；自动摘要失败留下一条携带错误文本、供会话渲染的 `compaction/end`。

本次改动不附带快照变体。压力路径变体既需要一次带密钥的录制，也需要一个已挂载的 `compactionPolicy` 提供方，而仓内尚不存在这样的提供方——它是本项工作的插件一半。两个现有无密钥回放因此作为回归证据，其中 `snapshots/acp/image-compaction` 正是上文那道基线门的判依：它逐字节回放通过，这就是未计费图片压力仍会触发的断言。
