---
description: "压缩后重建任务状态：量压缩丢了什么、维护重建消息的人阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-compaction-rehydration

[English](README.md) | 中文

## 摘要

`dsh-compaction-rehydration` 在一次成功压缩后追加一条持久消息，重述 checkpoint 可能丢掉的任务状态：当前 todo 列表、最后一次获批的计划、本会话读过的文件、注册且未结算的后台任务，以及父会话目录里的直接子代理。每一节都从本会话**自有**日志（不含 fork 继承的前缀）或在其上折叠的投影重建；每个 checkpoint 只写一次，重启后的会话能看到重建已经发生过。

todo 列表折叠最近一次整表 `todo/write`，而不是读 `todos` 投影：两者承载同一份有效计划，但折叠日志让本包不依赖投影是否被物化：持久列表按 `dsh-tool-todo` 的说明跨轮、跨重开保留，所以轮边界上的压缩必须恢复它。

只有**最新一次** `exit_plan_mode` 复核说了算：批准带 plan-mode 的固定批准文案；驳回（非 error 结果）或本构建不认识的回答，都表示当前计划未定，于是既不恢复更早的批准，也不注入计划。还没有结果的复核视为仍在进行，同样不注入，不猜。

本包是原型：opt-in，不被任何发行组合挂载；投影缺席时只当作缺一节，不报错。它只新增一个消息来源 kind，不新增 Session 事件类型。

## 使用本包

挂在 `dsh-agent` 旁即可。todo、plan 与未结算 job 不需要别的服务；`Files` 节使用可选的 `ctx.fs` 服务，没有该服务时整节省略；要包含子代理一节，再挂 `dsh-session-projection`。

```yaml
- name: '@deepseek-ai/dsh-compaction-rehydration'
```

## 已知限制

- 子代理一节读父会话的 `subagentCatalog` 投影；聚焦测试注册投影桩，覆盖直接子级与跨会话隔离，但没有挂真实 `dsh-subagent`。
- 后台任务一节折叠 `job/registered` 与 `job/settled`，**不会把任务说成正在运行**：最近一次 `session/end-seed` 之前注册的显示「可能已停止」，之后的显示「尚无结算，可能仍在运行」；进程被杀且从未落结算时保持不确定。
- 消息上限 4,000 字符，按节截断；很长的计划会丢尾部。
- `Files` 节最多列 5 个文本读取、2,000 字符：记录的版本仍匹配时只给一行 `already read`；整文件读取且已变化时重述当前内容；只读过窗口、文件缺失/不可读、超过检查上限、或没有文件系统服务时只给指针；凭据类路径整条跳过。
- 读取事实依赖 `read` 工具持久化的 `meta`；没有 `version`/`digest` 的旧日志用一次有界重读核对。被 pruner 剪过的读取会回溯到原始 seq，旧内容永远不会被当作当前内容。
- checkpoint 是「摘要 **加** 它在 surface 上的 replacement」：`compaction/end` 可能缺失（进程在 replacement 落盘后死掉），也可能带 error（收尾失败）；让摘要对模型可见的是 replacement，所以两种情况都仍然重建。日志里的 `compactionSeq` 有收尾事件时取它，否则取 replacement。只有摘要、没有 replacement 的从未到达 surface，不算 checkpoint，不写重建。
- 批准识别依赖 plan-mode 的固定结果文案；换文案的构建会退化为不注入计划，不会猜，也不会恢复更早的批准。
