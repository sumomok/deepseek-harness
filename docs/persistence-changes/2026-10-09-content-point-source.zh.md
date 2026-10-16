---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-09-content-point-source

[English](2026-10-09-content-point-source.md) | 中文

## 概述

新增 content-point 消息来源：控制台「指一下」这一行在带有指向的用户消息之后追加的、写进日志的用户消息，指名那条消息并写出每一处的键行。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-09-content-point-source
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-26-console-content-events"
    after: "ce884812a97f5cee5460fa893035876a8a1ae9e5b8861f2711eef61982364b42"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-26-console-content-events"
    after: "0d71b7d96a005f4af80899b5b6a3554415dcd974a55b1fccd2a9bd30eae57efe"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-26-console-content-events"
    after: "1fe8c85ceb6c97f7d5f26862d1e3d119986c697b5bf96d9e677c408cb40230e9"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-26-console-content-events"
    after: "018fae974b7119038daddbf1cbd530a804cb67453e673d74baa4b9885edc960f"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

只新增：一个只用于归属的来源种类。已有记录不含它，仍然有效。这个种类带 @persistenceAttribution，没有 content-point 包的读取方保留消息内容，按日志里的种类显示这一行；去掉这一行之后，带过它写下的会话仍然能读。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/experimental/content-point --maxWorkers=2：82 个测试通过，其中一个真实 Loader 组合的会话日志里，content-point 消息紧跟在它指名的那条提示之后；content-point Web 场景在控制台组合里记下了追加的消息。

<a id="dev-note"></a>
## 开发备注

无。
