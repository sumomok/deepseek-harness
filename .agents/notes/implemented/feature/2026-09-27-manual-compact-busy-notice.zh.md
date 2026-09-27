# Agent Note: 回答进行中的手动 `/compact` 等到设置所选的边界再执行

Status: implemented

[English](2026-09-27-manual-compact-busy-notice.md) | 中文

## 问题

用户在回答进行中输入 `/compact`，反馈「没有反应」。Host 经 `compactNow` 执行手动压缩，它调用 `agent.runMaintenance`，agent 不空闲就抛 `busy`，于是命令以一张失败的 `/compact` 卡结束。这张卡是运行中轮次里的 `manual-compaction` 节点，而 `compact` 与 `standard` 两档工作步骤展示在轮次运行时也折叠过程组，所以卡被藏起来了。轮次完成后，整轮折叠又把它藏了一次。[自动压缩的运行行](2026-09-18-auto-compaction-running-card.zh.md) 已经移出了组，手动卡没有。

用户 09-27 定：忙时的 `/compact` 不拒绝；设置 → 通用里的「繁忙时的压缩行为」一行选择它在运行中轮次的下一个 step 边界执行（「立即打断」），还是在轮次结束后立即执行（「排队等候」）；轮次折叠后压缩相关的行仍然可见。

## 决定

**引擎改为等待而不是拒绝。** `CompactionEngine.compactNow` 接受可选的 `whileBusy: 'next-step' | 'turn-end'`。agent 空闲或不传它时行为不变。agent 运行中时，`dsh-compaction-basic` 为每个 Session 保留一个等待中的请求。它的 `agent/pre-step` 监听器在下一个 step 边界处理 `next-step`，标记对归开放轮次所有——与自动压力压缩同一位置、同一归属，因此轮次在替换后的表层上继续，不被取消。`turn-end` 在一个非中止的 `turn/end` 之后处理：若循环不经空闲直接从收件箱接续下一轮次，就在该轮次的第一个 step 边界；否则在 `agent/status` 转为空闲时，作为普通空闲维护、以独立标记对执行。轮次在没有后续边界时就结束的 `next-step` 请求（回答已是最后一个 step）同样这样处理。在 `turn/end` 或 `turn/start` 之后、该轮次第一个 `step/start` 之前到达的 `turn-end` 请求（接续的轮次正在组装系统提示词时）立即到期，在那个第一个 step 边界处理；监听器按 Session 跟踪 `turn/start`、`step/start` 与 `turn/end` 以判断这一点，否则这样的请求会等到接续轮次结束。空闲监听器同步启动 `runMaintenance`，因此排队的提示词会锁存在维护之后，而不是先开启下一轮次。中止的 `turn/end`（Stop）、请求自身的信号与引擎释放会取消等待；已有请求等待时的第二个请求是 `busy`。这些监听器不依赖 `auto`：它们只执行用户明确要求的事。

**选择是一个实时的 host 平面服务。** `@deepseek-ai/dsh-compaction` 声明 `ctx.manualCompactionTiming` 及其 `whileBusy()`。`ui-chat` 的 Host 插件把设置作为 volatile 字段 `ui-chat.busyCompaction` 持有并提供该服务；`command-compact` 每个请求读取一次，把回答传给 `compactNow`。`command-compact` 在每个预设里各挂一份，拿不到唯一寻址的设置表单；`ui-chat` 可以，而且它已经拥有 `/compact` 卡片。这与 `compactionPolicy` 同一做法：host 平面提供方，预设 realm 经 `ctx.get` 读取。没有提供方时（TUI、ACP、无界面组合），忙时 `/compact` 仍按上游行为被拒绝。

**默认「排队等候」。** 与排队的消息一样，运行中的轮次会在它开始时的历史上完成，而且繁忙时发送的默认值本来就是「排队发送」。「立即打断」会在轮次中途用摘要替换该轮次自己的工具结果，应由用户主动选择。

**在 step 边界的手动压缩保持零保留。** 轮次内的请求选择与空闲 `/compact` 相同的范围，只保留最后一个节点和成对的工具调用。改用自动压缩的保留尾部，会让同一条命令因时机不同而做两种不同的缩减。

**输入框拒绝被移除。** 在该设置下两个选项都接受忙时 `/compact`，所以消费命令并弹出「正在回答，等这一轮结束后再压缩」的 `commandUi` 装饰已无可拒绝之事。它的模块、测试、locale 键、web 场景与 `ui-commands` 依赖都已删除。

**卡片显示等待状态，并用读者的语言。** 命令 Definition 折叠关联的 `compaction/start`；在它到来之前，未结算的 `/compact` 卡显示 `等待压缩…` / `Waiting to compact…`，之后显示 `正在压缩…`。Host 进程在请求等待时退出，就不会有 `command/done`；上游的孤儿卡只持续几秒，这里的等待可长达整个轮次。重新加载时，agent-loop 的恢复会为崩溃留下的开放轮次追加（session-query 的冷读会合成）一条原因为 `interrupted` 的 `turn/end`，循环在运行中从不发出这个原因。`command/run` 位于这样的轮次、尚未结算、且没有关联的 `compaction/start` 时，卡片结算为 `压缩没有完成（应用中途退出）` / `Compaction did not finish (the app exited)`。`aborted` 轮次不算：Stop 的 `command/done` 紧跟在它的 `turn/end` 之后。Host 的固定英文结果文本从不依赖 cordis 的 `@deepseek-ai/dsh-command-compact/result-text` 叶模块导出；客户端 bundle 不能导入这个值，所以 `chat/compact-result.ts` 重述这张表，`satisfies typeof COMPACT_RESULT_TEXT` 在 Host 文本改变时让构建失败。

**压缩相关的行位于两层折叠之外。** `process-groups.ts` 把 `manual-compaction` 列为独立根，`contract/turn-process.ts` 把它列入已完成轮次整轮折叠之外的类别。自动压缩失败行经 `auto-compaction-policy-seat` 得到同样两处登记。

**为什么是核心补丁。** 引擎监听器、Service Definition 与消费方都在上游包里，两处折叠集合是 `ui-chat` 内部的常量。提供时机的一方必须同时随桌面线与控制台线出货；本仓库之外的包只能到达桌面。

## 考虑过的替代方案

**继续在输入框拒绝。** 被 09-27 的决定取代；它还让用户在轮次结束后重新输入命令。

**在 Host 侧命令队列里排队。** 否决：那需要新的持久记录，而引擎已有 step 与空闲两种边界，命令生命周期（`command/run` … `command/done`）也已记录了等待。

**由客户端扣住 `/compact` 直到轮次结束。** 否决：「立即打断」无法在客户端实现，而且接续的排队轮次从不让客户端看到空闲状态。

**扩展 `CompactionPolicy`。** 否决：桌面的 auto-compact 插件是它唯一的提供方，它将不得不实现一个不属于它的设置。

## 后果

等待中的请求让它的 `commands/execute` 调用保持打开；关闭发起它的页面会取消它，卡片以已取消结算。「立即打断」的标记对归轮次所有，所以卡片位于该轮次内；「排队等候」的卡片在独立标记对落地后移到轮次之后，若排队的提示词不经空闲紧接而来，则进入下一轮次。没有提供方的组合里的 `/compact` 仍得到 `busy` 卡片，如今已本地化。

**退役。** 引擎与消费方部分在上游让忙时 `/compact` 可以等待、或以其他方式改变 `compactNow` 或 `command-compact` 的 `busy` 分支时退役。折叠登记在上游让轮次内的 `manual-compaction` 在两层折叠中都可见时退役。`.claude/core-patches.md` 里的 `manual-compact-busy-notice` 条目给出机械判据。

## 测试

`compaction-basic/tests/manual-compaction-while-busy.spec.ts` 驱动真实循环：轮次内的 next-step、最后一个 step 之后的 next-step、越过 step 边界的 turn-end、接续排队轮次之前的 turn-end、出错轮次之后、带时机的空闲请求、不带时机的 busy、单一等待请求、Stop、请求自身的中止、引擎释放、失败的 step 压缩，以及其间的 Stop。`command-compact` 的测试钉住转发的时机与 teardown 中止；`ui-chat` 的测试钉住 volatile 字段上的 Host 服务、设置行、等待文案、本地化结果与两层折叠。`apps/web/tests/compact-while-busy.e2e.ts` 用节奏回放在真实线路上运行随附 Web 组合：从设置行选「立即打断」后在轮次的两个 step 之间压缩；「排队等候」在 `turn/end` 之后压缩，显示等待卡片与第二个请求的本地化拒绝，并在轮次折叠后保持卡片可见。
