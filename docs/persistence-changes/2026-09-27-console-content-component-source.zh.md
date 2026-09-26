---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-27-console-content-component-source

[English](2026-09-27-console-content-component-source.md) | 中文

## 概述

记录 content-component 消息来源种类：skill-pack-components 这个 host 程序里的包引入了 component-surface，持久化提取器因此看得到它。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-27-console-content-component-source
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-26-console-content-events"
    after: "1a3f7c4ecd6422f66c15ce10754966c561bbdfa5d72ab80fc5b118c42769d0ec"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-26-console-content-events"
    after: "1a4549f45b4441bf254f7edd80477e08995fe83e5f07f7b38bcdc4752b180083"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-26-console-content-events"
    after: "4e5f9ffc93dec0e10eed95c231cb39ea230825660eeffc3d215370540ff40167"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-26-console-content-events"
    after: "54dc1185359adf59e8fc9aa2336251e5bce4b79e8550fe320d8f3998969757a9"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

该种类以 @persistenceAttribution 标注，component-surface 的动作通知早已写入它；变化的只是提取器能否看见它。已有的每条记录都保持原有 schema 与回放方式，没有对应写入方的读取方会原样保留这种来源种类及其元数据，不校验也不回放它。

<a id="verification"></a>
## 验证

在 packages/session/session-persistence-jsonl 中放置的临时 spec 以会话格式 4 写入一条来源种类为 content-component 的 user/message，并读回了同一条记录。

<a id="dev-note"></a>
## 开发备注

无。
