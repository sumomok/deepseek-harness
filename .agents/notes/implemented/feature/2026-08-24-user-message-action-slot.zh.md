# Agent Note: 用户消息上的贡献位

Status: implemented

[English](2026-08-24-user-message-action-slot.md) | 中文

## 问题

已定稿的 assistant 消息带有贡献位：`conversation.chat.assistant-actions` 渲染在该消息的 IconActions 行内，反馈操作条正是经由它抵达 transcript（文本记录）。用户消息没有对应物。它们的 IconActions 行只有复制与时钟，而 `UserMessageNodeView` 未声明任何 children，因此插件无法在那里放置任何东西。

剩下的路子性质上都不对。插件可以整体遮蔽 keyed `user` 条目，为加一个按钮而替换随产品发布的气泡；或者把消息作用域的操作放到并非该消息的位置——想要这个能力的插件实际就是这么做的，落到了 composer dock 或 assistant 行上。

## 决策

`conversation.chat.user-actions` 是会话作用域的 list slot，渲染在 user 与已接纳 steering 消息的 IconActions 行内，紧邻复制与时钟。条目按 `order` 升序渲染，与 assistant 侧一致。

声明该位的是 chat 视图，而不是消息 renderer。一个子 slot key 只能有一个声明条目（`SlotCore.register` 会拒绝第二次声明），而 `user` 与 `steering` 是共用同一组件的两个 keyed 条目——因此声明落在 `conversation.view` 的 chat 条目上，由它通过 `ChatNodeOwnerProps` 向每个 chat node 传下 `renderUserActions` 渲染份额。`conversation.message.images` 早已用同一机制经 `renderMessageImages` 抵达多种 node kind。

`UserActionOwnerProps` 是被指向消息的持久日志位置及其已渲染文本：

| 字段 | 理由 |
|---|---|
| `seq` | `user/message` 事件位置。用户消息没有 message id——`messageId` 属于 assistant 侧的身份空间——因此 `seq` 才是诚实的身份。 |
| `text` | 气泡为复制操作已经算好的合并文本，使贡献方无需重读日志即可指向该消息。 |

由 owner 决定哪些气泡带操作条。持久的 `user` 与 `steering` node 带；待接纳的 steering 气泡不带，因为在 host 接纳之前它没有可指向的持久位置。

## 备选方案

**在 `user` 与 `steering` 两个 keyed 注册上都声明 children 表。** 不予采纳，因为 slot 内核禁止：第二次注册会抛出 `slot "conversation.chat.user-actions" is already declared`。一个 key，一个声明条目。

**为每种 kind 各设一个 key（`user-actions` 与 `steering-actions`）。** 不予采纳：它本是一个含义相同的位，贡献方却要注册两次并保持两个条目同步，去迎合读者根本看不见的区分。

**只在 `user` 上声明，steering 留空。** 不予采纳：已接纳的 steering 消息在 transcript 中就是用户消息，这种不对称会表现为操作只出现在读者自己的部分消息上。

**仿照 assistant 位用 `messageId` 指向消息。** 不予采纳：`UserMessageNode` 没有 id，而在客户端造一个会为同一条消息制造第二个身份空间。

**让插件遮蔽 keyed `user` 条目。** 不予采纳：为追加一个按钮而替换随产品发布的气泡，会迫使每个贡献方重新实现气泡 chrome，并让两个贡献方互斥。

## 后果

插件只需注册一个条目，即可在读者自己的消息上添加逐消息操作，无需 fork conversation 包。`ChatNodeOwnerProps` 新增一个必填成员，因此该 owner currency 的每个构造点都必须提供它——这个位属于标准 node currency，而不是某些 renderer 会遗漏的可选附加项。

**退役条件。** 本次变更在 fork 中以临时 overlay 形式承载。若上游获得等价的用户消息逐消息贡献位——无论采用何种形式——即退役该 overlay，并让 fork 的插件适配上游形式；绝不与之并行维护同一行为的 fork 实现。

不改动任何浏览器快照。`apps/web/tests/message-feedback-layout.e2e.ts` 通过反馈插件的已评分控件测量 assistant 行；随产品发布的 Web 组合没有该新位的贡献方，因此其包裹层渲染为空，该场景无从观察。要加入观察就得把仅供测试的贡献方塞进组合，而该位自身的组件测试已经覆盖：它固定了 user node 与 steering node 的 owner props、assistant tail 上不出现操作条，以及移除渲染点会让测试变红。
