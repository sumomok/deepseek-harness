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
    previous: "2026-09-21-user-question-reply"
    after: "f59eae14fb97cbb776436a520bd7d09c14fd22952689537a62ca3ff27d7c2045"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-21-user-question-reply"
    after: "339640984b5b1b8274ee21777553560e3961286ad4e70025fe8582cdd3a91ccb"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-21-user-question-reply"
    after: "85d522c605d528c2fd9e8bff07aae252d4978834347520f79b0b088995dc9ef2"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-21-user-question-reply"
    after: "943dcd53e5cf6a2369f7ce74afc19ad271da8085a5fd62766980f5ca04f1ea81"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有记录仍然有效：来源没有 `references` 表示提示未携带引用，宿主省略该属性而不是写入空数组。较旧的第 4 版读取方已经接受带额外 JSON 属性的已知用户来源并原样返回；回放、投影、标题、搜索和模型请求都不读取这个新属性，因此较旧的读取方忽略它，回放不变。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/session/session-persistence-jsonl/tests/native-source-admission.spec.ts packages/api/session-controller/tests/session-cold.host.spec.ts packages/llm/llm-deepseek/tests/serialize.spec.ts：全部测试通过，包括 user/message 与 agent/inbox/spliced 记录中带引用的用户来源被原样接受，以及 Messages 请求体中不含引用。

<a id="dev-note"></a>
## 开发备注

无。
