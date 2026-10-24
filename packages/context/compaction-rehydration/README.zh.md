---
description: "压缩后重建任务状态：量压缩丢了什么、维护重建消息的人阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-compaction-rehydration

[English](README.md) | 中文

## 摘要

`dsh-compaction-rehydration` 在一次成功压缩后追加一条持久消息，重述 checkpoint 可能丢掉的任务状态：当前 todo 列表、最后一次获批的计划、本会话注册且未结算的后台任务，以及父会话目录里的直接子代理。每一节都从本会话**自有**日志（不含 fork 继承的前缀）或在其上折叠的投影重建；每个 checkpoint 只写一次，重启后的会话能看到重建已经发生过。

todo 列表折叠最近一次整表 `todo/write`，而不是读 `todos` 投影：两者语义不同——持久列表按 `dsh-tool-todo` 的说明跨轮、跨重开保留，而那个投影是「本轮计划」视图，下一轮 `turn/start` 时清空。轮边界上的压缩必须恢复列表，所以这里以日志为准。

计划是否获批取自复核的持久结果：plan-mode 对批准与驳回各渲染一句固定文案，且驳回是非 error 结果。若结果里两句都没有（别的构建写的模板），才用可重放的 `plan/mode` 关闭事件在不含糊时判定；否则宁可不注入计划，也不猜。

本包是原型：opt-in，不被任何发行组合挂载；投影缺席时只当作缺一节，不报错。它只新增一个消息来源 kind，不新增 Session 事件类型。

## 已知限制

- 子代理一节读父会话的 `subagentCatalog` 投影；聚焦测试注册投影桩，覆盖直接子级与跨会话隔离，但没有挂真实 `dsh-subagent`。
- 后台任务一节折叠 `job/registered` 与 `job/settled`，**不会把任务说成正在运行**：最近一次 `session/end-seed` 之前注册的显示「可能已停止」，之后的显示「尚无结算，可能仍在运行」；进程被杀且从未落结算时保持不确定。
- 消息上限 4,000 字符，按节截断；很长的计划会丢尾部。
- 真正的 surface replacement 若 `compaction/end` 没有落盘（压缩中途崩溃），不当作 checkpoint，不写重建；等崩溃夹具的结论。
- 批准识别依赖 plan-mode 的固定结果文案；换文案的构建会退化到 `plan/mode` 兜底或干脆不注入计划，不会猜。
