---
kind: upgrade-guide
description: "session_event_read 现在默认返回有界分页，只有 full: true 才返回未删节事件。"
---

# `session_event_read` 默认有界返回

[English](guide.md) | 中文

## 变更

`session_event_read` 过去返回完整目标事件 JSON，现在默认最多返回 16,000 个目标 JSON 字符，并给出字符范围与 `nextOffset`。需要旧版未删节结果的调用方必须传入 `full: true`。这影响面向模型的会话历史读取，以及任何假设一次调用必然返回完整事件的调用方。

## 迁移

1. 普通精确读取保留默认行为，并按 `nextOffset` 继续翻页。`maxChars` 接受 2–100000，`before` / `after` 相邻事件摘要只出现在第一页。
2. 需要完整恢复被修剪工具结果或其他完整事件时，添加 `full: true`。不要与 `offset` 或 `maxChars` 组合，该组合会被拒绝。
3. 运行 `pnpm exec vitest run packages/experimental/tool-session-query` 验证。长事件会显示 `characters … nextOffset …`，而 `full: true` 仍按旧行为返回完整事件。
