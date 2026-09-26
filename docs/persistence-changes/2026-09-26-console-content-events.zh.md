---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-26-console-content-events

[English](2026-09-26-console-content-events.md) | 中文

## 概述

新增产品控制台的六个内容事件，以及它的三种仅作归属用途的消息来源种类（content-surface、content-frame、content-component）。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-26-console-content-events
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-16-session-format-v4"
    after: "688bda1d52cd4e79ea57451c511621e4c7ac107615e75cfd76a3a5257c956bef"
    decision: same-version
  - root: "event:content-component/resolved"
    previous: null
    after: "4f32865bccfdf8fe0abac226d4d2f8c1d2b78070174ae3de059b44474db76071"
    decision: same-version
  - root: "event:content-component/shown"
    previous: null
    after: "7f723dc6ec038f47ead783d50012698f414212e6a3cc6f4e9b829b3dbc8f582d"
    decision: same-version
  - root: "event:content-surface/dismissed"
    previous: null
    after: "4ad228bdbed1b7de8d019fe494d963be0650509d3d29769258e9b1e79ab6b456"
    decision: same-version
  - root: "event:content-surface/selected"
    previous: null
    after: "0c8f7c583d9df301011303ed5739d7764664093b4ef3072d9373285cbc937c9b"
    decision: same-version
  - root: "event:content/navigated"
    previous: null
    after: "27c8bdff407955334cfd7e20f5809d438e2c826892f29c31ff5dd88043f967d4"
    decision: same-version
  - root: "event:content/shown"
    previous: null
    after: "a21aefcdb207a9f214b3a5e7ea13a96aa085fcc10b6555b9750679f5be02673c"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-16-session-format-v4"
    after: "bdfe3bfb16b6e037153249a74f7adad41a3708e25cf1183257977ccc8ec79913"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-16-session-format-v4"
    after: "039a5be0827030b0530e2c3c2f83f85f5c22f94d97a9a440da927f18c6f15d6e"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-16-session-format-v4"
    after: "ebc9df9b986ccc625872fb686fcbd0a4e66909ee0b4e3113d2bbe89e1f0fd48a"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

六个事件是新的普通事件类型，三种来源种类以 @persistenceAttribution 标注，因此已有的每条记录都保持原有 schema 与回放方式。不认识这六个事件的旧读取方会拒收携带它们的日志，因为它们没有标记 ignorable；没有对应写入方的读取方会原样保留这三种来源种类及其元数据，不校验也不回放它们。rc.2 基座之前写下的日志把这些来源记为 kind plugin，V3 到 V4 的迁移会把它改写成 plugin:content-surface 之类，控制台不会把它们映射回来。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/experimental/content-surface packages/experimental/content-frame packages/experimental/component-surface：72 个文件、1625 个测试通过。在 packages/session/session-persistence-jsonl 中放置的临时 spec 以会话格式 4 写入六个事件中的每一个，并读回了同一条记录。

<a id="dev-note"></a>
## 开发备注

无。
