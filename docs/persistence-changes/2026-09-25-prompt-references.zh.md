---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-25-prompt-references

[English](2026-09-25-prompt-references.md) | 中文

## 概述

为浏览器提示（`user-rpc`）消息来源增加可选的提示引用。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-25-prompt-references
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-13-user-rpc-principal"
    after: "d8d8e7d8f398f9b6bf76872dbfa550b6627a2371c8c23e81671c30991003a3f5"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "58e733b9a5e7a282025d7adf6e754d0f596b90cb4b069b701dcd8f9a365967cb"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-13-user-rpc-principal"
    after: "57ffe3611876596e30b389419b2ffe2a36ebb466f0253a348cd16a1e8848ee27"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "afadd5a3d07b87d6d7f071783f697448a10fdb0b2e36c47d0512f50468defa7c"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有记录仍然有效：来源没有 `references` 表示提示未携带引用，宿主省略该属性而不是写入空数组。较旧的第 4 版读取方已经接受带额外 JSON 属性的已知用户来源并原样返回。回放、投影、标题、session_search 与提供方请求序列化都不读取这个属性，因此较旧的读取方忽略它，回放不变；可选插件 tool-session-query 的 session_event_read 会把整份已存事件（包括 references）放进写入日志的 tool/result 返回。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/session/session-persistence-jsonl/tests/native-source-admission.spec.ts packages/api/session-controller/tests/session-cold.host.spec.ts packages/llm/llm-deepseek/tests/serialize.spec.ts：全部测试通过，包括 user/message 与 agent/inbox/spliced 记录中带引用的用户来源被原样接受，以及 Messages 请求体中不含引用。

<a id="dev-note"></a>
## 开发备注

无。
