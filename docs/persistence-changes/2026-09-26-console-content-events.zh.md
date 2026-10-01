---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-26-console-content-events

[English](2026-09-26-console-content-events.md) | 中文

## 概述

新增产品控制台的六个内容事件，以及 Host 聚合声明的两种仅作归属用途的消息来源种类（content-surface、content-component）；content-frame 的来源种类声明在 Host 聚合之外的一个 Client 包里，不在本记录内。

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
    previous: "2026-09-21-user-question-reply"
    after: "94843f9d9fa8e11376be659407d5cf543a2dd707aaf4f15699e408ee6fc3fa4b"
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
    previous: "2026-09-21-user-question-reply"
    after: "6bd2e61a23f063b07cf0559b77267357890438a905e420620b198689ee7e8e4c"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-21-user-question-reply"
    after: "fa70c64552504733734b7d05d6708074cfaee19fce00bfc7bb6c50555a20680c"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-21-user-question-reply"
    after: "703fa13cdf1e1acf2cd64be1aee29a2eb062367d41125e3f1d8182047e3ffc14"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

六个事件是新的普通事件类型，两种来源种类以 @persistenceAttribution 标注，因此已有的每条记录都保持原有 schema 与回放方式，排在本记录之前的用户提问回复来源也是如此。不认识这六个事件的旧读取方会拒收携带它们的日志，因为它们没有标记 ignorable；没有对应写入方的读取方会原样保留这两种来源种类及其元数据，不校验也不回放它们。content-component 种类由 component-surface 的动作通知写入。rc.2 基座之前写下的日志把这些来源记为 kind plugin，V3 到 V4 的迁移会把它改写成 plugin:content-surface 之类，控制台不会把它们映射回来。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/experimental/content-surface packages/experimental/content-frame packages/experimental/component-surface：75 个文件、1738 个测试通过。pnpm run verify-persistence-changes 通过。

<a id="dev-note"></a>
## 开发备注

无。
