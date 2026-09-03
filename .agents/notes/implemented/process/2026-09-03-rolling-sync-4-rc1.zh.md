# Agent Note: 滚动同步 #4——补丁线迁到 0.1.2-rc.1

Status: implemented

[English](2026-09-03-rolling-sync-4-rc1.md) | 中文

## Problem

本 fork 把上游补丁放在一条滚动的 `core-patches-vN` 线上，每次同步都整条变基到新的 `upstream/master`，好让每个补丁都在它真正要发布的基座上重新被证明一遍。第四轮滚动同步要把这条线从 0.1.2-alpha.5（`49a606bc5b`）搬到 0.1.2-rc.1（`76fda72979`），中间隔着 63 个上游提交。其中三处对一条 fork 线有真实碰撞风险：新库 `packages/util/http-proxy` 把所有出站请求按配置的代理路由、模型清单发现改到了 `packages/client/ui-settings-models`、以及一个同会话消息编辑功能被上游合入后又整体 revert——这一对如果 revert 不彻底，就会悄悄增删 `SessionEventMap` 成员。revert 不彻底或 `SESSION_FORMAT_VERSION` 被抬高，都会让已发布桌面写下的每一份会话日志读不回来。

## Decision

这条线以 `core-patches-v6` 整体迁移（`git rebase --onto upstream/master 49a606bc5b`），一个补丁一个提交、不压缩，逐个冲突套用 fork 的退化条款。65 个补丁全部重放，只有一个提交产生冲突，零 drop、零退役、零缩减：两侧改动文件集只有 13 条重合，且全是清单或生成的目录文件，即没有任何补丁的实体源文件被上游碰过，退化条款一条都没触发。唯一的冲突（`0d6f579a96`，溢出文件附件外溢）是三处依赖清单并集，每处都取「在上游自己的形态上做最小增量」——上游那条非字典序追加的 `http-proxy` 保持在上游放的位置，上游对 `python/sdk-runtime` 依赖顺序的重排也保留而不是改回来。

只需要一个适配提交，且是机械项：fork 唯一自有的工作区包 `packages/attachment/attachment-spill` 版本还停在上一个基座，而上游发版把根版本推到了 `0.1.2-rc.1`，`check-workspace-constraints` 因此拒收。这条红在每次基座升版时都会复发，不是变基缺陷。

三处高风险的上游改动都逐条实查，而不是假定无害。补丁线上没有任何自建 fetch 或代理变量读取，新的 `http-proxy` 库无需适配；这条线在 `ui-settings-models` 下零文件；`SESSION_FORMAT_VERSION` 在两个基座与变基后的树上都还是 `0`；编辑功能与它的 revert 精确抵消——`git diff ef88756f13^ e974a655a0` 输出为空——即 `SessionEventMap` 净变化为零。

## Alternatives considered

- **靠门禁套件去发现会话读不回来。** 否决：单元套件读的是自己在同一进程里刚写出的日志，观测不到「新构建拒读旧构建产出的日志」。本次同步改为直接读一份已发布 rc.28 桌面写出的真实日志——607 条事件、`seq` 连续、头行带遗留的 `agentPreset: "code"`——素材是只读拷贝；并另行证明拒读路径仍会对伪造的更高版本头行触发，避免「全绿只是因为什么都没检查」。
- **把全量套件的红当成变基回归去追。** 按证据否决：四个失败文件在本线上与 `upstream/master` 逐字节相同，纯净 `upstream/master` 工作树复现了其中三个且条数完全一致（238 + 6 + 1 = 245，本线全量为 246）。剩下那一个在两棵树上单跑都通过，即并行负载抖动，台账已立案。
- **每轮同步压成一个补丁。** 否决：逐补丁提交才是退化条款可审计的前提——被上游吸收的补丁必须能单独 drop，压扁的线说不清是哪个补丁死了。

## Consequences

- `core-patches-v6` 在 `76fda72979` 上带 66 个提交；`master` 已快进到同一提交并推到 `origin`。
- 台账表头现在写明当前补丁线与其基座，下一轮同步从一个明写的指针出发，而不是靠翻分支考古。
- 四条基座环境红维持立案而不修：本机 `/usr/bin/python3` 是 CPython 3.9.6 而门槛是 3.10，另有一条 spill 测试断言的 mtime 边界是本文件系统表示不出来的。两者都需要换宿主，不是改代码。
