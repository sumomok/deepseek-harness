---
description: "压缩后重建任务状态：量压缩丢了什么、维护重建消息的人阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-compaction-rehydration

[English](README.md) | 中文

## 摘要

`dsh-compaction-rehydration` 在一次成功压缩后追加一条持久消息，重述 checkpoint 可能丢掉的任务状态：当前 todo 列表、最后一次获批的计划、本会话注册且未结算的后台任务，以及父会话目录里的直接子代理。每一节都从 Session 日志或在其上折叠的投影重建——todo 列表折叠最近一次整表写入，跨轮边界不会丢；每个 checkpoint 只写一次，重启后的会话能看到重建已经发生过。

本包是原型：opt-in，不被任何发行组合挂载；投影缺席时只当作缺一节，不报错。它只新增一个消息来源 kind，不新增 Session 事件类型。

## 已知限制

- 子代理一节读父会话的 `subagentCatalog` 投影；聚焦测试注册投影桩，覆盖直接子级与跨会话隔离，但没有挂真实 `dsh-subagent`。
- 后台任务一节折叠 `job/registered` 与 `job/settled`，**不会把任务说成正在运行**：最近一次 `session/end-seed` 之前注册的显示「可能已停止」，之后的显示「尚无结算，可能仍在运行」；进程被杀且从未落结算时保持不确定。
- 消息上限 4,000 字符，按节截断；很长的计划会丢尾部。
