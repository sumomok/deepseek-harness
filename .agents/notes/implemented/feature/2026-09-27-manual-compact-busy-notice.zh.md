# Agent Note: 回答进行中的手动 `/compact` 在输入框作答

Status: implemented

[English](2026-09-27-manual-compact-busy-notice.md) | 中文

## 问题

用户在回答进行中输入 `/compact`，反馈「没有反应」。Host 经 `compactNow` 执行手动压缩，它调用 `agent.runMaintenance`，agent 不空闲就抛 `busy`，于是命令以一张失败的 `/compact` 卡结束。这张卡是运行中轮次里的 `manual-compaction` 节点，而 `compact` 与 `standard` 两档工作步骤展示在轮次运行时也折叠过程组，所以卡被藏起来了。输入框不为已准入的命令显示任何东西：`runDetached` 只在准入失败时发输入框提示，而忙时拒绝是一条已准入、处理器失败的命令。[自动压缩的运行行](2026-09-18-auto-compaction-running-card.zh.md) 已经移出了组，手动卡没有。

## 决定

**会话报告 `running` 时在输入框拒绝。** `ui-chat` 经 `commandUi.decorate` 给 Host 的 `compact` 命令挂一个 `action` 装饰，与 `ui-message-feedback` 装饰 `/feedback` 用的是同一个接口。它的 `available` 读会话快照的 `running`，所以轮次不在运行时装饰不生效，裸命令原样发往 Host。轮次运行时，裸的菜单选取或回车会消费输入的指令、不发送任何东西，并发出一条 `error` 级输入框提示：中文 `正在回答，等这一轮结束后再压缩`，英文 `A reply is in progress. Compact after this turn ends.`。`error` 级就是输入框的临时 Toast。没有用常驻的 `info` 条，因为轮次结束时没有东西清掉它，回答结束后它仍会显示正在回答。

**拒绝而不排队。** 输入框忙时，普通消息经 `ISession.prompt` 的 `queue` 或 `steer` 进入 agent 的消息队列。命令从不进入这个队列，Host 也没有「agent 空闲后再执行某条命令」的机制；排队 `/compact` 需要 Host 侧的命令队列和一种新的会话日志记录。命令路径已有的忙时行为是拒绝：`matchEnter` 对不接收附件的命令发一条输入框提示，不执行任何东西。

**把 Host 的卡移出过程组。** `process-groups.ts` 把 `manual-compaction` 列入独立根，与 `compaction-running` 并列。轮次运行期间仍然到达 Host 的 `/compact`（另一客户端发来的，或本客户端尚未收到 `running` 时发出的）会把拒绝结果渲染在折叠组之外。空闲时的 `/compact` 不属于任何轮次，本来就不进组。

**为什么是核心补丁。** 装饰用的是现成的扩展点，但注册它的代码必须随桌面线与控制台线一起出货，而本仓之外的包只到得了桌面线。分组规则没有扩展点：独立根集合是 `ui-chat` 内部的常量。`ui-chat` 已经拥有 `/compact` 卡片与 `message.compaction.*` 文案，所以两半都放在这里。

## 考虑过的替代方案

**把 `/compact` 排到轮次结束后。** 否决，理由见上：它需要 Host 命令队列和一种新的持久记录，而用户重新输入一次即可。

**让 `command-compact` 等到空闲。** 否决：处理器会在轮次剩余时间里一直挂着一条命令、没有可见状态，Stop 还得同时取消两件事。

**只把 Host 的忙时文案本地化，不在客户端拒绝。** 否决为唯一改动：卡片仍是唯一反馈，而在轮次内它恰恰是被藏起来的那部分。

**由 fork 的桌面插件提供装饰。** 否决：控制台线不加载它们。

## 后果

输入的 `/compact` 被消费，提示是拒绝留下的唯一痕迹；用户在轮次结束后重新输入。提示出现在输入框 Toast 的位置，即对话区顶部。会话不在 `running`、但 Host 正在做维护时（fork 的轮末自动压缩），没有提示：命令到达 Host，卡片上是 Host 的英文 `busy` 原文，位于轮次之外。已完成轮次的整轮折叠仍会藏起落在该轮内的 `manual-compaction` 卡，与它藏起所有过程行一样；解除的只是过程组的折叠。

**退役。** 上游自己在客户端或 Host 处理忙时 `/compact` 时，装饰退役。上游把 `manual-compaction` 列为独立根、或以其他方式让轮内命令卡不进折叠组时，分组那一项退役。机械判据在 `.claude/core-patches.md` 的 `manual-compact-busy-notice` 条目里。

## 测试

`packages/client/ui-chat/tests/compact-busy.client.spec.ts` 钉住装饰只在会话 `running` 时生效，并把当前语言的提示写进该会话的输入框。`chat-apply.client.spec.tsx` 钉住 `apply` 在 `commandUi` 出现后注册它。`chat-view.client.spec.tsx` 在 `compact` 档的打开轮次里渲染一张失败的 `manual-compaction`，钉住它在折叠组之外。`apps/web/tests/compact-busy.e2e.ts` 走发布的 Web 组合与真实连接：挂起一轮、发送 `/compact`，钉住提示、清空的输入框、以及没有 `command/run`；再经 `commands/execute` 发同一命令，钉住 Host 卡在组外。分别去掉 `running` 判断、提示调用、`apply` 接线、`INDEPENDENT` 那一项，各自的测试都会失败。
