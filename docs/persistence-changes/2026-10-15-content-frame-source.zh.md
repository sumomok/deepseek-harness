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
    after: "8cde06df44b5be0083e91613574fe3a8ecd1f2c5aa16d10279ffb666eb13776c"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-09-content-point-source"
    after: "2df3c0ef4687316a392cca3ca96731b76b027ad146b40c2da52b3620b7451c6f"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-09-content-point-source"
    after: "09a7663822734b792c416edcc4b0e62c192b62f6c22c6a33b6932afa4d432927"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-09-content-point-source"
    after: "1c11506f3fa8c453677331c4676965532de2fba767e7fa2c339bb9bfeb1290b2"
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
