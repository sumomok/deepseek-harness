---
kind: upgrade-guide
description: "SessionQueryEngine 新增抽象方法 searchMessages，所有 provider 都必须实现。"
---

# SessionQueryEngine 的 provider 必须实现 searchMessages

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-session-query` 为 `SessionQueryEngine` 新增抽象方法 `searchMessages(request, exec)`。它返回一页匹配事件，而不是每个会话仅一个排序命中，因此调用方可以定位到片段所属的那条消息。会话页行为不变：`searchSessions` 仍然归组事件并只保留每个会话的最强命中。

由于该方法是抽象的，按旧版本编译的 provider 不再满足基类。变更只影响 `SessionQueryEngine` 的实现方；仅调用该服务的消费者只会看到多出一个方法。

## 迁移

1. 在每个 `SessionQueryEngine` 子类中实现 `searchMessages`。无法提供消息粒度的 provider 应当抛错，而不是返回空页，这样缺口是可见的，不会被读成「没有匹配」。
2. 返回 provider 自己的 `SessionSearchPage<SessionEventSearchHit>`，按相关度排序，并使用与 `searchSessions` 相同的 cursor 契约分页。每条命中自带所属的 `sessionId` 与 `seq`。
3. 用两个入口分别跑 provider 的搜索测试。调用方施加的可见性、表层与消息类型规则对二者相同，因此覆盖其中一个的 fixture 也应覆盖另一个。
