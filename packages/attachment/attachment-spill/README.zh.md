---
description: "面向超大文本文件附件的幂等、会话级 spill 物化——用一个模型按需读取的 locator 取代截断内联文本。"
kind: "package-reference"
---

# @deepseek-ai/dsh-attachment-spill

[English](README.md) | 中文

## 概述

`dsh-attachment-spill`让超大文本文件附件保持完整可读，而不是丢失字符数上限之外的全部内容。它注册 `ctx.attachmentSpill`，被 `@deepseek-ai/dsh-llm` 的文件降级路径（`lowerFileBlocksFromStore`）通过各 provider 适配器（`dsh-llm-deepseek`、`dsh-llm-pi-ai`）消费。一个解码后字符数超过配置阈值的文件，会落盘为一份[`ctx.spillStore`](../../spill/spill)会话级产物，并在同一 (会话、附件) 的每次后续请求构建之间复用——同一个稳定 locator，而不是每步都换一个新的。无需任何配置：出厂默认值直接复用此前"始终截断"的字符上限作为落盘阈值，部署方不调参就不会有任何变化。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在同时挂载了带文件附件的 provider 适配器和一个 `SpillStore` 后端（例如 `dsh-spill-local`）的组合中挂载本包。各适配器自身的 `lowerFileBlocksFromStore` 调用会自动串联 `ctx.attachmentSpill`；除加载插件本身外，适配器侧无需任何配置。

### 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `inlineWholeUnderChars` | `16000` | 字符数阈值：等于或低于该值时文件解码文本整段内联（与本包出现之前的行为一致）；高于该值则落盘。非负整数；加载时校验。 |
| `previewChars` | `4000` | 已落盘文件解码文本随 locator 一起展示的预览字符数。非负整数；加载时校验。 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-attachment-spill)是每个可用字段的详尽来源。

### 行为

1. `resolveSpill(attachment, content)` 读取*当前发起方 agent*（`ctx.agents.currentInitiator()`），而不是调用方传入的会话 id——因为降级文件分片这一步，总是发生在发起方 agent 自身的异步调用链内部，从活的 `Agent.session` 派生归属，排除了两者不一致的可能。
2. 没有活的发起方 agent（agent 轮次之外的无会话 LLM 调用）⇒ 返回 `undefined`；调用方保持文件内联截断。在没有会话可供记录物化事件的情况下落盘，会让模型可见的 locator 文本无法从会话日志重建。
3. (会话、附件 id) 命中缓存 ⇒ 返回缓存的 `SpillRef`——不重复调用 `saveText`，不重复记录 `attachment/materialized`。
4. 缓存未命中且未加载 `ctx.spillStore`，或 `saveText` 被拒绝 ⇒ 返回 `undefined`（best-effort；记一条警告日志）。调用方保持文件内联截断。
5. 缓存未命中且成功：以确定性、可读的 `suggestedName`（`attachment-<sha256 前 8 位十六进制>-<显示名>`）调用 `ctx.spillStore.saveText`，向发起方 agent 的会话追加 `attachment/materialized { attachmentId, locator }`，缓存该 `SpillRef` 并返回。

**幂等只在进程内成立**，不是"同一附件全生命周期只落一份"：`@deepseek-ai/dsh-spill-local` 的 `saveText` 对重复的 `suggestedName` 从不复用路径（不可预测的随机前缀用于防范共享根目录下的符号链接预置攻击），因此落盘前没有确定性文件名可供 `stat` 复用。一个刚恢复的进程从空缓存起步，可能会为同一个附件在新的 locator 下再落一份——但这次落盘同样会被立即记录，因此会话日志始终准确反映某个请求步骤当时真正展示给模型的那个 locator，只是不保证一个附件全生命周期只对应一份落盘文件。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

本节说明本包背后的设计决策；可观察行为已在[使用本包](#use-this-package)中完整覆盖。

### 源码地图

| 文件 | 角色 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config`、`AttachmentSpill` 服务、幂等缓存、`fileSpillOptionsFrom` |
| [`src/types.ts`](src/types.ts) | `attachment/materialized` 会话事件词表 |
| [`src/invariant.ts`](src/invariant.ts) | 不变量伴生插件（无运行时不变量；缓存及其日志记录在 `resolveSpill` 调用点直接落实） |

### 为什么用当前发起方而不是传入的会话 id

`resolveSpill` 运行在各适配器自身的请求构建调用内部，而该调用本身运行在发起方 agent 自己的异步调用链内。在此处读取 `ctx.agents.currentInitiator()`——而不是接受一个会话 id 参数——从结构上排除了落盘归属方与正在降级该文件的 agent 不一致的可能。

### 为什么是依赖图上的独立包，而不是 `dsh-llm` 的导出

`dsh-spill` 依赖 `dsh-llm`（为了 `ToolCallId`），因此 `dsh-llm` 不能反过来依赖 `dsh-spill`，否则会成环。因此 `dsh-llm/file-lowering.ts` 只声明它需要的形状（`LoweredFileSpillRef`，与 `dsh-spill` 的 `SpillRef` 结构兼容但并不导入它），并接受调用方提供的 `resolveSpill` 钩子。本包处在这四个包依赖图的最上层，是唯一把具体的、返回 `SpillRef` 的实现串接进该钩子的地方。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级契约不够用时，阅读以下页面。

- [附件存储接缝](../attachment/README.zh.md)——本包落盘的文本所读取的持久 `FileAttachmentRef`/`AttachmentStore` 词表。
- [Spill 存储服务](../../spill/spill/README.zh.md)——本包调用的后端所实现的 `saveText` 契约与词表。
- [dsh-spill-local](../../spill/spill-local/README.zh.md)——多数组合挂载为 `ctx.spillStore` 的文件系统后端。
- [附件子系统](../../../docs/subsystems/attachment.zh.md)——详尽的词表与归属关系。

-----

<a id="model-experience"></a>
## 模型体验

### 一个超大的文件附件

#### 模型看到什么

字符数不超过 `inlineWholeUnderChars` 的文件保持不变（整段内联文本，与之前一致）。更大的文件如果能解析出落盘产物，则变为一行头部——`File <name> (<size>, <N> chars) stored at: <locator>. <retrievalHint>`——后接一个只含前 `previewChars` 个字符的围栏代码块，以及一行 `(preview: first <shown> of <N> chars)` 提示；具体渲染由 `@deepseek-ai/dsh-llm` 的 `lowerSpilledFileBlockText` 完成。更大的文件如果解析不出落盘产物（无归属会话、未加载后端，或存储失败），则回退到之前的截断内联格式。

#### Token 影响

一份已落盘文件每次构建请求只消耗一行头部加 `previewChars` 个字符，与文件真实大小无关；只有模型对该 locator 调用 `read`/`grep` 时才会读到完整文本。

#### KV 缓存影响

同一进程内针对未变化的附件重复构建请求会复用同一个 locator（幂等缓存），因此各步骤间的降级文本逐字节一致，不会因此使可复用的请求前缀失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **幂等不跨进程重启存活**——见上文[行为](#use-this-package)；一个恢复的会话可能会在新 locator 下重新落盘一个已经落过盘的附件，而不是复用原文件。
- **没有发起方 agent ⇒ 永不落盘**——会话之外的无会话 LLM 调用（例如 agent 轮次之外的一次性直连请求）即使加载了 `ctx.spillStore`，遇到超大文件也总是回退到截断内联文本。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作背景——点击展开</summary>

本开发备注是面向维护者的工作背景：开放方向。明确不具有权威性。

#### 未来方向：跨进程幂等

进程内的 `Map<SessionId, Map<AttachmentId, SpillRef>>` 缓存是一个刻意为之、已记录在案的限制，而非承诺：一个支持按建议名查找或按内容寻址去重的后端（不同于 `dsh-spill-local` 总是写入全新随机路径的做法），可以让恢复后的进程重新发现已经落盘过的产物，而不是重新落盘。

</details>
