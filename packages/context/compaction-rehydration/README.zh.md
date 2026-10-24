---
description: "压缩后重建任务状态：量压缩丢了什么、维护重建消息的人阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-compaction-rehydration

[English](README.md) | 中文

## 概述

`dsh-compaction-rehydration` 在一次成功压缩后追加一条持久消息，重述 checkpoint 可能丢掉的任务状态：当前 todo 列表、最后一次获批的计划、本会话读过的文件、注册且未结算的后台任务，以及父会话目录里的直接子代理。每一节都从本会话**自有**日志（不含 fork 继承的前缀）或在其上折叠的投影重建；每个 checkpoint 只写一次，重启后的会话能看到重建已经发生过。

todo 列表折叠最近一次整表 `todo/write`，而不是读 `todos` 投影：两者承载同一份有效计划，但折叠日志让本包不依赖投影是否被物化：持久列表按 `dsh-tool-todo` 的说明跨轮、跨重开保留，所以轮边界上的压缩必须恢复它。

只有**最新一次** `exit_plan_mode` 复核说了算：批准带 plan-mode 的固定批准文案；驳回（非 error 结果）或本构建不认识的回答，都表示当前计划未定，于是既不恢复更早的批准，也不注入计划。还没有结果的复核视为仍在进行，同样不注入，不猜。

本包是原型：opt-in，不被任何发行组合挂载；投影缺席时只当作缺一节，不报错。它只新增一个消息来源 kind，不新增 Session 事件类型。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

挂在 `dsh-agent` 旁即可。todo、plan 与未结算 job 不需要别的服务；`Files` 节使用可选的 `ctx.fs` 服务，没有该服务时整节省略；要包含子代理一节，再挂 `dsh-session-projection`。

```yaml
- name: '@deepseek-ai/dsh-compaction-rehydration'
```

<a id="model-experience"></a>
## 模型体验

### 重建消息

#### 模型看到什么

在可恢复的 checkpoint 之后，下一次请求会多一条持久的 user 消息：checkpoint 前言，随后是仍有状态的各节，包括 todo 列表、最近获批的计划、有界的 `Files` 块、未结算 job 与直接子代理。每个 checkpoint 只出现一次，resume 后不会重复。

#### Token 影响

消息上限 4,000 字符并按节截断，不新增模型请求。它重述的是 Session 日志里已有的状态，因此可能与 checkpoint 摘要重复计费，但能挽回落在保留尾部之外的任务状态。

#### KV Cache 影响

消息追加在 checkpoint replacement 之后。提供方已缓存到该 replacement 的请求前缀仍可复用；重建消息与当前轮剩余部分属于新的未缓存输入。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 子代理一节读父会话的 `subagentCatalog` 投影；聚焦测试注册投影桩，覆盖直接子级与跨会话隔离，但没有挂真实 `dsh-subagent`。
- 后台任务一节折叠 `job/registered` 与 `job/settled`，**不会把任务说成正在运行**：最近一次 `session/end-seed` 之前注册的显示「可能已停止」，之后的显示「尚无结算，可能仍在运行」；进程被杀且从未落结算时保持不确定。
- 消息上限 4,000 字符，按节截断；很长的计划会丢尾部。
- `Files` 节最多列 5 个文本读取、2,000 字符，并受两层规则约束：只有 Session 工作目录内的路径可以出现，已知凭据位置整条省略。没有工作目录、读取发生在目录外、或属于凭据类路径时，什么都不注入——包括 unchanged 时的路径名。其余按新鲜度处理：记录的版本仍匹配时只给一行 `already read`；整文件读取且已变化时重述当前内容；只读过窗口、文件缺失/不可读、超过检查上限、或没有文件系统服务时只给指针。
- 凭据匹配覆盖 `.npmrc`、`.netrc`、`.git-credentials`、`.htpasswd`、`.pgpass`、`.env*`、`id_rsa*`、key/keystore 后缀、`application_default_credentials.json`，以及 `.ssh`/`.aws`/`.gnupg`/`.kube`/`.docker`/`.config/gcloud`/`.config/gh`/`secrets`/`credentials` 位置。它是尽力而为：名字普通的未知密钥无法靠文件名识别，可靠边界是 workspace 加部署的 deny rules。文件系统后端无法报告 containment 时退回规范化路径比较；远程与符号链接后端仍未验证。
- 读取事实依赖 `read` 工具持久化的 `meta`；没有 `version`/`digest` 的旧日志用一次有界重读核对。被 pruner 剪过的读取会回溯到原始 seq，旧内容永远不会被当作当前内容。
- checkpoint 是「摘要 **加** 它在 surface 上的 replacement」：`compaction/end` 可能缺失（进程在 replacement 落盘后死掉），也可能带 error（收尾失败）；让摘要对模型可见的是 replacement，所以两种情况都仍然重建。日志里的 `compactionSeq` 有收尾事件时取它，否则取 replacement。只有摘要、没有 replacement 的从未到达 surface，不算 checkpoint，不写重建。
- 批准识别依赖 plan-mode 的固定结果文案；换文案的构建会退化为不注入计划，不会猜，也不会恢复更早的批准。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>供维护者使用的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文，明确非权威；对外行为以本文上面的章节、包代码与链接的 Agent Notes 为准。

- **Files 恢复边界是有意设计** —— 仅重述工作目录内、且不在已知凭据位置的文件；未知密钥依赖 workspace 与部署的 deny rules，而不是本包的文件名清单。
- **missing-end 恢复已接受** —— 摘要加上它的 surface replacement 即为 checkpoint 证据；即使 `compaction/end` 从未提交也仍重建，收尾事件只作为日志里的 `compactionSeq` 优先值。
</details>
