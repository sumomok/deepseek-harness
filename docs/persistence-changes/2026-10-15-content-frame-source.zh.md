---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-15-content-frame-source

[English](2026-10-15-content-frame-source.md) | 中文

## 概述

新增 content-frame 消息来源：用户在内容区打开页面时，内容区那一行注入的通知，写明现在在前面的是哪个页面。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-15-content-frame-source
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-09-content-point-source"
    after: "da202589e73f3737cbc43bcca5ffae28378e33ae0c937a0b04035f6f9f4fda15"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-09-content-point-source"
    after: "7011ee848ccb76d19a197b95ed03d7644d0af8e60347e32b17591a1311570ab2"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-09-content-point-source"
    after: "bfe43be97603c26d8f4ac4c8d3d7119b4724f1fd4b9e1b930814f69477e76fb2"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-09-content-point-source"
    after: "e198badbd6923ea75cc046361878f7f14cb412dc7d94377b844d7ef1caeced1b"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

纯新增：只用于标注来源的 source kind。已有记录不含它，仍然有效。该 kind 以 @persistenceAttribution 声明，没有 content-frame 包的读取方会保留消息内容，并按持久的 kind 显示这条通知；带这一行写下的会话，在去掉这一行之后仍可读取。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/experimental/content-frame/tests/command.client.spec.ts --maxWorkers=2：22 个测试通过，其中一条打开页面后在日志里找到注入的通知，source 为 { kind: 'content-frame', form: 'notice' } 并带有该页面的摘要。

<a id="dev-note"></a>
## 开发备注

无。
