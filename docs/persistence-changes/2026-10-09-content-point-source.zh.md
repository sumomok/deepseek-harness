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
    after: "0390e0dc730dad0ec25fa43e28403fc9ad610d8d23a53601dfd107d36012e046"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-26-console-content-events"
    after: "2669909f0621ab2da9f5d10d8ea3d93f890f867004fa5a368b18eb2e46887a98"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-26-console-content-events"
    after: "626e90e45ae1387304daf001c8008f84666f50229263c4623d42f2987d734a59"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-26-console-content-events"
    after: "61bf312402150b95890adb1f2cd41794732a7e891e48d22a116da790b3531ce4"
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
