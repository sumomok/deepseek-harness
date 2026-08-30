# @deepseek-ai/dsh-attachment-spill

[English](README.md) | 中文

面向超大文本文件附件的幂等、会话级 spill 物化。注册 `ctx.attachmentSpill`，被 `@deepseek-ai/dsh-llm` 的文件降级路径（`lowerFileBlocksFromStore`）通过各 provider 适配器（`dsh-llm-deepseek`、`dsh-llm-pi-ai`）消费。

Provider 适配器在每次构建请求时，都会对完整消息历史里的每个 `file` 内容分片重新降级一次。因此一个解码后字符数超过 `inlineWholeUnderChars` 的文件，需要在同一 (会话、附件) 的每次后续请求构建之间复用同一份稳定的 spill 产物（以及同一个 locator），而不是每步都新落一份、换一个新 locator。本包正是负责这件事：给定一个 `FileAttachmentRef` 及其已解码文本，`resolveSpill` 解析或创建背后的 [`ctx.spillStore`](../../spill/spill) 产物，在进程内缓存结果，并在本进程首次为某个附件落盘时追加一条 `attachment/materialized`——这条持久记录让模型可见的 locator 文本能够从会话日志重建。

`fileSpillOptionsFrom(attachmentSpill)` 把一个已解析的 `AttachmentSpill` 实例适配成 `@deepseek-ai/dsh-llm` 的 `FileSpillOptions`，供 provider 适配器自己的 `lowerFileBlocksFromStore(messages, attachments, signal, fileSpillOptionsFrom(ctx.get('attachmentSpill')))` 调用使用——这是 `dsh-llm-deepseek` 与 `dsh-llm-pi-ai` 共用的唯一一处转换。

## 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `inlineWholeUnderChars` | `16000` | 字符数阈值：等于或低于该值时文件解码文本整段内联（与本包出现之前的行为一致）；高于该值则落盘。非负整数；加载时校验。 |
| `previewChars` | `4000` | 已落盘文件解码文本随 locator 一起展示的预览字符数。非负整数；加载时校验。 |

## 行为

1. `resolveSpill(attachment, content)` 读取*当前发起方 agent*（`ctx.agents.currentInitiator()`），而不是调用方传入的会话 id——因为降级文件分片这一步，总是发生在发起方 agent 自身的异步调用链内部，从活的 `Agent.session` 派生归属，排除了两者不一致的可能。
2. 没有活的发起方 agent（agent 轮次之外的无会话 LLM 调用）⇒ 返回 `undefined`；调用方保持文件内联截断。在没有会话可供记录物化事件的情况下落盘，会让模型可见的 locator 文本无法从会话日志重建。
3. (会话、附件 id) 命中缓存 ⇒ 返回缓存的 `SpillRef`——不重复调用 `saveText`，不重复记录 `attachment/materialized`。
4. 缓存未命中且未加载 `ctx.spillStore`，或 `saveText` 被拒绝 ⇒ 返回 `undefined`（best-effort；记一条警告日志）。调用方保持文件内联截断。
5. 缓存未命中且成功：以确定性、可读的 `suggestedName`（`attachment-<sha256 前 8 位十六进制>-<显示名>`）调用 `ctx.spillStore.saveText`，向发起方 agent 的会话追加 `attachment/materialized { attachmentId, locator }`，缓存该 `SpillRef` 并返回。

**幂等只在进程内成立**，不是"同一附件全生命周期只落一份"：`@deepseek-ai/dsh-spill-local` 的 `saveText` 对重复的 `suggestedName` 从不复用路径（不可预测的随机前缀用于防范共享根目录下的符号链接预置攻击），因此落盘前没有确定性文件名可供 `stat` 复用。一个刚恢复的进程从空缓存起步，可能会为同一个附件在新的 locator 下再落一份——但这次落盘同样会被立即记录，因此会话日志始终准确反映某个请求步骤当时真正展示给模型的那个 locator，只是不保证一个附件全生命周期只对应一份落盘文件。

## 模型体验

### 一个超大的文件附件

#### 模型看到什么

字符数不超过 `inlineWholeUnderChars` 的文件保持不变（整段内联文本，与之前一致）。更大的文件如果能解析出落盘产物，则变为一行头部——`File <name> (<size>, <N> chars) stored at: <locator>. <retrievalHint>`——后接一个只含前 `previewChars` 个字符的围栏代码块，以及一行 `(preview: first <shown> of <N> chars)` 提示；具体渲染由 `@deepseek-ai/dsh-llm` 的 `lowerSpilledFileBlockText` 完成。更大的文件如果解析不出落盘产物（无归属会话、未加载后端，或存储失败），则回退到之前的截断内联格式。

#### Token 影响

一份已落盘文件每次构建请求只消耗一行头部加 `previewChars` 个字符，与文件真实大小无关；只有模型对该 locator 调用 `read`/`grep` 时才会读到完整文本。

#### KV 缓存影响

同一进程内针对未变化的附件重复构建请求会复用同一个 locator（幂等缓存），因此各步骤间的降级文本逐字节一致，不会因此使可复用的请求前缀失效。

## 已知限制与遗留工作

- **幂等不跨进程重启存活**——见上文"行为"；一个恢复的会话可能会在新 locator 下重新落盘一个已经落过盘的附件，而不是复用原文件。
- **没有发起方 agent ⇒ 永不落盘**——会话之外的无会话 LLM 调用（例如 agent 轮次之外的一次性直连请求）即使加载了 `ctx.spillStore`，遇到超大文件也总是回退到截断内联文本。
