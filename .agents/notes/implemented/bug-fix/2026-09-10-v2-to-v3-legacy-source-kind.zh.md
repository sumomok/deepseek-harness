# Agent Note: V2→V3 迁移边带过一种历史消息来源种类

Status: implemented

[English](2026-09-10-v2-to-v3-legacy-source-kind.md) | 中文

## Problem

`dsh-session-format-v2-to-v3` 在转换一条消息之前先给它的来源分类。[`payload.ts`](../../../../packages/session/session-format-v2-to-v3/src/payload.ts) 里的 `assertSource` 接纳十五种已发布的 `source.kind` 取值，其余一律以 `cannot safely transform unclassified message source` 拒绝——一个叫不出来源名字的转换，无法承诺自己安全地搬动了它。

一个仓外的 composer 插件（在本机评估期间挂载过）写下的 `user/message`，来源是 `{"kind":"at-file-mention","relative":"test/1.txt"}`，唯一的内容块是 `<workspace-reference path="test/1.txt" kind="file" />`。这个种类在本仓历史里根本不存在：`git log --all -S at-file-mention` 无输出，对所有已检出的插件工作区做 grep 同样无命中。

这次拒绝的代价不止是那份会话的历史。`SqliteSessionQuery._reconcile` 会冷读每一份尚未建索引的持久会话，一次被拒的读取就会中止整次观测，于是整库的内容搜索退回到名称匹配。用 `JsonlSessionPersistence.open(id, 'read').read()` 对本机两个库做冷读回放：在姊妹补丁点名的三种 v0 形状不再先行拒绝之后，`~/.dsh` 有八份、rc.27 前备份有同样的八份撞上这次拒绝。

## Decision

`LEGACY_UNINTERPRETED_SOURCE_KINDS` 点名 `at-file-mention`，`assertSource` 对被点名的种类直接返回而不抛错。来源对象带着它的两个成员原样跨到 V3。

之所以敢说原样携带是安全的：这条迁移边只读两种 kind——`plugin`（用于重命名已停用的 `tools-code-mode` owner）与 `agent-message`（校验其中继归属）。其余种类对这条边而言只是被复制的数据。V3 自己的校验器也是这个态度：`assertV3Event` 把叫不出名字的事件类型当作 opaque，而 `restoreReleasedV3Artifact` 投影回 `restoreReleasedV2Artifact` 的冻结关系视图，把未知的 message-source `kind` 当作 owner-opaque JSON——v0 与 v1 两代对它本来就是这么处理的。

选择携带而不是改写成 `user`。改写会丢掉 `relative` 成员，并断言一个写入方从未主张过的来源；V3 产物是持久的，一个错误的断言会比它所描述的会话活得更久。

这里没有任何一处扩成通用规则。未被点名的来源种类仍以同一条消息被拒，被点名的集合是一份落盘实证过的种类清单，而不是对未知插件的策略。

## 两个库现在的读数

同一次回放，本补丁与它的 v0 姊妹补丁都在位：`~/.dsh` 的 139 份全部打得开，备份的 121 份也全部打得开。两个库都到达零拒绝。

## Alternatives considered

**把来源改写成 `{ kind: 'user' }`。** 不需要新增清单，产出的 V3 产物也落在冻结词表之内。但它丢掉了 `relative` 成员，并且声称这条消息由一个已发布的写入方产出——对每一份带这种 kind 的会话来说这都是假的。

**接纳任何未分类的来源种类。** 一行代码，而且下一个仓外 composer 也不必再打补丁。这条拒绝存在的意义，是让抵达 V3 的每一种 kind 都被人读过；一刀切的放行退掉了这个保证，而点名清单没有这个代价。

**就让这些会话继续被拒。** 这种 kind 由 fork 并不发行的插件写下，所以这次拒绝可以说是上游按设计行事。代价是这些会话失去自己的历史，任何存有其中一份的库失去内容搜索——而换来的只是一个没有任何代码读取的来源成员。

## Consequences

带这种 kind 的会话能打开、能迁移、能建索引。落盘的 V2 文件逐字节不动——迁移把 `session.v3.jsonl.zstd` 写在它旁边——删掉迁移后的代次即可回到此前的拒绝。对 `source.kind` 做分支的读者会在 V3 日志里看到一个落在已发布联合类型之外的取值；本仓每一个这样的读者本来就把未知 kind 当作 opaque。

## Testing

`session-format-v2-to-v3` 的 `legacy-uninterpreted.spec.ts` 逐字迁移这份语料 payload、还原 V3 结果，并在同一条消息上钉住未被点名种类的拒绝。
