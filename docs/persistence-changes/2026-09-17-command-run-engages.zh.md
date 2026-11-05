---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-17-command-run-engages

[English](2026-09-17-command-run-engages.md) | 中文

## 概述

给持久化的 `command/run` 载荷增加可选成员 `engages`，记录这次运行是否让所在 Session 离开 blank 状态。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-17-command-run-engages
baseline: false
changes:
  - root: "event:command/run"
    previous: "2026-09-11-initial"
    after: "9a944f8067e257ede51d92c059c34043c4dbcd59fa5b70a7215580875cd4ef08"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

旧记录不带该成员，折叠把缺失读作「转正」，这正是本补丁之前每个构建的行为。旧读者忽略该成员不改变回放：该值只决定列表元数据折叠是否清除 `blank`，不认识它的构建会像此前一样在每个 `command/run` 上清除 `blank`。只有声明 `engages: false` 的命令才写入该成员，因此语料里每次纯配置命令运行至多多出一个布尔值。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/interaction/commands packages/api/session-controller packages/session/session-format-v0-to-v1 packages/session/session-format-v1-to-v2：2 个用例因无关的并发超时红过一次、重跑通过；命令转正、载荷校验与 v0/v1/v2 迁移用例全部通过。

<a id="dev-note"></a>
## 开发备注

无。
