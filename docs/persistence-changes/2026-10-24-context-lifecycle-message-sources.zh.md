---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-24-context-lifecycle-message-sources

[English](2026-10-24-context-lifecycle-message-sources.md) | 中文

## 概述

新增两个可选启用的 user 消息 source kind，用于压缩后的任务状态重建与同工作区历史召回。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-24-context-lifecycle-message-sources
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-22-action-card-status"
    after: "ab745034ce2567062bc2d77c666c56b2cede10d1d16e7463e634b8ab1d533da4"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-22-action-card-status"
    after: "2b4f4e709e7f4e0a80b00616c6c6008d613c3d958b6fc3e425d0d2d0f91646da"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-22-action-card-status"
    after: "dfcb7471099e73fdf3db00c8e29ff16831fa4baa654bc83285bbb4ab2dbf920e"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-22-action-card-status"
    after: "42bbeec482ca3556312bf7dbb91ea68c01c5893a9a9b1ae2c63377585a26fd5f"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有记录仍然有效。这两个 source kind 只由可选启用的插件附加在已持久化的 user 消息内容上：不新增 Session 事件、不改变任何既有字段的语义，缺失时行为不变。不认识某个 source kind 的 reader 会保留或忽略该 source 元数据，并继续投影原始 user 消息内容，因此 Session 写入格式保持 V4。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/context/compaction-rehydration packages/test-support/session-snapshot/tests/memory-recall：5 个文件、78 个测试通过。pnpm exec vitest run packages/test-support/session-snapshot/tests/context-lifecycle：7 个文件、59 个测试通过。

<a id="dev-note"></a>
## 开发备注

无。
