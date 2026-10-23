---
description: "压缩后重建任务状态：量压缩丢了什么、维护重建消息的人阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-compaction-rehydration

[English](README.md) | 中文

## 摘要

`dsh-compaction-rehydration` 在一次成功压缩后追加一条持久消息，重述 checkpoint 可能丢掉的任务状态：当前 todo 列表、最后一次获批的计划、本会话注册且未结算的后台任务，以及父会话目录里的直接子代理。每一节都从 Session 日志或在其上折叠的投影重建；每个 checkpoint 只写一次，重启后的会话能看到重建已经发生过。

本包是原型：opt-in，不被任何发行组合挂载；投影缺席时只当作缺一节，不报错。它只新增一个消息来源 kind，不新增 Session 事件类型。

## 已知限制

- 子代理一节读父会话的 `subagentCatalog` 投影；原型的聚焦测试没有挂载 `dsh-subagent`，这一节只做到编译与形状验证，未端到端跑过。
- 后台任务一节折叠 `job/registered` 与 `job/settled`；重启后没有结算记录的任务会一直显示为运行中，直到后续结算事件落盘。
- 消息上限 4,000 字符，按节截断；很长的计划会丢尾部。
